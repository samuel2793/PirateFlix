import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import pump from 'pump';
import rangeParser from 'range-parser';
import ffmpeg from 'fluent-ffmpeg';
import { Readable } from 'stream';
import path from 'path';
import https from 'https';
import axios from 'axios';
import fs from 'fs';
import os from 'os';

const app = express();
const PORT = 3001;

// Circuit-breaker / mirror health tracking
const mirrorStats = new Map();
const MIRROR_FAILURE_THRESHOLD = parseInt(process.env.PIRATEFLIX_MIRROR_FAILURE_THRESHOLD || '3', 10);
const MIRROR_COOLDOWN_MS = parseInt(process.env.PIRATEFLIX_MIRROR_COOLDOWN_MS || '60000', 10); // 60s
const EXTENDED_MIRROR_TIMEOUT_MS = parseInt(process.env.PIRATEFLIX_MIRROR_EXTENDED_TIMEOUT_MS || '30000', 10); // 30s
// Hedged request / tuning
const FAST_PARALLEL_MIRRORS = parseInt(process.env.PIRATEFLIX_FAST_PARALLEL_MIRRORS || '2', 10); // mirrors to probe first
const MIRROR_RETRY_COUNT = parseInt(process.env.PIRATEFLIX_MIRROR_RETRY_COUNT || '0', 10); // retries per mirror in fast stage
const MIRROR_RETRY_DELAY_MS = parseInt(process.env.PIRATEFLIX_MIRROR_RETRY_DELAY_MS || '500', 10);

// Track active search AbortControllers so we can abort searches on-demand
const activeSearchControllers = new Set();

// Configurar CORS
app.use(cors());
app.use(express.json());

// Cliente WebTorrent (versión Node.js - soporta todos los trackers)
const client = new WebTorrent();

// Almacenar torrents activos y metadata de subtítulos
const activeTorrents = new Map();
const embeddedSubtitlesCache = new Map();

// Cache de videos transcodificados (para poder hacer seeking)
const transcodedCache = new Map();
const CACHE_DIR = path.join(os.tmpdir(), 'pirateflix-transcoded');

// Rastrear procesos FFmpeg activos para limpiarlos
const activeFFmpegProcesses = new Map();

// Crear directorio de cache si no existe
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log('📁 Directorio de cache creado:', CACHE_DIR);
}

// Helper: esperar hasta que el archivo exista en disco y tenga al menos `minBytes` bytes
async function waitForFileOnDisk(file, filePath, minBytes = 1024, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        // Priorizar descarga de inicio del archivo
        try {
          file.select(0, Math.min(minBytes, file.length));
        } catch (e) {
          // ignorar si no se puede seleccionar
        }

        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          if (stat.size >= Math.min(minBytes, file.length) || file.downloaded > 0) {
            return resolve();
          }
        }

        if (Date.now() - start > timeoutMs) {
          return reject(new Error('Timeout waiting for file on disk'));
        }
      } catch (err) {
        // Si ocurre cualquier error, terminar con reject
        return reject(err);
      }
      setTimeout(check, 150);
    };
    check();
  });
}

// Endpoint para buscar torrents en The Pirate Bay
app.get('/api/search-torrent', async (req, res) => {
  const { query, category = '207' } = req.query; // 207 = HD Movies

  if (!query) {
    return res.status(400).json({ error: 'query es requerido' });
  }

  try {
    // Limpiar el query de caracteres problemáticos
    let cleanQuery = query
      .replace(/'/g, '') // Remover apóstrofes
      .replace(/:/g, '') // Remover dos puntos
      .replace(/[^\w\s]/g, ' ') // Remover otros caracteres especiales
      .replace(/\s+/g, ' ') // Normalizar espacios
      .trim();

    console.log(`Buscando torrent: ${query}`);
    if (cleanQuery !== query) {
      console.log(`Query limpio: ${cleanQuery}`);
    }

    // Probar varios mirrors/proxies en orden hasta obtener respuesta
    // Timeout por defecto para requests a mirrors (ms). Se puede sobreescribir con env `PIRATEFLIX_SEARCH_TIMEOUT_MS`.
    const timeoutMs = parseInt(process.env.PIRATEFLIX_SEARCH_TIMEOUT_MS || '30000', 10); // 30s por defecto
    // Permitir TLS débiles (útil en entornos locales o mirrors con certificados viejos).
    // Para habilitar, exporta: PIRATEFLIX_ALLOW_WEAK_TLS=true
    const allowInsecureTLS = String(process.env.PIRATEFLIX_ALLOW_WEAK_TLS || 'false').toLowerCase() === 'true';
    const mirrors = [
      'https://thepibay.site',
      'https://tpb.party',
      'https://thepiratebay.org',
    ];

    const searchStart = Date.now();
    console.log(`Intentando mirrors: ${mirrors.join(', ')}`);
    console.log(`Busqueda iniciada: ${new Date(searchStart).toISOString()}`);

    // Diagnostics to help debug why searches may fail after prior activity
    try {
      const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : 'unknown';
      const requests = typeof process._getActiveRequests === 'function' ? process._getActiveRequests().length : 'unknown';
      console.log(`Diagnostics: torrents=${client.torrents.length}, activeFFmpeg=${activeFFmpegProcesses.size}, transcodedCache=${transcodedCache.size}, handles=${handles}, requests=${requests}`);
    } catch (e) {
      console.warn('No se pudieron obtener diagnostics internos:', e.message);
    }

    async function fetchSearchHtml(cleanQuery, category) {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Referer': 'https://www.google.com/',
      };

      // Cache simple en memoria para evitar repetir búsquedas idénticas en corto plazo
      const cacheKey = `${cleanQuery}::${category}`;
      const cacheTtl = parseInt(process.env.PIRATEFLIX_SEARCH_CACHE_MS || '30000', 10); // 30s por defecto
      if (!global.__pirateflix_search_cache) global.__pirateflix_search_cache = new Map();
      const searchCache = global.__pirateflix_search_cache;
      const cached = searchCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < cacheTtl) {
        console.log('✅ Sirviendo búsqueda desde cache:', cacheKey);
        return cached.html;
      }

      // Helper: intento rápido a APIs externas (YTS) para obtener magnet links
      const tryYtsFallback = async (q) => {
        if (String(process.env.PIRATEFLIX_USE_EXTERNAL_API || 'true').toLowerCase() !== 'true') return null;
        try {
          const apiUrl = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(q)}&limit=5`;
          console.log('Intentando fallback externo rápido (YTS):', apiUrl);
          const resp = await axios.get(apiUrl, { timeout: 5000, responseType: 'json' });
          const movies = resp?.data?.data?.movies;
          if (!movies || movies.length === 0) return null;

          const magnets = [];
          for (const m of movies) {
            if (!m.torrents) continue;
            for (const t of m.torrents) {
              if (!t.hash) continue;
              const dn = encodeURIComponent(`${m.title} ${m.year} ${t.quality}`);
              const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=${dn}`;
              magnets.push(magnet);
            }
          }

          if (magnets.length === 0) return null;
          // Construir HTML mínimo con enlaces magnet para que el parser existente los encuentre
          const fakeHtml = magnets.map((m) => `<a href="${m}">download</a>`).join('\n');
          return fakeHtml;
        } catch (err) {
          console.warn('Fallback YTS falló:', err && err.message ? err.message : err);
          return null;
        }
      };

      // Estrategia por fases (hedged requests):
      // 1) Probar los N mirrors más saludables en paralelo (rápido)
      // 2) Si falla, ampliar a todos los mirrors en paralelo con timeout mayor
      // 3) Si sigue fallando, intentar secuencial con timeout extendido (como antes)
      const perMirrorTimeout = parseInt(process.env.PIRATEFLIX_MIRROR_TIMEOUT_MS || '8000', 10); // 8s por request por defecto
      const controllers = [];

      // Preferir mirrors que no estén en estado "open" del circuit-breaker
      const healthyMirrors = mirrors.filter((base) => {
        const s = mirrorStats.get(base);
        if (!s) return true;
        if (s.openUntil && s.openUntil > Date.now()) {
          // Circuit abierto: saltar este mirror
          return false;
        }
        return true;
      });

      const prioritized = (healthyMirrors.length > 0 ? healthyMirrors : mirrors).slice();
      // Ordenar por último éxito (más reciente primero) y menos fallos
      prioritized.sort((a, b) => {
        const sa = mirrorStats.get(a) || {};
        const sb = mirrorStats.get(b) || {};
        const ta = sa.lastSuccess || 0;
        const tb = sb.lastSuccess || 0;
        if (ta !== tb) return tb - ta; // más reciente primero
        const fa = sa.fails || 0;
        const fb = sb.fails || 0;
        return fa - fb; // menos fallos primero
      });

      if (healthyMirrors.length === 0) console.log('⚠️ Todos los mirrors en cooldown; se utilizarán todos los mirrors temporalmente');

      const makeRequestFor = (base, timeoutMs, signalController) => {
        const url = `${base}/search/${encodeURIComponent(cleanQuery)}/1/99/${category}`;
        const controller = signalController || new AbortController();
        controllers.push({ controller, base, url });
        activeSearchControllers.add(controller);

        console.log(`Lanzando petición a: ${url} (timeout ${timeoutMs}ms)`);

        const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 10, rejectUnauthorized: !allowInsecureTLS });

        return axios.get(url, {
          headers,
          timeout: timeoutMs,
          maxRedirects: 5,
          responseType: 'text',
          validateStatus: (s) => s >= 200 && s < 400,
          httpsAgent,
          signal: controller.signal,
        }).then((resp) => {
          if (resp && resp.data && resp.data.length > 0) {
            console.log(`HTML recibido desde ${base}: ${resp.data.length} bytes`);
            mirrorStats.set(base, { fails: 0, lastSuccess: Date.now(), openUntil: null });
            try { activeSearchControllers.delete(controller); } catch (e) { /* ignore */ }
            return { base, html: resp.data };
          }
          throw new Error(`Empty response from ${base}`);
        }).catch((err) => {
          const msg = err && err.message ? String(err.message).toLowerCase() : '';
          if (msg.includes('certificate key too weak') || (msg.includes('certificate') && msg.includes('weak'))) {
            console.warn(`Advertencia: certificado débil en mirror ${base}`);
          }

          const prev = mirrorStats.get(base) || { fails: 0 };
          prev.fails = (prev.fails || 0) + 1;
          prev.lastFail = Date.now();
          if (prev.fails >= MIRROR_FAILURE_THRESHOLD) {
            prev.openUntil = Date.now() + MIRROR_COOLDOWN_MS;
            console.warn(`⛔ Mirror ${base} abierto por circuit-breaker hasta ${new Date(prev.openUntil).toISOString()} (fails=${prev.fails})`);
          }
          mirrorStats.set(base, prev);

          try { activeSearchControllers.delete(controller); } catch (e) { /* ignore */ }
          throw err;
        });
      };

      let result = null;
      try {
        // Stage 1: fast parallel to top N mirrors
        const topN = Math.max(1, Math.min(prioritized.length, FAST_PARALLEL_MIRRORS));
        const topList = prioritized.slice(0, topN);
        try {
          console.log(`Stage1: probando top ${topList.length} mirrors en paralelo`);
          const requests = topList.map((m) => makeRequestFor(m, perMirrorTimeout));
          const winner = await Promise.any(requests);
          result = winner.html;
        } catch (stage1Err) {
          console.warn('Stage1 falló:', stage1Err && stage1Err.errors ? stage1Err.errors.map(e => e && e.message).join(' | ') : (stage1Err && stage1Err.message) || stage1Err);

          // Abort any pending controllers from stage1
          for (const { controller } of controllers) {
            try { controller.abort(); } catch (e) { /* ignore */ }
            try { activeSearchControllers.delete(controller); } catch (e) { /* ignore */ }
          }

          // Stage 2: ampliar a todos los mirrors en paralelo con timeout mayor
          const wideTimeout = Math.max(perMirrorTimeout * 2, Math.floor(perMirrorTimeout + 7000));
          const controllersStage2 = [];
          console.log(`Stage2: probando todos los mirrors en paralelo (timeout ${wideTimeout}ms)`);
          try {
            const requests2 = prioritized.map((m) => {
              const controller = new AbortController();
              controllersStage2.push({ controller, base: m });
              return makeRequestFor(m, wideTimeout, controller);
            });
            const winner2 = await Promise.any(requests2);
            result = winner2.html;
          } catch (stage2Err) {
            console.warn('Stage2 falló:', stage2Err && stage2Err.errors ? stage2Err.errors.map(e => e && e.message).join(' | ') : (stage2Err && stage2Err.message) || stage2Err);

            // Abort stage2 controllers
            for (const { controller } of controllersStage2) {
              try { controller.abort(); } catch (e) { /* ignore */ }
              try { activeSearchControllers.delete(controller); } catch (e) { /* ignore */ }
            }
            // Intento rápido externo antes del reintento secuencial lento
            try {
              const ytsHtml = await tryYtsFallback(cleanQuery);
              if (ytsHtml) {
                console.log('✅ Fallback externo (YTS) exitoso — usando resultados rápidos');
                result = ytsHtml;
              }
            } catch (e) {
              console.warn('Error en fallback externo rápido:', e && e.message ? e.message : e);
            }

            // Stage 3: secuencial con timeout extendido (último recurso)
            if (!result) console.log('Intentando reintentos secuenciales con timeout extendido...');
            for (const base of mirrors) {
              const url = `${base}/search/${encodeURIComponent(cleanQuery)}/1/99/${category}`;
              console.log(`Intentando secuencial a: ${url} (timeout ${EXTENDED_MIRROR_TIMEOUT_MS}ms)`);
              const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 10, rejectUnauthorized: !allowInsecureTLS });
              try {
                const resp = await axios.get(url, {
                  headers,
                  timeout: EXTENDED_MIRROR_TIMEOUT_MS,
                  maxRedirects: 5,
                  responseType: 'text',
                  validateStatus: (s) => s >= 200 && s < 400,
                  httpsAgent,
                });

                if (resp && resp.data && resp.data.length > 0) {
                  console.log(`HTML recibido (secuencial) desde ${base}: ${resp.data.length} bytes`);
                  mirrorStats.set(base, { fails: 0, lastSuccess: Date.now(), openUntil: null });
                  result = resp.data;
                  break;
                }
              } catch (err) {
                const prev = mirrorStats.get(base) || { fails: 0 };
                prev.fails = (prev.fails || 0) + 1;
                prev.lastFail = Date.now();
                if (prev.fails >= MIRROR_FAILURE_THRESHOLD) {
                  prev.openUntil = Date.now() + MIRROR_COOLDOWN_MS;
                  console.warn(`⛔ Mirror ${base} abierto por circuit-breaker hasta ${new Date(prev.openUntil).toISOString()} (fails=${prev.fails})`);
                }
                mirrorStats.set(base, prev);
                console.warn(`Secuencial falló para ${base}:`, err && err.message ? err.message : err);
              }

              // Pequeña espera entre intentos secuenciales para evitar ráfagas
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        }
      } finally {
        // Abortar cualquier petición pendiente
        for (const { controller } of controllers) {
          try { controller.abort(); } catch (e) { /* ignore */ }
          try { activeSearchControllers.delete(controller); } catch (e) { /* ignore */ }
        }
      }

      if (!result) {
        throw new Error('All mirrors failed');
      }

      // Cachear resultado
      searchCache.set(cacheKey, { html: result, ts: Date.now() });
      return result;
    }

    // Intentar búsqueda principal y, si falla, probar fallbacks (quitar resolución / año)
    let html = null;
    try {
      html = await fetchSearchHtml(cleanQuery, category);
      console.log(`Busqueda finalizada en ${Date.now() - searchStart} ms`);
    } catch (initialErr) {
      console.warn('Búsqueda inicial falló, intentando fallbacks de query:', initialErr.message);

      // Construir variantes de fallback: quitar tokens de resolución (1080p, 720p, 4k, etc.) y/o año
      const fallbacks = [];
      const withoutRes = cleanQuery.replace(/\b(1080p|720p|2160p|4k|4k?p|bdrip|bluray|brip|brrip|webrip|web-dl|dvdrip|hdrip)\b/gi, '').replace(/\s+/g, ' ').trim();
      if (withoutRes && withoutRes !== cleanQuery) fallbacks.push(withoutRes);

      const withoutYear = cleanQuery.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
      if (withoutYear && withoutYear !== cleanQuery && !fallbacks.includes(withoutYear)) fallbacks.push(withoutYear);

      const noResNoYear = withoutRes.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
      if (noResNoYear && !fallbacks.includes(noResNoYear) && noResNoYear !== cleanQuery) fallbacks.push(noResNoYear);

      for (const fq of fallbacks) {
        try {
          console.log(`Intentando fallback: '${fq}'`);
          html = await fetchSearchHtml(fq, category);
          console.log(`Fallback exitoso con query: '${fq}'`);
          break;
        } catch (fbErr) {
          console.warn(`Fallback falló para '${fq}':`, fbErr && fbErr.message ? fbErr.message : fbErr);
        }
      }

      if (!html) {
        // No se pudo recuperar con fallbacks, re-lanzar el error original para manejo más arriba
        throw initialErr;
      }

      console.log(`Busqueda (fallback) finalizada en ${Date.now() - searchStart} ms`);
    }

    // Parsear resultados del HTML
    const torrents = [];

    // Primero buscar todos los magnet links
    const magnetRegex = /<a href="(magnet:\?xt=urn:btih:[^"]+)"/g;
    const magnets = [];
    let magnetMatch;

    while ((magnetMatch = magnetRegex.exec(html)) !== null) {
      magnets.push(magnetMatch[1]);
    }

    console.log(`Magnet links encontrados: ${magnets.length}`);    // Para cada magnet, buscar su información
    for (const magnetLink of magnets) {
      if (torrents.length >= 10) break;

      // Extraer el nombre del torrent del magnet link
      const nameMatch = magnetLink.match(/&dn=([^&]+)/);
      const name = nameMatch ? decodeURIComponent(nameMatch[1].replace(/\+/g, ' ')) : 'Unknown';

      // Buscar seeders y leechers cerca del magnet link
      const escapedMagnet = magnetLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const infoRegex = new RegExp(escapedMagnet + '[\\s\\S]{0,500}?<td align="right">(\\d+)<\\/td>\\s*<td align="right">(\\d+)<\\/td>', 'i');
      const infoMatch = html.match(infoRegex);

      let seeders = 0;
      let leechers = 0;

      if (infoMatch) {
        seeders = parseInt(infoMatch[1]);
        leechers = parseInt(infoMatch[2]);
      }

      // Buscar tamaño
      const sizeRegex = new RegExp(escapedMagnet + '[\\s\\S]{0,300}?Size ([^,<]+)', 'i');
      const sizeMatch = html.match(sizeRegex);
      const size = sizeMatch ? sizeMatch[1].trim() : 'Unknown';

      torrents.push({
        name,
        magnetLink,
        size,
        seeders,
        leechers,
        score: seeders * 2 + leechers
      });
    }

    // Ordenar por score (más seeders = mejor)
    torrents.sort((a, b) => b.score - a.score);

    console.log(`Torrents parseados: ${torrents.length}`);
    if (torrents.length > 0) {
      console.log(`Mejor resultado: ${torrents[0].name} (${torrents[0].seeders}S/${torrents[0].leechers}L)`);
    } else {
      console.log('No se pudieron parsear torrents del HTML');
    }

    res.json({
      query,
      results: torrents,
      count: torrents.length
    });

  } catch (error) {
    console.error('Error al buscar torrent:', error && error.message ? error.message : error);

    const msg = (error && error.message) ? String(error.message).toLowerCase() : '';
    // Axios yields 'timeout of XXXXms exceeded' or code 'ECONNABORTED' on timeout
    // También mapear errores TLS/certificado a 504 para evitar 500s cuando un mirror tiene certificado débil
    if (msg.includes('timeout') || error?.code === 'ECONNABORTED' || msg.includes('all mirrors failed') || msg.includes('empty response') || msg.includes('certificate key too weak') || (msg.includes('certificate') && msg.includes('weak')) || msg.includes('request failed with status code 5') || (error && error.response && error.response.status >= 500 && error.response.status < 600)) {
      return res.status(504).json({ error: 'Timeout en búsqueda', message: 'La búsqueda tardó demasiado o los mirrors no respondieron' });
    }

    res.status(500).json({ error: 'Error al buscar torrent', message: (error && error.message) || String(error) });
  }
});

// Endpoint para agregar un torrent
app.post('/api/torrent/add', (req, res) => {
  const { magnetUri } = req.body;

  if (!magnetUri) {
    return res.status(400).json({ error: 'magnetUri es requerido' });
  }

  console.log('Agregando torrent:', magnetUri);

  // Verificar si ya existe
  const existingTorrent = client.get(magnetUri);
  if (existingTorrent) {
    console.log('Torrent ya existe');
    return res.json({
      infoHash: existingTorrent.infoHash,
      name: existingTorrent.name || 'Esperando metadata...',
      files: existingTorrent.files.map((f, i) => ({
        index: i,
        name: f.name,
        length: f.length,
        type: getFileType(f.name),
      })),
    });
  }

  // Agregar torrent
  client.add(magnetUri, (torrent) => {
    console.log('Torrent agregado:', torrent.name);
    console.log('InfoHash:', torrent.infoHash);
    console.log('Archivos:', torrent.files.length);

    activeTorrents.set(torrent.infoHash, torrent);

    // Seleccionar todos los archivos para descargar
    torrent.files.forEach((file) => {
      file.select();
    });

    res.json({
      infoHash: torrent.infoHash,
      name: torrent.name,
      files: torrent.files.map((f, i) => ({
        index: i,
        name: f.name,
        length: f.length,
        type: getFileType(f.name),
      })),
    });
  });

  // Manejar errores
  client.on('error', (err) => {
    console.error('Error del cliente:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  });
});

// Función helper para determinar el tipo de archivo
function getFileType(filename) {
  const ext = filename.toLowerCase().split('.').pop();

  // Videos
  if (['mp4', 'mkv', 'avi', 'webm', 'mov', 'flv', 'wmv'].includes(ext)) {
    return 'video';
  }

  // Subtítulos
  if (['srt', 'vtt', 'sub', 'ass', 'ssa', 'sbv'].includes(ext)) {
    return 'subtitle';
  }

  return 'other';
}

// Endpoint para obtener información de un torrent
app.get('/api/torrent/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) {
    return res.status(404).json({ error: 'Torrent no encontrado' });
  }

  res.json({
    infoHash: torrent.infoHash,
    name: torrent.name,
    progress: torrent.progress,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    numPeers: torrent.numPeers,
    files: torrent.files.map((f, i) => ({
      index: i,
      name: f.name,
      length: f.length,
      type: getFileType(f.name),
    })),
  });
});

// Endpoint para detectar subtítulos embebidos en un archivo de video
app.get('/api/embedded-subtitles/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const cacheKey = `${infoHash}-${fileIndex}`;

  // Verificar cache
  if (embeddedSubtitlesCache.has(cacheKey)) {
    return res.json(embeddedSubtitlesCache.get(cacheKey));
  }

  const torrent = client.get(infoHash);
  if (!torrent) {
    return res.status(404).json({ error: 'Torrent no encontrado' });
  }

  const file = torrent.files[parseInt(fileIndex)];
  if (!file) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }

  try {
    // Obtener la ruta del archivo en el sistema de archivos
    // WebTorrent descarga los archivos en su carpeta temporal
    const filePath = path.join(torrent.path, file.path);

    console.log('Analizando subtítulos embebidos en:', filePath);

    // Esperar a que el archivo exista en disco y tenga datos suficientes para ffprobe
    try {
      await waitForFileOnDisk(file, filePath, Math.min(10 * 1024 * 1024, file.length), 20000);
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló:', err.message);
      // Continuar y dejar que ffprobe intente de todos modos
    }

    // Usar ffprobe con la ruta del archivo directamente
    const subtitles = await new Promise((resolve, reject) => {
      const subtitleTracks = [];

      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          console.error('Error al analizar archivo:', err.message);
          resolve([]);
          return;
        }

        if (metadata.streams) {
          metadata.streams.forEach((stream, index) => {
            if (stream.codec_type === 'subtitle') {
              subtitleTracks.push({
                index: stream.index,
                codec: stream.codec_name,
                language: stream.tags?.language || 'und',
                title: stream.tags?.title || `Subtitle ${index}`,
                forced: stream.disposition?.forced === 1,
                default: stream.disposition?.default === 1,
              });
            }
          });
        }

        resolve(subtitleTracks);
      });
    });

    // Guardar en cache
    embeddedSubtitlesCache.set(cacheKey, subtitles);

    res.json(subtitles);
  } catch (error) {
    console.error('Error al detectar subtítulos embebidos:', error);
    res.json([]);
  }
});

// Endpoint para streamear un archivo de video
app.get('/api/stream/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) {
    return res.status(404).send('Torrent no encontrado');
  }

  const file = torrent.files[parseInt(fileIndex)];
  if (!file) {
    return res.status(404).send('Archivo no encontrado');
  }

  const filePath = path.join(torrent.path, file.path);
  const fileName = file.name.toLowerCase();

  // Detectar si necesita transcodificación automáticamente
  const needsTranscode = fileName.endsWith('.mkv') ||
                         fileName.includes('hevc') ||
                         fileName.includes('x265') ||
                         fileName.includes('h265');

  console.log('Streaming archivo:', file.name, needsTranscode ? '(TRANSCODIFICANDO automáticamente)' : '');

  // TRANSCODIFICACIÓN UNIVERSAL: Convierte cualquier video a H.264 + AAC
  if (needsTranscode) {
    const cacheKey = `${infoHash}_${fileIndex}`;
    const cachedPath = path.join(CACHE_DIR, `${cacheKey}.mp4`);

    // LIMPIAR proceso FFmpeg anterior si existe
    if (activeFFmpegProcesses.has(cacheKey)) {
      const oldProcess = activeFFmpegProcesses.get(cacheKey);
      console.log('🧹 Deteniendo transcodificación anterior:', cacheKey);
      try {
        oldProcess.kill('SIGKILL');
      } catch (err) {
        // Ignorar errores si el proceso ya murió
      }
      activeFFmpegProcesses.delete(cacheKey);
    }

    // Si ya existe en cache completo, servir directamente con soporte de seeking
    if (transcodedCache.get(cacheKey) === 'ready' && fs.existsSync(cachedPath)) {
      console.log('✅ Sirviendo desde cache:', file.name);
      return serveVideoFile(cachedPath, req, res);
    }

    console.log('🎬 Transcodificación en tiempo real:', file.name);

    // Esperar a que el archivo exista en disco (o que tenga algunos bytes) antes de ffprobe
    try {
      await waitForFileOnDisk(file, filePath, Math.min(64 * 1024, file.length), 15000);
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló antes de ffprobe:', err.message);
      // permitimos que ffprobe lo intente igualmente
    }

    // Obtener duración del video original
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error('❌ Error al obtener metadata:', err.message);
        return res.status(500).send('Error al analizar video');
      }

      const duration = metadata.format.duration;
      console.log(`📹 Duración: ${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`);

      // Headers para streaming (el navegador recibirá el video inmediatamente)
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'none', // No seeking durante transcodificación en tiempo real
      });

      // Marcar como transcodificando
      transcodedCache.set(cacheKey, 'transcoding');

      // STREAMING EN TIEMPO REAL
      const ffmpegCommand = ffmpeg(filePath)
        .videoCodec('libx264')
        .videoBitrate('2500k')
        .audioCodec('aac')
        .audioBitrate('192k')
        .audioChannels(2)
        .format('mp4')
        .outputOptions([
          '-preset ultrafast',
          '-tune zerolatency',
          '-movflags frag_keyframe+empty_moov+default_base_moof',
          '-frag_duration 1000000',
          '-max_muxing_queue_size 1024'
        ])
        .on('start', (cmd) => {
          console.log('🔄 FFmpeg transcodificando en vivo');
        })
        .on('progress', (progress) => {
          // Solo mostrar progreso cada 10% para no saturar logs
          if (progress.percent && Math.floor(progress.percent) % 10 === 0) {
            const rounded = Math.floor(progress.percent);
            if (!ffmpegCommand._lastProgressLog || ffmpegCommand._lastProgressLog !== rounded) {
              console.log(`⏳ Progreso: ${rounded}%`);
              ffmpegCommand._lastProgressLog = rounded;
            }
          }
        })
        .on('error', (err) => {
          // Solo mostrar error si no es SIGKILL (desconexión intencional)
          if (!err.message.includes('SIGKILL')) {
            console.error('❌ Error FFmpeg:', err.message);
          }
          transcodedCache.delete(cacheKey);
          activeFFmpegProcesses.delete(cacheKey);
          if (!res.headersSent) {
            res.status(500).send('Error de transcodificación');
          }
        })
        .on('end', () => {
          console.log('✅ Transcodificación completada');
          activeFFmpegProcesses.delete(cacheKey);
        });

      // Registrar proceso activo
      activeFFmpegProcesses.set(cacheKey, ffmpegCommand);

      // Stream directamente al navegador
      ffmpegCommand.pipe(res, { end: true });

      // Si el cliente se desconecta, detener transcodificación INMEDIATAMENTE
      res.on('close', () => {
        console.log('🛑 Cliente desconectado, deteniendo transcodificación');
        try {
          ffmpegCommand.kill('SIGKILL');
        } catch (err) {
          // Ignorar si ya está muerto
        }
        transcodedCache.delete(cacheKey);
        activeFFmpegProcesses.delete(cacheKey);
      });
    });

    return;
  }

  // Streaming normal para archivos ya compatibles (MP4 con H.264)
  serveVideoFile(filePath, req, res, file);
});

// Función auxiliar para servir archivos de video con soporte de Range requests (seeking)
function serveVideoFile(filePath, req, res, webTorrentFile = null) {
  // Si es archivo del sistema (transcodificado), usar fs
  if (!webTorrentFile) {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = rangeParser(fileSize, range);

      if (parts === -1 || parts === -2 || parts.type !== 'bytes' || parts.length === 0) {
        res.status(416).send('Rango no satisfactorio');
        return;
      }

      const [{ start, end }] = parts;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
      });

      const fileStream = fs.createReadStream(filePath, { start, end });
      pump(fileStream, res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes'
      });

      const fileStream = fs.createReadStream(filePath);
      pump(fileStream, res);
    }
    return;
  }

  // Si es archivo de WebTorrent, usar su API
  const fileSize = webTorrentFile.length;
  const range = req.headers.range;

  if (range) {
    const parts = rangeParser(fileSize, range);

    if (parts === -1 || parts === -2 || parts.type !== 'bytes' || parts.length === 0) {
      res.status(416).send('Rango no satisfactorio');
      return;
    }

    const [{ start, end }] = parts;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });

    const stream = webTorrentFile.createReadStream({ start, end });
    pump(stream, res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes'
    });

    const stream = webTorrentFile.createReadStream();
    pump(stream, res);
  }
}
// Endpoint para extraer subtítulos embebidos de un archivo de video
app.get('/api/embedded-subtitle/:infoHash/:fileIndex/:streamIndex', async (req, res) => {
  const { infoHash, fileIndex, streamIndex } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) {
    return res.status(404).send('Torrent no encontrado');
  }

  const file = torrent.files[parseInt(fileIndex)];
  if (!file) {
    return res.status(404).send('Archivo no encontrado');
  }

  try {
    console.log(`Extrayendo subtítulo stream ${streamIndex} de:`, file.name);

    // Obtener la ruta del archivo en el sistema de archivos
    const filePath = path.join(torrent.path, file.path);

    let clientDisconnected = false;
    let ffmpegCommand = null;

    // Manejar cierre de conexión del cliente
    res.on('close', () => {
      clientDisconnected = true;
      console.log('Cliente desconectado durante extracción de subtítulo');

      // Limpiar recursos
      try {
        if (ffmpegCommand) {
          ffmpegCommand.kill('SIGKILL');
        }
      } catch (e) {
        // Ignorar errores al limpiar
      }
    });

    // Esperar a que el archivo exista en disco y tenga algunos bytes
    try {
      await waitForFileOnDisk(file, filePath, Math.min(64 * 1024, file.length), 15000);
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló antes de extraer subtítulo:', err.message);
      // Continuar y permitir que ffmpeg intente igualmente
    }

    // Configurar headers
    res.writeHead(200, {
      'Content-Type': 'text/vtt',
      'Access-Control-Allow-Origin': '*',
    });

    // Usar ffmpeg para extraer el subtítulo específico y convertirlo a WebVTT
    // Ahora usando la ruta del archivo en lugar de un stream
    ffmpegCommand = ffmpeg(filePath)
      .outputOptions([
        `-map 0:${streamIndex}`,
        '-f webvtt'
      ])
      .on('error', (err) => {
        if (!clientDisconnected && err.code !== 'EPIPE') {
          console.error('Error extrayendo subtítulo:', err.message);
          if (!res.headersSent) {
            res.status(500).send('Error al extraer subtítulo');
          }
        }
      })
      .on('end', () => {
        if (!clientDisconnected) {
          console.log('Subtítulo extraído exitosamente');
        }
      });

    // Pipe directamente a la respuesta
    ffmpegCommand.pipe(res, { end: true });

  } catch (error) {
    console.error('Error al extraer subtítulo embebido:', error.message);
    if (!res.headersSent) {
      res.status(500).send('Error al procesar subtítulo');
    }
  }
});

// Endpoint para obtener subtítulos
app.get('/api/subtitle/:infoHash/:fileIndex', (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) {
    return res.status(404).send('Torrent no encontrado');
  }

  const file = torrent.files[parseInt(fileIndex)];
  if (!file) {
    return res.status(404).send('Archivo no encontrado');
  }

  console.log('Sirviendo subtítulo:', file.name);

  // Determinar el tipo MIME según la extensión
  const ext = file.name.toLowerCase().split('.').pop();

  // Siempre servir como WebVTT para compatibilidad con el elemento <track>
  res.writeHead(200, {
    'Content-Type': 'text/vtt',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=31536000',
  });

  const stream = file.createReadStream();

  // Si es SRT, convertir a WebVTT
  if (ext === 'srt') {
    let srtData = '';

    stream.on('data', (chunk) => {
      srtData += chunk.toString('utf-8');
    });

    stream.on('end', () => {
      try {
        // Convertir SRT a WebVTT
        const vttData = convertSrtToVtt(srtData);
        res.end(vttData);
      } catch (error) {
        console.error('Error al convertir SRT a VTT:', error);
        res.status(500).send('Error al convertir subtítulo');
      }
    });

    stream.on('error', (err) => {
      console.error('Error al leer subtítulo:', err);
      if (!res.headersSent) {
        res.status(500).send('Error al leer subtítulo');
      }
    });
  } else {
    // Para VTT o SUB, enviar directamente
    pump(stream, res);
  }
});

// Función auxiliar para convertir SRT a WebVTT
function convertSrtToVtt(srtContent) {
  // Agregar header de WebVTT
  let vtt = 'WEBVTT\n\n';

  // Reemplazar comas por puntos en timestamps (SRT usa comas, VTT usa puntos)
  vtt += srtContent.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

  return vtt;
}

// Endpoint para eliminar un torrent
app.delete('/api/torrent/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) {
    return res.status(404).json({ error: 'Torrent no encontrado' });
  }

  // Detener TODOS los procesos FFmpeg relacionados con este torrent
  for (const [cacheKey, ffmpegProcess] of activeFFmpegProcesses.entries()) {
    if (cacheKey.startsWith(infoHash)) {
      console.log('🧹 Deteniendo FFmpeg para torrent:', cacheKey);
      try {
        ffmpegProcess.kill('SIGKILL');
      } catch (err) {
        // Ignorar si ya está muerto
      }
      activeFFmpegProcesses.delete(cacheKey);
      transcodedCache.delete(cacheKey);
    }
  }

  torrent.destroy(() => {
    activeTorrents.delete(infoHash);
    embeddedSubtitlesCache.delete(infoHash);
    console.log('Torrent eliminado:', infoHash);
    res.json({ success: true });
  });
});

// Endpoint de health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    torrents: client.torrents.length,
    uploadSpeed: client.uploadSpeed,
    downloadSpeed: client.downloadSpeed,
  });
});

// Endpoint para reinicio suave del estado (no reinicia proceso):
// - aborta búsquedas en curso
// - destruye torrents activos
// - mata procesos FFmpeg activos
// - limpia caches y estado de mirrors
app.post('/api/reset-state', async (req, res) => {
  try {
    console.log('🔁 Reset de estado solicitado');

    // Abort active search controllers
    for (const ctrl of Array.from(activeSearchControllers)) {
      try { ctrl.abort(); } catch (e) { /* ignore */ }
      try { activeSearchControllers.delete(ctrl); } catch (e) { /* ignore */ }
    }

    // Kill FFmpeg processes
    for (const [key, proc] of activeFFmpegProcesses.entries()) {
      try {
        proc.kill && proc.kill('SIGKILL');
      } catch (e) { /* ignore */ }
      activeFFmpegProcesses.delete(key);
      transcodedCache.delete(key);
    }

    // Destroy all torrents (stop networking and free resources)
    for (const t of Array.from(client.torrents)) {
      try {
        console.log('🧹 Destruyendo torrent (reset):', t.infoHash);
        t.destroy();
      } catch (e) {
        console.warn('Error destruyendo torrent', t.infoHash, e && e.message ? e.message : e);
      }
    }

    // Clear maps/caches
    activeTorrents.clear();
    embeddedSubtitlesCache.clear();
    transcodedCache.clear();
    if (global.__pirateflix_search_cache) global.__pirateflix_search_cache.clear();
    mirrorStats.clear();

    console.log('✅ Reset completado');
    res.json({ success: true });
  } catch (err) {
    console.error('Error durante reset:', err);
    res.status(500).json({ error: 'failed to reset state', message: err && err.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor de torrents escuchando en http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

// Limpiar al cerrar
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando servidor...');
  client.destroy(() => {
    console.log('✅ Cliente WebTorrent cerrado');
    process.exit(0);
  });
});

// Manejar errores no capturados
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') {
    console.log('Cliente desconectado (EPIPE) - ignorado');
  } else {
    console.error('Error no capturado:', err);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada no manejada:', reason);
});

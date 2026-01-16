import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import pump from 'pump';
import rangeParser from 'range-parser';
import ffmpeg from 'fluent-ffmpeg';
import { Readable } from 'stream';
import path from 'path';
import https from 'https';
import http from 'http';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import dns from 'dns';

const app = express();
const PORT = 3001;

// =====================
// DNS / IPv4 first (reduce weird long stalls on some hosts)
// =====================
try {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
    console.log('🌐 DNS: ipv4first');
  }
} catch (_) {
  // ignore
}

// =====================
// Circuit-breaker / mirror health tracking
// =====================
const mirrorStats = new Map();
const MIRROR_FAILURE_THRESHOLD = parseInt(
  process.env.PIRATEFLIX_MIRROR_FAILURE_THRESHOLD || '3',
  10
);
const MIRROR_COOLDOWN_MS = parseInt(process.env.PIRATEFLIX_MIRROR_COOLDOWN_MS || '60000', 10); // 60s

// Extended timeout (env alias support for backward/forward compatibility)
const EXTENDED_MIRROR_TIMEOUT_MS = parseInt(
  process.env.PIRATEFLIX_MIRROR_EXTENDED_TIMEOUT_MS ||
    process.env.PIRATEFLIX_EXTENDED_MIRROR_TIMEOUT_MS ||
    '45000',
  10
); // 45s por defecto

// Hedged request / tuning
const FAST_PARALLEL_MIRRORS = parseInt(process.env.PIRATEFLIX_FAST_PARALLEL_MIRRORS || '3', 10); // mirrors to probe first
const MIRROR_RETRY_COUNT = parseInt(process.env.PIRATEFLIX_MIRROR_RETRY_COUNT || '0', 10);
const MIRROR_RETRY_DELAY_MS = parseInt(process.env.PIRATEFLIX_MIRROR_RETRY_DELAY_MS || '500', 10);

// Mirrors usados en varias rutinas (centralizado)
const MIRRORS = [
  'https://thepibay.site',
  'https://tpb.party',
  'https://thepiratebay.org',
  'https://thpibay.xyz',
  'https://thpibay.site',
  'https://thepibay.online',
];

// Warmup tracking
let lastWarmupAt = 0;
const WARMUP_INTERVAL_MS = parseInt(process.env.PIRATEFLIX_WARMUP_INTERVAL_MS || '60000', 10); // 60s

// =====================
// Agentes HTTP/HTTPS globales keep-alive
// =====================
const ALLOW_INSECURE_TLS =
  String(process.env.PIRATEFLIX_ALLOW_WEAK_TLS || 'false').toLowerCase() === 'true';
let httpAgentGlobal = null;
let httpsAgentGlobal = null;

function createAgents() {
  try {
    if (httpAgentGlobal && typeof httpAgentGlobal.destroy === 'function') {
      try {
        httpAgentGlobal.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    if (httpsAgentGlobal && typeof httpsAgentGlobal.destroy === 'function') {
      try {
        httpsAgentGlobal.destroy();
      } catch (e) {
        /* ignore */
      }
    }

    httpAgentGlobal = new http.Agent({ keepAlive: true, maxSockets: 50 });
    httpsAgentGlobal = new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      rejectUnauthorized: !ALLOW_INSECURE_TLS,
    });

    console.log(
      '🔌 Agentes HTTP/HTTPS globales creados (keepAlive) - allowInsecureTLS=',
      ALLOW_INSECURE_TLS
    );
  } catch (err) {
    console.warn('No se pudieron crear agentes globales:', err && err.message ? err.message : err);
  }
}

// Inicializar agentes al inicio
createAgents();

// Track active search AbortControllers so we can abort searches on-demand
const activeSearchControllers = new Set();

// Configurar CORS
app.use(cors());
app.use(express.json());

// =====================
// WebTorrent client RECREABLE (esto es clave para "reset" real)
// =====================
let client = null;

function wireClientEvents(c) {
  // Un solo handler global (NO dentro de /api/torrent/add)
  c.on('error', (err) => {
    console.error('WebTorrent client error:', err && err.message ? err.message : err);
  });
}

function createWebTorrentClient() {
  const c = new WebTorrent();
  wireClientEvents(c);
  return c;
}

client = createWebTorrentClient();

// =====================
// Estado / caches
// =====================
const activeTorrents = new Map();
const embeddedSubtitlesCache = new Map();

const transcodedCache = new Map();
const CACHE_DIR = path.join(os.tmpdir(), 'pirateflix-transcoded');

const activeFFmpegProcesses = new Map();

// --- NUEVO: tracking de streams activos por torrent ---
// Esto evita destruir torrents mientras el navegador todavía hace Range requests,
// que te estaba generando ERR_CONTENT_LENGTH_MISMATCH/404 al cambiar rápido.
const activeStreamsByInfoHash = new Map(); // infoHash -> count
const pendingDestroy = new Set(); // infoHash marcado para destruir cuando streams=0
// Map para llevar las respuestas HTTP activas por torrent: infoHash -> Set(res)
const activeResponsesByInfoHash = new Map();

function incStream(infoHash) {
  activeStreamsByInfoHash.set(infoHash, (activeStreamsByInfoHash.get(infoHash) || 0) + 1);
}

function decStream(infoHash) {
  const n = (activeStreamsByInfoHash.get(infoHash) || 0) - 1;
  if (n <= 0) activeStreamsByInfoHash.delete(infoHash);
  else activeStreamsByInfoHash.set(infoHash, n);
}

function hasFfmpegForInfoHash(infoHash) {
  for (const key of activeFFmpegProcesses.keys()) {
    if (String(key).startsWith(`${infoHash}_`) || String(key).startsWith(infoHash)) return true;
  }
  return false;
}

function canDestroyNow(infoHash) {
  const streams = activeStreamsByInfoHash.get(infoHash) || 0;
  const ff = hasFfmpegForInfoHash(infoHash);
  return streams === 0 && !ff;
}

function clearEmbeddedCacheForInfoHash(infoHash) {
  for (const k of Array.from(embeddedSubtitlesCache.keys())) {
    if (String(k).startsWith(`${infoHash}-`)) embeddedSubtitlesCache.delete(k);
  }
}

function destroyTorrentNow(infoHash) {
  const torrent = client?.get(infoHash);
  if (!torrent) return false;

  try {
    torrent.destroy(() => {
      activeTorrents.delete(infoHash);
      clearEmbeddedCacheForInfoHash(infoHash);
      pendingDestroy.delete(infoHash);
      console.log('Torrent eliminado:', infoHash);
    });
    return true;
  } catch (e) {
    console.warn('Error destruyendo torrent:', infoHash, e && e.message ? e.message : e);
    return false;
  }
}

function attachStreamLifecycle(infoHash, res) {
  incStream(infoHash);
  // Registrar la respuesta activa
  try {
    let s = activeResponsesByInfoHash.get(infoHash);
    if (!s) {
      s = new Set();
      activeResponsesByInfoHash.set(infoHash, s);
    }
    s.add(res);
  } catch (e) {
    /* ignore */
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;

    decStream(infoHash);

    // Quitar la respuesta del tracking
    try {
      const s = activeResponsesByInfoHash.get(infoHash);
      if (s) {
        s.delete(res);
        if (s.size === 0) activeResponsesByInfoHash.delete(infoHash);
      }
    } catch (e) {
      /* ignore */
    }

    // Si estaba pendiente de destruirse y ya no quedan streams/ffmpeg, destruye
    if (pendingDestroy.has(infoHash) && canDestroyNow(infoHash)) {
      destroyTorrentNow(infoHash);
    }
  };

  res.on('close', release);
  res.on('finish', release);
}

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
        try {
          file.select(0, Math.min(minBytes, file.length));
        } catch (e) {
          // ignore
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
        return reject(err);
      }
      setTimeout(check, 150);
    };
    check();
  });
}

// Warmup: hacer peticiones HEAD/GET rápidas a mirrors
async function warmupMirrors(timeoutPer = 3000) {
  try {
    console.log('🔧 Ejecutando warmup de mirrors...');
    const tasks = MIRRORS.map(async (base) => {
      try {
        try {
          const resp = await axios.head(base, {
            timeout: timeoutPer,
            httpAgent: httpAgentGlobal,
            httpsAgent: httpsAgentGlobal,
          });
          console.log(`🔧 Warmup OK: ${base} ${resp && resp.status ? resp.status : 'unknown'}`);
          return;
        } catch (e) {
          // fallback GET
        }

        const resp2 = await axios.get(base, {
          timeout: timeoutPer,
          httpAgent: httpAgentGlobal,
          httpsAgent: httpsAgentGlobal,
        });
        console.log(`🔧 Warmup OK: ${base} ${resp2 && resp2.status ? resp2.status : 'unknown'}`);
      } catch (err) {
        console.warn(`🔧 Warmup fallo: ${base} -> ${err && err.message ? err.message : err}`);
      }
    });

    await Promise.allSettled(tasks);
    lastWarmupAt = Date.now();
    console.log('🔧 Warmup completado');
  } catch (err) {
    console.warn('🔧 Warmup inesperado fallo:', err && err.message ? err.message : err);
  }
}

// =====================
// Endpoint para buscar torrents
// =====================
app.get('/api/search-torrent', async (req, res) => {
  const { query, category = '207' } = req.query; // 207 = HD Movies
  if (!query) return res.status(400).json({ error: 'query es requerido' });

  try {
    let cleanQuery = query
      .replace(/'/g, '')
      .replace(/:/g, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`Buscando torrent: ${query}`);
    if (cleanQuery !== query) console.log(`Query limpio: ${cleanQuery}`);

    const timeoutMs = parseInt(process.env.PIRATEFLIX_SEARCH_TIMEOUT_MS || '30000', 10);
    const httpAgent = httpAgentGlobal;
    const httpsAgentShared = httpsAgentGlobal;
    const mirrors = MIRRORS.slice();

    const searchStart = Date.now();
    console.log(`Intentando mirrors: ${mirrors.join(', ')}`);
    console.log(`Busqueda iniciada: ${new Date(searchStart).toISOString()}`);

    try {
      const handles =
        typeof process._getActiveHandles === 'function'
          ? process._getActiveHandles().length
          : 'unknown';
      const requests =
        typeof process._getActiveRequests === 'function'
          ? process._getActiveRequests().length
          : 'unknown';
      console.log(
        `Diagnostics: torrents=${client.torrents.length}, activeFFmpeg=${activeFFmpegProcesses.size}, transcodedCache=${transcodedCache.size}, handles=${handles}, requests=${requests}`
      );
    } catch (e) {
      console.warn('No se pudieron obtener diagnostics internos:', e.message);
    }

    async function fetchSearchHtml(cleanQuery, category) {
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9',
        Referer: 'https://www.google.com/',
      };

      const cacheKey = `${cleanQuery}::${category}`;
      const cacheTtl = parseInt(process.env.PIRATEFLIX_SEARCH_CACHE_MS || '30000', 10);
      if (!global.__pirateflix_search_cache) global.__pirateflix_search_cache = new Map();
      const searchCache = global.__pirateflix_search_cache;
      const cached = searchCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < cacheTtl) {
        console.log('✅ Sirviendo búsqueda desde cache:', cacheKey);
        return cached.html;
      }

      const tryYtsFallback = async (q) => {
        if (String(process.env.PIRATEFLIX_USE_EXTERNAL_API || 'true').toLowerCase() !== 'true')
          return null;
        try {
          const apiUrl = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(
            q
          )}&limit=5`;
          const ytsTimeout = parseInt(process.env.PIRATEFLIX_YTS_TIMEOUT_MS || '7000', 10);
          console.log(
            'Intentando fallback externo rápido (YTS):',
            apiUrl,
            `(timeout ${ytsTimeout}ms)`
          );
          const resp = await axios.get(apiUrl, {
            timeout: ytsTimeout,
            responseType: 'json',
            httpsAgent: httpsAgentShared,
            httpAgent,
          });
          const movies = resp?.data?.data?.movies;
          if (!movies || movies.length === 0) return null;

          const magnets = [];
          for (const m of movies) {
            if (!m.torrents) continue;
            for (const t of m.torrents) {
              if (!t.hash) continue;
              const dn = encodeURIComponent(`${m.title} ${m.year} ${t.quality}`);
              magnets.push(`magnet:?xt=urn:btih:${t.hash}&dn=${dn}`);
            }
          }

          if (magnets.length === 0) return null;
          return magnets.map((m) => `<a href="${m}">download</a>`).join('\n');
        } catch (err) {
          console.warn('Fallback YTS falló:', err && err.message ? err.message : err);
          return null;
        }
      };

      const perMirrorTimeout = parseInt(process.env.PIRATEFLIX_MIRROR_TIMEOUT_MS || '20000', 10);
      const controllers = [];

      try {
        if (Date.now() - lastWarmupAt > WARMUP_INTERVAL_MS) {
          console.log(
            '🔧 Warmup previo detectado como antiguo. Ejecutando warmup corto antes de buscar...'
          );
          await warmupMirrors(3000);
        }
      } catch (e) {
        console.warn('Warmup corto falló antes de buscar:', e && e.message ? e.message : e);
      }

      const healthyMirrors = mirrors.filter((base) => {
        const s = mirrorStats.get(base);
        if (!s) return true;
        if (s.openUntil && s.openUntil > Date.now()) return false;
        return true;
      });

      const prioritized = (healthyMirrors.length > 0 ? healthyMirrors : mirrors).slice();
      prioritized.sort((a, b) => {
        const sa = mirrorStats.get(a) || {};
        const sb = mirrorStats.get(b) || {};
        const ta = sa.lastSuccess || 0;
        const tb = sb.lastSuccess || 0;
        if (ta !== tb) return tb - ta;
        const fa = sa.fails || 0;
        const fb = sb.fails || 0;
        return fa - fb;
      });

      if (healthyMirrors.length === 0)
        console.log(
          '⚠️ Todos los mirrors en cooldown; se utilizarán todos los mirrors temporalmente'
        );

      const makeRequestFor = (base, timeoutMs, signalController) => {
        const url = `${base}/search/${encodeURIComponent(cleanQuery)}/1/99/${category}`;
        const controller = signalController || new AbortController();
        controllers.push({ controller, base, url });
        activeSearchControllers.add(controller);

        console.log(`Lanzando petición a: ${url} (timeout ${timeoutMs}ms)`);

        return axios
          .get(url, {
            headers,
            timeout: timeoutMs,
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: (s) => s >= 200 && s < 400,
            httpsAgent: httpsAgentShared,
            httpAgent,
            signal: controller.signal,
          })
          .then((resp) => {
            if (resp && resp.data && resp.data.length > 0) {
              console.log(`HTML recibido desde ${base}: ${resp.data.length} bytes`);
              mirrorStats.set(base, { fails: 0, lastSuccess: Date.now(), openUntil: null });
              try {
                activeSearchControllers.delete(controller);
              } catch (e) {
                /* ignore */
              }
              return { base, html: resp.data };
            }
            throw new Error(`Empty response from ${base}`);
          })
          .catch((err) => {
            const msg = err && err.message ? String(err.message).toLowerCase() : '';
            if (
              msg.includes('certificate key too weak') ||
              (msg.includes('certificate') && msg.includes('weak'))
            ) {
              console.warn(`Advertencia: certificado débil en mirror ${base}`);
            }

            const prev = mirrorStats.get(base) || { fails: 0 };
            prev.fails = (prev.fails || 0) + 1;
            prev.lastFail = Date.now();
            if (prev.fails >= MIRROR_FAILURE_THRESHOLD) {
              prev.openUntil = Date.now() + MIRROR_COOLDOWN_MS;
              console.warn(
                `⛔ Mirror ${base} abierto por circuit-breaker hasta ${new Date(
                  prev.openUntil
                ).toISOString()} (fails=${prev.fails})`
              );
            }
            mirrorStats.set(base, prev);

            try {
              activeSearchControllers.delete(controller);
            } catch (e) {
              /* ignore */
            }
            throw err;
          });
      };

      let result = null;
      try {
        const topN = Math.max(1, Math.min(prioritized.length, FAST_PARALLEL_MIRRORS));
        const topList = prioritized.slice(0, topN);
        try {
          console.log(`Stage1: probando top ${topList.length} mirrors en paralelo`);
          const requests = topList.map((m) => makeRequestFor(m, perMirrorTimeout));
          const winner = await Promise.any(requests);
          result = winner.html;
        } catch (stage1Err) {
          console.warn(
            'Stage1 falló:',
            stage1Err && stage1Err.errors
              ? stage1Err.errors.map((e) => e && e.message).join(' | ')
              : (stage1Err && stage1Err.message) || stage1Err
          );

          for (const { controller } of controllers) {
            try {
              controller.abort();
            } catch (e) {
              /* ignore */
            }
            try {
              activeSearchControllers.delete(controller);
            } catch (e) {
              /* ignore */
            }
          }

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
            console.warn(
              'Stage2 falló:',
              stage2Err && stage2Err.errors
                ? stage2Err.errors.map((e) => e && e.message).join(' | ')
                : (stage2Err && stage2Err.message) || stage2Err
            );

            for (const { controller } of controllersStage2) {
              try {
                controller.abort();
              } catch (e) {
                /* ignore */
              }
              try {
                activeSearchControllers.delete(controller);
              } catch (e) {
                /* ignore */
              }
            }

            try {
              const ytsHtml = await tryYtsFallback(cleanQuery);
              if (ytsHtml) {
                console.log('✅ Fallback externo (YTS) exitoso — usando resultados rápidos');
                result = ytsHtml;
              }
            } catch (e) {
              console.warn('Error en fallback externo rápido:', e && e.message ? e.message : e);
            }

            if (!result) console.log('Intentando reintentos secuenciales con timeout extendido...');
            for (const base of mirrors) {
              const url = `${base}/search/${encodeURIComponent(cleanQuery)}/1/99/${category}`;
              console.log(
                `Intentando secuencial a: ${url} (timeout ${EXTENDED_MIRROR_TIMEOUT_MS}ms)`
              );
              try {
                const resp = await axios.get(url, {
                  headers,
                  timeout: EXTENDED_MIRROR_TIMEOUT_MS,
                  maxRedirects: 5,
                  responseType: 'text',
                  validateStatus: (s) => s >= 200 && s < 400,
                  httpsAgent: httpsAgentShared,
                  httpAgent,
                });

                if (resp && resp.data && resp.data.length > 0) {
                  console.log(
                    `HTML recibido (secuencial) desde ${base}: ${resp.data.length} bytes`
                  );
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
                  console.warn(
                    `⛔ Mirror ${base} abierto por circuit-breaker hasta ${new Date(
                      prev.openUntil
                    ).toISOString()} (fails=${prev.fails})`
                  );
                }
                mirrorStats.set(base, prev);
                console.warn(
                  `Secuencial falló para ${base}:`,
                  err && err.message ? err.message : err
                );
              }

              await new Promise((r) => setTimeout(r, 500));
            }
          }
        }
      } finally {
        for (const { controller } of controllers) {
          try {
            controller.abort();
          } catch (e) {
            /* ignore */
          }
          try {
            activeSearchControllers.delete(controller);
          } catch (e) {
            /* ignore */
          }
        }
      }

      if (!result) throw new Error('All mirrors failed');

      searchCache.set(cacheKey, { html: result, ts: Date.now() });
      return result;
    }

    let html = null;
    try {
      html = await fetchSearchHtml(cleanQuery, category);
      console.log(`Busqueda finalizada en ${Date.now() - searchStart} ms`);
    } catch (initialErr) {
      console.warn('Búsqueda inicial falló, intentando fallbacks de query:', initialErr.message);

      const fallbacks = [];
      const withoutRes = cleanQuery
        .replace(
          /\b(1080p|720p|2160p|4k|4k?p|bdrip|bluray|brip|brrip|webrip|web-dl|dvdrip|hdrip)\b/gi,
          ''
        )
        .replace(/\s+/g, ' ')
        .trim();
      if (withoutRes && withoutRes !== cleanQuery) fallbacks.push(withoutRes);

      const withoutYear = cleanQuery
        .replace(/\b(19|20)\d{2}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (withoutYear && withoutYear !== cleanQuery && !fallbacks.includes(withoutYear))
        fallbacks.push(withoutYear);

      const noResNoYear = withoutRes
        .replace(/\b(19|20)\d{2}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (noResNoYear && !fallbacks.includes(noResNoYear) && noResNoYear !== cleanQuery)
        fallbacks.push(noResNoYear);

      for (const fq of fallbacks) {
        try {
          console.log(`Intentando fallback: '${fq}'`);
          html = await fetchSearchHtml(fq, category);
          console.log(`Fallback exitoso con query: '${fq}'`);
          break;
        } catch (fbErr) {
          console.warn(
            `Fallback falló para '${fq}':`,
            fbErr && fbErr.message ? fbErr.message : fbErr
          );
        }
      }

      if (!html) throw initialErr;
      console.log(`Busqueda (fallback) finalizada en ${Date.now() - searchStart} ms`);
    }

    const torrents = [];
    const magnetRegex = /<a href="(magnet:\?xt=urn:btih:[^"]+)"/g;
    const magnets = [];
    let magnetMatch;

    while ((magnetMatch = magnetRegex.exec(html)) !== null) {
      magnets.push(magnetMatch[1]);
    }

    console.log(`Magnet links encontrados: ${magnets.length}`);

    for (const magnetLink of magnets) {
      if (torrents.length >= 10) break;

      const nameMatch = magnetLink.match(/&dn=([^&]+)/);
      const name = nameMatch ? decodeURIComponent(nameMatch[1].replace(/\+/g, ' ')) : 'Unknown';

      const escapedMagnet = magnetLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const infoRegex = new RegExp(
        escapedMagnet +
          '[\\s\\S]{0,500}?<td align="right">(\\d+)<\\/td>\\s*<td align="right">(\\d+)<\\/td>',
        'i'
      );
      const infoMatch = html.match(infoRegex);

      let seeders = 0;
      let leechers = 0;

      if (infoMatch) {
        seeders = parseInt(infoMatch[1]);
        leechers = parseInt(infoMatch[2]);
      }

      const sizeRegex = new RegExp(escapedMagnet + '[\\s\\S]{0,300}?Size ([^,<]+)', 'i');
      const sizeMatch = html.match(sizeRegex);
      const size = sizeMatch ? sizeMatch[1].trim() : 'Unknown';

      torrents.push({
        name,
        magnetLink,
        size,
        seeders,
        leechers,
        score: seeders * 2 + leechers,
      });
    }

    torrents.sort((a, b) => b.score - a.score);

    console.log(`Torrents parseados: ${torrents.length}`);
    if (torrents.length > 0) {
      console.log(
        `Mejor resultado: ${torrents[0].name} (${torrents[0].seeders}S/${torrents[0].leechers}L)`
      );
    } else {
      console.log('No se pudieron parsear torrents del HTML');
    }

    res.json({ query, results: torrents, count: torrents.length });
  } catch (error) {
    console.error('Error al buscar torrent:', error && error.message ? error.message : error);

    const msg = error && error.message ? String(error.message).toLowerCase() : '';
    if (
      msg.includes('timeout') ||
      error?.code === 'ECONNABORTED' ||
      msg.includes('all mirrors failed') ||
      msg.includes('empty response') ||
      msg.includes('certificate key too weak') ||
      (msg.includes('certificate') && msg.includes('weak')) ||
      msg.includes('request failed with status code 5') ||
      (error && error.response && error.response.status >= 500 && error.response.status < 600)
    ) {
      return res
        .status(504)
        .json({
          error: 'Timeout en búsqueda',
          message: 'La búsqueda tardó demasiado o los mirrors no respondieron',
        });
    }

    res
      .status(500)
      .json({
        error: 'Error al buscar torrent',
        message: (error && error.message) || String(error),
      });
  }
});

// =====================
// Endpoint para agregar un torrent
// =====================
app.post('/api/torrent/add', (req, res) => {
  const { magnetUri } = req.body;
  if (!magnetUri) return res.status(400).json({ error: 'magnetUri es requerido' });

  console.log('Agregando torrent:', magnetUri);

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

  client.add(magnetUri, (torrent) => {
    console.log('Torrent agregado:', torrent.name);
    console.log('InfoHash:', torrent.infoHash);
    console.log('Archivos:', torrent.files.length);

    activeTorrents.set(torrent.infoHash, torrent);

    torrent.files.forEach((file) => file.select());

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
});

// Función helper para determinar el tipo de archivo
function getFileType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (['mp4', 'mkv', 'avi', 'webm', 'mov', 'flv', 'wmv'].includes(ext)) return 'video';
  if (['srt', 'vtt', 'sub', 'ass', 'ssa', 'sbv'].includes(ext)) return 'subtitle';
  return 'other';
}

// Endpoint para obtener información de un torrent
app.get('/api/torrent/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  const torrent = client.get(infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent no encontrado' });

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

// Endpoint para detectar subtítulos embebidos
app.get('/api/embedded-subtitles/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const cacheKey = `${infoHash}-${fileIndex}`;

  if (embeddedSubtitlesCache.has(cacheKey)) return res.json(embeddedSubtitlesCache.get(cacheKey));

  const torrent = client.get(infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent no encontrado' });

  const file = torrent.files[parseInt(fileIndex)];
  if (!file) return res.status(404).json({ error: 'Archivo no encontrado' });

  try {
    const filePath = path.join(torrent.path, file.path);
    console.log('Analizando subtítulos embebidos en:', filePath);

    try {
      await waitForFileOnDisk(file, filePath, Math.min(10 * 1024 * 1024, file.length), 20000);
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló:', err.message);
    }

    const subtitles = await new Promise((resolve) => {
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

    embeddedSubtitlesCache.set(cacheKey, subtitles);
    res.json(subtitles);
  } catch (error) {
    console.error('Error al detectar subtítulos embebidos:', error);
    res.json([]);
  }
});

// =====================
// Streaming
// =====================
app.get('/api/stream/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const torrent = client.get(infoHash);
  if (!torrent) return res.status(404).send('Torrent no encontrado');

  const file = torrent.files[parseInt(fileIndex)];
  if (!file) return res.status(404).send('Archivo no encontrado');

  // NUEVO: contabilizar stream activo de este torrent
  attachStreamLifecycle(infoHash, res);

  const filePath = path.join(torrent.path, file.path);
  const fileName = file.name.toLowerCase();

  const needsTranscode =
    fileName.endsWith('.mkv') ||
    fileName.includes('hevc') ||
    fileName.includes('x265') ||
    fileName.includes('h265');

  console.log(
    'Streaming archivo:',
    file.name,
    needsTranscode ? '(TRANSCODIFICANDO automáticamente)' : ''
  );

  if (needsTranscode) {
    const cacheKey = `${infoHash}_${fileIndex}`;
    const cachedPath = path.join(CACHE_DIR, `${cacheKey}.mp4`);

    if (activeFFmpegProcesses.has(cacheKey)) {
      const oldProcess = activeFFmpegProcesses.get(cacheKey);
      console.log('🧹 Deteniendo transcodificación anterior:', cacheKey);
      try {
        oldProcess.kill('SIGKILL');
      } catch (_) {}
      activeFFmpegProcesses.delete(cacheKey);
    }

    if (transcodedCache.get(cacheKey) === 'ready' && fs.existsSync(cachedPath)) {
      console.log('✅ Sirviendo desde cache:', file.name);
      return serveVideoFile(cachedPath, req, res);
    }

    console.log('🎬 Transcodificación en tiempo real:', file.name);

    try {
      await waitForFileOnDisk(file, filePath, Math.min(64 * 1024, file.length), 15000);
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló antes de ffprobe:', err.message);
    }

    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error('❌ Error al obtener metadata:', err.message);
        return res.status(500).send('Error al analizar video');
      }

      const duration = metadata.format.duration;
      console.log(`📹 Duración: ${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`);

      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
      });

      transcodedCache.set(cacheKey, 'transcoding');

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
          '-max_muxing_queue_size 1024',
        ])
        .on('start', () => {
          console.log('🔄 FFmpeg transcodificando en vivo');
        })
        .on('progress', (progress) => {
          if (progress.percent && Math.floor(progress.percent) % 10 === 0) {
            const rounded = Math.floor(progress.percent);
            if (!ffmpegCommand._lastProgressLog || ffmpegCommand._lastProgressLog !== rounded) {
              console.log(`⏳ Progreso: ${rounded}%`);
              ffmpegCommand._lastProgressLog = rounded;
            }
          }
        })
        .on('error', (err) => {
          if (!String(err.message || '').includes('SIGKILL')) {
            console.error('❌ Error FFmpeg:', err.message);
          }
          transcodedCache.delete(cacheKey);
          activeFFmpegProcesses.delete(cacheKey);
          if (!res.headersSent) res.status(500).send('Error de transcodificación');
        })
        .on('end', () => {
          console.log('✅ Transcodificación completada');
          activeFFmpegProcesses.delete(cacheKey);
        });

      activeFFmpegProcesses.set(cacheKey, ffmpegCommand);

      ffmpegCommand.pipe(res, { end: true });

      // Si el cliente se desconecta, matar ffmpeg y limpiar.
      // (attachStreamLifecycle ya decrementarará streams y podrá destruir torrent si estaba pendiente)
      res.on('close', () => {
        console.log('🛑 Cliente desconectado, deteniendo transcodificación');
        try {
          ffmpegCommand.kill('SIGKILL');
        } catch (_) {}
        transcodedCache.delete(cacheKey);
        activeFFmpegProcesses.delete(cacheKey);
      });
    });

    return;
  }

  // Streaming normal compatible: PASAMOS el file de WebTorrent para que sirva con createReadStream
  serveVideoFile(filePath, req, res, file);
});

// Función auxiliar para servir archivos de video con soporte de Range
function serveVideoFile(filePath, req, res, webTorrentFile = null) {
  // Si es archivo del sistema (transcodificado)
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
        'Accept-Ranges': 'bytes',
      });

      const fileStream = fs.createReadStream(filePath);
      pump(fileStream, res);
    }
    return;
  }

  // Si es archivo de WebTorrent
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
      'Accept-Ranges': 'bytes',
    });

    const stream = webTorrentFile.createReadStream();
    pump(stream, res);
  }
}

// Endpoint para extraer subtítulos embebidos
app.get('/api/embedded-subtitle/:infoHash/:fileIndex/:streamIndex', async (req, res) => {
  const { infoHash, fileIndex, streamIndex } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) return res.status(404).send('Torrent no encontrado');

  const file = torrent.files[parseInt(fileIndex)];
  if (!file) return res.status(404).send('Archivo no encontrado');

  try {
    console.log(`Extrayendo subtítulo stream ${streamIndex} de:`, file.name);

    const filePath = path.join(torrent.path, file.path);

    let clientDisconnected = false;
    let ffmpegCommand = null;

    res.on('close', () => {
      clientDisconnected = true;
      console.log('Cliente desconectado durante extracción de subtítulo');
      try {
        if (ffmpegCommand) ffmpegCommand.kill('SIGKILL');
      } catch (_) {}
    });

    try {
      await waitForFileOnDisk(file, filePath, Math.min(64 * 1024, file.length), 15000);
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló antes de extraer subtítulo:', err.message);
    }

    res.writeHead(200, {
      'Content-Type': 'text/vtt',
      'Access-Control-Allow-Origin': '*',
    });

    ffmpegCommand = ffmpeg(filePath)
      .outputOptions([`-map 0:${streamIndex}`, '-f webvtt'])
      .on('error', (err) => {
        if (!clientDisconnected && err.code !== 'EPIPE') {
          console.error('Error extrayendo subtítulo:', err.message);
          if (!res.headersSent) res.status(500).send('Error al extraer subtítulo');
        }
      })
      .on('end', () => {
        if (!clientDisconnected) console.log('Subtítulo extraído exitosamente');
      });

    ffmpegCommand.pipe(res, { end: true });
  } catch (error) {
    console.error('Error al extraer subtítulo embebido:', error.message);
    if (!res.headersSent) res.status(500).send('Error al procesar subtítulo');
  }
});

// Endpoint para obtener subtítulos
app.get('/api/subtitle/:infoHash/:fileIndex', (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) return res.status(404).send('Torrent no encontrado');

  const file = torrent.files[parseInt(fileIndex)];
  if (!file) return res.status(404).send('Archivo no encontrado');

  console.log('Sirviendo subtítulo:', file.name);

  const ext = file.name.toLowerCase().split('.').pop();

  res.writeHead(200, {
    'Content-Type': 'text/vtt',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=31536000',
  });

  const stream = file.createReadStream();

  if (ext === 'srt') {
    let srtData = '';
    stream.on('data', (chunk) => {
      srtData += chunk.toString('utf-8');
    });
    stream.on('end', () => {
      try {
        const vttData = convertSrtToVtt(srtData);
        res.end(vttData);
      } catch (error) {
        console.error('Error al convertir SRT a VTT:', error);
        res.status(500).send('Error al convertir subtítulo');
      }
    });
    stream.on('error', (err) => {
      console.error('Error al leer subtítulo:', err);
      if (!res.headersSent) res.status(500).send('Error al leer subtítulo');
    });
  } else {
    pump(stream, res);
  }
});

function convertSrtToVtt(srtContent) {
  let vtt = 'WEBVTT\n\n';
  vtt += srtContent.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return vtt;
}

// =====================
// Endpoint para eliminar un torrent (DEFERRED si hay streams activos)
// =====================
app.delete('/api/torrent/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) return res.status(404).json({ error: 'Torrent no encontrado' });

  // Marcar para destruir (aunque no se pueda ahora)
  pendingDestroy.add(infoHash);

  // Matar FFmpeg si existe (si hay transcode activo, igual prefieres dejarlo terminar;
  // pero para cambio de peli es mejor cortarlo)
  for (const [cacheKey, ffmpegProcess] of activeFFmpegProcesses.entries()) {
    if (String(cacheKey).startsWith(infoHash)) {
      console.log('🧹 Deteniendo FFmpeg para torrent:', cacheKey);
      try {
        ffmpegProcess.kill('SIGKILL');
      } catch (_) {}
      activeFFmpegProcesses.delete(cacheKey);
      transcodedCache.delete(cacheKey);
    }
  }

  // Si no hay streams ni ffmpeg, destruye ya
  if (canDestroyNow(infoHash)) {
    destroyTorrentNow(infoHash);
    return res.json({ success: true, destroyed: true });
  }

  // Si hay streams activos, responde OK pero el destroy será cuando acaben
  const streams = activeStreamsByInfoHash.get(infoHash) || 0;
  return res.json({ success: true, destroyed: false, pending: true, activeStreams: streams });
});

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    torrents: client?.torrents?.length ?? 0,
    uploadSpeed: client?.uploadSpeed ?? 0,
    downloadSpeed: client?.downloadSpeed ?? 0,
    activeStreamsTracked: activeStreamsByInfoHash.size,
    pendingDestroy: pendingDestroy.size,
  });
});

// Mirror stats
app.get('/api/mirror-stats', (req, res) => {
  try {
    const arr = Array.from(mirrorStats.entries()).map(([base, s]) => ({
      base,
      fails: s.fails || 0,
      lastFail: s.lastFail ? new Date(s.lastFail).toISOString() : null,
      lastSuccess: s.lastSuccess ? new Date(s.lastSuccess).toISOString() : null,
      openUntil: s.openUntil ? new Date(s.openUntil).toISOString() : null,
    }));

    const cacheInfo = {
      searchCacheSize: global.__pirateflix_search_cache ? global.__pirateflix_search_cache.size : 0,
      transcodedCacheSize: transcodedCache.size,
    };

    res.json({ mirrors: arr, cache: cacheInfo });
  } catch (err) {
    console.error('Error obteniendo mirror-stats:', err);
    res.status(500).json({ error: 'failed to get mirror stats' });
  }
});

// =====================
// Quick-switch: Endpoint LIGERO para cambiar de película rápido
// Solo mata FFmpeg y streams activos, NO destruye el cliente WebTorrent
// =====================
app.post('/api/quick-switch', async (req, res) => {
  const startTime = Date.now();
  console.log('⚡ Quick-switch solicitado');

  try {
    // 1. Abortar búsquedas activas inmediatamente
    for (const ctrl of Array.from(activeSearchControllers)) {
      try { ctrl.abort(); } catch (_) {}
      activeSearchControllers.delete(ctrl);
    }

    // 2. Matar todos los procesos FFmpeg
    for (const [key, proc] of activeFFmpegProcesses.entries()) {
      try { proc.kill && proc.kill('SIGKILL'); } catch (_) {}
      activeFFmpegProcesses.delete(key);
      transcodedCache.delete(key);
    }

    // 3. Cerrar streams HTTP activos (sin esperar)
    for (const [infoHash, resSet] of Array.from(activeResponsesByInfoHash.entries())) {
      for (const r of Array.from(resSet)) {
        try { r.destroy && r.destroy(); } catch (_) {}
      }
    }
    activeResponsesByInfoHash.clear();
    activeStreamsByInfoHash.clear();

    // 4. Destruir torrents activos en background (no esperar)
    const torrentsToDestroy = client?.torrents?.slice() || [];
    for (const t of torrentsToDestroy) {
      try {
        const ih = t.infoHash;
        activeTorrents.delete(ih);
        clearEmbeddedCacheForInfoHash(ih);
        t.destroy(() => {});
      } catch (_) {}
    }

    // 5. Limpiar caches de subtítulos
    embeddedSubtitlesCache.clear();
    pendingDestroy.clear();

    console.log(`⚡ Quick-switch completado en ${Date.now() - startTime}ms`);
    res.json({ success: true, time: Date.now() - startTime });
  } catch (err) {
    console.error('Error en quick-switch:', err);
    res.json({ success: true, time: Date.now() - startTime }); // No fallar, seguir
  }
});

// =====================
// Reset-state COMPLETO: Solo usar si quick-switch no funciona
// =====================
app.post('/api/reset-state', async (req, res) => {
  const startTime = Date.now();
  console.log('🔁 Reset completo solicitado');

  try {
    // 1. Abortar búsquedas
    for (const ctrl of Array.from(activeSearchControllers)) {
      try { ctrl.abort(); } catch (_) {}
      activeSearchControllers.delete(ctrl);
    }

    // 2. Matar FFmpeg
    for (const [key, proc] of activeFFmpegProcesses.entries()) {
      try { proc.kill && proc.kill('SIGKILL'); } catch (_) {}
      activeFFmpegProcesses.delete(key);
      transcodedCache.delete(key);
    }

    // 3. Cerrar streams
    for (const [, resSet] of Array.from(activeResponsesByInfoHash.entries())) {
      for (const r of Array.from(resSet)) {
        try { r.destroy && r.destroy(); } catch (_) {}
      }
    }
    activeResponsesByInfoHash.clear();
    activeStreamsByInfoHash.clear();
    pendingDestroy.clear();

    // 4. Destruir cliente WebTorrent y recrearlo
    if (client) {
      try {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 2000); // Max 2s
          client.destroy(() => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch (_) {}
    }

    client = createWebTorrentClient();

    // 5. Limpiar caches
    activeTorrents.clear();
    embeddedSubtitlesCache.clear();
    transcodedCache.clear();

    console.log(`✅ Reset completo en ${Date.now() - startTime}ms`);
    res.json({ success: true, time: Date.now() - startTime });
  } catch (err) {
    console.error('Error en reset:', err);
    // Recrear cliente de todas formas
    try { client = createWebTorrentClient(); } catch (_) {}
    res.json({ success: true, time: Date.now() - startTime });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor de torrents escuchando en http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);

  (async () => {
    try {
      await warmupMirrors(3000);
    } catch (err) {
      console.warn('🔧 Warmup inesperado fallo:', err && err.message ? err.message : err);
    }
  })();
});

// Limpiar al cerrar
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando servidor...');
  const c = client;
  if (!c) return process.exit(0);

  c.destroy(() => {
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

process.on('unhandledRejection', (reason) => {
  console.error('Promesa rechazada no manejada:', reason);
});

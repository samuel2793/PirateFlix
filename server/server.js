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
    const timeoutMs = 10000;
    const mirrors = [
      'https://thepibay.site',
      'https://tpb.party',
      'https://thepiratebay.org',
    ];

    console.log(`Intentando mirrors: ${mirrors.join(', ')}`);

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

      let lastError = null;

      for (const base of mirrors) {
        const url = `${base}/search/${encodeURIComponent(cleanQuery)}/1/99/${category}`;
        console.log(`Probando mirror: ${url}`);
        try {
          // Create a fresh agent per request to avoid socket pool exhaustion
          const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 10 });
          const resp = await axios.get(url, {
            headers,
            timeout: timeoutMs,
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: (s) => s >= 200 && s < 400,
            httpsAgent,
          });

          if (resp && resp.data && resp.data.length > 0) {
            console.log(`HTML recibido desde ${base}: ${resp.data.length} bytes`);
            return resp.data;
          }
          lastError = new Error(`Empty response from ${base}`);
          console.warn(lastError.message);
        } catch (err) {
          lastError = err;
          console.warn(`Error al solicitar ${base}: ${err.message}`);
          // pequeño backoff entre mirrors para evitar bloqueos por rate limiting
          await new Promise(r => setTimeout(r, 250));
          // Intentar siguiente mirror
        }
      }

      // Si todos fallaron, lanzar el último error
      throw lastError || new Error('All mirrors failed');
    }

    const html = await fetchSearchHtml(cleanQuery, category);

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

    const msg = (error && error.message) ? error.message.toLowerCase() : '';
    // Axios yields 'timeout of XXXXms exceeded' or code 'ECONNABORTED' on timeout
    if (msg.includes('timeout') || error?.code === 'ECONNABORTED' || msg.includes('all mirrors failed') || msg.includes('empty response')) {
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

    // Esperar a que el archivo tenga al menos algunos bytes descargados
    // Esto es necesario para que ffprobe pueda leerlo
    const waitForFile = () => new Promise((resolve) => {
      const checkSize = () => {
        // Priorizar la descarga del inicio del archivo
        file.select(0, Math.min(10 * 1024 * 1024, file.length));

        if (file.downloaded > 0) {
          resolve();
        } else {
          setTimeout(checkSize, 100);
        }
      };
      checkSize();
    });

    await waitForFile();

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
app.get('/api/stream/:infoHash/:fileIndex', (req, res) => {
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

    // Esperar a que el archivo tenga datos disponibles
    const waitForFile = () => new Promise((resolve) => {
      const checkSize = () => {
        file.select(); // Seleccionar todo el archivo para descarga

        if (file.downloaded > 0) {
          resolve();
        } else {
          setTimeout(checkSize, 100);
        }
      };
      checkSize();
    });

    await waitForFile();

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

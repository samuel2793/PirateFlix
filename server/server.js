import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import pump from 'pump';
import rangeParser from 'range-parser';
import ffmpeg from 'fluent-ffmpeg';
import { Readable } from 'stream';
import path from 'path';

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

  console.log('Streaming archivo:', file.name);

  // Obtener el rango solicitado
  const range = req.headers.range;
  const fileSize = file.length;

  if (range) {
    const parts = rangeParser(fileSize, range);

    if (parts === -1) {
      // Rango inválido
      res.status(416).send('Rango solicitado no satisfactorio');
      return;
    }

    if (parts === -2 || parts.type !== 'bytes' || parts.length === 0) {
      // Rango no parseable o inválido
      res.status(416).send('Rango solicitado no satisfactorio');
      return;
    }

    const [{ start, end }] = parts;
    const chunkSize = end - start + 1;

    // Headers para streaming con rango
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });

    // Crear stream del archivo con rango
    const stream = file.createReadStream({ start, end });
    pump(stream, res);
  } else {
    // Sin rango, enviar todo el archivo
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    });

    const stream = file.createReadStream();
    pump(stream, res);
  }
});

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

  torrent.destroy(() => {
    activeTorrents.delete(infoHash);
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

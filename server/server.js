import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import pump from 'pump';
import rangeParser from 'range-parser';

const app = express();
const PORT = 3001;

// Configurar CORS
app.use(cors());
app.use(express.json());

// Cliente WebTorrent (versión Node.js - soporta todos los trackers)
const client = new WebTorrent();

// Almacenar torrents activos
const activeTorrents = new Map();

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
    })),
  });
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

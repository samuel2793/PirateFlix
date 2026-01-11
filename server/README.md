# Servidor de Torrents - PirateFlix

Backend de Node.js que usa WebTorrent para descargar y streamear archivos torrent al navegador.

## Instalación

```bash
cd server
npm install
```

## Uso

### Iniciar el servidor

```bash
npm start
```

O en modo desarrollo con auto-reload:

```bash
npm run dev
```

El servidor escuchará en `http://localhost:3001`

## Endpoints

### POST /api/torrent/add
Agrega un torrent mediante magnet link.

**Body:**
```json
{
  "magnetUri": "magnet:?xt=urn:btih:..."
}
```

**Response:**
```json
{
  "infoHash": "...",
  "name": "Nombre del torrent",
  "files": [
    {
      "index": 0,
      "name": "video.mp4",
      "length": 123456789
    }
  ]
}
```

### GET /api/torrent/:infoHash
Obtiene información sobre un torrent activo.

### GET /api/stream/:infoHash/:fileIndex
Streamea un archivo específico del torrent. Soporta HTTP Range requests para seeking.

### DELETE /api/torrent/:infoHash
Elimina un torrent del cliente.

### GET /health
Health check del servidor.

## Notas

- El servidor usa WebTorrent versión Node.js que soporta todos los trackers (HTTP, UDP, WebSocket).
- Los archivos se descargan bajo demanda según se soliciten.
- Soporta HTTP Range requests para permitir seeking en videos.
- Los torrents permanecen activos hasta que se eliminen explícitamente o se cierre el servidor.

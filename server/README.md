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

### GET /api/opensubtitles/search
Busca subtítulos en OpenSubtitles (requiere `OPEN_SUBTITLES_API_KEY`).

**Query params:**
`query`, `tmdbId`, `type`, `season`, `episode`, `languages`

### GET /api/opensubtitles/subtitle/:fileId
Descarga y convierte el subtítulo de OpenSubtitles a VTT.

### DELETE /api/torrent/:infoHash
Elimina un torrent del cliente.

### GET /health
Health check del servidor.

## Notas

- El servidor usa WebTorrent versión Node.js que soporta todos los trackers (HTTP, UDP, WebSocket).
- Los archivos se descargan bajo demanda según se soliciten.
- Soporta HTTP Range requests para permitir seeking en videos.
- Los torrents permanecen activos hasta que se eliminen explícitamente o se cierre el servidor.

## OpenSubtitles

Configura estas variables de entorno para habilitar la descarga de subtítulos:

- `OPEN_SUBTITLES_API_KEY` (obligatoria)
- `OPEN_SUBTITLES_USER_AGENT` (opcional, por defecto `PirateFlix`)
- `OPEN_SUBTITLES_USERNAME` / `OPEN_SUBTITLES_PASSWORD` (opcional, para token de descarga)

También puedes definir `openSubtitles` en `src/app/core/config/app-config.ts`; el servidor lo usa
como fallback si no hay variables de entorno.

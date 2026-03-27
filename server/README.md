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

### GET /api/storage/stats
Muestra uso de disco, política activa (cuota/retención) y último prune.

### POST /api/storage/prune
Lanza limpieza manual de almacenamiento.

### GET /health
Health check del servidor.

## Notas

- El servidor usa WebTorrent versión Node.js que soporta todos los trackers (HTTP, UDP, WebSocket).
- Los archivos se descargan bajo demanda según se soliciten.
- Soporta HTTP Range requests para permitir seeking en videos.
- Los torrents permanecen activos hasta que se eliminen explícitamente o se cierre el servidor.

## Almacenamiento

Por defecto, las descargas y transcodificados se guardan en `server/storage/`.

Puedes ajustar las rutas con variables de entorno:

- `PIRATEFLIX_STORAGE_DIR`
- `PIRATEFLIX_TORRENT_DIR`
- `PIRATEFLIX_TRANSCODE_DIR`

Políticas de limpieza (automáticas y manuales):

- `PIRATEFLIX_STORAGE_MAX_BYTES` (prioridad alta, cuota total en bytes)
- `PIRATEFLIX_STORAGE_MAX_GB` (si no defines bytes, cuota total en GB; por defecto `20`)
- `PIRATEFLIX_STORAGE_RETENTION_MS` (retención general; por defecto `7 días`)
- `PIRATEFLIX_STORAGE_PARTIAL_RETENTION_MS` (retención para `*.partial`; por defecto `2 horas`)
- `PIRATEFLIX_STORAGE_SWEEP_INTERVAL_MS` (intervalo de limpieza periódica; por defecto `10 min`)
- `PIRATEFLIX_STORAGE_PRUNE_ON_START` (`true/false`, por defecto `true`)
- `PIRATEFLIX_STORAGE_DELETE_ON_TORRENT_DESTROY` (`true/false`, por defecto `true`)

## OpenSubtitles

Configura estas variables de entorno para habilitar la descarga de subtítulos:

- `OPEN_SUBTITLES_API_KEY` (obligatoria)
- `OPEN_SUBTITLES_USER_AGENT` (opcional, por defecto `PirateFlix`)
- `OPEN_SUBTITLES_USERNAME` / `OPEN_SUBTITLES_PASSWORD` (opcional, para token de descarga)
- `OPEN_SUBTITLES_TIMEOUT_MS` (timeout general OpenSubtitles)
- `OPEN_SUBTITLES_SEARCH_TIMEOUT_MS` (timeout específico de búsqueda; si no se define usa valor automático)
- `OPEN_SUBTITLES_RETRY_COUNT` (reintentos por config para errores temporales; por defecto `1`)
- `OPEN_SUBTITLES_RETRY_DELAY_MS` (espera base entre reintentos; por defecto `600`)
- `OPEN_SUBTITLES_MAX_CONFIGS_PER_REQUEST` (cuántas configs probar por request; por defecto `4`)

También puedes definir `openSubtitles` en `src/app/core/config/app-config-public.ts`; el servidor lo usa
como fallback si no hay variables de entorno.

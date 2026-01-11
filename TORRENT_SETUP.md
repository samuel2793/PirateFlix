# PirateFlix - Sistema de Streaming de Torrents

## Configuración Completa

### 1. Iniciar el Servidor de Torrents (Backend)

El backend es necesario para descargar y streamear los torrents.

```bash
# En una terminal:
cd server
node server.js
```

El servidor escuchará en `http://localhost:3001`

### 2. Iniciar la Aplicación Angular (Frontend)

```bash
# En otra terminal (en el directorio raíz):
npm start
```

La aplicación estará disponible en `http://localhost:4200`

## Cómo Usar

1. **Navega** a un detalle de película/serie
2. **Haz clic** en "Play" o "Reproducir"
3. **Ingresa** un magnet link cuando se solicite
4. **Espera** a que el torrent se conecte y descargue metadata
5. **El video comenzará** a reproducirse automáticamente

## Arquitectura

### Frontend (Angular + Ionic)
- Solicita magnet links al usuario
- Envía el magnet link al backend
- Recibe URL de streaming del backend
- Reproduce el video usando elemento `<video>` nativo

### Backend (Node.js + Express + WebTorrent)
- Recibe magnet links via API REST
- Descarga torrents usando WebTorrent (Node.js)
  - Soporta **todos los trackers**: HTTP, UDP, DHT, WebSocket
  - No tiene las limitaciones del navegador
- Streamea archivos de video al frontend
- Soporta HTTP Range requests para seeking

## Endpoints del Backend

- `POST /api/torrent/add` - Agregar torrent
- `GET /api/torrent/:infoHash` - Info del torrent
- `GET /api/stream/:infoHash/:fileIndex` - Stream de video
- `DELETE /api/torrent/:infoHash` - Eliminar torrent
- `GET /health` - Health check

## Ventajas de esta Solución

✅ **Soporta todos los trackers** (HTTP, UDP, DHT)
✅ **Funciona con cualquier magnet link**
✅ **Streaming progresivo** (no necesita descargar todo)
✅ **Seeking funcional** (avanzar/retroceder)
✅ **Múltiples formatos** (MP4, MKV, AVI, WebM)
✅ **Control total** del cliente torrent

## Notas Importantes

- Asegúrate de tener **ambos servidores corriendo** (backend y frontend)
- El backend debe estar en el puerto **3001**
- El frontend debe estar en el puerto **4200**
- Los torrents permanecen activos hasta que cierres el backend
- Se recomienda usar magnet links con muchos seeders para mejor velocidad

## Troubleshooting

### "Error al agregar torrent en el backend"
- Verifica que el servidor backend esté corriendo en puerto 3001
- Revisa la consola del servidor para ver errores

### "No se encontraron peers"
- El torrent puede no tener seeders activos
- Prueba con otro magnet link

### El video no carga
- Espera unos segundos, el torrent necesita descargar metadata primero
- Revisa la consola del navegador para más detalles

## Desarrollo

Para desarrollo con auto-reload del backend:

```bash
cd server
npm run dev
```

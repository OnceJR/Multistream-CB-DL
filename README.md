# chaturbate-multistream-web

App web (Node + Express) para **grabar streams de Chaturbate** con:
- **Vigilia infinita**: reintenta sola si el canal está offline/termina.
- **Detener real**: corta el árbol de procesos (yt-dlp/ffmpeg) y **no** reintenta.
- **Autocorte** por minutos (`cutMinutes`): crea archivos por segmentos y reanuda.
- **Calidad** (`format`): por ejemplo `best[height<=1080]`, `<=720`, etc.
- **Velocidad en tiempo real (MB/s)**, **bitrate**, **tamaño**.
- **Logs SSE** con eventos claros: `ONLINE`, `OFFLINE`, `RETRY_IN`, `ROTATE`, `SEGMENT_DONE`, `STOP_REQUESTED`.
- Listado de **finalizados**: expone `.mp4` y (si falla el remux) también `.ts/.mkv/.webm`.

> ⚠️ **Usar con responsabilidad**: respeta leyes y TOS del sitio. Graba solo contenido con permiso.

---

## Requisitos

- **Node.js** 18+ (o LTS reciente)
- **ffmpeg** accesible en PATH (`ffmpeg -version`)
- **yt-dlp** (o `yt-dlp.exe` en Windows). Descarga oficial: https://github.com/yt-dlp/yt-dlp

> En Windows, coloca `yt-dlp.exe` junto a `server.js` o define `YTDLP_PATH`.

---

## Variables de entorno (`.env`)

Crea un archivo `.env` en la raíz del proyecto con:

```env
PORT=3000
DOWNLOADS_DIR=./downloads
FFMPEG_PATH=ffmpeg
YTDLP_PATH=./yt-dlp.exe
```

- `DOWNLOADS_DIR`: carpeta donde se guardan descargas por canal.
- `FFMPEG_PATH`: binario de ffmpeg (puede ser ruta absoluta).
- `YTDLP_PATH`: binario de yt-dlp (o `.\yt-dlp.exe` en Windows).

---

## Scripts básicos

```bash
npm install
npm start
```

> Si usas `import ... from` en el backend, agrega `"type": "module"` en tu `package.json`.

```json
{
  "name": "chaturbate-multistream-web",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "node server.js" }
}
```

---

## Uso (UI)

1. Abrí `http://localhost:3000`.
2. Pegá la **URL o nombre de canal**.
3. Opcional: definí **Corte cada (min)** y **Calidad**.
4. **Iniciar**.
5. Modal de **Logs**: verás `ONLINE`, `SEGMENT_DONE …`, `OFFLINE`, `RETRY_IN …`.
6. **Detener** corta de verdad y no reintenta.

---

## API (rápida)

### POST `/api/jobs`
Crea una grabación.

Body JSON:
```json
{
  "input": "https://chaturbate.com/<canal>/",
  "cutMinutes": 60,
  "format": "best[height<=1080]",
  "autorestart": true
}
```

### GET `/api/jobs`
Estado de todas las grabaciones.

### POST `/api/jobs/:id/stop`
Detiene una grabación y evita reintentos.

### GET `/api/logs/:id`
SSE con logs en vivo (consumir con EventSource).

### GET `/api/files/:channel`
Lista archivos finalizados del canal (incluye `.mp4`, `.ts`, `.mkv`, `.webm`).

---

## Subir a GitHub

Este repo incluye **solo el andamiaje** (docs, CI, templates). Agregá tus **archivos del proyecto** al mismo nivel del README y luego:

```bash
git init
git add .
git commit -m "chore: repo scaffold + docs"
git branch -M main
git remote add origin <URL-de-tu-repo>
git push -u origin main
```

---

## Producción (opcional)

- Ejecutar con **PM2** o como servicio (systemd / NSSM en Windows).
- Redirigir logs a archivos (o usar un colector).
- Mantener `downloads/` en un volumen con espacio suficiente.
- Actualizar `yt-dlp` periódicamente.

---

## Solución de problemas

**Detener no corta**  
- Verifica que `YTDLP_PATH` apunte a `yt-dlp.exe`.
- En Windows, la app usa `taskkill /T /F` para matar el árbol (requiere permisos).

**Estado `ERROR` al finalizar el stream**  
- El backend ahora diferencia **OFFLINE** vs error real y marca `FINISHED` o `FINISHED_PARTIAL` si el remux falla. Revisa el modal de logs para ver `SEGMENT_DONE …`.

**Carpeta creada como “https”**  
- El backend ya extrae `canal` desde URL (incluye subdominios `es.`).

**Velocidad en 0 MB/s**  
- Se calcula cada ~1s. Si es un stream muy inestable o recién empezó, puede tardar.

**Puerto en uso**  
- Cambia `PORT` o cierra el proceso que lo usa.

---

## Legal

Este software se distribuye **“tal cual”** (ver `LICENSE`). El autor no se responsabiliza por usos indebidos. Respeta siempre la legislación y TOS del sitio origen.

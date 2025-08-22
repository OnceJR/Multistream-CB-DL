# Chaturbate Multistream — App Web (Node + HTML)

> **Aviso legal**: Grabar transmisiones puede violar Términos de Servicio o leyes locales. Usa esto solo con contenido propio o con permiso explícito. El autor no se hace responsable del uso indebido.

## Requisitos
- **Windows, macOS o Linux**
- **Node.js 18+**
- **yt-dlp** en el PATH (probar con `yt-dlp --version`)
- **ffmpeg** en el PATH (probar con `ffmpeg -version`)

### Windows (PowerShell)
```ps1
winget install Gyan.FFmpeg  # o instálalo manualmente
python -m pip install -U yt-dlp
yt-dlp --version
ffmpeg -version
```

## Instalar y ejecutar
```bash
# 1) Instalar deps del backend
npm install

# 2) (Opcional) Copiar .env.example a .env y ajustar rutas/puerto
cp .env.example .env   # en Windows: copy .env.example .env

# 3) Ejecutar el servidor
npm start
# Servirá la UI en http://localhost:3000
```

## Uso
1. Abre `http://localhost:3000` en tu navegador.
2. Pegá la **URL** o **nombre de canal** de Chaturbate.
3. Presioná **Iniciar** para cada stream que quieras grabar.
4. Podés ver **estado, tamaño, bitrate, archivo actual y logs**.
5. Al **Detener**, el sistema remuxa a MP4 con `-c copy -movflags +faststart` (y si falla, transcodifica).

## Salida
Los archivos se guardan en `./downloads/<canal>/<canal>-YYYYMMDD-HHMMSS.mp4`.

## Limitaciones
- La UI es estática y se comunica con el backend por HTTP/SSE.
- La detección "OFFLINE" no es perfecta: si la sala no está emitiendo, `yt-dlp` puede salir con error. La app lo mostrará como `ERROR`.
- Para ejecutar en hosting compartido, necesitás un entorno que permita procesos nativos (`yt-dlp` y `ffmpeg`).

---

### Seguridad
- Este proyecto no expone rutas fuera de `./downloads`. No subas esto a internet sin protección (auth/reverse proxy).
- Recomendado: usar firewall o ejecutarlo solo en red local.

¡Éxitos!

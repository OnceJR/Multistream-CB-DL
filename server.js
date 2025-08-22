/**
 * Backend Express:
 * - Stop robusto (Windows/Linux) sin reintentos si es manual
 * - Autoreintentos (vigilia) infinitos si está offline/termina
 * - Logs SSE: ONLINE/OFFLINE/RETRY_IN/ROTATE/SEGMENT_DONE/STOP_REQUESTED
 * - Velocidad (MB/s), bitrate, tamaño
 * - Autocorte por minutos (cutMinutes)
 * - Selector de calidad (format)
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import express from 'express';
import morgan from 'morgan';
import cors from 'cors';

const PORT = parseInt(process.env.PORT || '3000', 10);
const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOADS_DIR || './downloads');
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const YTDLP_BIN  = process.env.YTDLP_PATH  || (process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(cors());
app.use(morgan('dev'));
app.use(express.static(path.resolve('./public')));
app.use('/downloads', express.static(DOWNLOADS_DIR, { fallthrough: false }));

/* ---------- Utils ---------- */
function parseChannelFromUrl(u) {
  try {
    const url = new URL(u);
    return url.pathname.split('/').filter(Boolean)[0] || '';
  } catch { return ''; }
}
function sanitizeChannel(raw) {
  if (!raw) return 'desconocido';
  let ch = String(raw).trim().toLowerCase();
  if (/^https?:\/\//i.test(ch)) ch = parseChannelFromUrl(ch) || ch; // soporta subdominios (es., www., etc.)
  return (ch || 'desconocido').replace(/[^a-z0-9_-]+/g, '');
}
function buildUrl(input) {
  if (!input) return null;
  return /^https?:\/\//i.test(input) ? String(input) : `https://chaturbate.com/${input}/`;
}
function nowStamp() {
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function humanBytes(n) {
  if (n == null) return '0 B';
  const u=['B','KB','MB','GB','TB']; let i=0, x=Number(n);
  while (x>=1024 && i<u.length-1){ x/=1024; i++; }
  return `${x.toFixed(x>=100?0:x>=10?1:2)} ${u[i]}`;
}
function kbpsFrom(bytes, seconds) {
  if (!seconds || seconds <= 0) return 0;
  return Math.round((bytes * 8) / seconds / 1000);
}
function fmtDur(s) {
  const n = Math.max(0, Math.floor(s||0));
  const h = String(Math.floor(n/3600)).padStart(2,'0');
  const m = String(Math.floor((n%3600)/60)).padStart(2,'0');
  const ss= String(n%60).padStart(2,'0');
  return `${h}:${m}:${ss}`;
}
async function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  try { proc.kill('SIGINT'); } catch {}
  await new Promise(r=>setTimeout(r, 600));
  if (proc.killed) return;
  if (process.platform === 'win32') {
    await new Promise(res=>{
      const k = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      k.on('close', ()=>res());
    });
  } else {
    try { process.kill(proc.pid, 'SIGKILL'); } catch {}
  }
}
function ffmpegRun(args, logFn) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG_BIN, args, { stdio: ['ignore','pipe','pipe'] });
    p.stdout.on('data', d => logFn && logFn(d.toString()));
    p.stderr.on('data', d => logFn && logFn(d.toString()));
    p.on('close', code => resolve({ ok: code === 0, code }));
  });
}

/* ---------- Job ---------- */
class Job {
  constructor(id, input, opts = {}) {
    this.id = id;
    this.url = buildUrl(input);
    this.channel = sanitizeChannel(input);

    this.state = 'STARTING';
    this.startedAt = Date.now();           // inicio del ciclo actual
    this.segmentStartAt = Date.now();      // inicio del segmento actual
    this.endedAt = null;

    this.currentFile = null;
    this.outputFile = null;

    this.lastSize = 0;
    this.lastSizeSample = 0;
    this.lastSampleTs = Date.now();
    this.speedMBs = 0;

    this.proc = null;
    this.sizeTimer = null;
    this.rotateTimer = null;

    this.autorestart    = opts.autorestart ?? true;     // vigilia
    this.offlineRetryMs = opts.offlineRetryMs ?? 30000; // 30s
    this.cutMinutes     = (opts.cutMinutes ?? 0) | 0;   // 0 = sin corte
    this.format         = opts.format || null;

    this.stopRequested = false;             // evita reintento si fue stop manual
    this.logBuf = [];
    this.logSubs = new Set();

    this.outDir = path.join(DOWNLOADS_DIR, this.channel);
    fs.mkdirSync(this.outDir, { recursive: true });
  }

  _pushLog(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    this.logBuf.push(line);
    if (this.logBuf.length > 500) this.logBuf.shift();
    for (const res of this.logSubs) res.write(`data: ${line}\n\n`);
  }

  subscribeLogs(res) {
    this.logSubs.add(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    // Dump inicial
    for (const l of this.logBuf) res.write(`data: ${l}\n\n`);
    // Ping
    const ping = setInterval(()=>res.write(`:ping\n\n`), 15000);
    res.on('close', ()=>{ clearInterval(ping); this.logSubs.delete(res); });
  }

  start() {
    this.segmentStartAt = Date.now();
    const template = path.join(this.outDir, `${this.channel}-${nowStamp()}.%(ext)s`);
    const args = ['--newline'];
    if (this.format) { args.push('-f', this.format); }
    args.push(
      '-o', template,
      '--no-part',
      '--concurrent-fragments', '10',
      '--retries', 'infinite',
      '--hls-use-mpegts',
      this.url
    );

    this._pushLog(`SPAWN ${YTDLP_BIN} ${args.join(' ')}`);
    this.proc = spawn(YTDLP_BIN, args, { stdio: ['ignore','pipe','pipe'] });

    this.proc.stdout.on('data', (d) => {
      const s = d.toString();
      this._pushLog(s);

      // detectar archivo
      const m = s.match(/Destination:\s(.+)\s*$/) || s.match(/Writing video to:\s(.+)\s*$/);
      if (m && m[1]) {
        let p = m[1].trim();
        if (!path.isAbsolute(p)) p = path.resolve(p);
        this.currentFile = p;
      }

      if (this.state === 'STARTING') {
        this.state = 'RECORDING';
        this._pushLog(`ONLINE canal=${this.channel}`);
      }
    });

    this.proc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) this._pushLog(`yt-dlp: ${s}`);
    });

    this.proc.on('close', async (code, signal) => {
      this._pushLog(`EXIT code=${code} signal=${signal}`);
      clearInterval(this.sizeTimer);
      if (this.rotateTimer) { clearTimeout(this.rotateTimer); this.rotateTimer = null; }

      if (this.currentFile && fs.existsSync(this.currentFile)) {
        await this._finalizeSegment();     // remux + log SEGMENT_DONE
      } else {
        // Nunca llegó a grabar → OFFLINE (no lo consideramos error)
        if (!this.stopRequested) {
          this.state = 'OFFLINE';
          this._pushLog(`OFFLINE canal=${this.channel}`);
        }
      }

      if (!this.stopRequested && this.autorestart) {
        this._pushLog(`RETRY_IN ${Math.round(this.offlineRetryMs/1000)}s`);
        setTimeout(() => { this._resetForRestart(); this.start(); }, this.offlineRetryMs);
      } else {
        this._pushLog(`STOPPED autorestart=${this.autorestart} stopRequested=${this.stopRequested}`);
      }
    });

    // Métricas de tamaño y velocidad
    this.sizeTimer = setInterval(() => {
      if (this.currentFile && fs.existsSync(this.currentFile)) {
        try {
          const st = fs.statSync(this.currentFile);
          const now = Date.now();
          this.lastSize = st.size;

          const dt = (now - this.lastSampleTs) / 1000;
          if (dt >= 0.8) {
            const dbytes = st.size - this.lastSizeSample;
            this.speedMBs = dbytes > 0 ? (dbytes / dt) / (1024*1024) : 0;
            this.lastSizeSample = st.size;
            this.lastSampleTs = now;
          }
        } catch {}
      }
    }, 1000);

    // Autocorte
    if (this.cutMinutes > 0) {
      this.rotateTimer = setTimeout(() => {
        this._pushLog(`ROTATE cutMinutes=${this.cutMinutes}`);
        this.stop(); // detiene; al cerrar se remuxa y luego reanuda (si no fue stop manual)
      }, this.cutMinutes * 60 * 1000);
    }
  }

  async stop() {
    this._pushLog('STOP_REQUESTED');
    this.stopRequested = true;   // NO reintentar después
    if (this.proc && !this.proc.killed) {
      await killProcessTree(this.proc);
    }
  }

  async _finalizeSegment() {
    this.state = 'REMUXING';
    const input = (this.currentFile && fs.existsSync(this.currentFile)) ? this.currentFile : null;
    if (!input) {
      this._pushLog('SEGMENT_MISSING');
      this.state = 'OFFLINE';
      this.endedAt = Date.now();
      return;
    }

    // Si el archivo es casi vacío, trátalo como offline sin error
    try {
      const st = fs.statSync(input);
      if (st.size < 512 * 1024) {
        this._pushLog('SEGMENT_TOO_SMALL -> OFFLINE_NO_DATA');
        this.state = 'OFFLINE';
        this.endedAt = Date.now();
        return;
      }
    } catch {}

    const outBase = path.join(this.outDir, path.basename(input, path.extname(input)));
    const outMp4  = `${outBase}.mp4`;
    this.outputFile = outMp4;

    // 1) Remux copy tolerante
    let res = await ffmpegRun([
      '-y','-hide_banner','-loglevel','error',
      '-fflags','+genpts+igndts',
      '-err_detect','ignore_err',
      '-i', input,
      '-map','0', '-c','copy',
      '-movflags','+faststart',
      outMp4
    ], (m)=>this._pushLog(`ffmpeg: ${m}`));

    // 2) Fallback transcode si copy falla
    if (!res.ok) {
      this._pushLog('Remux copy falló. Transcodificando…');
      res = await ffmpegRun([
        '-y','-hide_banner','-loglevel','error',
        '-fflags','+genpts+igndts',
        '-err_detect','ignore_err',
        '-i', input,
        '-map','0',
        '-c:v','libx264','-preset','veryfast','-crf','20',
        '-c:a','aac','-b:a','128k',
        '-movflags','+faststart',
        outMp4
      ], (m)=>this._pushLog(`ffmpeg: ${m}`));
    }

    // 3) Si incluso eso falla, exponemos el original y marcamos FINISHED_PARTIAL
    let outPath = outMp4;
    if (!res.ok) {
      this._pushLog('Transcodificación también falló. Exponiendo archivo original.');
      this.outputFile = input;
      outPath = input;
      this.state = 'FINISHED_PARTIAL';
    } else {
      this.state = 'FINISHED';
    }

    const segDurSec = (Date.now() - this.segmentStartAt) / 1000;
    const sizeBytes = (() => { try { return fs.existsSync(outPath) ? fs.statSync(outPath).size : 0; } catch { return 0; } })();
    this._pushLog(`SEGMENT_DONE file="${outPath}" dur=${fmtDur(segDurSec)} size=${humanBytes(sizeBytes)}`);

    this.endedAt = Date.now();
  }

  _resetForRestart() {
    this.state = 'STARTING';
    this.startedAt = Date.now();
    this.segmentStartAt = Date.now();
    this.endedAt = null;

    this.currentFile = null;
    this.outputFile  = null;

    this.lastSize = 0;
    this.lastSizeSample = 0;
    this.lastSampleTs = Date.now();
    this.speedMBs = 0;

    this.stopRequested = false;

    if (this.cutMinutes > 0) {
      this.rotateTimer = setTimeout(() => {
        this._pushLog(`ROTATE cutMinutes=${this.cutMinutes}`);
        this.stop();
      }, this.cutMinutes * 60 * 1000);
    }
  }

  toJSON() {
    const elapsedSec = ((this.endedAt || Date.now()) - this.startedAt) / 1000;
    const kbps = kbpsFrom(this.lastSize, Math.max(1, (Date.now() - this.startedAt)/1000));
    return {
      id: this.id,
      channel: this.channel,
      url: this.url,
      state: this.state,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      elapsedSec,
      sizeBytes: this.lastSize,
      sizeHuman: humanBytes(this.lastSize),
      bitrateKbps: kbps,
      speedMBs: Number(this.speedMBs.toFixed(2)),
      currentFile: this.currentFile,
      outputFile: this.outputFile
    };
  }
}

/* ---------- Estado/API ---------- */
const JOBS = new Map();

app.post('/api/jobs', (req, res) => {
  const { input, autorestart = true, cutMinutes = 0, format = null } = req.body || {};
  if (!input || !String(input).trim()) {
    return res.status(400).json({ error: 'Falta input (URL o canal)' });
  }
  const id = String(Date.now());
  const job = new Job(id, String(input).trim(), { autorestart, cutMinutes, format });
  JOBS.set(id, job);
  job.start();
  res.json(job.toJSON());
});

app.get('/api/jobs', (_req, res) => {
  res.json([...JOBS.values()].map(j => j.toJSON()));
});

app.post('/api/jobs/:id/stop', async (req, res) => {
  const id = String(req.params.id);
  const job = JOBS.get(id);
  if (!job) return res.status(404).json({ error: 'No existe ese job' });
  await job.stop();
  res.json({ ok: true });
});

// SSE de logs
app.get('/api/logs/:id', (req, res) => {
  const id = String(req.params.id);
  const job = JOBS.get(id);
  if (!job) return res.status(404).end();
  job.subscribeLogs(res);
});

// Listado de archivos por canal (incluye varios formatos)
app.get('/api/files/:channel', (req, res) => {
  const channel = sanitizeChannel(req.params.channel || '');
  const dir = path.join(DOWNLOADS_DIR, channel);
  if (!fs.existsSync(dir)) return res.json([]);
  const exts = ['.mp4', '.ts', '.mkv', '.webm'];
  const files = fs.readdirSync(dir).filter(f => exts.includes(path.extname(f).toLowerCase()));
  res.json(files.map(f => ({ name:f, url:`/downloads/${encodeURIComponent(channel)}/${encodeURIComponent(f)}` })));
});

// Fallback
app.get('*', (_req, res) => {
  res.sendFile(path.resolve('./public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Descargas expuestas en /downloads`);
});

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HOSTS = ['youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'twitter.com', 'x.com', 'reddit.com', 'redd.it'];
const VIDEO = ['mp4', 'webm', 'mkv'];
const AUDIO = ['mp3', 'm4a', 'wav', 'opus', 'flac'];

function okUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    return HOSTS.some(h => x.hostname === h || x.hostname.endsWith('.' + h));
  } catch { return false; }
}

// Opsiyonel: Render "Secret Files" ile /etc/secrets/cookies.txt eklersen YouTube/Instagram engellerini azaltır
let cookies = null;
try {
  const src = process.env.COOKIES_FILE || '/etc/secrets/cookies.txt';
  if (fs.existsSync(src)) { cookies = '/tmp/cookies.txt'; fs.copyFileSync(src, cookies); }
} catch {}
const base = () => ['--no-playlist', '--no-warnings', ...(cookies ? ['--cookies', cookies] : [])];

function run(args, timeout) {
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', args);
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(err.split('\n').filter(Boolean).pop() || 'İşlem başarısız'));
    });
  });
}

app.post('/api/info', async (req, res) => {
  const url = (req.body || {}).url;
  if (!okUrl(url)) return res.status(400).json({ error: 'Bu link desteklenmiyor. TikTok, Instagram, YouTube, X veya Reddit linki gir.' });
  try {
    const j = JSON.parse(await run([...base(), '-J', '--', url], 60000));
    const heights = [...new Set((j.formats || []).map(f => f.height).filter(h => h && h >= 144))].sort((a, b) => b - a);
    res.json({ title: j.title, thumbnail: j.thumbnail, duration: j.duration, uploader: j.uploader || j.channel, heights });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

let busy = 0;
app.get('/api/download', async (req, res) => {
  const { url, format = 'mp4' } = req.query;
  const q = Math.min(parseInt(req.query.q) || 2160, 4320);
  if (!okUrl(url)) return res.status(400).send('Geçersiz link');
  const isAudio = AUDIO.includes(format);
  if (!isAudio && !VIDEO.includes(format)) return res.status(400).send('Geçersiz format');
  if (busy >= 2) return res.status(429).send('Sunucu şu an meşgul, biraz sonra tekrar dene.');

  busy++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const clean = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  try {
    const fmt = isAudio
      ? ['-f', 'ba/b', '-x', '--audio-format', format, '--audio-quality', '0']
      : ['-f', format === 'mp4'
          ? `bv*[height<=${q}][ext=mp4]+ba[ext=m4a]/b[height<=${q}][ext=mp4]/bv*[height<=${q}]+ba/b`
          : `bv*[height<=${q}]+ba/b`,
         '--merge-output-format', format];
    await run([...base(), ...fmt, '-o', path.join(dir, '%(title).80B [%(id)s].%(ext)s'), '--', url], 240000);
    const file = fs.readdirSync(dir)[0];
    if (!file) throw new Error('Dosya oluşturulamadı');
    res.download(path.join(dir, file), file, clean);
  } catch (e) {
    clean();
    if (!res.headersSent) res.status(500).send(e.message);
  } finally { busy--; }
});

app.listen(process.env.PORT || 3000, () => console.log('Hazır'));

'use strict';
/*
 * وسيط البث المباشر لمنصة مباريات رابطة تيبازة
 * المتصفح  --WebSocket(wss)-->  هذا الخادم  --ffmpeg(RTMPS)-->  فيسبوك / يوتيوب
 *
 * متغيرات البيئة (Environment) على Render:
 *   FIREBASE_API_KEY      مفتاح Web API لمشروع Firebase (عام)
 *   FIREBASE_PROJECT_ID   معرّف المشروع
 *   ALLOWED_ORIGINS       مواقع مسموح لها (مفصولة بفاصلة)، مثل https://esm-matches.onrender.com
 *   ALLOW_TRANSCODE       "1" للسماح بإعادة الترميز عند عدم دعم H.264 (يستهلك معالجاً كثيراً)
 *   FORCE_TRANSCODE       "1" لإعادة الترميز دائماً (مفاتيح إطارات مضبوطة كل ثانيتين)
 *   ALLOW_CUSTOM          "1" للسماح بعنوان RTMP مخصص (غير فيسبوك/يوتيوب)
 */
const http = require('http');
const dns = require('dns').promises;
const net = require('net');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');

const PORT = +process.env.PORT || 8080;
const API_KEY = process.env.FIREBASE_API_KEY || '';
const PROJECT = process.env.FIREBASE_PROJECT_ID || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const ALLOW_TRANSCODE = process.env.ALLOW_TRANSCODE === '1';
const FORCE_TRANSCODE = process.env.FORCE_TRANSCODE === '1';
const ALLOW_CUSTOM = process.env.ALLOW_CUSTOM === '1';
const MAX_HOURS = 3;
const MAX_BACKLOG = 8 * 1024 * 1024; // 8MB

const TARGETS = {
  facebook: k => 'rtmps://live-api-s.facebook.com:443/rtmp/' + k,
  youtube: k => 'rtmp://a.rtmp.youtube.com/live2/' + k,
};
const active = new Map(); // uid -> {kill}

/* فحص ذاتي: بعض نسخ ffmpeg الثابتة تتعطّل عند حلّ أسماء النطاقات (DNS). النتيجة على /diag */
const diag = { ffmpeg: ffmpegPath, state: 'checking' };
(function selfTest() {
  let e = '';
  const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.1', '-f', 'flv', 'rtmp://dns-selftest.invalid:1935/x/y'], { stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', b => { e += b; });
  p.on('error', er => { diag.state = 'error: ' + er.message; console.log('[selftest]', JSON.stringify(diag)); });
  p.on('exit', (c, sig) => { diag.state = sig ? 'CRASH (' + sig + ') عند حلّ أسماء النطاقات' : 'ok'; diag.detail = e.trim().slice(0, 160); console.log('[selftest]', JSON.stringify(diag)); });
})();

const server = http.createServer((req, res) => {
  if (req.url === '/diag') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(diag, null, 1));
  }
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
    return res.end('ok');
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, path: '/live', maxPayload: 8 * 1024 * 1024 });

/* التحقق من هوية المستخدم عبر Firebase ثم من اعتماد حسابه */
async function authorize(idToken) {
  if (!API_KEY || !PROJECT) throw new Error('الخادم غير مُعدّ (FIREBASE_API_KEY / FIREBASE_PROJECT_ID)');
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + API_KEY, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }),
  });
  if (!r.ok) throw new Error('جلسة الدخول غير صالحة، أعد تسجيل الدخول');
  const uid = ((await r.json()).users || [])[0]?.localId;
  if (!uid) throw new Error('حساب غير معروف');
  const d = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}`, {
    headers: { authorization: 'Bearer ' + idToken },
  });
  if (!d.ok) throw new Error('تعذّر التحقق من صلاحية حسابك');
  const f = (await d.json()).fields || {};
  const role = f.role?.stringValue, status = f.status?.stringValue, perm = f.perm?.stringValue || 'full';
  if (!(role === 'admin' || (role === 'manager' && status === 'approved' && perm !== 'view_only')))
    throw new Error('حسابك غير مصرّح له بالبث');
  return uid;
}

/* منع توجيه البث إلى عناوين داخلية (SSRF) عند تفعيل العنوان المخصص */
async function safeHost(url) {
  const u = new URL(url);
  if (!/^rtmps?:$/.test(u.protocol)) throw new Error('عنوان RTMP غير صالح');
  const ips = await dns.lookup(u.hostname, { all: true });
  for (const { address } of ips) {
    if (net.isIP(address) === 4 && /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(address)) throw new Error('عنوان غير مسموح');
    if (net.isIP(address) === 6 && /^(::1|fc|fd|fe80)/i.test(address)) throw new Error('عنوان غير مسموح');
  }
  return url;
}

function buildArgs(url, mime) {
  const h264 = /h264|avc|mp4/i.test(mime || '');
  const transcode = FORCE_TRANSCODE || !h264;
  if (transcode && !FORCE_TRANSCODE && !ALLOW_TRANSCODE) throw new Error('متصفحك لا يرسل H.264. استعمل Safari أو Chrome حديثاً.');
  const base = ['-hide_banner', '-loglevel', 'info', '-fflags', '+genpts+nobuffer', '-probesize', '1000000', '-analyzeduration', '1000000', '-i', 'pipe:0'];
  const video = transcode
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-b:v', '1800k', '-maxrate', '1800k', '-bufsize', '3600k', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0']
    : ['-c:v', 'copy'];
  return [...base, ...video, '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-f', 'flv', url];
}

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || '';
  if (ORIGINS.length && !ORIGINS.includes(origin)) { ws.close(1008, 'origin'); return; }
  const send = o => { try { ws.readyState === 1 && ws.send(JSON.stringify(o)); } catch (e) {} };
  let ff = null, uid = null, started = false, timer = null, beat = null, rx = 0, st = { frames: 0, fps: 0, kbps: 0 }, statT = null, secret = '';
  const stop = () => {
    clearTimeout(timer); clearInterval(beat); clearInterval(statT);
    if (uid && active.get(uid) === stop) active.delete(uid);
    if (ff) { try { ff.stdin.end(); } catch (e) {} const p = ff; ff = null; setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 4000); }
  };
  beat = setInterval(() => { try { ws.ping(); } catch (e) {} }, 20000);

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (!ff) return;
      if (ff.stdin.writableLength > MAX_BACKLOG) { send({ type: 'error', msg: 'الشبكة بطيئة جداً، توقف البث' }); stop(); ws.close(); return; }
      rx += data.length; ff.stdin.write(data); return;
    }
    if (started) return;
    started = true;
    try {
      const m = JSON.parse(data.toString());
      if (m.type !== 'start') throw new Error('طلب غير صالح');
      uid = await authorize(m.token);
      const key = String(m.key || '').trim();
      if (!/^[A-Za-z0-9_\-?=&.]{6,300}$/.test(key) && m.target !== 'custom') throw new Error('مفتاح البث غير صالح');
      let url;
      if (m.target === 'custom') {
        if (!ALLOW_CUSTOM) throw new Error('العنوان المخصص غير مفعّل على الخادم');
        url = await safeHost(String(m.url || '').trim());
      } else if (TARGETS[m.target]) url = TARGETS[m.target](key);
      else throw new Error('وجهة غير معروفة');
      const prev = active.get(uid); if (prev) prev();           // بث واحد لكل حساب
      active.set(uid, stop);
      ff = spawn(ffmpegPath, buildArgs(url, m.mime), { stdio: ['pipe', 'ignore', 'pipe'] });
      let tail = ''; secret = key;
      const mask = t => (secret ? t.split(secret).join('***') : t);
      ff.stderr.on('data', b => {
        const t = b.toString(); tail = (tail + t).slice(-900);
        const x = /frame=\s*(\d+).*?fps=\s*([\d.]+).*?bitrate=\s*([\d.]+)kbits\/s/.exec(t);
        if (x) st = { frames: +x[1], fps: +x[2], kbps: +x[3] };
        if (/error|fail|refused|invalid|denied|unable|timed out|Could not/i.test(t)) console.log('[ffmpeg]', mask(t).trim().slice(0, 300));
      });
      statT = setInterval(() => send({ type: 'stats', rx, ...st }), 2000);
      ff.stdin.on('error', () => {});
      ff.on('error', e => { send({ type: 'error', msg: 'تعذّر تشغيل ffmpeg على الخادم: ' + e.message }); ff = null; stop(); try { ws.close(); } catch (x) {} });
      ff.on('exit', (code, sig) => {
        if (!ff) return; ff = null;
        const bad = /Connection refused|Input\/output error|Server returned|Handshake|403|401|invalid|Unauthorized/i.test(tail);
        console.log('[ffmpeg exit]', code, mask(tail).slice(-300).replace(/\s+/g, ' '));
        send({ type: 'ended', code, msg: sig ? 'تعطّل ffmpeg على الخادم (' + sig + '). افتح /diag على رابط الخادم.' : bad ? 'رفضت المنصة الاتصال. تحقق من مفتاح البث وأن بثاً جديداً أُنشئ على فيسبوك.' : 'انتهى البث', detail: mask(tail).slice(-200).replace(/\s+/g, ' ') });
        stop(); try { ws.close(); } catch (e) {}
      });
      timer = setTimeout(() => { send({ type: 'ended', msg: 'بلغ البث الحد الأقصى للمدة' }); stop(); ws.close(); }, MAX_HOURS * 3600 * 1000);
      send({ type: 'ready', mode: FORCE_TRANSCODE || !/h264|avc|mp4/i.test(m.mime || '') ? 'transcode' : 'copy' });
    } catch (e) { send({ type: 'error', msg: e.message || 'خطأ' }); stop(); try { ws.close(); } catch (x) {} }
  });
  ws.on('close', stop);
  ws.on('error', stop);
});

server.listen(PORT, () => console.log('relay listening on', PORT));

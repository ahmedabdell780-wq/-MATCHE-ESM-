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
 *   FIREBASE_SERVICE_ACCOUNT  محتوى ملف JSON لحساب الخدمة (لتفعيل الإشعارات /notify)
 */
const http = require('http');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const ffmpegPath = process.env.FFMPEG_PATH || (fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : require('ffmpeg-static'));

const PORT = +process.env.PORT || 8080;
const API_KEY = process.env.FIREBASE_API_KEY || '';
const PROJECT = process.env.FIREBASE_PROJECT_ID || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const ALLOW_TRANSCODE = process.env.ALLOW_TRANSCODE !== '0';
const FORCE_TRANSCODE = process.env.FORCE_TRANSCODE !== '0';
const ALLOW_CUSTOM = process.env.ALLOW_CUSTOM === '1';
const MAX_HOURS = 3;
const MAX_BACKLOG = 8 * 1024 * 1024; // 8MB

const TARGETS = {
  facebook: k => 'rtmps://live-api-s.facebook.com:443/rtmp/' + k,
  youtube: k => 'rtmp://a.rtmp.youtube.com/live2/' + k,
};
const active = new Map(); // uid -> {kill}

/* فحص ذاتي: التحقق من جاهزية ffmpeg عبر المنفذ المحلي */
const diag = { ffmpeg: ffmpegPath, state: 'checking', tunnel: true };
(function selfTest() {
  let e = '';
  const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.1', '-f', 'flv', 'rtmp://127.0.0.1:9/x/y'], { stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', b => { e += b; });
  p.on('error', er => { diag.state = 'error: ' + er.message; console.log('[selftest]', JSON.stringify(diag)); });
  p.on('exit', (c, sig) => { diag.state = sig ? 'CRASH (' + sig + ')' : 'ok'; diag.detail = e.trim().slice(0, 160); console.log('[selftest]', JSON.stringify(diag)); });
})();

/* ===== الإشعارات (FCM) — تتطلب FIREBASE_SERVICE_ACCOUNT (JSON كامل لحساب الخدمة) ===== */
let fcm = null;
(function initAdmin() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.log('[push] FIREBASE_SERVICE_ACCOUNT غير مضبوط: الإشعارات معطّلة'); return; }
  try {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    fcm = { messaging: admin.messaging(), db: admin.firestore() };
    console.log('[push] جاهز');
  } catch (e) { console.log('[push] فشل التهيئة:', e.message); }
})();

function corsHeaders(req) {
  const o = (req.headers.origin || '').replace(/\/+$/, '');
  const ok = !ORIGINS.length || ORIGINS.includes(o);
  const h = { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'Origin' };
  if (ok && o) h['access-control-allow-origin'] = o;
  return { h, ok };
}

function readJson(req, max = 20000) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > max) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function pushTo(kind, teams, title, body) {
  const snap = await fcm.db.collection('pushTokens').get();
  const tokens = [];
  snap.forEach(d => {
    const v = d.data() || {};
    if (kind === 'live' || v.role === 'admin' || teams.includes(Number(v.teamId))) tokens.push(d.id);
  });
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const r = await fcm.messaging.sendEachForMulticast({ tokens: chunk, notification: { title, body }, data: { kind, title, body } });
    sent += r.successCount;
    const dead = [];
    r.responses.forEach((x, j) => { if (!x.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test((x.error && x.error.code) || '')) dead.push(chunk[j]); });
    await Promise.all(dead.map(t => fcm.db.collection('pushTokens').doc(t).delete().catch(() => {})));
  }
  return sent;
}

/* تذكير اليوم السابق: يرسل بعد الساعة 18:00 بتوقيت الجزائر لكل مباراة مجدولة غداً (مرة واحدة يومياً) */
async function runReminders() {
  if (!fcm) return;
  try {
    const now = new Date(Date.now() + 3600e3); // UTC+1
    if (now.getUTCHours() < 18) return;
    const today = now.toISOString().slice(0, 10);
    const tomorrow = new Date(now.getTime() + 86400e3).toISOString().slice(0, 10);
    const ref = fcm.db.collection('public').doc('remindersSent');
    const st = await ref.get();
    if (st.exists && st.data().date === today) return;
    const snap = await fcm.db.collection('scores').get();
    for (const d of snap.docs) {
      const v = d.data() || {}, x = v.data || {};
      if (x.date !== tomorrow || x.status !== 'scheduled') continue;
      const m = /^(?:([A-Z0-9]+)\|)?(\d+):/.exec(v.key || '');
      const title = '📅 تذكير · غداً مباراة' + (m ? ' (الجولة ' + m[2] + ' · ' + (m[1] || 'U15') + ')' : '');
      const body = [x.time, x.stad].filter(Boolean).join(' · ') || tomorrow;
      await pushTo('schedule', [Number(v.home), Number(v.away)], title, body);
    }
    await ref.set({ date: today });
  } catch (e) { console.log('[reminders]', e.message); }
}
setTimeout(runReminders, 30000);
setInterval(runReminders, 30 * 60 * 1000);

async function handleNotify(req, res) {
  const { h, ok } = corsHeaders(req);
  const send = (code, obj) => { res.writeHead(code, { ...h, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  if (!ok) return send(403, { error: 'origin' });
  if (!fcm) return send(503, { error: 'push disabled' });
  try {
    const b = await readJson(req);
    await authorize(String(b.token || ''));
    const kind = ['result', 'schedule', 'live'].includes(b.kind) ? b.kind : null;
    if (!kind) return send(400, { error: 'kind' });
    const title = String(b.title || '').slice(0, 120), body = String(b.body || '').slice(0, 240);
    const teams = Array.isArray(b.teams) ? b.teams.map(Number).filter(Number.isFinite) : [];
    const sent = await pushTo(kind, teams, title, body);
    send(200, { ok: true, sent });
  } catch (e) { send(400, { error: String(e.message || e).slice(0, 160) }); }
}

const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/notify') {
    if (req.method === 'OPTIONS') { const { h } = corsHeaders(req); res.writeHead(204, h); return res.end(); }
    if (req.method === 'POST') return handleNotify(req, res);
  }
  if (path === '/diag') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ ...diag, push: !!fcm }, null, 1));
  }
  if (path === '/healthz' || path === '/') {
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

function createRtmpTunnel(targetUrl) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('عنوان البث غير صالح: ' + e.message));
    }
    const isTls = u.protocol === 'rtmps:';
    const remoteHost = u.hostname;
    const remotePort = +u.port || (isTls ? 443 : 1935);

    let activeRemote = null;
    let activeClient = null;

    const srv = net.createServer(client => {
      activeClient = client;
      let remote;
      const opts = { host: remoteHost, port: remotePort };
      if (isTls) {
        opts.servername = remoteHost;
        remote = tls.connect(opts);
      } else {
        remote = net.connect(opts);
      }
      activeRemote = remote;

      client.pipe(remote);
      remote.pipe(client);

      remote.on('error', err => {
        console.log('[rtmp tunnel remote error]', err.message);
        try { client.destroy(); } catch (x) {}
      });
      client.on('error', err => {
        console.log('[rtmp tunnel client error]', err.message);
        try { remote.destroy(); } catch (x) {}
      });
      remote.on('close', () => {
        try { client.end(); } catch (x) {}
      });
      client.on('close', () => {
        try { remote.end(); } catch (x) {}
      });
    });

    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const localUrl = `rtmp://127.0.0.1:${port}${u.pathname}${u.search || ''}`;
      const appPath = u.pathname.split('/').slice(0, 2).join('/') || '/rtmp';
      const tcUrl = `${isTls ? 'rtmps' : 'rtmp'}://${remoteHost}:${remotePort}${appPath}`;
      resolve({
        url: localUrl,
        tcUrl: tcUrl,
        close: () => {
          try { if (activeClient) activeClient.destroy(); } catch (e) {}
          try { if (activeRemote) activeRemote.destroy(); } catch (e) {}
          try { srv.close(); } catch (e) {}
        }
      });
    });

    srv.on('error', reject);
  });
}

function buildArgs(url, tcUrl, mime) {
  const h264 = /h264|avc|mp4/i.test(mime || '');
  const transcode = FORCE_TRANSCODE || !h264;
  if (transcode && !FORCE_TRANSCODE && !ALLOW_TRANSCODE) throw new Error('متصفحك لا يرسل H.264. استعمل Safari أو Chrome حديثاً.');
  const base = ['-hide_banner', '-loglevel', 'info', '-fflags', '+genpts+nobuffer', '-probesize', '1000000', '-analyzeduration', '1000000', '-i', 'pipe:0'];
  const video = transcode
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-b:v', '1500k', '-maxrate', '1800k', '-bufsize', '3000k', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-r', '30']
    : ['-c:v', 'copy'];
  const rtmpOpts = tcUrl ? ['-rtmp_tcurl', tcUrl] : [];
  return [...base, ...video, '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', ...rtmpOpts, '-f', 'flv', url];
}

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || '';
  if (ORIGINS.length && !ORIGINS.includes(origin)) { ws.close(1008, 'origin'); return; }
  const send = o => { try { ws.readyState === 1 && ws.send(JSON.stringify(o)); } catch (e) {} };
  let ff = null, uid = null, started = false, timer = null, beat = null, rx = 0, st = { frames: 0, fps: 0, kbps: 0 }, statT = null, secret = '', tunnel = null;
  const stop = () => {
    clearTimeout(timer); clearInterval(beat); clearInterval(statT);
    if (tunnel) { try { tunnel.close(); } catch (e) {} tunnel = null; }
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
      try {
        tunnel = await createRtmpTunnel(url);
      } catch (err) {
        console.log('[rtmp tunnel fallback]', err.message);
      }
      const streamUrl = tunnel ? tunnel.url : url;
      const tcUrl = tunnel ? tunnel.tcUrl : '';
      ff = spawn(ffmpegPath, buildArgs(streamUrl, tcUrl, m.mime), { stdio: ['pipe', 'ignore', 'pipe'] });
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

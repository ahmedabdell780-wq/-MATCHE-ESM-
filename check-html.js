/* يفحص صياغة كل سكربتات index.html (دون تشغيلها) ويفشل إذا وُجد خطأ أو حرف تالف.
 * الاستعمال:  node check-html.js index.html */
const fs = require('fs'), vm = require('vm');
const file = process.argv[2] || 'index.html';
const html = fs.readFileSync(file, 'utf8');
let bad = 0;
if (html.includes('\uFFFD')) { console.error('✖ يوجد حرف تالف (U+FFFD) في الملف — غالباً نص مقطوع'); bad++; }
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m, i = 0;
while ((m = re.exec(html))) {
  i++;
  try { new vm.Script(m[1], { filename: file + '#script' + i }); }
  catch (e) { console.error('✖ خطأ صياغة في السكربت رقم ' + i + ': ' + e.message); bad++; }
}
if (!i) { console.error('✖ لم يُعثر على أي سكربت'); bad++; }
if (bad) process.exit(1);
console.log('✔ ' + file + ': ' + i + ' سكربت سليم');

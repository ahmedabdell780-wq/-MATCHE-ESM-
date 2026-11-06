# وسيط البث المباشر (Live Relay)

يستقبل فيديو الاستوديو من المتصفح ويرسله إلى فيسبوك (أو يوتيوب) عبر RTMPS.

## النشر على Render (Web Service)
1. ارفع مجلد `live-relay` إلى مستودع GitHub جديد (أو مجلد داخل المستودع الحالي).
2. Render ← New ← Web Service ← اختر المستودع.
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
3. Environment Variables:
   - `FIREBASE_API_KEY` = AIzaSyBSDRAZwpChKIXpRPVIUp0JtdfflLqPRfU
   - `FIREBASE_PROJECT_ID` = moubarati-l-w-t
   - `ALLOWED_ORIGINS` = https://esm-matches.onrender.com
4. انسخ رابط الخدمة (مثل https://esm-relay.onrender.com) وضعه في الاستوديو ← 📡 بث ← خادم البث.

## ملاحظات
- الخطة المجانية تنام بعد خمول: افتح رابط الخدمة قبل المباراة بدقيقة (الاستوديو يوقظه تلقائياً).
- النسخ بدون إعادة ترميز (`-c copy`) خفيف جداً. يعمل مع Safari (iPhone) وChrome (H.264).
- `FORCE_TRANSCODE=1` يضمن مفاتيح إطارات منتظمة لكنه يحتاج معالجاً أقوى (خطة مدفوعة).

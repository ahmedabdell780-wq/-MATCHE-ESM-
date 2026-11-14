importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js','https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
firebase.initializeApp({apiKey:"AIzaSyBSDRAZwpChKIXpRPVIUp0JtdfflLqPRfU",authDomain:"moubarati-l-w-t.firebaseapp.com",projectId:"moubarati-l-w-t",messagingSenderId:"582704281935",appId:"1:582704281935:web:aeb821d64b4de733386d3a"});
const messaging=firebase.messaging();
// الرسائل ذات حمولة notification يعرضها المتصفح تلقائياً؛ هذا للرسائل data فقط
messaging.onBackgroundMessage(p=>{
  if(p.notification)return;
  const d=p.data||{};
  self.registration.showNotification(d.title||'منصة مباريات رابطة تيبازة',{body:d.body||'',icon:'icon-192.png',badge:'icon-192.png'});
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const n=e.notification.data||{},d=(n.FCM_MSG&&n.FCM_MSG.data)||n;
  const isMsg=d.kind==='message';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{
    const c=l.find(x=>'focus' in x);
    if(c){if(isMsg)c.postMessage({type:'open-message',teamId:d.teamId==null?null:Number(d.teamId)});return c.focus()}
    return clients.openWindow(isMsg?'./index.html#msg':'./');
  }));
});

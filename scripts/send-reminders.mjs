// Sends the queued reminders and the daily automatic ones through Firebase Cloud Messaging.
// Usage: node send-reminders.mjs [queue|auto|both|clear]
//   clear = cancel every pending (queued) reminder without sending it
import admin from 'firebase-admin';
import { autoMessages, emailKey } from './reminder-lib.mjs';

const mode = process.argv[2] || 'queue';
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (!sa.project_id) { console.error('FIREBASE_SERVICE_ACCOUNT secret is missing or not valid JSON.'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const col = db.collection('chitLedgerApp');
const dead = [];

async function getTokens(){
  const snap = await col.doc('fcmTokens').get();
  return snap.exists ? (snap.data().tokens || {}) : {};
}
// Data-only messages: the app's service worker shows them (title/body).
async function sendTo(email, title, body, tokensMap){
  const tokens = tokensMap[emailKey(email)] || [];
  if (!tokens.length) return { status: 'no-device' };
  const res = await admin.messaging().sendEachForMulticast({
    tokens, data: { title, body }, webpush: { headers: { Urgency: 'high', TTL: '86400' } },
  });
  let ok = 0;
  res.responses.forEach((r, i) => {
    if (r.success) { ok++; return; }
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') dead.push({ email, token: tokens[i] });
  });
  return ok > 0 ? { status: 'sent' } : { status: 'failed', error: 'no device accepted the message' };
}
async function processQueue(tokensMap){
  const ref = col.doc('reminders');
  const snap = await ref.get();
  const items = snap.exists ? (snap.data().items || []) : [];
  const todo = items.filter(i => i.status === 'queued').slice(0, 200);
  if (!todo.length) { console.log('queue: nothing to send'); return; }
  const results = {};
  for (const it of todo) results[it.id] = await sendTo(it.email, it.title, it.body, tokensMap);
  await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    const cur = s.exists ? (s.data().items || []) : [];
    const now = new Date().toISOString();
    tx.set(ref, { items: cur.map(i => results[i.id] ? { ...i, ...results[i.id], sentAt: now } : i).slice(-500) }, { merge: true });
  });
  console.log(`queue: ${todo.length} processed, ${Object.values(results).filter(r => r.status === 'sent').length} sent`);
}
async function processAuto(tokensMap){
  const snap = await col.doc('sharedData').get();
  if (!snap.exists || !snap.data().payload) { console.log('auto: no data'); return; }
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); // IST date
  const logRef = col.doc('autoLog');
  const log = await logRef.get();
  if (log.exists && log.data().date === today) { console.log('auto: already sent today'); return; }
  const msgs = autoMessages(JSON.parse(snap.data().payload));
  let sent = 0;
  for (const m of msgs) { const r = await sendTo(m.email, m.title, m.body, tokensMap); if (r.status === 'sent') sent++; }
  console.log(`auto: ${msgs.length} messages, ${sent} sent`);
  await logRef.set({ date: today, messages: msgs.length, sent });
}
async function pruneTokens(){
  for (const d of dead) await col.doc('fcmTokens').update(new admin.firestore.FieldPath('tokens', emailKey(d.email)), admin.firestore.FieldValue.arrayRemove(d.token));
  if (dead.length) console.log(`removed ${dead.length} expired device token(s)`);
}
async function clearQueue(){
  const ref = col.doc('reminders');
  let n = 0;
  await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    const cur = s.exists ? (s.data().items || []) : [];
    n = cur.filter(i => i.status === 'queued').length;
    tx.set(ref, { items: cur.map(i => i.status === 'queued' ? { ...i, status: 'cancelled' } : i) }, { merge: true });
  });
  console.log(`clear: ${n} pending reminder(s) cancelled, nothing sent`);
}
if (mode === 'clear') { await clearQueue(); process.exit(0); }

const tokensMap = await getTokens();
if (mode === 'queue' || mode === 'both') await processQueue(tokensMap);
if (mode === 'auto' || mode === 'both') await processAuto(tokensMap);
await pruneTokens();

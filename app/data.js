/*
 * Everything the app reads from or sends to Firebase. app.js never talks to Firebase directly.
 *
 * Reads are live: each watch* call keeps the screen in step with the database and returns a stop function.
 * Writes go through the server functions (firebase/functions/index.js), which check prices and steps.
 * The only direct write is the shop's three live switches, which firestore.rules allows for staff.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, RecaptchaVerifier, signInWithPhoneNumber, signInWithCustomToken, signOut,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, connectFirestoreEmulator,
  doc, collection, query, where, orderBy, limit, onSnapshot, getDoc, updateDoc, documentId,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-functions.js';
import { SHOP_ID, REGION, FIREBASE, EMULATOR } from './config.js';

/* the shop page and the customer page get separate sign-ins, even in the same browser */
const MODE = document.body.dataset.mode === 'shop' ? 'shop' : 'customer';
const app = initializeApp(FIREBASE, MODE);
const auth = getAuth(app);
auth.languageCode = 'ar';
/* on a real phone keep a local copy so the app opens offline; on the emulator start clean each time */
const db = initializeFirestore(app, {
  localCache: EMULATOR ? memoryLocalCache() : persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
const fns = getFunctions(app, REGION);
const HOST = location.hostname;
if (EMULATOR) {
  connectAuthEmulator(auth, `http://${HOST}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, HOST, 8080);
  connectFunctionsEmulator(fns, HOST, 5001);
  auth.settings.appVerificationDisabledForTesting = true;
}

const shopRef = doc(db, 'shops', SHOP_ID);
export const emulator = EMULATOR;

/* ---------- reads ---------- */

/** Signed-in person: { uid, phone (+9665…) | null, staff: bool } or null. */
export function watchUser(cb) {
  return onAuthStateChanged(auth, async u => {
    if (!u) return cb(null);
    const t = await u.getIdTokenResult();
    cb({ uid: u.uid, phone: u.phoneNumber || null, staff: t.claims.role === 'staff' && t.claims.shopId === SHOP_ID });
  });
}

/** The shop document: menu, prices, slots, rules, live switches. */
export function watchShop(cb, onError) {
  return onSnapshot(shopRef, s => cb(s.exists() ? s.data() : null), onError);
}

/** Booked pickups per slot from `fromDate` (YYYY-MM-DD) on: { 'YYYY-MM-DD_slot': count }. */
export function watchSlotLoad(fromDate, cb) {
  const q = query(collection(shopRef, 'slotLoad'), where(documentId(), '>=', fromDate));
  return onSnapshot(q, qs => {
    const m = {};
    qs.forEach(d => { m[d.id] = d.data().count || 0; });
    cb(m);
  }, () => cb({}));
}

/** The signed-in customer's orders, newest first. */
export function watchMyOrders(phone, cb) {
  const q = query(collection(shopRef, 'orders'), where('customerPhone', '==', phone), orderBy('createdAt', 'desc'), limit(50));
  return onSnapshot(q, qs => cb(qs.docs.map(d => toOrder(d.data()))), () => cb([]));
}

/** Every recent order of the shop (staff only), newest first. */
export function watchShopOrders(cb, onError) {
  const q = query(collection(shopRef, 'orders'), orderBy('createdAt', 'desc'), limit(300));
  return onSnapshot(q, qs => cb(qs.docs.map(d => toOrder(d.data()))), onError);
}

/** A customer's loyalty card and plan (the customer's own, or any for staff). */
export function watchCustomer(phone, cb) {
  return onSnapshot(doc(shopRef, 'customers', phone), s => cb(s.exists() ? s.data() : null), () => cb(null));
}

export async function getCustomer(phone) {
  const s = await getDoc(doc(shopRef, 'customers', phone));
  return s.exists() ? s.data() : null;
}

/** Server order → the shape the screens use (times in ms, plan/reward like the demo). */
function toOrder(d) {
  const p = d.perks || {};
  return {
    ...d,
    created: d.createdAt ? d.createdAt.toMillis() : Date.now(),
    edited: d.edited ? d.edited.toMillis() : null,
    history: (d.history || []).map(h => ({ s: h.s, t: h.at, by: h.by })),
    subCover: p.subPieces ? { pieces: p.subPieces, value: p.subValue } : null,
    reward: !!p.reward,
    walkin: d.source === 'store',
  };
}

/* ---------- writes ---------- */

/**
 * Call a server function. Resolves to its result; rejects with an Error whose `reason`
 * is the short code the server sent (e.g. 'slot-full', 'wrong-pin').
 */
export async function call(name, data = {}) {
  try {
    const r = await httpsCallable(fns, name)({ shopId: SHOP_ID, ...data });
    return r.data;
  } catch (e) {
    const err = new Error(e.message);
    /* the server's reason is one word; the SDK may append the HTTP status ("wrong-pin [403]") */
    const word = String(e.message || '').trim().split(/[\s[(]/)[0];
    err.reason = e.code === 'functions/unavailable' || e.code === 'functions/internal' || !word ? 'network' : word;
    throw err;
  }
}

/** Staff flips open / dryClean / todaySlots. */
export function setLive(live) {
  return updateDoc(shopRef, { live });
}

/* ---------- sign-in ---------- */

let verifier = null;
/** Send an SMS code to +9665…; resolves to a confirmation for confirmCode(). */
export function sendCode(phone, containerId) {
  if (!verifier) verifier = new RecaptchaVerifier(auth, containerId, { size: 'invisible' });
  return signInWithPhoneNumber(auth, phone, verifier).catch(e => {
    if (verifier) { verifier.clear(); verifier = null; }
    throw authError(e);
  });
}

export function confirmCode(confirmation, code) {
  return confirmation.confirm(code).catch(e => { throw authError(e); });
}

function authError(e) {
  const map = {
    'auth/invalid-verification-code': 'bad-code', 'auth/code-expired': 'code-expired',
    'auth/too-many-requests': 'too-many', 'auth/invalid-phone-number': 'phone', 'auth/network-request-failed': 'network',
  };
  const err = new Error(e.message);
  err.reason = map[e.code] || 'auth';
  return err;
}

/** Shop device: PIN → staff token for this shop only. */
export async function staffSignIn(pin) {
  const r = await call('staffLogin', { pin });
  await signInWithCustomToken(auth, r.token);
}

/** The verified phone of whoever is signed in right now (+9665…), or null. */
export function currentPhone() {
  return (auth.currentUser && auth.currentUser.phoneNumber) || null;
}

export function logout() {
  return signOut(auth);
}

/** Emulator only: the SMS code the emulator "sent", so testing needs no real phone. */
export async function emulatorCode(phone) {
  if (!EMULATOR) return null;
  try {
    const r = await (await fetch(`http://${HOST}:9099/emulator/v1/projects/${FIREBASE.projectId}/verificationCodes`)).json();
    const hits = (r.verificationCodes || []).filter(c => c.phoneNumber === phone);
    return hits.length ? hits[hits.length - 1].code : null;
  } catch (e) { return null; }
}

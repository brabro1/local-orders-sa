/*
 * The ordering app. The customer page (index.html) and the shop page (shop.html) share this file;
 * <body data-mode="shop"> picks the shop side. Menu, prices and rules come from the shop document,
 * and every order lives in Firebase (see data.js). Nothing here is the source of truth for money:
 * the server recomputes every total.
 */
import * as D from './data.js';
import { SHOP_ID } from './config.js';

const MODE = document.body.dataset.mode === 'shop' ? 'shop' : 'customer';
const SHOP = MODE === 'shop';

/* ---------- shop configuration, filled from the shop document by applyShop() ---------- */
let SERVICES = {}, SVC_NOTE = {}, CATALOG = [], DISTRICTS = [], SLOTS = [], PLANS = [], REASONS = [];
const ITEMS = {}, CAT_OF = {};
let FEE = 0, FREE_OVER = 0, MIN_PICKUP = 0, URGENT = 0, CAP = 0, BOOK_DAYS = 3, FIRST_PCT = 0, FIRST_MAX = 0;
let STAMP_GOAL = 6, STAMP_REWARD = 0, SHOP_PHONE = '', HOURS = null, LEGAL = null;
let LIVE = { open: true, dryClean: true, todaySlots: true };
const LATE_MIN = 10;
const MIN = 60000;
const pairOf = x => (x && (x.ar || x.en) ? [x.ar || x.en, x.en || x.ar] : null);
function applyShop(s) {
  R.shop = s;
  const svc = s.services || {};
  SERVICES = Object.fromEntries(Object.entries(svc).map(([k, v]) => [k, pairOf(v)]));
  SVC_NOTE = Object.fromEntries(Object.entries(svc).map(([k, v]) => [k, pairOf(v.note)]));
  CATALOG = (s.catalog || []).map(c => ({ ...c, items: (c.items || []).map(i => ({ ...i, note: pairOf(i.note) })) }));
  for (const k of Object.keys(ITEMS)) delete ITEMS[k];
  for (const k of Object.keys(CAT_OF)) delete CAT_OF[k];
  CATALOG.forEach(c => c.items.forEach(i => { ITEMS[i.id] = i; CAT_OF[i.id] = c.id; }));
  DISTRICTS = (s.districts || []).map(pairOf);
  SLOTS = s.slots || [];
  PLANS = (s.plans || []).map(p => {
    const pressOnly = p.svcs && p.svcs.length === 1 && p.svcs[0] === 'press';
    return { ...p, name: pairOf(p.name), note: pairOf(p.note) || (pressOnly ? [`${p.pieces} قطعة كوي فقط كل شهر`, `${p.pieces} items pressed a month`] : [`${p.pieces} قطعة غسيل وكوي كل شهر`, `${p.pieces} items washed & pressed a month`]) };
  });
  REASONS = (s.rejectReasons || []).map(pairOf);
  const r = s.rules || {};
  FEE = r.fee || 0; FREE_OVER = r.freeOver || 0; MIN_PICKUP = r.minPickup || 0; URGENT = r.urgentRate || 0;
  CAP = r.slotCap || 0; BOOK_DAYS = r.bookDays || 3; FIRST_PCT = r.firstOrderPct || 0; FIRST_MAX = r.firstOrderMax || 0;
  STAMP_GOAL = r.stampGoal || 6; STAMP_REWARD = r.stampReward || 0;
  LIVE = { open: true, dryClean: true, todaySlots: true, ...(s.live || {}) };
  SHOP_PHONE = s.phone || ''; HOURS = pairOf(s.hours); LEGAL = s.legal || null;
}
const planOf = id => PLANS.find(p => p.id === id) || { id, name: [id, id], note: ['', ''], pieces: 0, price: 0 };

const FLOW = {
  pickup: ['new', 'accepted', 'picking', 'counted', 'cleaning', 'ready', 'delivering', 'done'],
  dropoff: ['new', 'accepted', 'counted', 'cleaning', 'ready', 'done'],
};
const TAB_OF = { new: 'new', accepted: 'active', picking: 'active', counted: 'active', cleaning: 'active', ready: 'ready', delivering: 'ready', done: 'done', rejected: 'done', cancelled: 'done' };

/* ---------- language + helpers ---------- */
const L = (ar, en) => S.lang === 'en' ? en : ar;
const N = x => S.lang === 'en' ? x.en : x.name;
const P = pair => pair ? pair[S.lang === 'en' ? 1 : 0] : '';
const svcName = k => P(SERVICES[k]);
const distName = v => { const d = DISTRICTS.find(x => x[0] === v); return d ? P(d) : v; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* official Saudi riyal symbol (SAMA, public domain); always placed left of the number with a space */
const SAR = '<svg class="sar-i" viewBox="0 0 1124.14 1256.39" aria-hidden="true" focusable="false"><path fill="currentColor" d="M699.62,1113.02h0c-20.06,44.48-33.32,92.75-38.4,143.37l424.51-90.24c20.06-44.47,33.31-92.75,38.4-143.37l-424.51,90.24Z"/><path fill="currentColor" d="M1085.73,895.8c20.06-44.47,33.32-92.75,38.4-143.37l-330.68,70.33v-135.2l292.27-62.11c20.06-44.47,33.32-92.75,38.4-143.37l-330.68,70.27V66.13c-50.67,28.45-95.67,66.32-132.25,110.99v403.35l-132.25,28.11V0c-50.67,28.44-95.67,66.32-132.25,110.99v525.69l-295.91,62.88c-20.06,44.47-33.33,92.75-38.42,143.37l334.33-71.05v170.26l-358.3,76.14c-20.06,44.47-33.32,92.75-38.4,143.37l375.04-79.7c30.53-6.35,56.77-24.4,73.83-49.24l68.78-101.97v-.02c7.14-10.55,11.3-23.27,11.3-36.97v-149.98l132.25-28.11v270.4l424.53-90.28Z"/></svg>';
const amt = n => Math.round(n).toLocaleString('en-US');
const money = n => `<span class="sar" dir="ltr">${SAR}<span>${amt(n)}</span><span class="sr"> ${L('ريال', 'riyals')}</span></span>`;
const moneyT = n => L(`${amt(n)} ر.س`, `SAR ${amt(n)}`);
const num = n => `<span class="num" dir="ltr">#${n}</span>`;
const pcs = n => S.lang === 'en' ? (n === 1 ? '1 item' : `${n} items`) : n === 1 ? 'قطعة واحدة' : n === 2 ? 'قطعتان' : n >= 3 && n <= 10 ? `${n} قطع` : `${n} قطعة`;
const pad2 = n => String(n).padStart(2, '0');
const catIcon = (cat, cls = '', size = 22) => `<span class="gi ${cat} ${cls}" aria-hidden="true">${(IC[cat] || IC.hanger)(size)}</span>`;
const itemIcon = (id, cls = '') => catIcon(CAT_OF[id], cls, cls.includes('sm') ? 18 : 22);
function dateKey(offset) { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function dayOffset(key) {
  if (!key) return null;
  const [y, m, d] = key.split('-').map(Number);
  const a = new Date(y, m - 1, d), t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((a - t) / 864e5);
}
const fmtCache = {};
function fmt(kind, d) {
  const k = S.lang + kind;
  if (!fmtCache[k]) {
    const o = kind === 'long' ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short' };
    try { fmtCache[k] = new Intl.DateTimeFormat(S.lang === 'en' ? 'en-GB' : 'ar-SA-u-ca-gregory-nu-latn', o); }
    catch (e) { fmtCache[k] = new Intl.DateTimeFormat(S.lang === 'en' ? 'en' : 'ar', o); }
  }
  return fmtCache[k].format(d);
}
const dayDate = (offset, kind) => { const d = new Date(); d.setDate(d.getDate() + offset); return fmt(kind, d); };
function dayLabel(offset) {
  if (offset === 0) return L('اليوم', 'Today');
  if (offset === 1) return L('غدًا', 'Tomorrow');
  if (offset === -1) return L('أمس', 'Yesterday');
  if (offset === 2) return L('بعد غد', 'In 2 days');
  return dayDate(offset, 'long');
}
const slotLabel = id => { const s = SLOTS.find(x => x.id === id); return s ? (S.lang === 'en' ? s.en : s.ar) : ''; };
const slotText = o => o.slot ? `${dayLabel(dayOffset(o.slotDate))} ${slotLabel(o.slot)}` : '';
function clock(t) { const d = new Date(t); let h = d.getHours(); const ap = h < 12 ? L('ص', 'AM') : L('م', 'PM'); h = h % 12 || 12; return `${h}:${pad2(d.getMinutes())} ${ap}`; }
function ago(t) {
  const m = Math.floor((Date.now() - t) / MIN);
  if (m < 1) return L('الآن', 'now');
  if (m < 60) return L(`منذ ${m} د`, `${m} min ago`);
  const h = Math.floor(m / 60);
  if (h < 24) return L(`منذ ${h} س`, `${h} h ago`);
  return dayLabel(-Math.round(h / 24));
}
function normPhone(p) {
  let s = String(p || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^\d+]/g, '');
  if (s.startsWith('+966')) s = '0' + s.slice(4);
  else if (s.startsWith('00966')) s = '0' + s.slice(5);
  else if (s.startsWith('966')) s = '0' + s.slice(3);
  return s;
}
/* an order line keeps the price it was sold at; a basket line uses today's price */
/* WhatsApp chat link to a Saudi mobile, or null */
function waLink(phone, text) {
  const p = normPhone(phone);
  return /^05\d{8}$/.test(p) ? `https://wa.me/966${p.slice(1)}?text=${encodeURIComponent(text)}` : null;
}
/* a line telling a signed-out customer to sign in with their mobile */
function signInCard(why) {
  return `<div class="empty"><span class="gi kids" aria-hidden="true">${IC.user(30)}</span><b>${L('ادخل برقم جوالك', 'Sign in with your mobile')}</b><span>${why}</span>
    <button class="btn primary sm" data-a="signin">${L('أرسل رمز التحقق', 'Send me a code')}</button></div>`;
}
const priceOf = l => (l.price != null ? l.price : (ITEMS[l.id] && ITEMS[l.id].prices[l.svc]) || 0);
/* totals of a saved order come from the server; this only previews a basket before it is sent */
function calc(o) {
  if (o.totals) return o.totals;
  const items = o.items || [];
  const sub = items.reduce((s, l) => s + priceOf(l) * l.qty, 0);
  const count = items.reduce((s, l) => s + l.qty, 0);
  const urgent = o.speed === 'urgent' ? Math.round(sub * URGENT) : 0;
  const base = sub + urgent;
  const delivery = o.method === 'pickup' && base > 0 && base < FREE_OVER ? FEE : 0;
  const discount = o.firstOrder && sub > 0 ? Math.min(FIRST_MAX, Math.round(sub * FIRST_PCT)) : 0;
  const subFree = o.subCover ? Math.min(o.subCover.value, sub) : 0;
  const loyalty = o.reward ? Math.min(STAMP_REWARD, Math.max(0, sub - subFree - discount)) : 0;
  return { sub, count, urgent, delivery, discount, subFree, subPieces: o.subCover ? o.subCover.pieces : 0, loyalty, total: Math.max(0, base + delivery - discount - subFree - loyalty) };
}
/* which pieces of an order the customer's monthly plan pays for */
function subCover(items, sub) {
  if (!sub || sub.left <= 0) return null;
  const svcs = planOf(sub.plan).svcs || ['wash', 'press'];
  let pieces = 0, value = 0;
  for (const l of items) {
    const cat = CATALOG.find(c => c.id === CAT_OF[l.id]);
    if (!svcs.includes(l.svc) || (cat && cat.planExcluded)) continue;
    const take = Math.min(l.qty, sub.left - pieces);
    if (take <= 0) break;
    pieces += take; value += take * priceOf(l);
  }
  return pieces ? { pieces, value } : null;
}
const awaitingCount = o => o.quick && !o.counted;
function itemsSummary(items) {
  return items.map(l => `${esc(N(ITEMS[l.id]))} <span class="muted">(${svcName(l.svc)})</span> × <b class="num">${l.qty}</b>`).join(L('، ', ', '));
}
const sv = (d, s = 20, cls = '') => `<svg class="${cls}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
const IC = {
  hanger: s => sv('<path d="M12 6.6a2.1 2.1 0 1 1 2.1 2.1c-1 0-2.1.7-2.1 1.9v.9L3.3 16.8a1.3 1.3 0 0 0 .7 2.4h16a1.3 1.3 0 0 0 .7-2.4L12 11.5"/>', s),
  search: s => sv('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>', s),
  list: s => sv('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>', s),
  bag: s => sv('<path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>', s),
  home: s => sv('<path d="M4 11 12 4l8 7v9H4v-9Z"/><path d="M10 20v-5h4v5"/>', s),
  receipt: s => sv('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>', s),
  back: s => sv('<path d="m9 6 6 6-6 6"/>', s, 'dir-flip'),
  fwd: s => sv('<path d="m15 6-6 6 6 6"/>', s, 'dir-flip'),
  check: s => sv('<path d="m5 12 4.5 4.5L19 7"/>', s),
  clock: s => sv('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>', s),
  pin: s => sv('<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11Z"/><circle cx="12" cy="10" r="2"/>', s),
  truck: s => sv('<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>', s),
  store: s => sv('<path d="M4 9h16l-1-4H5L4 9Z"/><path d="M5 9v11h14V9M10 20v-5h4v5"/>', s),
  bolt: s => sv('<path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/>', s),
  chat: s => sv('<path d="M4 20l1.4-3.8A7.6 7.6 0 1 1 8.6 19L4 20Z"/>', s),
  info: s => sv('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', s),
  alert: s => sv('<path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4M12 17h.01"/>', s),
  sparkle: s => sv('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>', s),
  repeat: s => sv('<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>', s),
  gear: s => sv('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>', s),
  sun: s => sv('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', s),
  moon: s => sv('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>', s),
  device: s => sv('<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18.5h2"/>', s),
  men: s => sv('<path d="M8.5 4 4 6.6l1.6 3.6L8 9.2V20h8V9.2l2.4 1 1.6-3.6L15.5 4c-.6 1.5-1.9 2.4-3.5 2.4S9.1 5.5 8.5 4Z"/>', s),
  women: s => sv('<path d="M9.5 3.5h5l-1.2 4.6L18 20H6l4.7-11.9-1.2-4.6Z"/><path d="M10.7 8.1h2.6"/>', s),
  kids: s => sv('<path d="M7.5 5.5 4 8l1.4 2.8 2.1-.8V19h9v-9l2.1.8L20 8l-3.5-2.5c-.7 1.2-2.4 2-4.5 2s-3.8-.8-4.5-2Z"/><path d="M10 13h4"/>', s),
  home: s => sv('<path d="M3 19V6M3 15h18v4M21 15v-2.5A2.5 2.5 0 0 0 18.5 10H11v5"/><circle cx="7" cy="12" r="1.8"/>', s),
  globe: s => sv('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>', s),
  card: s => sv('<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/>', s),
  star: s => sv('<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"/>', s),
  plus: s => sv('<path d="M12 5v14M5 12h14"/>', s),
  user: s => sv('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>', s),
  download: s => sv('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', s),
};

/* ---------- state ----------
 * S: this device's own state (language, theme, basket draft, open tab), kept in localStorage.
 * R: what comes from the database, kept live by data.js. Never edited here directly.
 */
const LS_KEY = `orders-app:${SHOP_ID}:${MODE}`;
function freshState(lang, theme) {
  return {
    v: 4, lang: lang || 'ar', theme: theme || 'system',
    cust: { screen: 'home', cat: null, q: '', cart: {}, speed: 'normal', method: 'pickup', day: 0, slot: null, district: '', address: '', mapUrl: '', name: '', phone: '', note: '', pay: 'cod', quick: false, trackN: null },
    own: { tab: 'new' },
  };
}
let S;
try {
  const p = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
  S = p && p.v === 4 ? p : freshState(p && p.lang, p && p.theme);
} catch (e) { S = freshState(); }
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { /* works without storage */ } }

const R = {
  shop: null, shopMissing: false, offline: false,
  user: null, authKnown: false,
  orders: [], ordersLoaded: false,
  rawOrders: [],         // orders as the server last sent them; `orders` adds the steps still on their way
  pending: new Map(),    // shop: order n → { from, to } shown already, waiting for the server
  card: null,           // customer: own loyalty card / plan (customers/{phone})
  slotLoad: {},          // booked pickups per 'YYYY-MM-DD_slot'
  custCache: {},         // shop: cards of customers typed in the in-store order
};
const shopName = () => (R.shop ? (S.lang === 'en' ? R.shop.nameEn || R.shop.name : R.shop.name) : '');

const ui = { view: MODE, sheetC: null, sheetO: null, errors: {}, rejecting: null, cancelArm: null, flash: null, opener: {}, focusErr: false, busy: false, pin: '', pinErr: '', lastPlaced: null, confirmation: null };
const myOrders = () => (SHOP ? [] : R.orders);
const findOrder = n => R.orders.find(o => o.n === n);
const cartLines = () => Object.entries(S.cust.cart).map(([k, qty]) => { const [id, svc] = k.split('|'); return { id, svc, qty }; }).filter(l => ITEMS[l.id] && ITEMS[l.id].prices[l.svc] != null);
const EMPTY_CARD = { stamps: 0, rewards: 0, sub: null, orders: 0 };
const myCard = () => R.card || EMPTY_CARD;
/* a plan counts until its renewal date */
const activeSub = sub => (sub && (!sub.renews || sub.renews >= dateKey(0)) ? sub : null);
const cartDraft = () => {
  const items = cartLines(), card = myCard();
  return { items, speed: S.cust.speed, method: S.cust.method, firstOrder: !card.orders, reward: card.rewards > 0, subCover: subCover(items, activeSub(card.sub)) };
};
const validPhone = p => /^05\d{8}$/.test(normPhone(p));
const e164 = p => (validPhone(p) ? `+966${normPhone(p).slice(1)}` : null);
/* shop side: the card of a customer typed in the in-store order, fetched once */
function cardOf(phone) {
  const k = e164(phone);
  if (!k) return null;
  if (!(k in R.custCache)) {
    R.custCache[k] = undefined;
    D.getCustomer(k).then(c => { R.custCache[k] = c; if (ui.sheetO && ui.sheetO.type === 'walkin') wkPreview(ui.sheetO); if (ui.sheetO) renderAll(); }).catch(() => { R.custCache[k] = null; });
  }
  return R.custCache[k] || null;
}
const finished = o => ['done', 'rejected', 'cancelled'].includes(o.status);

function slotState(day, id) {
  const s = SLOTS.find(x => x.id === id);
  if (!s) return 'closed';
  if (day === 0) {
    if (!LIVE.open) return 'closed';
    if (!LIVE.todaySlots) return 'paused';
    const d = new Date(); if (d.getHours() + d.getMinutes() / 60 > s.start - 1) return 'past';
  }
  return (R.slotLoad[`${dateKey(day)}_${id}`] || 0) >= CAP ? 'full' : 'ok';
}
const slotNote = st => ({ past: L('انتهى', 'Passed'), full: L('ممتلئ', 'Full'), closed: L('مغلق', 'Closed'), paused: L('متوقف', 'Paused') })[st];
function firstOpenDay() { for (let d = 0; d < BOOK_DAYS; d++) if (SLOTS.some(s => slotState(d, s.id) === 'ok')) return d; return 1; }

function statusLabel(o, s = o.status) {
  const pick = o.method === 'pickup';
  return ({
    new: L('بانتظار قبول المغسلة', 'Waiting for the laundry to accept'),
    accepted: pick ? L('تم القبول · بانتظار موعد الاستلام', 'Accepted · waiting for pickup time') : L('تم القبول · بانتظار تسليم القطع', 'Accepted · waiting for drop-off'),
    picking: L('المندوب في الطريق للاستلام', 'Driver on the way to collect'),
    counted: L('تم الاستلام والجرد', 'Collected and counted'),
    cleaning: L('قيد الغسيل والكوي', 'Being washed and pressed'),
    ready: pick ? L('جاهز · بانتظار التوصيل', 'Ready · awaiting delivery') : L('جاهز للاستلام من المحل', 'Ready for collection in store'),
    delivering: L('في الطريق إليك', 'On the way to you'),
    done: L('تم التسليم', 'Delivered'), rejected: L('تعذّر قبول الطلب', 'Order declined'), cancelled: L('أُلغي الطلب', 'Order cancelled'),
  })[s];
}
const stepName = s => ({ new: L('استلمنا طلبك', 'Order received'), accepted: L('قبول الطلب', 'Accepted'), picking: L('المندوب في الطريق', 'Driver on the way'), counted: L('الاستلام والجرد', 'Collected & counted'), cleaning: L('الغسيل والكوي', 'Washing & pressing'), ready: L('جاهز', 'Ready'), delivering: L('خرج للتوصيل', 'Out for delivery'), done: L('تم التسليم', 'Delivered') })[s];
function statusChip(o) {
  const cls = { new: 'warn', ready: 'ok', delivering: 'ok', done: 'ok', rejected: 'bad', cancelled: 'bad' }[o.status] || 'brand';
  return `<span class="chip ${cls}">${statusLabel(o)}</span>`;
}
function progressOf(o) {
  if (o.status === 'rejected' || o.status === 'cancelled') return 0;
  const f = FLOW[o.method]; return Math.round(f.indexOf(o.status) / (f.length - 1) * 100);
}
function waText(o, s) {
  const first = (o.customer.name || '').split(' ')[0];
  const shop = shopName(), t = calc(o), pick = o.method === 'pickup';
  switch (s) {
    case 'new': return L(`مرحبًا ${first}، وصلنا طلبك رقم ${o.n} في ${shop}. ` + (pick ? `موعد الاستلام: ${slotText(o)}.` : 'سلّم القطع في المحل في أي وقت خلال ساعات العمل.') + ' سنرسل لك تحديثًا عند كل مرحلة.',
      `Hi ${first}, ${shop} received your order #${o.n}. ` + (pick ? `Pickup: ${slotText(o)}.` : 'Drop your items at the store any time during opening hours.') + ' We will update you at every step.');
    case 'accepted': return pick ? L(`تم تأكيد طلبك ${o.n}. المندوب سيصلك ${slotText(o)}.`, `Order #${o.n} confirmed. Our driver will come ${slotText(o)}.`) : L(`تم تأكيد طلبك ${o.n}. بانتظارك في المحل.`, `Order #${o.n} confirmed. See you at the store.`);
    case 'picking': return L(`المندوب في الطريق إليك الآن لاستلام طلب ${o.n}.`, `Our driver is on the way to collect order #${o.n}.`);
    case 'counted': return L(`استلمنا ملابسك وجردناها: ${pcs(t.count)}، والإجمالي ${moneyT(t.total)}. التسليم المتوقع ${o.speed === 'urgent' ? 'خلال 24 ساعة' : 'خلال 48 ساعة'}.`,
      `We collected and counted your items: ${pcs(t.count)}, total ${moneyT(t.total)}. Expected back ${o.speed === 'urgent' ? 'within 24 hours' : 'within 48 hours'}.`);
    case 'cleaning': return L(`طلبك ${o.n} قيد الغسيل والكوي الآن.`, `Order #${o.n} is being washed and pressed.`);
    case 'ready': return pick ? L(`ملابسك جاهزة، وسنوصل طلب ${o.n} إليك اليوم.`, `Your clothes are ready. We will deliver order #${o.n} today.`) : L(`ملابسك جاهزة للاستلام من المحل. طلب ${o.n} · الإجمالي ${moneyT(t.total)}.`, `Your clothes are ready for collection. Order #${o.n} · total ${moneyT(t.total)}.`);
    case 'delivering': return L(`المندوب في الطريق لتسليم طلب ${o.n}.` + (o.paid ? '' : ` المبلغ المطلوب ${moneyT(t.total)} نقدًا أو شبكة.`), `Our driver is delivering order #${o.n}.` + (o.paid ? '' : ` Amount due ${moneyT(t.total)}, cash or card.`));
    case 'done': return L(`تم تسليم طلبك ${o.n}. شكرًا لاختيارك ${shop}.`, `Order #${o.n} delivered. Thank you for choosing ${shop}.`);
    case 'rejected': return L(`نعتذر ${first}، تعذّر قبول طلبك ${o.n}: ${P(REASONS[o.rejectReason])}.`, `Sorry ${first}, we could not accept order #${o.n}: ${P(REASONS[o.rejectReason])}.`);
    case 'cancelled': return L(`تم إلغاء طلبك ${o.n} بناءً على طلبك.`, `Order #${o.n} was cancelled at your request.`);
  }
  return '';
}

/* ---------- toasts ---------- */
function toast(which, text) {
  const layer = document.querySelector(`#dev-${which} .toasts`);
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = text;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 3400);
  while (layer.children.length > 2) layer.firstChild.remove();
}

/* ---------- shared: preferences sheet ---------- */
function prefsSheet(which) {
  const seg = (a, items, cur) => `<div class="seg-x">${items.map(([v, ic, t, lang]) => `<button data-a="${a}" data-v="${v}" aria-pressed="${cur === v}" ${lang ? `lang="${lang}"` : ''}>${ic ? IC[ic](18) : ''}<span>${t}</span></button>`).join('')}</div>`;
  return `<div class="sheet-wrap" data-a="closesheet" data-self="1"><div class="sheet pad" role="dialog" aria-modal="true" aria-labelledby="pf-${which}">
    <div class="grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2 id="pf-${which}" tabindex="-1">${L('الإعدادات', 'Settings')}</h2><button class="icon-btn" data-a="closesheet" aria-label="${L('إغلاق', 'Close')}">✕</button></div>
    <div role="group" aria-labelledby="pf-l-${which}"><div class="lbl" id="pf-l-${which}" style="margin-bottom:8px">${IC.globe(16)} ${L('اللغة', 'Language')}</div>
      ${seg('lang', [['ar', '', 'العربية', 'ar'], ['en', '', 'English', 'en']], S.lang)}</div>
    <div role="group" aria-labelledby="pf-t-${which}"><div class="lbl" id="pf-t-${which}" style="margin-bottom:8px">${L('المظهر', 'Appearance')}</div>
      ${seg('theme', [['system', 'device', L('حسب الجهاز', 'Device')], ['light', 'sun', L('فاتح', 'Light')], ['dark', 'moon', L('داكن', 'Dark')]], S.theme)}</div>
    <p class="muted small">${L('تُحفظ على هذا الجهاز فقط.', 'Saved on this device only.')}</p>
    ${which === 'c' && R.user && R.user.phone ? `<button class="btn quiet wide" data-a="signout">${L('تسجيل الخروج من', 'Sign out of')} <span class="num" dir="ltr">${normPhone(R.user.phone)}</span></button>` : ''}
    ${which === 'o' ? `<button class="btn quiet wide" data-a="signout" style="color:var(--bad)">${L('قفل الجهاز (تسجيل الخروج)', 'Lock this device (sign out)')}</button>` : ''}
  </div></div>`;
}
function applyPrefs() {
  const root = document.documentElement, app = document.getElementById('app'), en = S.lang === 'en';
  root.lang = app.lang = en ? 'en' : 'ar';
  root.dir = app.dir = en ? 'ltr' : 'rtl';
  if (S.theme === 'system') delete root.dataset.theme; else root.dataset.theme = S.theme;
  const name = shopName() || L('الطلبات', 'Orders');
  document.title = SHOP ? `${L('لوحة', 'Dashboard ·')} ${name}` : name;
}
const PREFS = {
  lang(d) { S.lang = d.v; applyPrefs(); renderChrome(); },
  theme(d) { S.theme = d.v; applyPrefs(); },
};

/* ---------- customer screens ---------- */
function steps(n) {
  const T = [L('القطع', 'Items'), L('الموعد والعنوان', 'Time & address'), L('التأكيد', 'Confirm')];
  return `<ol class="steps" aria-label="${L('مراحل الطلب', 'Order steps')}">${T.map((t, i) => `<li class="${i < n ? 'done' : i === n ? 'cur' : ''}" ${i === n ? 'aria-current="step"' : ''}><span>${i + 1}. ${t}</span></li>`).join('')}</ol>`;
}
const gearBtn = (cls = 'icon-btn') => `<button class="${cls}" data-a="prefs" aria-label="${L('الإعدادات: اللغة والمظهر', 'Settings: language and appearance')}">${IC.gear(20)}</button>`;
function greeting() { return new Date().getHours() < 12 ? L('صباح الخير', 'Good morning') : L('مساء الخير', 'Good evening'); }
function cHome() {
  const st = LIVE;
  const active = myOrders().find(o => !finished(o));
  const lastDone = myOrders().find(o => o.status === 'done' && o.items.length);
  const first = myOrders().length === 0 && !myCard().orders && FIRST_PCT > 0;
  const minOf = c => Math.min(...c.items.flatMap(i => Object.values(i.prices)), Infinity);
  return `
  <div class="hero"><div class="pad">
    <div class="brand-row"><div class="logo" aria-hidden="true">${IC.hanger(28)}</div><div style="flex:1;min-width:0"><div class="brand-name">${esc(shopName())}</div><div class="brand-sub">${L('غسيل وكوي · تنظيف جاف · مفروشات', 'Wash & press · dry cleaning · linens')}</div></div>${gearBtn('icon-btn on-hero')}</div>
    <div class="status-pill ${st.open ? '' : 'off'}">${st.open ? L('مفتوح الآن · نستقبل الطلبات', 'Open now · taking orders') : L('مغلق مؤقتًا اليوم · نستقبل طلبات الغد', 'Closed today · taking orders for tomorrow')}</div>
    <p class="greet">${greeting()}${S.cust.name ? `${L('، ', ', ')}${esc(S.cust.name.split(' ')[0])}` : ''}</p>
    <h1 class="hero-h" tabindex="-1" data-focus>${L('نستلم ملابسك من الباب، ونرجّعها نظيفة ومكوية', 'We collect from your door and bring it back fresh and pressed')}</h1>
    <div class="hero-cta">
      <button class="btn main" data-a="go" data-to="catalog">${IC.list(19)} ${L('اطلب استلامًا', 'Book a pickup')}</button>
      <button class="btn alt" data-a="quick">${IC.bag(19)} ${L('استلام سريع', 'Quick pickup')}</button>
    </div>
  </div></div>
  <div class="pad stack screen">
    ${active ? `<button class="card live-card" data-a="track" data-n="${active.n}" aria-label="${L(`طلبك الحالي ${active.n}: ${statusLabel(active)}. اضغط للتتبّع`, `Current order ${active.n}: ${statusLabel(active)}. Tap to track`)}">
      <span class="sec-head" style="margin:0;width:100%"><span class="sec-title" style="margin:0">${L('طلبك الحالي', 'Your current order')}</span><span class="tnum" dir="ltr">${active.n}</span></span>
      <span style="font-weight:800">${statusLabel(active)}</span>
      <span class="prog" aria-hidden="true"><i style="width:${Math.max(6, progressOf(active))}%"></i></span>
      <span class="small muted">${active.method === 'pickup' ? slotText(active) : L('تسليم في المحل', 'In-store drop-off')} · ${L('اضغط للتتبّع', 'tap to track')}</span>
    </button>` : ''}
    ${lastDone && !active ? `<div class="card" style="display:flex;align-items:center;gap:12px">${itemIcon(lastDone.items[0].id, 'thumb')}<div style="flex:1;min-width:0"><b>${L('اطلب نفس آخر طلب', 'Order your last basket again')}</b><p class="small muted">${pcs(calc(lastDone).count)} · ${money(calc(lastDone).sub)}</p></div><button class="btn sm" data-a="again" data-n="${lastDone.n}">${IC.repeat(17)} ${L('أعد الطلب', 'Reorder')}</button></div>` : ''}
    ${first ? `<div class="offer"><span class="pct">${Math.round(FIRST_PCT * 100)}%</span><span><b>${L('خصم على أول طلب', 'Off your first order')}</b><br><span class="small muted">${L('حتى', 'Up to')} ${money(FIRST_MAX)} · ${L('يُطبّق تلقائيًا', 'applied automatically')}</span></span></div>` : ''}
    <section aria-labelledby="h-cats">
      <div class="sec-head"><h2 id="h-cats">${L('الأقسام', 'Categories')}</h2><button class="btn quiet sm" data-a="go" data-to="catalog">${L('كل الأسعار', 'All prices')}</button></div>
      <div class="cats">${CATALOG.map(c => `<button class="cat" data-a="opencat" data-id="${c.id}">${catIcon(c.id)}<span class="cat-tx"><b>${N(c)}</b><span>${L('من', 'from')} ${money(minOf(c))}</span></span></button>`).join('')}</div>
    </section>
    <section aria-labelledby="h-how">
      <div class="sec-head"><h2 id="h-how">${L('كيف نخدمك', 'How it works')}</h2></div>
      <ol class="how">
        <li><span class="gi men" aria-hidden="true">${IC.list(20)}</span>${L('اختر قطعك وموعدك', 'Pick items and a time')}</li>
        <li><span class="gi kids" aria-hidden="true">${IC.truck(20)}</span>${L('نستلم من بابك', 'We collect at your door')}</li>
        <li><span class="gi home" aria-hidden="true">${IC.sparkle(20)}</span>${L('نرجّعها نظيفة', 'Back fresh and pressed')}</li>
      </ol>
    </section>
    <div class="card">
      <dl class="facts">
        ${HOURS ? `<div><span class="fi">${IC.clock(18)}</span><dt>${L('مواعيد العمل', 'Opening hours')}</dt><dd>${esc(P(HOURS))}</dd></div>` : ''}
        <div><span class="fi">${IC.pin(18)}</span><dt>${L('أحياء الاستلام والتوصيل', 'Pickup & delivery areas')}</dt><dd>${DISTRICTS.map(P).join(L('، ', ', '))}</dd></div>
        <div><span class="fi">${IC.truck(18)}</span><dt>${L('رسوم الاستلام والتوصيل', 'Pickup & delivery fee')}</dt><dd>${money(FEE)} · ${L('مجانًا من', 'free from')} ${money(FREE_OVER)} · ${L('الحد الأدنى', 'minimum')} ${money(MIN_PICKUP)}</dd></div>
        <div><span class="fi">${IC.bolt(18)}</span><dt>${L('مدة التجهيز', 'Turnaround')}</dt><dd>${L(`خلال 48 ساعة · المستعجل خلال 24 ساعة (+${Math.round(URGENT * 100)}%)`, `Within 48 hours · express within 24 hours (+${Math.round(URGENT * 100)}%)`)}</dd></div>
      </dl>
    </div>
    <p class="legal">${L('الأسعار شاملة ضريبة القيمة المضافة.', 'Prices include VAT.')} ${esc(shopName())}${LEGAL && LEGAL.cr ? ` · ${L('سجل تجاري', 'CR')} <span class="num">${esc(LEGAL.cr)}</span>` : ''}${LEGAL && LEGAL.vat ? ` · ${L('الرقم الضريبي', 'VAT no.')} <span class="num">${esc(LEGAL.vat)}</span>` : ''}.<br>
    <button data-a="soon">${L('سياسة الخصوصية', 'Privacy policy')}</button> · <button data-a="soon">${L('الشروط والاستبدال', 'Terms & returns')}</button></p>
  </div>`;
}

function cCatalog() {
  const q = S.cust.q.trim().toLowerCase();
  const match = i => [i.name, i.en, ...(i.note || [])].some(x => x.toLowerCase().includes(q));
  const cats = q ? CATALOG.map(c => ({ ...c, items: c.items.filter(match) })).filter(c => c.items.length)
    : [CATALOG.find(x => x.id === S.cust.cat) || CATALOG[0]];
  const tile = it => {
    const min = Math.min(...Object.values(it.prices));
    const inCart = Object.entries(S.cust.cart).filter(([k]) => k.startsWith(it.id + '|')).reduce((s, [, n]) => s + n, 0);
    const svcs = Object.keys(it.prices).map(k => `<span class="svc ${k === 'dry' && !LIVE.dryClean ? 'off' : ''}">${svcName(k)}</span>`).join('');
    return `<li><button class="tile ${inCart ? 'in' : ''}" data-a="item" data-id="${it.id}" aria-label="${esc(N(it))}${L('، من ', ', from ')}${moneyT(min)}${inCart ? L(`، في السلة ${inCart}`, `, ${inCart} in basket`) : ''}">
      ${inCart ? `<span class="qty-pill" aria-hidden="true">${inCart}</span>` : ''}
      ${itemIcon(it.id)}
      <span class="tile-body" aria-hidden="true">
        <span class="tile-name">${esc(N(it))}</span>${it.note ? `<span class="tile-note">${esc(P(it.note))}</span>` : ''}
        <span class="svcs">${svcs}</span>
        <span class="tile-foot"><span class="from">${L('من', 'from')} <b>${money(min)}</b></span><span class="plus">+</span></span>
      </span>
    </button></li>`;
  };
  return `
  <div class="pad topbar"><h1 tabindex="-1" data-focus style="flex:1">${L('الأسعار والطلب', 'Prices & order')}</h1>${gearBtn()}</div>
  <div class="pad sticky">
    <div class="search"><label class="sr" for="c-q">${L('ابحث عن قطعة', 'Search items')}</label>${IC.search(18)}<input class="input" id="c-q" type="search" data-in="q" placeholder="${L('ابحث: ثوب، عباءة، بطانية…', 'Search: thobe, abaya, blanket…')}" value="${esc(S.cust.q)}" autocomplete="off"></div>
    ${q ? '' : `<div class="chips" role="group" aria-label="${L('الأقسام', 'Categories')}">${CATALOG.map(c => `<button class="chip-btn" data-a="cat" data-id="${c.id}" aria-pressed="${c.id === cats[0].id}">${N(c)}</button>`).join('')}</div>`}
  </div>
  ${!LIVE.dryClean ? `<div class="pad" style="padding-top:8px"><div class="notice warn">${IC.info(17)}<span>${L('التنظيف الجاف متوقف اليوم، وبقية الخدمات متاحة.', 'Dry cleaning is paused today; other services are available.')}</span></div></div>` : ''}
  <div class="pad">${cats.length ? cats.map(c => `${q ? `<h2 style="font-size:16px;margin:14px 0 4px">${N(c)}</h2>` : ''}<ul class="tiles" aria-label="${N(c)}">${c.items.map(tile).join('')}</ul>`).join('')
    : `<div class="empty"><span class="gi men" aria-hidden="true">${IC.search(28)}</span><b>${L(`لا توجد نتائج لـ «${esc(S.cust.q)}»`, `No results for “${esc(S.cust.q)}”`)}</b><span>${L('جرّب كلمة أخرى، أو اطلب «استلامًا سريعًا» ونعدّ القطع عندنا.', 'Try another word, or book a quick pickup and we will count the items for you.')}</span><button class="btn sm" data-a="clearq">${L('مسح البحث', 'Clear search')}</button></div>`}</div>
  <p class="pad muted small" style="margin-top:6px">${L('اضغط على القطعة لاختيار الخدمة والعدد. الأسعار تجريبية للعرض.', 'Tap an item to choose the service and quantity.')}</p>`;
}

function cCart() {
  const lines = cartLines(), t = calc(cartDraft());
  if (!lines.length) return `<div class="pad topbar"><h1 tabindex="-1" data-focus>${L('السلة', 'Basket')}</h1></div>
    <div class="empty screen"><span class="gi men" aria-hidden="true">${IC.bag(30)}</span><b>${L('السلة فارغة', 'Your basket is empty')}</b><span>${L('اختر القطع من قائمة الأسعار، أو اطلب استلامًا سريعًا ونعدّها عندنا.', 'Pick items from the price list, or book a quick pickup and we will count them.')}</span>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><button class="btn primary sm" data-a="go" data-to="catalog">${L('قائمة الأسعار', 'Price list')}</button><button class="btn sm" data-a="quick">${L('استلام سريع', 'Quick pickup')}</button></div></div>`;
  return `<div class="pad topbar"><h1 tabindex="-1" data-focus>${L('السلة', 'Basket')}</h1></div>
  <div class="pad">${steps(0)}</div>
  <div class="pad stack screen" style="padding-top:12px">
    <div class="card" style="padding-block:4px">${lines.map(l => {
      const k = `${l.id}|${l.svc}`, nm = esc(N(ITEMS[l.id]));
      return `<div class="line">${itemIcon(l.id, 'thumb')}<div class="line-main"><b>${nm}</b><span>${svcName(l.svc)} · ${money(priceOf(l))} ${L('للقطعة', 'each')}</span></div>
        <div class="stepper"><button data-a="line" data-k="${k}" data-d="1" aria-label="${L('زيادة', 'Add one')} ${nm}">+</button><output aria-live="polite" aria-label="${L('عدد', 'Quantity of')} ${nm}">${l.qty}</output><button data-a="line" data-k="${k}" data-d="-1" aria-label="${l.qty === 1 ? L('حذف', 'Remove') : L('إنقاص', 'Remove one')} ${nm}">−</button></div>
        <span class="line-sum">${money(priceOf(l) * l.qty)}</span></div>`;
    }).join('')}</div>
    <button class="btn sm" data-a="go" data-to="catalog" style="align-self:flex-start">+ ${L('أضف قطعًا أخرى', 'Add more items')}</button>
    ${speedPicker()}
    <div class="field"><label for="c-note">${L('ملاحظات للمغسلة (اختياري)', 'Notes for the laundry (optional)')}</label><textarea class="input" id="c-note" data-in="note" placeholder="${L('مثال: بقعة على الثوب الأبيض، بدون معطّر', 'e.g. stain on the white thobe, no fragrance')}">${esc(S.cust.note)}</textarea></div>
    <div class="card">${totalsHtml(t, { method: 'pickup' })}<p class="muted small" style="margin-top:10px">${L('رسوم التوصيل تُحذف إن اخترت تسليم القطع بنفسك في المحل.', 'No delivery fee if you drop the items at the store yourself.')}</p></div>
  </div>`;
}
function speedPicker() {
  const sp = S.cust.speed;
  return `<div role="group" aria-labelledby="lbl-speed"><div class="lbl" id="lbl-speed" style="margin-bottom:8px">${L('مدة التجهيز', 'Turnaround')}</div><div class="grid2">
    <button class="choice" data-a="speed" data-v="normal" aria-pressed="${sp === 'normal'}"><b>${IC.clock(17)} ${L('عادي', 'Standard')}</b><span>${L('خلال 48 ساعة', 'Within 48 hours')}</span></button>
    <button class="choice" data-a="speed" data-v="urgent" aria-pressed="${sp === 'urgent'}"><b>${IC.bolt(17)} ${L('مستعجل', 'Express')}</b><span>${L('خلال 24 ساعة · +50%', 'Within 24 hours · +50%')}</span></button>
  </div></div>`;
}
function totalsHtml(t, o = {}) {
  if (o.awaiting) return `<div class="totals"><div class="row"><span>${L('الإجمالي', 'Total')}</span><span>${L('يُحدَّد بعد الجرد', 'Set after counting')}</span></div>
    <div class="row muted small"><span>${L('الاستلام والتوصيل', 'Pickup & delivery')}</span><span>${money(FEE)} ${L('أو مجانًا من', 'or free from')} ${money(FREE_OVER)}</span></div></div>`;
  return `<div class="totals">
    <div class="row"><span>${L('المجموع', 'Subtotal')} (${pcs(t.count)})</span><span>${money(t.sub)}</span></div>
    ${t.urgent ? `<div class="row"><span>${L('رسوم الاستعجال', 'Express fee')}</span><span>${money(t.urgent)}</span></div>` : ''}
    ${o.method === 'pickup' ? `<div class="row"><span>${L('الاستلام والتوصيل', 'Pickup & delivery')}</span><span>${t.delivery ? money(t.delivery) : L('مجانًا', 'Free')}</span></div>` : ''}
    ${t.discount ? `<div class="row disc"><span>${L('خصم أول طلب', 'First-order discount')}</span><span>− ${money(t.discount)}</span></div>` : ''}
    ${t.subFree ? `<div class="row disc"><span>${L('من اشتراكك الشهري', 'Covered by your plan')} (${pcs(t.subPieces)})</span><span>− ${money(t.subFree)}</span></div>` : ''}
    ${t.loyalty ? `<div class="row disc"><span>${L('مكافأة بطاقة الولاء', 'Loyalty reward')}</span><span>− ${money(t.loyalty)}</span></div>` : ''}
    <div class="row total"><span>${L('الإجمالي شامل الضريبة', 'Total incl. VAT')}</span><span>${money(t.total)}</span></div>
  </div>`;
}
function backBar(title, to) {
  return `<div class="pad topbar"><button class="icon-btn" data-a="go" data-to="${to}" aria-label="${L('رجوع', 'Back')}">${IC.back(20)}</button><h1 tabindex="-1" data-focus>${title}</h1></div>`;
}
const errAttr = k => ui.errors[k] ? `aria-invalid="true" aria-describedby="err-${k}"` : '';
function fieldErr(k) { return ui.errors[k] ? `<span class="err" id="err-${k}">${ui.errors[k]}</span>` : ''; }
const ERR = {
  slot: () => L('اختر موعد الاستلام.', 'Choose a pickup time.'),
  district: () => L('اختر الحي.', 'Choose your area.'),
  other: () => L('هذا الحي خارج نطاق الاستلام.', 'That area is outside our pickup zone.'),
  address: () => L('اكتب وصفًا مختصرًا للعنوان.', 'Add a short address description.'),
  min: () => L('الحد الأدنى للاستلام.', 'Pickup minimum.'),
  name: () => L('اكتب اسمك.', 'Enter your name.'),
  phone: () => L('رقم سعودي يبدأ بـ 05 ومن 10 أرقام.', 'A Saudi number: 10 digits starting with 05.'),
};

function cCheckout() {
  const c = S.cust, pick = c.method === 'pickup';
  const t = calc(cartDraft());
  const belowMin = pick && !c.quick && t.sub < MIN_PICKUP;
  const days = Array.from({ length: BOOK_DAYS }, (_, i) => i).map(d => `<button class="chip-btn" data-a="day" data-v="${d}" aria-pressed="${c.day === d}">${dayLabel(d)}<span class="cnt">${dayDate(d, 'short')}</span></button>`).join('');
  const slots = SLOTS.map(s => {
    const st = slotState(c.day, s.id), lab = slotLabel(s.id);
    return `<button class="slot" data-a="slot" data-v="${s.id}" aria-pressed="${c.slot === s.id}" ${st !== 'ok' ? `disabled aria-label="${lab}، ${slotNote(st)}"` : ''}><span dir="auto">${lab}</span>${st !== 'ok' ? `<small aria-hidden="true">${slotNote(st)}</small>` : ''}</button>`;
  }).join('');
  const closedNote = c.day === 0 && !LIVE.open ? `<div class="notice warn">${IC.info(17)}<span>${L('المغسلة مغلقة مؤقتًا اليوم. اختر موعدًا من الغد.', 'The laundry is closed today. Pick a time from tomorrow.')}</span></div>`
    : c.day === 0 && !LIVE.todaySlots ? `<div class="notice warn">${IC.info(17)}<span>${L('مواعيد الاستلام لليوم متوقفة. اختر موعدًا من الغد.', 'Pickups are paused for today. Pick a time from tomorrow.')}</span></div>` : '';
  return `${backBar(c.quick ? L('استلام سريع', 'Quick pickup') : L('الموعد والعنوان', 'Time & address'), c.quick ? 'home' : 'cart')}
  <div class="pad">${steps(1)}</div>
  <div class="pad stack screen" style="padding-top:12px">
    ${c.quick ? `<div class="notice">${IC.bag(17)}<span>${L('جهّز ملابسك في كيس. نعدّ القطع في المغسلة ونرسل لك الفاتورة على واتساب قبل البدء بالغسيل.', 'Put your clothes in a bag. We count the items at the laundry and send you the bill on WhatsApp before washing.')}</span></div>${speedPicker()}
      <div class="field"><label for="c-note">${L('ملاحظات للمغسلة (اختياري)', 'Notes for the laundry (optional)')}</label><textarea class="input" id="c-note" data-in="note" placeholder="${L('مثال: كيسان، فيهما بطانية', 'e.g. two bags, one has a blanket')}">${esc(c.note)}</textarea></div>` : ''}
    <div class="card" role="group" aria-labelledby="lbl-method">
      <div class="sec-title" id="lbl-method">${L('طريقة التسليم', 'How to hand over')}</div>
      <div class="grid2">
        <button class="choice" data-a="method" data-v="pickup" aria-pressed="${pick}"><b>${IC.truck(17)} ${L('استلام وتوصيل', 'Pickup & delivery')}</b><span>${money(FEE)} · ${L('مجانًا من', 'free from')} ${money(FREE_OVER)}</span></button>
        <button class="choice" data-a="method" data-v="dropoff" aria-pressed="${!pick}"><b>${IC.store(17)} ${L('أسلّمها في المحل', 'Drop off in store')}</b><span>${L('بدون رسوم توصيل', 'No delivery fee')}</span></button>
      </div>
      ${belowMin ? `<div class="notice warn" style="margin-top:10px">${IC.alert(17)}<span>${L('الحد الأدنى لطلبات الاستلام', 'Pickup orders have a minimum of')} ${money(MIN_PICKUP)}. ${L('أضف قطعًا أو اختر التسليم في المحل.', 'Add items or choose in-store drop-off.')}</span></div>` : ''}
    </div>
    ${pick ? `<div class="card" role="group" aria-labelledby="lbl-slot">
      <div class="sec-title" id="lbl-slot">${L('موعد الاستلام من البيت', 'Pickup time')}</div>
      <div class="chips" role="group" aria-label="${L('اليوم', 'Day')}" style="padding-top:0">${days}</div>
      ${closedNote}
      <div class="slots" role="group" aria-label="${L('الفترة', 'Time window')}" style="margin-top:${closedNote ? '10px' : '0'}" ${ui.errors.slot ? 'aria-describedby="err-slot"' : ''}>${slots}</div>
      ${fieldErr('slot')}
    </div>
    <div class="card stack" style="padding-block:16px;gap:14px">
      <div class="sec-title" style="margin:0">${L('العنوان', 'Address')}</div>
      <div class="field"><label for="c-district">${L('الحي', 'Area')}</label>
        <select class="input" id="c-district" data-in="district" ${errAttr('district')}><option value="">${L('اختر الحي', 'Choose your area')}</option>${DISTRICTS.map(d => `<option value="${d[0]}" ${c.district === d[0] ? 'selected' : ''}>${P(d)}</option>`).join('')}<option value="other" ${c.district === 'other' ? 'selected' : ''}>${L('حي آخر', 'Another area')}</option></select>
        ${c.district === 'other' && !ui.errors.district ? `<span class="err">${L('هذا الحي خارج نطاق الاستلام حاليًا. يمكنك تسليم القطع في المحل.', 'That area is outside our pickup zone. You can drop off at the store.')}</span>` : fieldErr('district')}
      </div>
      <div class="field"><label for="c-address">${L('وصف العنوان', 'Address details')}</label>
        <input class="input" id="c-address" data-in="address" type="text" autocomplete="street-address" placeholder="${L('الشارع، رقم المنزل أو العمارة، علامة مميزة', 'Street, house or building number, landmark')}" value="${esc(c.address)}" ${errAttr('address')}>
        ${fieldErr('address')}
        <button class="btn quiet sm" data-a="locate" style="align-self:flex-start;padding-inline:0">${IC.pin(17)} ${c.mapUrl ? L('تم تحديد موقعك · اضغط للتحديث', 'Location added · tap to update') : L('أرسل موقعي للمندوب (اختياري)', 'Share my location with the driver (optional)')}</button>
      </div>
    </div>` : `<div class="notice">${IC.store(17)}<span>${L('سلّم القطع في المحل في أي وقت خلال ساعات العمل، واذكر رقم طلبك عند الوصول.', 'Drop the items at the store during opening hours and mention your order number.')}</span></div>`}
    <div class="card stack" style="padding-block:16px;gap:14px">
      <div class="sec-title" style="margin:0">${L('بياناتك', 'Your details')}</div>
      <div class="grid2">
        <div class="field"><label for="c-name">${L('الاسم', 'Name')}</label><input class="input" id="c-name" data-in="name" type="text" autocomplete="name" value="${esc(c.name)}" placeholder="${L('مثال: محمد', 'e.g. Mohammed')}" ${errAttr('name')}>${fieldErr('name')}</div>
        <div class="field"><label for="c-phone">${L('الجوال', 'Mobile')}</label><input class="input tel" id="c-phone" data-in="phone" type="tel" inputmode="tel" dir="ltr" autocomplete="tel" value="${esc(c.phone)}" placeholder="05XXXXXXXX" ${errAttr('phone')}>${fieldErr('phone')}</div>
      </div>
    </div>
    <div class="card" role="radiogroup" aria-labelledby="lbl-pay">
      <div class="sec-title" id="lbl-pay">${L('الدفع', 'Payment')}</div>
      <div class="opts">
        <label class="opt is-on"><input type="radio" name="pay" value="cod" checked><span class="opt-main"><span class="opt-name">${L('عند التسليم', 'On delivery')}</span><span class="opt-sub">${L('نقدًا أو بالشبكة مع المندوب أو في المحل', 'Cash or card with the driver or in store')}</span></span></label>
        <label class="opt is-off"><input type="radio" name="pay" value="online" disabled><span class="opt-main"><span class="opt-name">${L('دفع إلكتروني · مدى / Apple Pay', 'Pay online · mada / Apple Pay')}</span><span class="opt-sub">${L('قريبًا', 'Coming soon')}</span></span></label>
      </div>
    </div>
    <div class="card">${totalsHtml(t, { method: c.method, awaiting: c.quick })}</div>
    <p class="muted small">${L('بتأكيد الطلب، توافق على استخدام اسمك وجوالك وعنوانك لتنفيذ هذا الطلب والتواصل بشأنه فقط.', 'By confirming, you agree we use your name, mobile and address only to fulfil and contact you about this order.')}</p>
  </div>`;
}
function checkoutFoot() {
  const c = S.cust, t = calc(cartDraft());
  const label = c.quick ? L('تأكيد طلب الاستلام', 'Confirm pickup') : `${L('تأكيد الطلب', 'Place order')} · ${money(t.total)}`;
  const n = Object.keys(ui.errors).length;
  return `<div class="footbar pad">${n ? `<span class="err" style="text-align:center">${L(`أكمل الحقول المحددة بالأحمر (${n})`, `Complete the fields marked in red (${n})`)}</span>` : ''}<button class="btn primary wide" data-a="confirm" ${ui.busy ? 'disabled aria-busy="true"' : ''}>${ui.busy ? L('جارٍ الإرسال…', 'Sending…') : label}</button></div>`;
}

function cSuccess() {
  /* the order shows up in the live list a moment later; until then use what the server answered */
  const o = findOrder(S.cust.trackN) || (ui.lastPlaced && ui.lastPlaced.n === S.cust.trackN ? ui.lastPlaced : null);
  if (!o) return cHome();
  return `<div class="pad">${steps(3)}</div>
  <div class="pad stack screen" style="padding-top:22px;align-items:stretch">
    <div style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px">
      <span class="check-anim" aria-hidden="true">${IC.check(32)}</span>
      <h1 tabindex="-1" data-focus style="font-size:23px">${L(`وصل طلبك إلى ${esc(shopName())}`, `${esc(shopName())} has your order`)}</h1>
      <p class="muted">${L('بانتظار تأكيد المغسلة. تابع كل تحديث من «طلباتي».', 'Waiting for the laundry to confirm. Follow every update in “Orders”.')}</p>
    </div>
    <div class="ticket"><span><span class="t-lab">${L('رقم الطلب', 'Order no.')}</span><br><span class="t-num" dir="ltr">${o.n}</span></span><span class="perf"></span><span class="t-side">${o.method === 'pickup' ? slotText(o) : L('تسليم في المحل', 'In-store drop-off')}<br><span style="font-weight:600">${awaitingCount(o) ? L('الإجمالي بعد الجرد', 'Total after counting') : money(calc(o).total)}</span></span></div>
    <div class="grid2"><button class="btn primary" data-a="track" data-n="${o.n}">${L('تتبّع الطلب', 'Track order')}</button><button class="btn" data-a="go" data-to="home">${L('الرئيسية', 'Home')}</button></div>
  </div>`;
}

function cTrack() {
  const o = findOrder(S.cust.trackN);
  if (!o) return cOrders();
  const t = calc(o), flow = FLOW[o.method], hist = {};
  o.history.forEach(h => { hist[h.s] = h.t; });
  const stopped = o.status === 'rejected' || o.status === 'cancelled';
  const curIdx = stopped ? -1 : flow.indexOf(o.status);
  const tl = flow.map((s, i) => {
    const cls = stopped ? '' : i < curIdx || (i === curIdx && s === 'done') ? 'done' : i === curIdx ? 'cur' : '';
    const label = s === 'ready' && o.method === 'dropoff' ? L('جاهز للاستلام من المحل', 'Ready for collection') : stepName(s);
    return `<li class="${cls}" ${cls === 'cur' ? 'aria-current="step"' : ''}><span class="dotc" aria-hidden="true">${cls === 'done' ? IC.check(13) : ''}</span><span class="tl-name">${label}${cls === 'done' ? `<span class="sr"> (${L('تم', 'done')})</span>` : ''}</span><span class="tl-time">${hist[s] ? clock(hist[s]) : ''}</span></li>`;
  }).join('');
  const late = o.status === 'new' && Date.now() - o.created > LATE_MIN * MIN;
  const pct = progressOf(o);
  return `${backBar(L('تتبّع الطلب', 'Track order'), 'orders')}
  <div class="pad stack screen" style="padding-top:8px">
    <div class="ticket mini"><span><span class="t-lab">${L('رقم الطلب', 'Order no.')}</span><br><span class="t-num" dir="ltr">${o.n}</span></span><span class="perf"></span><span class="t-side">${o.method === 'pickup' ? L('استلام وتوصيل', 'Pickup & delivery') : L('تسليم في المحل', 'In-store drop-off')}<br>${o.speed === 'urgent' ? L('مستعجل', 'Express') : L('عادي', 'Standard')}</span></div>
    ${stopped ? `<div class="notice bad">${IC.alert(17)}<span>${o.status === 'rejected' ? `${L('اعتذرت المغسلة عن الطلب:', 'The laundry declined the order:')} ${esc(P(REASONS[o.rejectReason]))}.` : L('أُلغي هذا الطلب بناءً على طلبك.', 'This order was cancelled at your request.')}</span></div>` : `
    <div class="card status-card">
      <span class="small muted">${L('الحالة الآن', 'Status now')}</span>
      <span class="big">${statusLabel(o)}</span>
      <span class="prog" role="progressbar" aria-label="${L('تقدّم الطلب', 'Order progress')}" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.max(6, pct)}%"></i></span>
      ${o.slot && ['new', 'accepted'].includes(o.status) ? `<span class="small">${IC.clock(15)} ${L('موعد الاستلام:', 'Pickup:')} <b>${slotText(o)}</b></span>` : ''}
    </div>`}
    ${late ? `<div class="notice warn">${IC.clock(17)}<span>${L('لم تؤكد المغسلة طلبك بعد. راسلها على واتساب من الزر بالأسفل.', 'The laundry has not confirmed yet. Message them on WhatsApp below.')}</span></div>` : ''}
    <div class="card"><h2 class="sec-title">${L('مراحل الطلب', 'Order steps')}</h2><ol class="tl">${tl}</ol></div>
    <div class="card"><h2 class="sec-title">${IC.receipt(18)} ${L('الفاتورة', 'Bill')}</h2>
      ${awaitingCount(o) ? `<p class="muted small" style="margin-bottom:10px">${L('سيتم جرد القطع عند الاستلام، وتظهر الفاتورة هنا وتصلك على واتساب.', 'Items are counted at pickup; the bill appears here and on WhatsApp.')}</p>${totalsHtml(t, { awaiting: true })}`
        : `<div style="margin-bottom:10px">${o.items.map(l => `<div class="line" style="padding-block:8px">${itemIcon(l.id, 'thumb sm')}<div class="line-main"><b>${esc(N(ITEMS[l.id]))} × <span class="num">${l.qty}</span></b><span>${svcName(l.svc)}</span></div><span class="line-sum">${money(priceOf(l) * l.qty)}</span></div>`).join('')}</div>
        ${totalsHtml(t, { method: o.method })}
        <p class="small" style="margin-top:10px">${o.paid ? L('مدفوع', 'Paid') : L('الدفع عند التسليم، نقدًا أو بالشبكة', 'Pay on delivery, cash or card')}</p>`}
    </div>
    <div class="card"><dl class="kv">
      <dt>${L('التسليم', 'Handover')}</dt><dd>${o.method === 'pickup' ? L('استلام وتوصيل', 'Pickup & delivery') : L('في المحل', 'In store')}</dd>
      ${o.slot ? `<dt>${L('الموعد', 'Time')}</dt><dd>${slotText(o)}</dd>` : ''}
      ${o.customer.district ? `<dt>${L('العنوان', 'Address')}</dt><dd>${esc(distName(o.customer.district))} · ${esc(o.customer.address)}</dd>` : ''}
      <dt>${L('المدة', 'Turnaround')}</dt><dd>${o.speed === 'urgent' ? L('مستعجل · 24 ساعة', 'Express · 24 h') : L('عادي · 48 ساعة', 'Standard · 48 h')}</dd>
      ${o.note ? `<dt>${L('ملاحظتك', 'Your note')}</dt><dd>${esc(o.note)}</dd>` : ''}
    </dl></div>
    <div class="grid2">
      ${waLink(SHOP_PHONE, L(`مرحبًا، بخصوص طلبي رقم ${o.n}`, `Hello, about my order #${o.n}`)) ? `<a class="btn" href="${waLink(SHOP_PHONE, L(`مرحبًا، بخصوص طلبي رقم ${o.n}`, `Hello, about my order #${o.n}`))}" target="_blank" rel="noopener">${IC.chat(18)} ${L('راسل المغسلة', 'Message us')}</a>` : '<span></span>'}
      ${o.status === 'done' && o.items.length ? `<button class="btn primary" data-a="again" data-n="${o.n}">${IC.repeat(18)} ${L('أعد الطلب', 'Reorder')}</button>`
        : o.status === 'new' ? `<button class="btn danger" data-a="cancel" data-n="${o.n}" ${ui.busy ? 'disabled' : ''}>${ui.cancelArm === o.n ? L('اضغط للتأكيد', 'Tap to confirm') : L('إلغاء الطلب', 'Cancel order')}</button>` : '<span></span>'}
    </div>
  </div>`;
}

function cOrders() {
  const list = myOrders();
  const head = `<div class="pad topbar"><h1 tabindex="-1" data-focus style="flex:1">${L('طلباتي', 'My orders')}</h1>${gearBtn()}</div>`;
  if (R.authKnown && !(R.user && R.user.phone)) return `${head}<div class="pad screen">${signInCard(L('طلباتك محفوظة على رقم جوالك، فتشوفها من أي جهاز.', 'Your orders are saved on your mobile number, so you can see them on any device.'))}</div>`;
  if (!R.ordersLoaded) return `${head}<div class="pad screen"><p class="muted" role="status">${L('جارٍ التحميل…', 'Loading…')}</p></div>`;
  return `${head}
  <div class="pad screen">${list.length ? `<ul class="olist" style="list-style:none;margin:0;padding:0">${list.map(o => `<li class="orow">
      <button class="open" data-a="track" data-n="${o.n}">
        <span class="tnum" dir="ltr">${o.n}</span>
        <span class="orow-main"><b>${statusLabel(o)}</b><span>${o.method === 'pickup' ? slotText(o) : L('تسليم في المحل', 'In-store drop-off')} · ${awaitingCount(o) ? L('بانتظار الجرد', 'awaiting count') : money(calc(o).total)}</span></span>
        ${IC.fwd(18)}</button>
      ${o.status === 'done' && o.items.length ? `<button class="icon-btn" data-a="again" data-n="${o.n}" aria-label="${L('أعد الطلب', 'Reorder')} ${o.n}">${IC.repeat(18)}</button>` : ''}
    </li>`).join('')}</ul>`
    : `<div class="empty"><span class="gi home" aria-hidden="true">${IC.receipt(30)}</span><b>${L('لا توجد طلبات بعد', 'No orders yet')}</b><span>${L('جرّب طلبًا الآن، وسيظهر هنا مع حالته ورسائله.', 'Place one now and it will show here with its status and messages.')}</span><button class="btn primary sm" data-a="go" data-to="catalog">${L('ابدأ طلبًا', 'Start an order')}</button></div>`}</div>`;
}

function cWallet() {
  const card = myCard(), sub = activeSub(card.sub), plan = sub && planOf(sub.plan);
  const phone = R.user && R.user.phone ? normPhone(R.user.phone) : '', hasPhone = !!phone;
  const left = STAMP_GOAL - card.stamps;
  const dots = Array.from({ length: STAMP_GOAL }, (_, i) => `<span class="stamp ${i < card.stamps ? 'on' : ''}" aria-hidden="true">${i < card.stamps ? IC.check(18) : i === STAMP_GOAL - 1 ? IC.star(16) : ''}</span>`).join('');
  return `<div class="pad topbar"><h1 tabindex="-1" data-focus style="flex:1">${L('بطاقتي', 'My card')}</h1>${gearBtn()}</div>
  <div class="pad stack screen" style="padding-top:8px">
    <section class="loyal" aria-labelledby="h-loyal">
      <div class="loyal-top"><span class="logo sm" aria-hidden="true">${IC.hanger(20)}</span><span style="flex:1;min-width:0"><b>${esc(shopName())}</b><br><span id="h-loyal">${L('بطاقة الولاء', 'Loyalty card')}</span></span><span class="loyal-cnt num" dir="ltr">${card.stamps}/${STAMP_GOAL}</span></div>
      <div class="stamps" role="img" aria-label="${L(`${card.stamps} أختام من ${STAMP_GOAL}`, `${card.stamps} of ${STAMP_GOAL} stamps`)}">${dots}</div>
      <p class="loyal-note">${L(`كل طلب مكتمل = ختم. باقي ${left} ${left === 1 ? 'طلب' : 'طلبات'} على خصم`, `Every completed order earns a stamp. ${left} more for`)} ${money(STAMP_REWARD)}${L('', ' off')}</p>
    </section>
    ${card.rewards ? `<div class="notice ok">${IC.star(17)}<span>${L(`عندك ${card.rewards === 1 ? 'مكافأة' : `${card.rewards} مكافآت`}: خصم`, `You have ${card.rewards} reward${card.rewards > 1 ? 's' : ''}:`)} ${money(STAMP_REWARD)} ${L('يُطبّق تلقائيًا على طلبك القادم.', 'off, applied automatically to your next order.')}</span></div>` : ''}
    <div class="card member">
      <div class="sec-title" style="margin-bottom:6px">${IC.user(18)} ${L('رقم العضوية', 'Member number')}</div>
      ${hasPhone ? `<div class="member-no num" dir="ltr">${phone}</div><p class="muted small">${L('قل رقم جوالك للموظف في المحل، وتنضاف أختامك ويُخصم من اشتراكك تلقائيًا.', 'Give this mobile number at the counter so your stamps and plan apply automatically.')}</p>`
        : `<p class="muted small" style="margin-bottom:10px">${L('رقم جوالك هو رقم عضويتك في المحل. ادخل به عشان تشوف أختامك واشتراكك.', 'Your mobile number is your member number at the store. Sign in to see your stamps and plan.')}</p><button class="btn primary sm" data-a="signin">${L('ادخل برقم جوالك', 'Sign in with your mobile')}</button>`}
    </div>
    <section aria-labelledby="h-sub">
      <div class="sec-head"><h2 id="h-sub">${L('الاشتراك الشهري', 'Monthly plan')}</h2></div>
      ${sub ? `<div class="card stack" style="padding-block:16px;gap:12px">
          <div style="display:flex;align-items:center;gap:10px"><span class="chip ok">${L('مفعّل', 'Active')}</span><b style="font-family:var(--f-display);font-size:17px">${P(plan.name)}</b><span class="muted small" style="margin-inline-start:auto">${money(plan.price)} ${L('شهريًا', '/ month')}</span></div>
          <div><div style="display:flex;justify-content:space-between;font-weight:800"><span>${L('المتبقي هذا الشهر', 'Left this month')}</span><span class="num">${sub.left} / ${plan.pieces}</span></div>
          <span class="prog" role="progressbar" aria-label="${L('المتبقي من الاشتراك', 'Plan remaining')}" aria-valuenow="${sub.left}" aria-valuemin="0" aria-valuemax="${plan.pieces}" style="display:block;margin-top:8px"><i style="width:${Math.max(3, Math.round(sub.left / plan.pieces * 100))}%"></i></span></div>
          <p class="muted small">${L('صالح حتى', 'Valid until')} ${dayLabel(dayOffset(sub.renews))}${L('، وتجدّده من المحل.', ', renew it at the store.')} ${plan.svcs ? L('يغطي الكوي فقط للملابس.', 'Covers pressing of clothes.') : L('يغطي الغسيل والكوي للملابس، ولا يشمل التنظيف الجاف والمفروشات.', 'Covers wash & press for clothes; not dry cleaning or linens.')}</p>
        </div>`
      : `<div class="opts">${PLANS.map(p => `<div class="plan">
          <div style="flex:1;min-width:0"><b>${P(p.name)}</b><span class="muted small" style="display:block">${P(p.note)}</span></div>
          <div class="plan-side"><span class="plan-price">${money(p.price)}</span><span class="muted small">${L('شهريًا', '/ month')}</span></div>
        </div>`).join('')}</div>
        <p class="muted small" style="margin-top:8px">${L('اشترك من المحل: ادفع عند الكاشير وقل رقم جوالك، ويتفعّل هنا فورًا. بعدها يُخصم تلقائيًا في كل طلب، من التطبيق أو في المحل.', 'Subscribe at the store: pay at the counter and give your mobile number, and it shows here right away. It is then used automatically on every order, in the app or at the store.')}</p>`}
    </section>
  </div>`;
}

/* sign-in with the mobile number: one SMS code per device, then the app remembers it */
const OTP_ERR = {
  phone: () => L('رقم سعودي يبدأ بـ 05 ومن 10 أرقام.', 'A Saudi number: 10 digits starting with 05.'),
  'bad-code': () => L('الرمز غير صحيح. تأكد منه وجرّب مرة ثانية.', 'That code is wrong. Check it and try again.'),
  'code-expired': () => L('انتهت صلاحية الرمز. اطلب رمزًا جديدًا.', 'The code expired. Ask for a new one.'),
  'too-many': () => L('محاولات كثيرة. انتظر قليلًا ثم جرّب.', 'Too many tries. Wait a bit and try again.'),
  network: () => L('تعذّر الاتصال. تأكد من الإنترنت وجرّب مرة ثانية.', 'No connection. Check the internet and try again.'),
  auth: () => L('تعذّر التحقق. جرّب مرة ثانية.', 'Could not verify. Try again.'),
};
function otpSheet(sh) {
  const close = `<button class="icon-btn" data-a="closesheet" aria-label="${L('إغلاق', 'Close')}">✕</button>`;
  const err = sh.err ? `<span class="err" id="otp-err" role="alert">${(OTP_ERR[sh.err] || OTP_ERR.auth)()}</span>` : '';
  const body = sh.step === 'code' ? `
    <p>${L('أرسلنا رمزًا من 6 أرقام إلى', 'We sent a 6-digit code to')} <b class="num" dir="ltr">${esc(sh.phone)}</b></p>
    <div class="field"><label for="otp-code">${L('رمز التحقق', 'Verification code')}</label>
      <input class="input tel wk-phone" id="otp-code" data-otp="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" value="${esc(sh.code)}" ${sh.err ? 'aria-invalid="true" aria-describedby="otp-err"' : ''}>${err}</div>
    ${sh.hint ? `<p class="muted small">${L('رمز التجربة على هذا الجهاز:', 'Test code on this computer:')} <b class="num" dir="ltr">${esc(sh.hint)}</b></p>` : ''}
    <button class="btn primary wide" data-a="otpverify" ${sh.busy ? 'disabled aria-busy="true"' : ''}>${sh.busy ? L('جارٍ التحقق…', 'Checking…') : L('تأكيد', 'Confirm')}</button>
    <div class="grid2"><button class="btn quiet sm" data-a="otpback">${L('غيّر الرقم', 'Change number')}</button><button class="btn quiet sm" data-a="otpsend" ${sh.busy ? 'disabled' : ''}>${L('أعد إرسال الرمز', 'Send again')}</button></div>`
    : `
    <p class="muted">${L('نرسل لك رمز تحقق برسالة نصية مرة وحدة على هذا الجهاز. بعدها تشوف طلباتك وأختامك من أي مكان.', 'We text you a code once on this device. After that you can see your orders and stamps anywhere.')}</p>
    <div class="field"><label for="otp-phone">${L('رقم الجوال', 'Mobile number')}</label>
      <input class="input tel wk-phone" id="otp-phone" data-otp="phone" type="tel" inputmode="tel" autocomplete="tel" dir="ltr" placeholder="05XXXXXXXX" value="${esc(sh.phone)}" ${sh.err ? 'aria-invalid="true" aria-describedby="otp-err"' : ''}>${err}</div>
    <button class="btn primary wide" data-a="otpsend" ${sh.busy ? 'disabled aria-busy="true"' : ''}>${sh.busy ? L('جارٍ الإرسال…', 'Sending…') : L('أرسل الرمز', 'Send code')}</button>`;
  return `<div class="sheet-wrap" data-a="closesheet" data-self="1"><div class="sheet pad" role="dialog" aria-modal="true" aria-labelledby="otp-title">
    <div class="grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2 id="otp-title" tabindex="-1">${sh.then === 'order' ? L('آخر خطوة: تأكيد رقمك', 'Last step: confirm your number') : L('الدخول برقم الجوال', 'Sign in with your mobile')}</h2>${close}</div>
    ${body}
  </div></div>`;
}
function openOtp(then) {
  const known = R.user && R.user.phone ? normPhone(R.user.phone) : '';
  ui.sheetC = { type: 'otp', step: 'phone', phone: S.cust.phone || known, code: '', err: '', busy: false, then: then || null, hint: '' };
}

function cSheet() {
  const sh = ui.sheetC;
  if (!sh) return '';
  if (sh.type === 'prefs') return prefsSheet('c');
  if (sh.type === 'otp') return otpSheet(sh);
  const it = ITEMS[sh.id];
  const avail = Object.keys(it.prices).filter(k => !(k === 'dry' && !LIVE.dryClean));
  const inCart = S.cust.cart[`${sh.id}|${sh.svc}`];
  const price = sh.svc ? it.prices[sh.svc] : 0;
  return `<div class="sheet-wrap" data-a="closesheet" data-self="1"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-title">
    <div class="pad" style="display:flex;flex-direction:column;gap:16px">
    <div class="grab" aria-hidden="true"></div>
    <div class="sheet-head"><div class="sheet-title">${itemIcon(sh.id)}<div><h2 id="sh-title" tabindex="-1">${esc(N(it))}</h2>${it.note ? `<p class="muted small">${esc(P(it.note))}</p>` : ''}</div></div><button class="icon-btn" data-a="closesheet" aria-label="${L('إغلاق', 'Close')}">✕</button></div>
    <div role="radiogroup" aria-labelledby="svc-lbl"><div class="lbl" id="svc-lbl" style="margin-bottom:8px">${L('الخدمة', 'Service')}</div>
    <div class="opts">${Object.entries(it.prices).map(([k, p]) => {
      const off = k === 'dry' && !LIVE.dryClean;
      return `<label class="opt ${off ? 'is-off' : sh.svc === k ? 'is-on' : ''}"><input type="radio" name="svc" value="${k}" data-a="svc" ${sh.svc === k ? 'checked' : ''} ${off ? 'disabled' : ''}><span class="opt-main"><span class="opt-name">${svcName(k)}</span><span class="opt-sub">${off ? L('متوقف اليوم', 'Paused today') : P(SVC_NOTE[k])}</span></span><span class="opt-price">${off ? '—' : money(p)}</span></label>`;
    }).join('')}</div></div>
    ${avail.length ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><span class="lbl" id="qty-lbl">${L('العدد', 'Quantity')}</span>
      <div class="stepper" role="group" aria-labelledby="qty-lbl"><button data-a="sq" data-d="1" aria-label="${L('زيادة العدد', 'Increase')}">+</button><output aria-live="polite">${sh.qty}</output><button data-a="sq" data-d="-1" aria-label="${L('إنقاص العدد', 'Decrease')}" ${sh.qty <= 1 ? 'disabled' : ''}>−</button></div></div>
      <button class="btn primary wide split" data-a="addcart"><span>${inCart ? L('تحديث السلة', 'Update basket') : L('أضف إلى السلة', 'Add to basket')}</span><span>${money(price * sh.qty)}</span></button>
      ${inCart ? `<button class="btn quiet wide" data-a="rmcart" style="color:var(--bad)">${L('إزالة من السلة', 'Remove from basket')}</button>` : ''}`
      : `<div class="notice warn">${IC.info(17)}<span>${L('هذه القطعة تحتاج تنظيفًا جافًا، والخدمة متوقفة اليوم. جرّب غدًا أو تواصل مع المغسلة.', 'This item needs dry cleaning, which is paused today. Try tomorrow or contact the laundry.')}</span></div>`}
    </div>
  </div></div>`;
}

/* first load, or the shop document is missing / unreachable */
function loadingView() {
  const msg = R.shopMissing ? L('هذا المحل غير موجود في قاعدة البيانات.', 'This shop is not in the database.')
    : R.offline ? L('تعذّر الاتصال. تأكد من الإنترنت، وبنكمل تلقائيًا لما يرجع.', 'No connection. Check the internet; we will continue when it is back.')
    : L('جارٍ التحميل…', 'Loading…');
  return `<div class="scroller"><div class="empty screen" style="min-height:70vh" role="status"><span class="gi men" aria-hidden="true">${IC.hanger(30)}</span><b>${msg}</b></div></div>`;
}
function renderCustomer() {
  if (!R.shop) { paint('c', 'loading' + S.lang, loadingView()); return; }
  const c = S.cust, s = c.screen;
  let body = '', foot = '';
  if (s === 'catalog') {
    body = cCatalog();
    const t = calc(cartDraft());
    if (t.count) foot = `<div class="footbar pad"><button class="btn primary wide split" data-a="go" data-to="cart"><span>${L('عرض السلة', 'View basket')} · ${pcs(t.count)}</span><span>${money(t.sub)}</span></button></div>`;
  } else if (s === 'cart') {
    body = cCart();
    if (cartLines().length) foot = `<div class="footbar pad"><button class="btn primary wide" data-a="tocheckout">${L('التالي: الموعد والعنوان', 'Next: time & address')}</button></div>`;
  } else if (s === 'checkout') { body = cCheckout(); foot = checkoutFoot(); }
  else if (s === 'success') body = cSuccess();
  else if (s === 'track') body = cTrack();
  else if (s === 'orders') body = cOrders();
  else if (s === 'wallet') body = cWallet();
  else body = cHome();
  const tab = s === 'catalog' ? 'catalog' : s === 'cart' ? 'cart' : s === 'wallet' ? 'wallet' : (s === 'orders' || s === 'track') ? 'orders' : 'home';
  const count = calc(cartDraft()).count;
  const tb = (to, ic, label, extra = '') => `<button data-a="go" data-to="${to}" ${tab === to ? 'aria-current="page"' : ''}><span class="t-ic">${IC[ic](21)}</span>${label}${extra}</button>`;
  const rew = myCard().rewards;
  const tabs = ['home', 'catalog', 'cart', 'orders', 'track', 'wallet'].includes(s) ? `<nav class="tabbar" aria-label="${L('التنقل الرئيسي', 'Main navigation')}">
    ${tb('home', 'home', L('الرئيسية', 'Home'))}${tb('catalog', 'list', L('الأسعار', 'Prices'))}${tb('cart', 'bag', L('السلة', 'Basket'), count ? `<span class="badge" aria-label="${pcs(count)}">${count}</span>` : '')}${tb('orders', 'receipt', L('طلباتي', 'Orders'))}${tb('wallet', 'card', L('بطاقتي', 'My card'), rew ? `<span class="badge" aria-label="${L('مكافأة جاهزة', 'Reward ready')}">${rew}</span>` : '')}
  </nav>` : '';
  paint('c', s + (s === 'track' ? c.trackN : '') + S.lang, `<div class="scroller">${body}</div>${foot}${tabs}${cSheet()}`);
}

/* ---------- owner screens ---------- */
function nextAction(o) {
  const pick = o.method === 'pickup';
  switch (o.status) {
    case 'new': return { label: L('قبول الطلب', 'Accept order'), to: 'accepted' };
    case 'accepted': return pick ? { label: L('المندوب في الطريق', 'Driver on the way'), to: 'picking' } : { label: L('استلمت القطع · جرد القطع', 'Items received · count'), count: true };
    case 'picking': return { label: L('تم الاستلام · جرد القطع', 'Collected · count items'), count: true };
    case 'counted': return { label: L('بدء الغسيل', 'Start washing'), to: 'cleaning' };
    case 'cleaning': return { label: L('الطلب جاهز', 'Mark ready'), to: 'ready' };
    case 'ready': return pick ? { label: L('خرج للتوصيل', 'Out for delivery'), to: 'delivering' } : { label: L('تم التسليم والتحصيل', 'Handed over & paid'), to: 'done' };
    case 'delivering': return { label: L('تم التسليم والتحصيل', 'Handed over & paid'), to: 'done' };
  }
  return null;
}
function oCard(o) {
  const t = calc(o), age = Math.floor((Date.now() - o.created) / MIN);
  const late = o.status === 'new' && age >= LATE_MIN, act = nextAction(o);
  const pick = o.method === 'pickup';
  /* one tap opens WhatsApp with the message for the order's current step, ready to send */
  const wa = o.customer.phone ? waLink(o.customer.phone, waText(o, o.status)) : null;
  return `<article class="ocard ${late ? 'is-late' : ''} ${ui.flash === o.n ? 'flash' : ''}" aria-label="${L('طلب', 'Order')} ${o.n} ${L('من', 'from')} ${esc(o.customer.name)}">
    <div class="ocard-top"><span class="tnum" dir="ltr">${o.n}</span><b>${o.customer.name === WALKIN_NAME ? L(WALKIN_NAME, 'Walk-in customer') : esc(o.customer.name)}</b>${late ? `<span class="chip warn">${IC.clock(13)} ${L(`تأخر القبول ${age} د`, `Late to accept · ${age} min`)}</span>` : ''}<span class="ago" data-ago="${o.created}">${ago(o.created)}</span></div>
    <div class="meta">
      <span class="chip">${pick ? IC.truck(13) + ' ' + L('استلام وتوصيل', 'Pickup & delivery') : o.walkin ? IC.store(13) + ' ' + L('طلب في المحل', 'Walk-in') : IC.store(13) + ' ' + L('تسليم في المحل', 'In-store drop-off')}</span>
      ${o.subCover ? `<span class="chip ok">${L('من الاشتراك', 'From plan')}: ${pcs(o.subCover.pieces)}</span>` : ''}
      ${o.reward ? `<span class="chip ok">${IC.star(13)} ${L('مكافأة ولاء', 'Loyalty reward')}</span>` : ''}
      ${o.edited ? `<span class="chip">${L('عُدّل', 'Edited')} ${clock(o.edited)}</span>` : ''}
      ${o.slot ? `<span class="chip">${IC.clock(13)} ${slotText(o)}</span>` : ''}
      ${o.customer.district ? `<span class="chip">${IC.pin(13)} ${esc(distName(o.customer.district))}</span>` : ''}
      ${o.speed === 'urgent' ? `<span class="chip warn">${IC.bolt(13)} ${L('مستعجل', 'Express')}</span>` : ''}
    </div>
    <div class="ocard-items">${awaitingCount(o) ? `<b>${L('استلام سريع', 'Quick pickup')}</b> · <span class="muted">${L('القطع غير محددة، تُجرد عند الاستلام', 'items not listed; count at pickup')}</span>` : itemsSummary(o.items)}</div>
    ${o.note ? `<div class="ocard-note">${L('ملاحظة العميل:', 'Customer note:')} ${esc(o.note)}</div>` : ''}
    ${o.customer.phone || o.customer.mapUrl ? `<div class="meta">${o.customer.phone ? `<span class="chip"><span class="num" dir="ltr">${esc(o.customer.phone)}</span></span>` : ''}${o.customer.address ? `<span class="chip">${esc(o.customer.address)}</span>` : ''}${o.customer.mapUrl ? `<a class="chip brand" href="${esc(o.customer.mapUrl)}" target="_blank" rel="noopener">${IC.pin(13)} ${L('الموقع على الخريطة', 'Map')}</a>` : ''}</div>` : ''}
    <div class="ocard-foot"><span><b>${awaitingCount(o) ? L('بعد الجرد', 'after count') : money(t.total)}</b> · ${o.paid ? L('مدفوع', 'paid') : L('الدفع عند التسليم', 'pay on delivery')}</span>${statusChip(o)}</div>
    ${o.status === 'rejected' ? `<div class="small muted">${L('سبب الرفض:', 'Reason:')} ${esc(P(REASONS[o.rejectReason]))}</div>` : ''}
    ${act || wa ? `<div class="ocard-actions">${act ? `<button class="btn primary sm" data-a="adv" data-n="${o.n}" ${ui.busy ? 'disabled' : ''}>${act.label}</button>` : ''}${o.status === 'new' ? `<button class="btn sm" data-a="reject" data-n="${o.n}" aria-expanded="${ui.rejecting === o.n}">${L('اعتذار', 'Decline')}</button>` : ''}${o.walkin && act ? `<button class="btn sm" data-a="wkedit" data-n="${o.n}">${L('تعديل', 'Edit')}</button>` : ''}${wa ? `<a class="btn sm" href="${wa}" target="_blank" rel="noopener" aria-label="${L('أرسل للعميل على واتساب:', 'WhatsApp the customer:')} ${esc(statusLabel(o))}">${IC.chat(16)} ${L('واتساب', 'WhatsApp')}</a>` : ''}</div>` : ''}
    ${ui.rejecting === o.n ? `<div role="group" aria-label="${L('سبب الاعتذار', 'Decline reason')}"><div class="small muted" style="margin-bottom:6px">${L('اختر سبب الاعتذار (يصل للعميل):', 'Choose a reason (sent to the customer):')}</div><div class="reasons">${REASONS.map((r, i) => `<button class="chip-btn" data-a="rreason" data-n="${o.n}" data-i="${i}">${P(r)}</button>`).join('')}</div></div>` : ''}
  </article>`;
}
function oSettings() {
  const st = LIVE;
  const row = (k, title, desc) => `<div class="set-row"><div><b id="set-${k}">${title}</b><p>${desc}</p></div>
    <button class="toggle" role="switch" aria-checked="${st[k]}" data-a="toggle" data-k="${k}" aria-labelledby="set-${k}"><span class="knob"></span></button></div>`;
  return `<div class="card" style="padding-block:2px">
    ${row('open', L('استقبال الطلبات اليوم', 'Taking orders today'), L('عند الإيقاف يظهر للعميل «مغلق مؤقتًا»، ويستطيع جدولة الاستلام من الغد.', 'When off, customers see “closed today” and can book from tomorrow.'))}
    ${row('todaySlots', L('مواعيد استلام اليوم', 'Today’s pickups'), L('أوقفها إذا كان المندوب مشغولًا أو غائبًا؛ تبقى مواعيد الغد متاحة.', 'Pause if the driver is busy or away; tomorrow stays open.'))}
    ${row('dryClean', L('خدمة التنظيف الجاف', 'Dry cleaning'), L('أوقفها عند تعطل الجهاز؛ تظهر للعميل «متوقف اليوم» ولا يستطيع طلبها.', 'Pause if the machine is down; customers see “paused today”.'))}
  </div>
  <button class="btn wide" data-a="prefs">${IC.gear(18)} ${L('اللغة والمظهر وقفل الجهاز', 'Language, appearance, lock device')}</button>
  <div class="notice">${IC.info(17)}<span>${L('لتعديل الأسعار والقطع، أو أحياء التوصيل ورسومها، أو سعة المواعيد: تواصل معنا ونعدّلها لك.', 'To change prices and items, delivery areas and fees, or slot capacity: contact us and we will update them.')}</span></div>`;
}
/* in-store order for walk-in customers: big tiles, no typing needed; the mobile number is optional (loyalty + plan) */
const wkLines = sh => Object.entries(sh.lines).map(([k, qty]) => { const [id, svc] = k.split('|'); return { id, svc, qty }; });
function oWalkin(sh) {
  const close = `<button class="icon-btn" data-a="closesheet" aria-label="${L('إغلاق', 'Close')}">✕</button>`;
  if (sh.done) {
    /* sh.done = what the server answered: { n, totals, name, phone } */
    const o = { n: sh.done.n, customer: { name: sh.done.name } }, t = sh.done.totals, card = !!sh.done.phone;
    return `<div class="sheet-wrap" data-a="closesheet" data-self="1"><div class="sheet pad wk" role="dialog" aria-modal="true" aria-labelledby="wk-title">
      <div class="grab" aria-hidden="true"></div>
      <div class="sheet-head"><span></span>${close}</div>
      <div style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px">
        <span class="check-anim" aria-hidden="true">${IC.check(32)}</span>
        <h2 id="wk-title" tabindex="-1">${sh.edited ? L('تم حفظ التعديل', 'Changes saved') : L('تم حفظ الطلب', 'Order saved')}</h2>
        ${o.customer.name !== WALKIN_NAME ? `<p class="muted">${esc(o.customer.name)}</p>` : ''}
      </div>
      <div class="ticket"><span><span class="t-lab">${L('رقم الطلب', 'Order no.')}</span><br><span class="t-num" dir="ltr">${o.n}</span></span><span class="perf"></span><span class="t-side">${pcs(t.count)}<br>${money(t.total)}</span></div>
      <p class="wk-hint">${L('اكتب الرقم على البطاقة الصفراء وعلّقها على الملابس.', 'Write this number on the yellow tag and pin it to the clothes.')}</p>
      ${card ? `<div class="notice ok">${IC.star(17)}<span>${t.subFree ? L(`خُصم ${pcs(t.subPieces)} من اشتراك العميل.`, `${pcs(t.subPieces)} taken from the customer’s plan.`) + ' ' : ''}${t.loyalty ? L('طُبّقت مكافأة الولاء.', 'Loyalty reward applied.') + ' ' : ''}${L('ينضاف ختم الولاء عند التسليم.', 'The loyalty stamp is added at handover.')}</span></div>` : ''}
      <button class="btn primary wide wk-big" data-a="wknew">${IC.plus(22)} ${L('طلب جديد', 'New order')}</button>
    </div></div>`;
  }
  const lines = wkLines(sh), t = calc({ items: lines, method: 'dropoff', speed: 'normal', subCover: sh.cover, reward: sh.reward });
  const cat = CATALOG.find(c => c.id === sh.cat) || CATALOG[0];
  const svcs = [['wash', 'men'], ['press', 'kids'], ['dry', 'women']];
  const phone = normPhone(sh.phone), ok = validPhone(phone), card = ok ? cardOf(phone) : null;
  const tiles = cat.items.map(it => {
    const price = it.prices[sh.svc], off = price == null || (sh.svc === 'dry' && !LIVE.dryClean);
    const q = sh.lines[`${it.id}|${sh.svc}`] || 0;
    return `<li class="wk-cell"><button class="wk-tile ${q ? 'in' : ''}" data-a="wkadd" data-id="${it.id}" ${off ? 'disabled' : ''} aria-label="${esc(N(it))}${off ? '' : `، ${moneyT(price)}`}${q ? L(`، العدد ${q}`, `, ${q} added`) : ''}">
      ${q ? `<span class="qty-pill" aria-hidden="true">${q}</span>` : ''}${catIcon(cat.id, '', 30)}<b>${esc(N(it))}</b><span>${off ? '—' : money(price)}</span></button>
      ${q ? `<button class="wk-minus" data-a="wkdec" data-k="${it.id}|${sh.svc}" aria-label="${L('إنقاص', 'Remove one')} ${esc(N(it))}">−</button>` : ''}</li>`;
  }).join('');
  return `<div class="sheet-wrap" data-a="closesheet" data-self="1"><div class="sheet pad wk" role="dialog" aria-modal="true" aria-labelledby="wk-title">
    <div class="grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2 id="wk-title" tabindex="-1">${sh.editN ? `${L('تعديل الطلب', 'Edit order')} ${num(sh.editN)}` : L('طلب في المحل', 'In-store order')}</h2>${close}</div>
    <div class="wk-step"><span class="wk-n">1</span>${L('اختر الخدمة', 'Pick the service')}</div>
    <div class="wk-svcs" role="group" aria-label="${L('الخدمة', 'Service')}">${svcs.map(([k, tone]) => `<button class="wk-svc" data-a="wksvc" data-v="${k}" aria-pressed="${sh.svc === k}" ${k === 'dry' && !LIVE.dryClean ? 'disabled' : ''}><span class="gi ${tone}" aria-hidden="true">${IC[k === 'wash' ? 'sparkle' : k === 'press' ? 'hanger' : 'bolt'](22)}</span>${svcName(k)}</button>`).join('')}</div>
    <div class="wk-step"><span class="wk-n">2</span>${L('اضغط على القطعة لكل حبة', 'Tap an item once per piece')}</div>
    <div class="chips" role="group" aria-label="${L('الأقسام', 'Categories')}" style="padding-top:0">${CATALOG.map(c => `<button class="chip-btn wk-chip" data-a="wkcat" data-id="${c.id}" aria-pressed="${c.id === cat.id}">${catIcon(c.id, '', 18)}${N(c)}</button>`).join('')}</div>
    <ul class="wk-tiles" aria-label="${N(cat)}">${tiles}</ul>
    ${lines.length ? `<div class="card" style="padding-block:4px">${lines.map(l => `<div class="line" style="padding-block:8px">${itemIcon(l.id, 'thumb sm')}<div class="line-main"><b>${esc(N(ITEMS[l.id]))} × <span class="num">${l.qty}</span></b><span>${svcName(l.svc)}</span></div><span class="line-sum">${money(priceOf(l) * l.qty)}</span></div>`).join('')}</div>` : ''}
    <div class="wk-step"><span class="wk-n">3</span>${L('بيانات العميل (اختياري)', 'Customer details (optional)')}</div>
    <div class="field"><label for="wk-phone">${L('الجوال', 'Mobile')}</label>
      <input class="input tel wk-phone" id="wk-phone" data-win="phone" type="tel" inputmode="numeric" dir="ltr" autocomplete="off" placeholder="05XXXXXXXX" value="${esc(sh.phone)}">
      ${ok ? `<div class="wk-cust">${card ? `<span class="chip brand">${IC.star(13)} ${L('أختام', 'Stamps')} <span class="num">${card.stamps || 0}/${STAMP_GOAL}</span></span>${activeSub(card.sub) ? `<span class="chip ok">${L('اشتراك', 'Plan')}: ${L(`باقي ${card.sub.left}`, `${card.sub.left} left`)}</span>` : ''}${card.rewards ? `<span class="chip ok">${L('له مكافأة', 'Has a reward')}</span>` : ''}` : `<span class="chip">${L('عميل جديد · تنفتح له بطاقة', 'New customer · card opened')}</span>`}</div>` : ''}
    </div>
    <div class="field"><label for="wk-name">${L('الاسم', 'Name')}</label>
      <input class="input wk-name" id="wk-name" data-win="name" type="text" autocomplete="off" maxlength="40" placeholder="${L('مثال: أبو محمد', 'e.g. Abu Mohammed')}" value="${esc(sh.name)}">
    </div>
    ${lines.length ? totalsHtml(t, { method: 'dropoff' }) : ''}
    ${sh.err ? `<div class="notice bad" role="alert">${IC.alert(17)}<span>${esc(sh.err)}</span></div>` : ''}
    <button class="btn primary wide wk-big split" data-a="wksave" ${lines.length && !ui.busy ? '' : 'disabled'} ${ui.busy ? 'aria-busy="true"' : ''}><span>${IC.check(22)} ${ui.busy ? L('جارٍ الحفظ…', 'Saving…') : sh.editN ? L('حفظ التعديل', 'Save changes') : L('حفظ الطلب', 'Save order')}</span><span>${lines.length ? money(t.total) : ''}</span></button>
  </div></div>`;
}
/* monthly plan sold at the counter: mobile → plan → "payment received". Big buttons, like the in-store order */
function oPlanSheet(sh) {
  const close = `<button class="icon-btn" data-a="closesheet" aria-label="${L('إغلاق', 'Close')}">✕</button>`;
  const wrap = body => `<div class="sheet-wrap" data-a="closesheet" data-self="1"><div class="sheet pad wk" role="dialog" aria-modal="true" aria-labelledby="pl-title">
    <div class="grab" aria-hidden="true"></div>${body}</div></div>`;
  if (sh.done) {
    const s = sh.done.sub, p = planOf(s.plan);
    return wrap(`<div class="sheet-head"><span></span>${close}</div>
      <div style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px">
        <span class="check-anim" aria-hidden="true">${IC.check(32)}</span>
        <h2 id="pl-title" tabindex="-1">${L('تم تفعيل الاشتراك', 'Plan is on')}</h2>
        <p class="muted">${sh.done.name ? `${esc(sh.done.name)} · ` : ''}<span class="num" dir="ltr">${esc(sh.done.phone)}</span></p>
      </div>
      <div class="ticket"><span><span class="t-lab">${L('الباقة', 'Plan')}</span><br><b>${esc(P(p.name))}</b></span><span class="perf"></span><span class="t-side">${pcs(s.left)}<br>${L('حتى', 'until')} ${dayLabel(dayOffset(s.renews))}</span></div>
      <p class="wk-hint">${L('القطع تنخصم تلقائيًا من طلباته، من التطبيق أو في المحل.', 'Pieces come off automatically on their orders, in the app or at the counter.')}</p>
      <button class="btn primary wide wk-big" data-a="plnew">${IC.plus(22)} ${L('اشتراك لعميل آخر', 'Another customer')}</button>`);
  }
  const phone = normPhone(sh.phone), ok = validPhone(phone), card = ok ? cardOf(phone) : null;
  const cur = card && activeSub(card.sub), curPlan = cur && planOf(cur.plan);
  const pick = PLANS.find(p => p.id === sh.plan);
  return wrap(`<div class="sheet-head"><h2 id="pl-title" tabindex="-1">${L('اشتراك شهري', 'Monthly plan')}</h2>${close}</div>
    <div class="wk-step"><span class="wk-n">1</span>${L('جوال العميل', 'Customer mobile')}</div>
    <div class="field"><label class="sr" for="pl-phone">${L('جوال العميل', 'Customer mobile')}</label>
      <input class="input tel wk-phone" id="pl-phone" data-pl="phone" type="tel" inputmode="numeric" dir="ltr" autocomplete="off" placeholder="05XXXXXXXX" value="${esc(sh.phone)}">
      ${ok ? `<div class="wk-cust">${cur ? `<span class="chip ok">${L('عنده', 'Has')} ${esc(P(curPlan.name))} · ${L(`باقي ${cur.left}`, `${cur.left} left`)}</span>` : card ? `<span class="chip">${esc(card.name || '')} ${L('· ما عنده اشتراك', '· no plan yet')}</span>` : `<span class="chip">${L('عميل جديد', 'New customer')}</span>`}</div>` : ''}
    </div>
    ${ok && !(card && card.name) ? `<div class="field"><label for="pl-name">${L('الاسم (اختياري)', 'Name (optional)')}</label><input class="input wk-name" id="pl-name" data-pl="name" type="text" autocomplete="off" maxlength="40" placeholder="${L('مثال: أبو محمد', 'e.g. Abu Mohammed')}" value="${esc(sh.name)}"></div>` : ''}
    <div class="wk-step"><span class="wk-n">2</span>${L('اختر الباقة', 'Pick the plan')}</div>
    <div class="plan-picks" role="group" aria-label="${L('الباقات', 'Plans')}">${PLANS.map(p => `<button class="choice" data-a="plpick" data-id="${p.id}" aria-pressed="${sh.plan === p.id}"><b>${esc(P(p.name))}</b><span>${esc(P(p.note))}</span><b class="plan-price">${money(p.price)}</b></button>`).join('')}</div>
    ${cur ? `<div class="notice warn">${IC.info(17)}<span>${L('عنده اشتراك شغّال. التفعيل يبدأ شهرًا جديدًا من اليوم، والقطع الباقية من الشهر الحالي ما تنتقل.', 'They already have a plan. This starts a new month today; pieces left from the current month do not carry over.')}</span></div>` : ''}
    ${sh.err ? `<div class="notice bad" role="alert">${IC.alert(17)}<span>${esc(sh.err)}</span></div>` : ''}
    <div class="wk-step"><span class="wk-n">3</span>${L('استلم المبلغ نقدًا أو بالشبكة، ثم فعّل', 'Take payment by cash or card, then turn it on')}</div>
    <button class="btn primary wide wk-big split" data-a="plsave" ${ok && pick && !ui.busy ? '' : 'disabled'} ${ui.busy ? 'aria-busy="true"' : ''}><span>${IC.check(22)} ${ui.busy ? L('جارٍ التفعيل…', 'Turning on…') : L('استلمت المبلغ · فعّل', 'Paid · turn on')}</span><span>${pick ? money(pick.price) : ''}</span></button>`);
}
const WALKIN_NAME = 'عميل المحل';
/* the name the shop already has for this mobile: from the customer's card, or an earlier order */
function knownName(phone) {
  const c = cardOf(phone);
  if (c && c.name && c.name !== WALKIN_NAME) return c.name;
  const prev = R.orders.find(x => x.customer.phone === phone && x.customer.name && x.customer.name !== WALKIN_NAME);
  return prev ? prev.customer.name : '';
}
/* preview of plan pieces and reward for the in-store order; the server decides the real numbers */
function wkPreview(sh) {
  const phone = normPhone(sh.phone), card = validPhone(phone) ? cardOf(phone) : null, lines = wkLines(sh);
  /* while editing, count what this order already took from the same customer as still available */
  const old = sh.editN ? findOrder(sh.editN) : null, same = old && card && old.customerPhone === e164(phone);
  const live = card && activeSub(card.sub);
  const sub = live ? { ...live, left: live.left + (same && old.subCover ? old.subCover.pieces : 0) } : null;
  sh.cover = subCover(lines, sub);
  sh.reward = !!(card && (card.rewards > 0 || (same && old.reward)));
}
function oCountSheet() {
  const sh = ui.sheetO;
  if (!sh) return '';
  if (sh.type === 'prefs') return prefsSheet('o');
  if (sh.type === 'walkin') return oWalkin(sh);
  if (sh.type === 'plan') return oPlanSheet(sh);
  const o = findOrder(sh.n);
  /* preview of the new bill: recalculate from the counted items, not the order's saved totals */
  const t = calc({ ...o, totals: null, items: sh.items });
  const opts = CATALOG.map(c => `<optgroup label="${N(c)}">${c.items.map(it => Object.entries(it.prices).map(([k, p]) => `<option value="${it.id}|${k}">${esc(N(it))} · ${svcName(k)} · ${moneyT(p)}</option>`).join('')).join('')}</optgroup>`).join('');
  return `<div class="sheet-wrap" data-a="closesheet" data-self="1"><div class="sheet pad" role="dialog" aria-modal="true" aria-labelledby="cnt-title">
    <div class="grab" aria-hidden="true"></div>
    <div class="sheet-head"><div><h2 id="cnt-title" tabindex="-1">${L('جرد القطع · طلب', 'Count items · order')} ${num(o.n)}</h2><p class="muted small">${L('عدّل الأعداد حسب القطع المستلمة فعليًا. يصل للعميل الإجمالي المحدّث.', 'Match the counts to what you actually received. The customer gets the updated total.')}</p></div><button class="icon-btn" data-a="closesheet" aria-label="${L('إغلاق', 'Close')}">✕</button></div>
    <div class="card" style="padding-block:4px">${sh.items.length ? sh.items.map((l, i) => {
      const nm = esc(N(ITEMS[l.id]));
      return `<div class="line">${itemIcon(l.id, 'thumb sm')}<div class="line-main"><b>${nm}</b><span>${svcName(l.svc)} · ${money(priceOf(l))}</span></div>
      <div class="stepper"><button data-a="cnt" data-i="${i}" data-d="1" aria-label="${L('زيادة', 'Add one')} ${nm}">+</button><output aria-live="polite">${l.qty}</output><button data-a="cnt" data-i="${i}" data-d="-1" aria-label="${L('إنقاص', 'Remove one')} ${nm}">−</button></div>
      <span class="line-sum">${money(priceOf(l) * l.qty)}</span></div>`;
    }).join('') : `<p class="muted small" style="padding-block:12px">${L('لم تُضف قطع بعد. أضف القطع المستلمة من القائمة بالأسفل.', 'No items yet. Add what you received from the list below.')}</p>`}</div>
    <div class="field"><label for="cnt-item">${L('إضافة قطعة مستلمة', 'Add a received item')}</label>
      <div style="display:flex;gap:8px"><select class="input" id="cnt-item">${opts}</select><button class="btn sm" data-a="cntadd">${L('إضافة', 'Add')}</button></div></div>
    ${sh.items.length ? totalsHtml(t, { method: o.method }) : ''}
    <button class="btn primary wide" data-a="cntsave" ${sh.items.length ? '' : 'disabled'}>${L('حفظ الجرد وإبلاغ العميل', 'Save count & notify customer')}</button>
  </div></div>`;
}
/* shop device sign-in: big keypad, the PIN is never stored on the device */
const PIN_ERR = {
  'wrong-pin': () => L('الرمز غير صحيح.', 'Wrong PIN.'),
  locked: () => L('محاولات خاطئة كثيرة. الجهاز مقفل 15 دقيقة.', 'Too many wrong tries. Locked for 15 minutes.'),
  network: () => L('تعذّر الاتصال. تأكد من الإنترنت.', 'No connection. Check the internet.'),
};
function pinView() {
  const n = ui.pin.length, dots = Array.from({ length: Math.max(4, n) }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  return `<div class="scroller"><div class="pad stack screen pin-screen">
    <div class="brand-row" style="justify-content:center"><div class="logo" aria-hidden="true">${IC.hanger(28)}</div><div><div class="o-title">${esc(shopName())}</div><div class="muted small">${L('لوحة الطلبات', 'Orders dashboard')}</div></div></div>
    <h1 tabindex="-1" data-focus style="text-align:center;font-size:22px">${L('أدخل رمز المحل', 'Enter the shop PIN')}</h1>
    <div class="pin-dots" role="img" aria-label="${L(`أُدخل ${n} أرقام`, `${n} digits entered`)}">${dots}</div>
    ${ui.pinErr ? `<p class="err" role="alert" style="text-align:center">${(PIN_ERR[ui.pinErr] || PIN_ERR.network)()}</p>` : ''}
    <div class="pinpad" role="group" aria-label="${L('لوحة الأرقام', 'Keypad')}">${keys.map(k => k === 'del'
      ? `<button data-a="pin" data-v="del" aria-label="${L('حذف رقم', 'Delete digit')}" ${n ? '' : 'disabled'}>⌫</button>`
      : k === 'ok' ? `<button class="go" data-a="pin" data-v="ok" aria-label="${L('دخول', 'Sign in')}" ${n >= 4 && !ui.busy ? '' : 'disabled'}>${IC.check(26)}</button>`
      : `<button data-a="pin" data-v="${k}" ${n >= 8 ? 'disabled' : ''}>${k}</button>`).join('')}</div>
  </div></div>`;
}
function renderOwner() {
  if (!R.shop || !R.authKnown) { paint('o', 'loading' + S.lang, loadingView()); return; }
  if (!R.user || !R.user.staff) { paint('o', 'pin' + S.lang, pinView()); return; }
  const tab = S.own.tab, os = R.orders;
  const by = k => os.filter(o => TAB_OF[o.status] === k);
  const lateN = by('new').filter(o => Date.now() - o.created >= LATE_MIN * MIN).length;
  const todayVal = os.filter(o => !['rejected', 'cancelled'].includes(o.status) && Date.now() - o.created < 864e5 && !awaitingCount(o)).reduce((s, o) => s + calc(o).total, 0);
  let list = tab === 'settings' ? null : by(tab);
  if (list) list = tab === 'new' ? list.sort((a, b) => a.created - b.created) : list.sort((a, b) => b.history[b.history.length - 1].t - a.history[a.history.length - 1].t);
  const tabBtn = (k, label) => `<button class="chip-btn" data-a="otab" data-v="${k}" aria-pressed="${tab === k}">${label}</button>`;
  /* the counters are the filter: tap «جديدة» to see the new orders */
  const statBtn = (k, label, warn) => `<button class="stat ${warn ? 'warn' : ''}" data-a="otab" data-v="${k}" aria-pressed="${tab === k}"><b class="num">${by(k).length}</b><span>${label}</span></button>`;
  const empties = { new: L('لا توجد طلبات جديدة. أي طلب من تطبيق العميل يظهر هنا فورًا.', 'No new orders. Anything placed in the customer app shows up here instantly.'), active: L('لا توجد طلبات قيد التنفيذ.', 'Nothing in progress.'), ready: L('لا توجد طلبات جاهزة.', 'Nothing ready.'), done: L('لا توجد طلبات مكتملة بعد.', 'No completed orders yet.') };
  const body = `
  <div class="o-head pad"><div style="flex:1;min-width:0"><h1 class="o-title" tabindex="-1" data-focus>${esc(shopName())}</h1><div class="muted small">${L('لوحة الطلبات', 'Orders dashboard')}</div></div>
    <button class="toggle" role="switch" aria-checked="${LIVE.open}" data-a="toggle" data-k="open"><span>${LIVE.open ? L('نستقبل الطلبات', 'Open') : L('مغلق مؤقتًا', 'Closed')}</span><span class="knob"></span></button>${gearBtn()}</div>
  ${audioReady() ? '' : `<div class="pad" style="padding-top:8px"><button class="btn wide" data-a="sound">${IC.alert(18)} ${L('فعّل صوت الطلبات الجديدة', 'Turn on the new-order sound')}</button></div>`}
  <div class="pad" style="padding-top:8px"><button class="btn primary wide wk-big" data-a="walkin">${IC.plus(24)} ${L('طلب جديد في المحل', 'New in-store order')}</button></div>
  ${PLANS.length ? `<div class="pad" style="padding-top:8px"><button class="btn wide" data-a="plan">${IC.card(20)} ${L('اشتراك شهري لعميل', 'Monthly plan for a customer')}</button></div>` : ''}
  <div class="pad sticky" role="group" aria-label="${L('تصفية الطلبات', 'Filter orders')}">
    <div class="stats">
      ${statBtn('new', lateN ? L(`جديدة · ${lateN} متأخر`, `New · ${lateN} late`) : L('جديدة', 'New'), lateN)}${statBtn('active', L('قيد التنفيذ', 'In progress'))}${statBtn('ready', L('جاهزة', 'Ready'))}
    </div>
    <div class="chips">${tabBtn('done', L('المكتملة', 'Completed'))}${tabBtn('settings', L('التشغيل', 'Operations'))}
      <span class="day-total">${L('آخر 24 ساعة', 'Last 24 h')} <b>${money(todayVal)}</b></span></div>
  </div>
  <div class="pad">${list ? (list.length ? `<div class="ocards">${list.map(oCard).join('')}</div>` : `<div class="empty"><span class="gi men" aria-hidden="true">${IC.receipt(28)}</span><span>${empties[tab]}</span></div>`) : `<div class="stack" style="padding-top:4px">${oSettings()}</div>`}</div>`;
  paint('o', tab + S.lang, `<div class="scroller">${body}</div>${oCountSheet()}`);
}

/* ---------- paint: keeps scroll, restores focus, manages dialogs ---------- */
const SIG_KEYS = ['a', 'id', 'n', 'k', 'v', 'to', 'd', 'i'];
function sigOf(el) {
  if (!el || !el.closest) return null;
  if (el.id) return '#' + CSS.escape(el.id);
  if (!el.dataset || !el.dataset.a) return null;
  return SIG_KEYS.filter(k => el.dataset[k] != null).map(k => `[data-${k}="${CSS.escape(el.dataset[k])}"]`).join('')
    + (el.tagName === 'INPUT' ? `[value="${CSS.escape(el.value)}"]` : '');
}
function focusBySig(root, sig) {
  if (!sig) return false;
  const el = root.querySelector(sig);
  if (el && !el.disabled) {
    el.focus({ preventScroll: true });
    if (el.type === 'search' || el.type === 'text' || el.type === 'tel') { const n = el.value.length; el.setSelectionRange(n, n); }
    return true;
  }
  return false;
}
function paint(which, key, html) {
  const dev = document.getElementById(`dev-${which}`), view = dev.querySelector('.view');
  const active = document.activeElement, inView = view.contains(active);
  const focusSig = inView ? sigOf(active) : null;
  const sc = view.querySelector('.scroller'), sameScreen = view.dataset.key === key, sameLang = (view.dataset.key || '').slice(-2) === key.slice(-2);
  const keep = sc && (sameScreen || !sameLang) ? sc.scrollTop : 0;
  const sheet = view.querySelector('.sheet'), sheetTop = sheet ? sheet.scrollTop : 0;
  view.innerHTML = html;
  view.dataset.key = key;
  const sc2 = view.querySelector('.scroller'); if (sc2) sc2.scrollTop = keep;
  const sh2 = view.querySelector('.sheet');
  [...view.children].forEach(ch => { if (!ch.classList.contains('sheet-wrap')) ch.inert = !!sh2; });
  if (sh2 && sheet) { sh2.classList.add('still'); sh2.scrollTop = sheetTop; }
  if (which === 'c' && ui.focusErr) {
    ui.focusErr = false;
    const bad = view.querySelector('[aria-invalid="true"], .slots[aria-describedby]');
    if (bad) { (bad.matches('.slots') ? bad.querySelector('button:not([disabled])') || bad : bad).focus(); return; }
  }
  if (sh2 && !sheet) { ui.opener[which] = focusSig; const h = sh2.querySelector('[tabindex="-1"]'); if (h) h.focus(); return; }
  if (!sh2 && sheet) { if (!focusBySig(view, ui.opener[which])) focusBySig(view, focusSig); return; }
  if (!inView) return;
  if (!sameScreen && sameLang && !sh2) { const h = view.querySelector('[data-focus]'); if (h) { h.focus({ preventScroll: true }); return; } }
  focusBySig(view, focusSig);
}
/* shop: number of new orders in the browser tab title, so it shows even when the tab is in the back */
function badge() {
  if (!SHOP) return;
  const n = R.user && R.user.staff ? R.orders.filter(o => o.status === 'new').length : 0;
  const base = `${L('لوحة', 'Dashboard ·')} ${shopName() || ''}`;
  document.title = n ? `(${n}) ${base}` : base;
}
function renderAll() { if (SHOP) renderOwner(); else renderCustomer(); badge(); }

/* ---------- actions ---------- */
/* the server answers with short codes; these are the words people see */
const REASON_TEXT = {
  closed: () => L('المغسلة مغلقة اليوم. اختر موعدًا من الغد.', 'The laundry is closed today. Pick a time from tomorrow.'),
  'slot-full': () => L('امتلأ هذا الموعد للتو. اختر موعدًا آخر.', 'That time just filled up. Pick another.'),
  'slot-past': () => L('فات هذا الموعد. اختر موعدًا آخر.', 'That time has passed. Pick another.'),
  'slot-paused': () => L('مواعيد اليوم متوقفة. اختر موعدًا من الغد.', 'Today’s pickups are paused. Pick a time from tomorrow.'),
  'slot-date': () => L('اختر موعدًا من الأيام المتاحة.', 'Pick one of the available days.'),
  'slot-unknown': () => L('اختر موعد الاستلام.', 'Choose a pickup time.'),
  'min-pickup': () => L('لم يكتمل الحد الأدنى لطلبات الاستلام.', 'The pickup minimum is not reached.'),
  district: () => L('اختر الحي من القائمة.', 'Choose your area from the list.'),
  address: () => L('اكتب وصف العنوان.', 'Add the address details.'),
  name: () => L('اكتب اسمك.', 'Enter your name.'),
  phone: () => L('رقم الجوال غير صحيح.', 'The mobile number is not valid.'),
  items: () => L('أضف قطعة واحدة على الأقل.', 'Add at least one item.'),
  qty: () => L('عدد غير صحيح.', 'Invalid quantity.'),
  'item-unknown': () => L('تغيّرت قائمة الأسعار. راجع السلة.', 'The price list changed. Check your basket.'),
  'service-paused': () => L('التنظيف الجاف متوقف اليوم.', 'Dry cleaning is paused today.'),
  'too-fast': () => L('أرسلت طلبًا قبل لحظات. انتظر نصف دقيقة.', 'You just sent an order. Wait half a minute.'),
  'sign-in': () => L('ادخل برقم جوالك أولًا.', 'Sign in with your mobile first.'),
  'not-cancellable': () => L('قبلت المغسلة الطلب، فما يُلغى من التطبيق. راسلها على واتساب.', 'The laundry already accepted it, so it can’t be cancelled here. Message them on WhatsApp.'),
  order: () => L('الطلب غير موجود.', 'Order not found.'),
  'wrong-step': () => L('تغيّرت حالة الطلب من جهاز ثاني. شوف الحالة الجديدة.', 'The order changed on another device. Check its new status.'),
  'needs-count': () => L('جرد القطع أولًا.', 'Count the items first.'),
  'not-countable': () => L('بدأ الغسيل، فما يتعدّل الجرد.', 'Washing has started; the count can’t change.'),
  'not-rejectable': () => L('الطلب تجاوز مرحلة القبول.', 'The order is past acceptance.'),
  finished: () => L('الطلب مكتمل، فما يتعدّل.', 'A completed order can’t be edited.'),
  'staff-only': () => L('انتهت جلسة الجهاز. أدخل الرمز مرة ثانية.', 'This device was signed out. Enter the PIN again.'),
  plan: () => L('هذه الباقة غير موجودة. اختر باقة من القائمة.', 'That plan does not exist. Pick one from the list.'),
  network: () => L('تعذّر الاتصال. تأكد من الإنترنت وجرّب مرة ثانية.', 'No connection. Check the internet and try again.'),
};
const reasonText = e => (REASON_TEXT[e && e.reason] || (() => L('حدث خطأ. جرّب مرة ثانية.', 'Something went wrong. Try again.')))();
const SLOT_REASONS = ['closed', 'slot-full', 'slot-past', 'slot-paused', 'slot-date', 'slot-unknown'];

/* one server call at a time: buttons are disabled while it runs; a failure becomes a toast */
async function run(which, fn, onError) {
  if (ui.busy) return;
  ui.busy = true; renderAll();
  try { await fn(); }
  catch (e) {
    if (onError) onError(e);
    toast(which, reasonText(e));
  } finally { ui.busy = false; save(); renderAll(); }
}

function validate() {
  const c = S.cust, e = {};
  if (c.method === 'pickup') {
    if (!c.slot || slotState(c.day, c.slot) !== 'ok') e.slot = ERR.slot();
    if (!c.district) e.district = ERR.district();
    else if (c.district === 'other') e.district = ERR.other();
    if (!c.address.trim()) e.address = ERR.address();
    if (!c.quick && calc(cartDraft()).sub < MIN_PICKUP) e.min = ERR.min();
  }
  if (c.name.trim().length < 2) e.name = ERR.name();
  if (!validPhone(c.phone)) e.phone = ERR.phone();
  return e;
}
/* the mobile typed at checkout must be the verified one; otherwise ask for the SMS code first */
function placeOrder() {
  const c = S.cust, pick = c.method === 'pickup', phone = e164(c.phone);
  if (D.currentPhone() !== phone) { openOtp('order'); ui.sheetC.phone = normPhone(c.phone); renderAll(); return; }
  const data = {
    method: c.method, speed: c.speed, quick: pick && c.quick, name: c.name.trim(), note: c.note.trim(),
    items: pick && c.quick ? [] : cartLines().map(({ id, svc, qty }) => ({ id, svc, qty })),
    slotDate: pick ? dateKey(c.day) : null, slot: pick ? c.slot : null,
    district: pick ? c.district : '', address: pick ? c.address.trim() : '', mapUrl: pick ? c.mapUrl || '' : '',
  };
  return run('c', async () => {
    const r = await D.call('placeOrder', data);
    ui.lastPlaced = { n: r.n, totals: r.totals, method: data.method, slotDate: data.slotDate, slot: data.slot, quick: data.quick };
    Object.assign(c, { cart: {}, note: '', quick: false, slot: null, speed: 'normal', screen: 'success', trackN: r.n });
    ui.sheetC = null; ui.errors = {};
  }, e => {
    if (SLOT_REASONS.includes(e.reason)) { c.slot = null; ui.errors.slot = reasonText(e); }
    if (e.reason === 'sign-in') openOtp('order');
  });
}

const C = {
  ...PREFS,
  prefs() { ui.sheetC = { type: 'prefs' }; },
  go(d) { if (d.to !== 'catalog') S.cust.q = ''; S.cust.screen = d.to; ui.errors = {}; ui.cancelArm = null; },
  cat(d) { S.cust.cat = d.id; },
  opencat(d) { S.cust.cat = d.id; S.cust.q = ''; S.cust.screen = 'catalog'; },
  clearq() { S.cust.q = ''; },
  item(d) {
    const it = ITEMS[d.id];
    if (!it) return;
    const avail = Object.keys(it.prices).filter(k => !(k === 'dry' && !LIVE.dryClean));
    const inCart = avail.find(k => S.cust.cart[`${d.id}|${k}`]);
    const svc = inCart || avail[0] || null;
    ui.sheetC = { type: 'item', id: d.id, svc, qty: svc && S.cust.cart[`${d.id}|${svc}`] || 1 };
  },
  svc(d, el) { const sh = ui.sheetC; sh.svc = el.value; sh.qty = S.cust.cart[`${sh.id}|${sh.svc}`] || 1; },
  sq(d) { const sh = ui.sheetC; sh.qty = Math.max(1, Math.min(99, sh.qty + Number(d.d))); },
  addcart() { const sh = ui.sheetC; if (!sh.svc) return; S.cust.cart[`${sh.id}|${sh.svc}`] = sh.qty; ui.sheetC = null; toast('c', `${L('أُضيف:', 'Added:')} ${N(ITEMS[sh.id])} × ${sh.qty}`); },
  rmcart() { const sh = ui.sheetC; delete S.cust.cart[`${sh.id}|${sh.svc}`]; ui.sheetC = null; toast('c', `${L('أُزيل:', 'Removed:')} ${N(ITEMS[sh.id])}`); },
  closesheet(d, el, ev) { if (d.self && ev.target !== el) return false; ui.sheetC = null; ui.sheetO = null; },
  line(d) {
    const q = (S.cust.cart[d.k] || 0) + Number(d.d);
    if (q <= 0) { delete S.cust.cart[d.k]; toast('c', `${L('أُزيل:', 'Removed:')} ${N(ITEMS[d.k.split('|')[0]])}`); }
    else S.cust.cart[d.k] = Math.min(99, q);
  },
  speed(d) { S.cust.speed = d.v; },
  quick() { S.cust.quick = true; S.cust.method = 'pickup'; S.cust.screen = 'checkout'; ui.errors = {}; if (!S.cust.slot) S.cust.day = firstOpenDay(); },
  tocheckout() { S.cust.quick = false; S.cust.screen = 'checkout'; ui.errors = {}; if (!S.cust.slot) S.cust.day = firstOpenDay(); },
  method(d) { S.cust.method = d.v; ui.errors = {}; },
  day(d) { S.cust.day = Number(d.v); if (S.cust.slot && slotState(S.cust.day, S.cust.slot) !== 'ok') S.cust.slot = null; },
  slot(d) { if (slotState(S.cust.day, d.v) === 'ok') { S.cust.slot = d.v; delete ui.errors.slot; } },
  locate() {
    if (!navigator.geolocation) { toast('c', L('المتصفح ما يدعم تحديد الموقع. اكتب العنوان بالتفصيل.', 'This browser can’t share location. Type the address in detail.')); return false; }
    toast('c', L('جارٍ تحديد موقعك…', 'Finding your location…'));
    navigator.geolocation.getCurrentPosition(p => {
      S.cust.mapUrl = `https://maps.google.com/?q=${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`;
      save(); renderAll(); toast('c', L('تم تحديد موقعك', 'Location added'));
    }, () => toast('c', L('ما قدرنا نحدد موقعك. اكتب العنوان بالتفصيل.', 'Couldn’t get your location. Type the address in detail.')), { enableHighAccuracy: true, timeout: 15000 });
    return false;
  },
  confirm() {
    if (ui.busy) return false;
    ui.errors = validate();
    if (Object.keys(ui.errors).length) { ui.focusErr = true; toast('c', L('راجع الحقول المطلوبة', 'Check the required fields')); return; }
    placeOrder(); return false;
  },
  track(d) { S.cust.trackN = Number(d.n); S.cust.screen = 'track'; ui.cancelArm = null; },
  again(d) {
    const o = findOrder(Number(d.n)); if (!o) return;
    S.cust.cart = {}; let skipped = 0;
    o.items.forEach(l => {
      if (!ITEMS[l.id] || ITEMS[l.id].prices[l.svc] == null || (l.svc === 'dry' && !LIVE.dryClean)) { skipped++; return; }
      S.cust.cart[`${l.id}|${l.svc}`] = l.qty;
    });
    S.cust.speed = o.speed; S.cust.screen = 'cart';
    toast('c', skipped ? L('أُضيفت القطع، عدا ما هو متوقف اليوم', 'Items added, except what is unavailable today') : L('أُضيفت قطع الطلب السابق إلى السلة', 'Your previous items are in the basket'));
  },
  cancel(d) {
    const n = Number(d.n);
    if (ui.cancelArm !== n) { ui.cancelArm = n; return; }
    ui.cancelArm = null;
    run('c', async () => { await D.call('cancelOrder', { n }); toast('c', L(`أُلغي الطلب ${n}`, `Order #${n} cancelled`)); });
    return false;
  },
  soon() { toast('c', L('قريبًا', 'Coming soon')); return false; },
  signin() { openOtp(null); },
  signout() { ui.sheetC = null; D.logout(); toast('c', L('تم تسجيل الخروج من هذا الجهاز', 'Signed out on this device')); },
  async otpsend() {
    const sh = ui.sheetC;
    if (!sh || sh.busy) return false;
    const phone = e164(sh.phone);
    if (!phone) { sh.err = 'phone'; renderAll(); return false; }
    sh.busy = true; sh.err = ''; renderAll();
    try {
      ui.confirmation = await D.sendCode(phone, 'recaptcha');
      Object.assign(sh, { step: 'code', code: '', busy: false, hint: (await D.emulatorCode(phone)) || '' });
    } catch (e) { sh.busy = false; sh.err = e.reason; }
    renderAll();
    return false;
  },
  async otpverify() {
    const sh = ui.sheetC;
    if (!sh || sh.busy || !ui.confirmation) return false;
    const code = (sh.code || '').replace(/[٠-٩]/g, x => '٠١٢٣٤٥٦٧٨٩'.indexOf(x)).replace(/\D/g, '');
    if (code.length !== 6) { sh.err = 'bad-code'; renderAll(); return false; }
    sh.busy = true; sh.err = ''; renderAll();
    try {
      await D.confirmCode(ui.confirmation, code);
      ui.confirmation = null; ui.sheetC = null;
      if (!validPhone(S.cust.phone)) S.cust.phone = sh.phone;
      save();
      toast('c', L('تم التحقق من رقمك', 'Number verified'));
      if (sh.then === 'order') { placeOrder(); return false; }
    } catch (e) { sh.busy = false; sh.err = e.reason; }
    renderAll();
    return false;
  },
  otpback() { const sh = ui.sheetC; if (sh) { sh.step = 'phone'; sh.err = ''; sh.busy = false; } },
};

const O = {
  ...PREFS,
  prefs() { ui.sheetO = { type: 'prefs' }; },
  otab(d) { S.own.tab = d.v; ui.rejecting = null; },
  toggle(d) {
    const k = d.k;
    const live = { open: LIVE.open, dryClean: LIVE.dryClean, todaySlots: LIVE.todaySlots };
    live[k] = !live[k];
    const on = live[k];
    LIVE = { ...LIVE, ...live };
    const msg = { open: on ? L('عاد استقبال الطلبات', 'Taking orders again') : L('أُوقف استقبال طلبات اليوم', 'Orders paused for today'), todaySlots: on ? L('فُتحت مواعيد اليوم', 'Today’s pickups reopened') : L('أُوقفت مواعيد استلام اليوم', 'Today’s pickups paused'), dryClean: on ? L('عاد التنظيف الجاف', 'Dry cleaning back on') : L('أُوقف التنظيف الجاف مؤقتًا', 'Dry cleaning paused') }[k];
    toast('o', `${msg} · ${L('ظهر التغيير للعملاء', 'customers see it now')}`);
    D.setLive(live).catch(() => toast('o', reasonText({ reason: 'network' })));
  },
  adv(d) {
    const o = findOrder(Number(d.n)), act = o && nextAction(o);
    if (!act || ui.busy || R.pending.has(o.n)) return;
    if (act.count) { ui.sheetO = { type: 'count', n: o.n, items: o.items.map(({ id, svc, qty }) => ({ id, svc, qty })) }; return; }
    /* move it on screen now; the server checks it behind the scenes and we undo it if it says no */
    R.pending.set(o.n, { from: o.status, to: act.to });
    refreshOrders();
    toast('o', statusLabel({ ...o, status: act.to }));
    D.call('advanceOrder', { n: o.n, to: act.to }).then(r => {
      if (r.stamp) toast('o', r.stamp === 'reward' ? L('اكتملت بطاقة العميل · له خصم على طلبه القادم', 'Customer’s card is full · discount on their next order') : L('أُضيف ختم ولاء للعميل', 'Loyalty stamp added'));
    }, e => {
      R.pending.delete(o.n); refreshOrders(); renderAll();
      toast('o', `${L(`ما تم تحديث الطلب ${o.n}`, `Order #${o.n} was not updated`)} · ${reasonText(e)}`);
    });
  },
  reject(d) { const n = Number(d.n); ui.rejecting = ui.rejecting === n ? null : n; },
  rreason(d) {
    const n = Number(d.n), reason = Number(d.i);
    ui.rejecting = null;
    run('o', async () => { await D.call('rejectOrder', { n, reason }); toast('o', L(`تم الاعتذار عن الطلب ${n}`, `Order #${n} declined`)); });
    return false;
  },
  cnt(d) { const sh = ui.sheetO, l = sh.items[Number(d.i)]; l.qty = Math.min(99, l.qty + Number(d.d)); if (l.qty <= 0) sh.items.splice(Number(d.i), 1); },
  cntadd() {
    const v = document.getElementById('cnt-item').value, [id, svc] = v.split('|'), sh = ui.sheetO;
    const ex = sh.items.find(l => l.id === id && l.svc === svc);
    if (ex) ex.qty = Math.min(99, ex.qty + 1); else sh.items.push({ id, svc, qty: 1 });
  },
  cntsave() {
    const sh = ui.sheetO;
    if (!sh.items.length) return;
    run('o', async () => {
      const r = await D.call('saveCount', { n: sh.n, items: sh.items });
      ui.sheetO = null;
      toast('o', L(`حُفظ الجرد: ${pcs(r.totals.count)} · ${moneyT(r.totals.total)}`, `Count saved: ${pcs(r.totals.count)} · ${moneyT(r.totals.total)}`));
    });
    return false;
  },
  plan() { ui.sheetO = { type: 'plan', phone: '', name: '', plan: null, done: null, err: '' }; },
  plnew() { O.plan(); },
  plpick(d) { ui.sheetO.plan = d.id; ui.sheetO.err = ''; },
  plsave() {
    const sh = ui.sheetO, phone = normPhone(sh.phone);
    if (!validPhone(phone) || !sh.plan || ui.busy) return;
    run('o', async () => {
      const r = await D.call('setPlan', { phone, plan: sh.plan, name: sh.name.trim() });
      /* forget the cached card so the next in-store order reads the fresh one */
      delete R.custCache[e164(phone)];
      sh.done = r;
      toast('o', L('تم تفعيل الاشتراك', 'Plan is on'));
    }, e => { sh.err = reasonText(e); });
    return false;
  },
  walkin() { ui.sheetO = { type: 'walkin', lines: {}, svc: 'wash', cat: CATALOG[0] && CATALOG[0].id, phone: '', name: '', done: null, editN: null, err: '' }; wkPreview(ui.sheetO); },
  wkedit(d) {
    const o = findOrder(Number(d.n));
    if (!o || !o.walkin || finished(o)) return;
    const lines = {}; o.items.forEach(l => { lines[`${l.id}|${l.svc}`] = l.qty; });
    const first = o.items[0];
    ui.sheetO = { type: 'walkin', lines, svc: first ? first.svc : 'wash', cat: first ? CAT_OF[first.id] : CATALOG[0].id, phone: o.customer.phone, name: o.customer.name === WALKIN_NAME ? '' : o.customer.name, done: null, editN: o.n, err: '' };
    wkPreview(ui.sheetO);
  },
  wknew() { O.walkin(); },
  wksvc(d) { ui.sheetO.svc = d.v; },
  wkcat(d) { ui.sheetO.cat = d.id; },
  wkadd(d) { const sh = ui.sheetO, k = `${d.id}|${sh.svc}`; sh.lines[k] = Math.min(99, (sh.lines[k] || 0) + 1); wkPreview(sh); },
  wkdec(d) { const sh = ui.sheetO; sh.lines[d.k] = (sh.lines[d.k] || 0) - 1; if (sh.lines[d.k] <= 0) delete sh.lines[d.k]; wkPreview(sh); },
  wksave() {
    const sh = ui.sheetO, items = wkLines(sh);
    if (!items.length || ui.busy) return;
    const typed = normPhone(sh.phone), ok = validPhone(typed);
    if (typed && !ok) { sh.err = L('رقم الجوال غير صحيح. اتركه فاضي أو اكتبه 05XXXXXXXX.', 'The mobile is not valid. Leave it empty or type 05XXXXXXXX.'); return; }
    sh.err = '';
    const name = sh.name.trim() || (ok && knownName(typed)) || '';
    run('o', async () => {
      const r = await D.call('saveWalkin', { items, phone: ok ? typed : null, name, n: sh.editN || null });
      sh.done = { n: r.n, totals: r.totals, name: name || WALKIN_NAME, phone: ok };
      sh.edited = !!sh.editN;
      ui.flash = r.n; S.own.tab = 'active';
      toast('o', sh.edited ? L(`عُدّل الطلب ${r.n}`, `Order #${r.n} updated`) : L(`حُفظ الطلب ${r.n}`, `Order #${r.n} saved`));
      setTimeout(() => { if (ui.flash === r.n) { ui.flash = null; renderAll(); } }, 3200);
    });
    return false;
  },
  pin(d) {
    if (ui.busy) return false;
    if (d.v === 'del') { ui.pin = ui.pin.slice(0, -1); ui.pinErr = ''; return; }
    if (d.v !== 'ok') { if (ui.pin.length < 8) ui.pin += d.v; ui.pinErr = ''; return; }
    if (ui.pin.length < 4) return;
    const pin = ui.pin;
    ui.busy = true; renderAll();
    D.staffSignIn(pin).then(() => { ui.pin = ''; ui.pinErr = ''; })
      .catch(e => { ui.pin = ''; ui.pinErr = e.reason || 'network'; })
      .finally(() => { ui.busy = false; renderAll(); });
    return false;
  },
  signout() { ui.sheetO = null; ui.pin = ''; D.logout(); },
  closesheet: C.closesheet,
};

function trapTab(container, ev) {
  const f = [...container.querySelectorAll('button:not([disabled]),input:not([disabled]),select,textarea,summary,a[href],[tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (!container.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
  else if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}
function bind(which, map) {
  const dev = document.getElementById(`dev-${which}`);
  dev.addEventListener('click', ev => {
    const el = ev.target.closest('[data-a]');
    if (!el || !dev.contains(el)) return;
    const fn = map[el.dataset.a];
    if (!fn || el.tagName === 'LABEL') return;
    const res = fn(el.dataset, el, ev);
    if (res === false) return;
    save(); renderAll();
  });
  dev.addEventListener('keydown', ev => {
    /* Enter in the sign-in sheet sends the number / checks the code */
    if (ev.key === 'Enter' && ev.target.dataset && ev.target.dataset.otp) { ev.preventDefault(); (ev.target.dataset.otp === 'code' ? C.otpverify : C.otpsend)(); return; }
    if (ev.key !== 'Tab') return;
    const sheet = dev.querySelector('.sheet');
    if (sheet) trapTab(sheet, ev);
  });
  dev.addEventListener('input', ev => {
    if (ev.target.dataset && ev.target.dataset.otp && ui.sheetC && ui.sheetC.type === 'otp') {
      ui.sheetC[ev.target.dataset.otp] = ev.target.value;
      if (ui.sheetC.err) { ui.sheetC.err = ''; ev.target.removeAttribute('aria-invalid'); const er = document.getElementById('otp-err'); if (er) er.remove(); }
      return;
    }
    if (ev.target.dataset && ev.target.dataset.pl && ui.sheetO && ui.sheetO.type === 'plan') {
      const sh = ui.sheetO;
      if (ev.target.dataset.pl === 'name') { sh.name = ev.target.value; return; }
      const before = validPhone(sh.phone);
      sh.phone = ev.target.value; sh.err = '';
      if (before !== validPhone(sh.phone)) renderOwner();
      return;
    }
    if (ev.target.dataset && ev.target.dataset.win && ui.sheetO && ui.sheetO.type === 'walkin') {
      const sh = ui.sheetO, field = ev.target.dataset.win;
      if (field === 'name') { sh.name = ev.target.value; return; }
      const before = validPhone(sh.phone);
      sh.phone = ev.target.value; wkPreview(sh);
      if (before !== validPhone(sh.phone)) {
        /* a known number fills in the name the shop already has, unless the worker typed one */
        if (validPhone(sh.phone) && !sh.name.trim()) { const k = knownName(normPhone(sh.phone)); if (k) sh.name = k; }
        renderOwner();
      }
      return;
    }
    const k = ev.target.dataset && ev.target.dataset.in;
    if (!k) return;
    S.cust[k] = ev.target.value;
    if (ui.errors[k]) {
      delete ui.errors[k];
      ev.target.removeAttribute('aria-invalid');
      const er = document.getElementById(`err-${k}`); if (er) er.remove();
    }
    save();
    if (k === 'district' || k === 'q') renderCustomer();
  });
}
bind(SHOP ? 'o' : 'c', SHOP ? O : C);

/* ---------- page chrome: install button ---------- */
/* install: Android/desktop Chrome hands us a prompt event; iOS needs Share → Add to Home Screen */
let installEvt = null;
const CAN_INSTALL = !!document.querySelector('link[rel="manifest"]');
const standalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
window.addEventListener('beforeinstallprompt', ev => { ev.preventDefault(); installEvt = ev; renderChrome(); });
window.addEventListener('appinstalled', () => { installEvt = null; renderChrome(); });
const topbar = document.getElementById('topbar'), installBtn = document.getElementById('install-btn');
function renderChrome() {
  const showInstall = CAN_INSTALL && !standalone();
  installBtn.hidden = !showInstall;
  topbar.hidden = !showInstall;
  installBtn.innerHTML = `${IC.download(16)}<span class="lbl"> ${SHOP ? L('ثبّت اللوحة على هذا الجهاز', 'Install the dashboard') : L('ثبّت التطبيق', 'Install app')}</span>`;
  installBtn.setAttribute('aria-label', L('ثبّت التطبيق', 'Install app'));
}
installBtn.addEventListener('click', () => {
  const evt = installEvt; installEvt = null;
  if (evt) { evt.prompt(); evt.userChoice.finally(() => renderChrome()); return; }
  toast(SHOP ? 'o' : 'c', isIOS() ? L('في سفاري: اضغط زر المشاركة ثم «إضافة إلى الشاشة الرئيسية».', 'In Safari: tap Share, then “Add to Home Screen”.') : L('من قائمة المتصفح اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».', 'From the browser menu choose “Install app” or “Add to Home screen”.'));
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') {
    if (ui.sheetC || ui.sheetO) { ui.sheetC = null; ui.sheetO = null; renderAll(); }
    return;
  }
  /* the PIN screen also takes the keyboard's digits */
  if (SHOP && R.shop && R.authKnown && !(R.user && R.user.staff) && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    const v = /^[0-9]$/.test(ev.key) ? ev.key : ev.key === 'Backspace' ? 'del' : ev.key === 'Enter' ? 'ok' : null;
    if (!v) return;
    ev.preventDefault();
    if (O.pin({ v }) !== false) renderAll();
  }
});

setInterval(() => {
  document.querySelectorAll('[data-ago]').forEach(el => { el.textContent = ago(Number(el.dataset.ago)); });
}, 30000);

/* ---------- new-order sound on the shop device ---------- */
/* browsers only allow sound after a tap, so the first tap anywhere turns it on */
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* no sound on this browser */ }
}
const audioReady = () => !!audioCtx && audioCtx.state === 'running';
function chime() {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  [880, 1175, 880].forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), s = t + i * 0.22;
    o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.35, s + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.3);
    o.start(s); o.stop(s + 0.32);
  });
}
if (SHOP) {
  document.addEventListener('pointerdown', () => { const was = audioReady(); unlockAudio(); if (!was) setTimeout(renderAll, 50); });
  O.sound = () => { unlockAudio(); setTimeout(() => { chime(); renderAll(); }, 50); return false; };
}

/* ---------- live data ---------- */
let stopOrders = null, stopCard = null;
function watchOrders() {
  if (stopOrders) { stopOrders(); stopOrders = null; }
  if (stopCard) { stopCard(); stopCard = null; }
  R.orders = []; R.rawOrders = []; R.pending.clear(); R.ordersLoaded = false; R.card = null; R.custCache = {};
  const u = R.user;
  if (SHOP && u && u.staff) {
    stopOrders = D.watchShopOrders(onOrders, () => toast('o', reasonText({ reason: 'staff-only' })));
  } else if (!SHOP && u && u.phone) {
    stopOrders = D.watchMyOrders(u.phone, onOrders);
    stopCard = D.watchCustomer(u.phone, c => { R.card = c; renderAll(); });
  }
}
/* show a step the moment it is tapped; once the server's copy has moved on, the server's copy wins */
function withPending(list) {
  if (!R.pending.size) return list;
  return list.map(o => {
    const p = R.pending.get(o.n);
    if (!p) return o;
    if (o.status !== p.from) { R.pending.delete(o.n); return o; }
    return { ...o, status: p.to, history: [...o.history, { s: p.to, t: Date.now(), by: 'staff' }], paid: p.to === 'done' ? true : o.paid };
  });
}
function refreshOrders() { R.orders = withPending(R.rawOrders); }
function onOrders(list) {
  const before = R.ordersLoaded ? new Map(R.orders.map(o => [o.n, o.status])) : null;
  R.rawOrders = list; refreshOrders(); R.ordersLoaded = true;
  list = R.orders;
  if (before) announce(before, list);
  renderAll();
}
/* what changed since the last snapshot: new orders for the shop, status updates for the customer */
function announce(before, list) {
  if (SHOP) {
    const fresh = list.filter(o => o.status === 'new' && !before.has(o.n));
    if (!fresh.length) return;
    chime();
    fresh.forEach(o => toast('o', L(`طلب جديد ${o.n} من ${o.customer.name}`, `New order #${o.n} from ${o.customer.name}`)));
    ui.flash = fresh[0].n;
    if (S.own.tab !== 'settings') S.own.tab = 'new';
    setTimeout(() => { if (ui.flash === fresh[0].n) { ui.flash = null; renderAll(); } }, 3200);
    return;
  }
  list.forEach(o => {
    const was = before.get(o.n), last = o.history[o.history.length - 1];
    if (was && was !== o.status && last && last.by !== 'customer') toast('c', L(`تحديث على طلبك ${o.n}: ${statusLabel(o)}`, `Update on order #${o.n}: ${statusLabel(o)}`));
  });
}

D.watchShop(s => {
  R.shopMissing = !s; R.offline = false;
  if (s) applyShop(s);
  applyPrefs(); renderAll();
}, () => { R.offline = true; renderAll(); });
if (!SHOP) D.watchSlotLoad(dateKey(0), m => { R.slotLoad = m; renderAll(); });
D.watchUser(u => {
  const changed = (R.user && R.user.uid) !== (u && u.uid) || (R.user && R.user.staff) !== (u && u.staff);
  R.user = u; R.authKnown = true;
  if (changed) watchOrders();
  renderAll();
});
window.addEventListener('online', () => { R.offline = false; renderAll(); });

applyPrefs();
renderChrome();
renderAll();

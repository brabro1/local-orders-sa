'use strict';
/*
 * Server side of the ordering app. Every change to an order goes through one of these
 * callable functions; the app never writes orders, customers or counters itself
 * (firestore.rules blocks it). That way prices, totals, order numbers and loyalty
 * stamps cannot be faked from a phone.
 *
 * Data (one shop = one document, everything else under it):
 *   shops/{shopId}                     menu, prices, slots, rules, live switches (public read)
 *   shops/{shopId}/orders/{n}          one order; n is the order number shown to people
 *   shops/{shopId}/customers/{+9665…}  loyalty stamps, rewards, monthly plan, order count
 *   shops/{shopId}/slotLoad/{date_slot} how many pickups are booked in a slot
 *   shops/{shopId}/private/*           staff PIN hash, login attempts, order counter (server only)
 *
 * Payment is not here yet: orders are cash or card in store ("cod"). See README.md.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const P = require('./src/pricing');
const F = require('./src/flow');
const { checkPin } = require('./src/pin');

/* [unverified] whether Cloud Functions run in Dammam (me-central2). Change in one place once the hosting decision is made. */
const REGION = 'me-central2';
setGlobalOptions({ region: REGION, maxInstances: 5 });

initializeApp();
const db = getFirestore();

const WALKIN_NAME = 'عميل المحل';
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 15 * 60e3;
const MIN_GAP_MS = 30e3; // one app order per customer every 30 seconds

/* ---------- helpers ---------- */

const fail = (code, reason) => { throw new HttpsError(code, reason); };

function shopIdOf(data) {
  const id = data && data.shopId;
  if (typeof id !== 'string' || !/^[a-z0-9-]{3,40}$/.test(id)) fail('invalid-argument', 'shop');
  return id;
}

/** The signed-in customer's phone (+9665…), verified by the SMS code. */
function customerPhone(req) {
  const phone = req.auth && req.auth.token && F.e164(req.auth.token.phone_number);
  if (!phone) fail('unauthenticated', 'sign-in');
  return phone;
}

function requireStaff(req, shopId) {
  const t = req.auth && req.auth.token;
  if (!t || t.role !== 'staff' || t.shopId !== shopId) fail('permission-denied', 'staff-only');
}

function text(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function orderNo(data) {
  const n = Number(data && data.n);
  if (!Number.isInteger(n) || n < 1) fail('invalid-argument', 'order');
  return n;
}

const refs = shopId => {
  const shop = db.collection('shops').doc(shopId);
  return {
    shop,
    order: n => shop.collection('orders').doc(String(n)),
    customer: phone => shop.collection('customers').doc(phone),
    slot: (date, slot) => shop.collection('slotLoad').doc(`${date}_${slot}`),
    counter: shop.collection('private').doc('counter'),
    pin: shop.collection('private').doc('auth'),
    attempts: shop.collection('private').doc('loginAttempts'),
  };
};

function newCustomer(phone, name, uid, now) {
  return { phone, name: name || '', uid: uid || null, stamps: 0, rewards: 0, sub: null, orders: 0, createdAt: Timestamp.fromMillis(now), lastOrderAt: null };
}

/** Wrap a pricing/validation error code as a client error. */
function guard(fn) {
  try { return fn(); } catch (e) {
    if (e instanceof HttpsError) throw e;
    fail('invalid-argument', e.message);
  }
}

function priced(shop, order, perks) {
  return { ...order, perks, totals: P.calc(shop, { ...order, perks }) };
}

/* ---------- customer ---------- */

/**
 * Customer places an order from the app.
 * data: { shopId, method: 'pickup'|'dropoff', slotDate, slot, speed, quick, items: [{id, svc, qty}],
 *         name, district, address, mapUrl, note }
 * quick = "just pick up my bag": no items yet, the shop counts them later.
 */
exports.placeOrder = onCall(async req => {
  const shopId = shopIdOf(req.data);
  const phone = customerPhone(req);
  const d = req.data || {};
  const R = refs(shopId);
  const now = Date.now();
  const today = F.riyadhDate(now);

  const method = d.method === 'pickup' ? 'pickup' : d.method === 'dropoff' ? 'dropoff' : fail('invalid-argument', 'method');
  const pick = method === 'pickup';
  const quick = pick && d.quick === true;
  const speed = d.speed === 'urgent' ? 'urgent' : 'normal';
  const name = text(d.name, 60);
  if (name.length < 2) fail('invalid-argument', 'name');
  const district = pick ? text(d.district, 60) : '';
  const address = pick ? text(d.address, 200) : '';
  const mapUrl = pick ? text(d.mapUrl, 300) : '';
  if (mapUrl && !/^https:\/\//.test(mapUrl)) fail('invalid-argument', 'map');
  const note = text(d.note, 300);

  return db.runTransaction(async tx => {
    const shopSnap = await tx.get(R.shop);
    if (!shopSnap.exists) fail('not-found', 'shop');
    const shop = shopSnap.data();
    /* when the shop is closed today, pickups for later days and drop-offs still go through (see slotProblem) */

    const items = quick ? [] : guard(() => P.priceLines(shop, d.items));
    if (!quick && !items.length) fail('invalid-argument', 'items');

    let slotRef = null, load = 0;
    if (pick) {
      if (!(shop.districts || []).some(x => x.ar === district)) fail('invalid-argument', 'district');
      if (!address) fail('invalid-argument', 'address');
      slotRef = R.slot(text(d.slotDate, 10), text(d.slot, 10));
      const slotSnap = await tx.get(slotRef);
      load = slotSnap.exists ? slotSnap.data().count || 0 : 0;
      const why = F.slotProblem(shop, text(d.slotDate, 10), text(d.slot, 10), load, now);
      if (why) fail('failed-precondition', why);
    }

    const [counterSnap, custSnap] = await Promise.all([tx.get(R.counter), tx.get(R.customer(phone))]);
    const cust = custSnap.exists ? custSnap.data() : newCustomer(phone, name, req.auth.uid, now);
    if (cust.lastOrderAt && now - cust.lastOrderAt.toMillis() < MIN_GAP_MS) fail('resource-exhausted', 'too-fast');

    const n = (counterSnap.exists ? counterSnap.data().seq : (shop.rules && shop.rules.firstOrderNo) || 1000) + 1;
    const base = {
      n, source: 'app', method, speed, quick, counted: !quick, items,
      slotDate: pick ? text(d.slotDate, 10) : null, slot: pick ? text(d.slot, 10) : null,
      firstOrder: (cust.orders || 0) === 0, today,
    };
    if (pick && !quick && P.calc(shop, base).sub < ((shop.rules && shop.rules.minPickup) || 0)) fail('failed-precondition', 'min-pickup');
    const perks = P.applyPerks(shop, base, cust);
    delete base.today;

    const order = {
      ...priced(shop, base, perks),
      customerPhone: phone,
      customerUid: req.auth.uid,
      customer: { name, phone: F.localPhone(phone), district, address, mapUrl },
      note, pay: 'cod', paid: false, stamped: false,
      status: 'new', history: [{ s: 'new', at: now, by: 'customer' }],
      createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now),
    };

    tx.set(R.counter, { seq: n });
    tx.set(R.order(n), order);
    if (slotRef) tx.set(slotRef, { count: load + 1 }, { merge: true });
    tx.set(R.customer(phone), {
      ...cust, name, uid: req.auth.uid, orders: (cust.orders || 0) + 1, lastOrderAt: Timestamp.fromMillis(now),
    });
    return { n, totals: order.totals };
  });
});

/** Customer cancels their own order while the shop has not accepted it. data: { shopId, n } */
exports.cancelOrder = onCall(async req => {
  const shopId = shopIdOf(req.data);
  const phone = customerPhone(req);
  const n = orderNo(req.data);
  const R = refs(shopId);
  return db.runTransaction(async tx => {
    const [shopSnap, oSnap] = await Promise.all([tx.get(R.shop), tx.get(R.order(n))]);
    if (!oSnap.exists || oSnap.data().customerPhone !== phone) fail('not-found', 'order');
    const o = oSnap.data();
    if (o.status !== 'new') fail('failed-precondition', 'not-cancellable');
    await endOrder(tx, R, shopSnap.data(), o, 'cancelled', 'customer');
    return { n, status: 'cancelled' };
  });
});

/**
 * Close an order as rejected or cancelled: give back plan pieces and rewards, free the slot.
 * Reads before writes, as Firestore transactions require.
 */
async function endOrder(tx, R, shop, o, status, by, extra = {}) {
  const now = Date.now();
  const custRef = o.customerPhone ? R.customer(o.customerPhone) : null;
  const slotRef = o.slot ? R.slot(o.slotDate, o.slot) : null;
  const [custSnap, slotSnap] = await Promise.all([custRef && tx.get(custRef), slotRef && tx.get(slotRef)]);
  if (custSnap && custSnap.exists && (o.perks.subPieces || o.perks.reward)) {
    const c = custSnap.data();
    P.revertPerks(shop, o.perks, c);
    tx.update(custRef, { sub: c.sub, rewards: c.rewards });
  }
  if (slotSnap && slotSnap.exists) tx.update(slotRef, { count: Math.max(0, (slotSnap.data().count || 0) - 1) });
  tx.update(R.order(o.n), {
    ...extra, status, history: [...o.history, { s: status, at: now, by }], updatedAt: Timestamp.fromMillis(now),
  });
}

/* ---------- staff ---------- */

/**
 * Shop device signs in with the shop PIN and gets a token that only works for this shop.
 * data: { shopId, pin }. After 5 wrong PINs the shop is locked for 15 minutes.
 */
exports.staffLogin = onCall(async req => {
  const shopId = shopIdOf(req.data);
  const pin = String((req.data && req.data.pin) || '');
  if (!/^\d{4,8}$/.test(pin)) fail('invalid-argument', 'pin');
  const R = refs(shopId);
  const now = Date.now();

  const ok = await db.runTransaction(async tx => {
    const [pinSnap, attSnap] = await Promise.all([tx.get(R.pin), tx.get(R.attempts)]);
    if (!pinSnap.exists) fail('not-found', 'shop');
    const att = attSnap.exists ? attSnap.data() : { fails: 0, lockedUntil: 0 };
    if (att.lockedUntil > now) return 'locked';
    const good = checkPin(pin, pinSnap.data());
    if (good) tx.set(R.attempts, { fails: 0, lockedUntil: 0 });
    else {
      const fails = (att.fails || 0) + 1;
      tx.set(R.attempts, fails >= PIN_MAX_FAILS ? { fails: 0, lockedUntil: now + PIN_LOCK_MS } : { fails, lockedUntil: 0 });
    }
    return good ? 'ok' : 'wrong';
  });
  if (ok === 'locked') fail('resource-exhausted', 'locked');
  if (ok !== 'ok') fail('permission-denied', 'wrong-pin');
  const token = await getAuth().createCustomToken(`staff-${shopId}`, { shopId, role: 'staff' });
  return { token };
});

/** Move an order one step forward. data: { shopId, n, to } — `to` must be the next step. */
exports.advanceOrder = onCall(async req => {
  const shopId = shopIdOf(req.data);
  requireStaff(req, shopId);
  const n = orderNo(req.data);
  const R = refs(shopId);
  return db.runTransaction(async tx => {
    const [shopSnap, oSnap] = await Promise.all([tx.get(R.shop), tx.get(R.order(n))]);
    if (!oSnap.exists) fail('not-found', 'order');
    const shop = shopSnap.data(), o = oSnap.data();
    const to = F.nextStatus(o);
    if (!to || req.data.to !== to) fail('failed-precondition', 'wrong-step');
    if (to === 'counted' && !o.counted) fail('failed-precondition', 'needs-count');
    const now = Date.now();
    const patch = { status: to, history: [...o.history, { s: to, at: now, by: 'staff' }], updatedAt: Timestamp.fromMillis(now) };
    let stamp = null;
    if (to === 'done') {
      patch.paid = true; // handed over and paid (cash or card in store)
      if (o.customerPhone && !o.stamped) {
        const custRef = R.customer(o.customerPhone);
        const cSnap = await tx.get(custRef);
        if (cSnap.exists) {
          const c = cSnap.data(), goal = (shop.rules && shop.rules.stampGoal) || 6;
          let stamps = (c.stamps || 0) + 1, rewards = c.rewards || 0;
          if (stamps >= goal) { stamps = 0; rewards += 1; stamp = 'reward'; } else stamp = 'stamp';
          tx.update(custRef, { stamps, rewards });
          patch.stamped = true;
        }
      }
    }
    tx.update(R.order(n), patch);
    return { n, status: to, stamp };
  });
});

/** Decline an order with one of the shop's reasons. data: { shopId, n, reason: index } */
exports.rejectOrder = onCall(async req => {
  const shopId = shopIdOf(req.data);
  requireStaff(req, shopId);
  const n = orderNo(req.data);
  const R = refs(shopId);
  return db.runTransaction(async tx => {
    const [shopSnap, oSnap] = await Promise.all([tx.get(R.shop), tx.get(R.order(n))]);
    if (!oSnap.exists) fail('not-found', 'order');
    const shop = shopSnap.data(), o = oSnap.data();
    if (!F.REJECTABLE.includes(o.status)) fail('failed-precondition', 'not-rejectable');
    const reason = Number(req.data.reason);
    if (!Number.isInteger(reason) || !(shop.rejectReasons || [])[reason]) fail('invalid-argument', 'reason');
    await endOrder(tx, R, shop, o, 'rejected', 'staff', { rejectReason: reason });
    return { n, status: 'rejected' };
  });
});

/**
 * Save the counted items (the final bill). Recomputes totals, plan pieces and reward.
 * data: { shopId, n, items: [{id, svc, qty}] }
 */
exports.saveCount = onCall(async req => {
  const shopId = shopIdOf(req.data);
  requireStaff(req, shopId);
  const n = orderNo(req.data);
  const R = refs(shopId);
  return db.runTransaction(async tx => {
    const [shopSnap, oSnap] = await Promise.all([tx.get(R.shop), tx.get(R.order(n))]);
    if (!oSnap.exists) fail('not-found', 'order');
    const shop = shopSnap.data(), o = oSnap.data();
    if (!F.COUNTABLE.includes(o.status)) fail('failed-precondition', 'not-countable');
    const items = guard(() => P.priceLines(shop, req.data.items, { allowPaused: true }));
    if (!items.length) fail('invalid-argument', 'items');

    const custRef = o.customerPhone ? R.customer(o.customerPhone) : null;
    const cSnap = custRef ? await tx.get(custRef) : null;
    const cust = cSnap && cSnap.exists ? cSnap.data() : null;
    const now = Date.now();
    P.revertPerks(shop, o.perks, cust);
    const perks = P.applyPerks(shop, { ...o, items, today: F.riyadhDate(now) }, cust);
    if (cust) tx.update(custRef, { sub: cust.sub, rewards: cust.rewards });

    const totals = P.calc(shop, { ...o, items, perks });
    const patch = { items, perks, totals, counted: true, updatedAt: Timestamp.fromMillis(now) };
    if (o.status !== 'counted') {
      patch.status = 'counted';
      patch.history = [...o.history, { s: 'counted', at: now, by: 'staff' }];
    }
    tx.update(R.order(n), patch);
    return { n, totals };
  });
});

/**
 * In-store order typed by the staff ("طلب جديد في المحل"). Starts already counted.
 * data: { shopId, items, phone?, name?, n? }  — with n, edits that in-store order instead.
 */
exports.saveWalkin = onCall(async req => {
  const shopId = shopIdOf(req.data);
  requireStaff(req, shopId);
  const d = req.data || {};
  const R = refs(shopId);
  const phone = d.phone ? F.e164(d.phone) : null;
  if (d.phone && !phone) fail('invalid-argument', 'phone');
  const typedName = text(d.name, 60);
  const editN = d.n == null ? null : orderNo(d);
  const now = Date.now();
  const today = F.riyadhDate(now);

  return db.runTransaction(async tx => {
    const shopSnap = await tx.get(R.shop);
    if (!shopSnap.exists) fail('not-found', 'shop');
    const shop = shopSnap.data();
    const items = guard(() => P.priceLines(shop, d.items, { allowPaused: true }));
    if (!items.length) fail('invalid-argument', 'items');

    /* reads first: the old order and its customer (when editing), the new customer, the counter */
    const old = editN ? await tx.get(R.order(editN)) : null;
    if (editN && (!old.exists || old.data().source !== 'store')) fail('not-found', 'order');
    const o = old ? old.data() : null;
    if (o && F.FINISHED.includes(o.status)) fail('failed-precondition', 'finished');
    const oldPhone = o ? o.customerPhone : null;
    const phones = [...new Set([oldPhone, phone].filter(Boolean))];
    const snaps = await Promise.all(phones.map(p => tx.get(R.customer(p))));
    const custs = Object.fromEntries(phones.map((p, i) => [p, snaps[i].exists ? snaps[i].data() : null]));
    const counterSnap = editN ? null : await tx.get(R.counter);

    if (o && oldPhone && custs[oldPhone]) P.revertPerks(shop, o.perks, custs[oldPhone]);
    let cust = phone ? custs[phone] : null;
    if (phone && !cust) cust = custs[phone] = newCustomer(phone, typedName, null, now);
    const name = typedName || (cust && cust.name) || WALKIN_NAME;
    if (cust && !cust.name && typedName) cust.name = typedName;

    const n = editN || (counterSnap.exists ? counterSnap.data().seq : (shop.rules && shop.rules.firstOrderNo) || 1000) + 1;
    const base = { n, source: 'store', method: 'dropoff', speed: 'normal', quick: false, counted: true, items, slotDate: null, slot: null, firstOrder: false };
    const perks = P.applyPerks(shop, { ...base, today }, cust);
    const fields = {
      ...priced(shop, base, perks),
      customerPhone: phone, customerUid: (cust && cust.uid) || null,
      customer: { name, phone: F.localPhone(phone), district: '', address: '', mapUrl: '' },
      updatedAt: Timestamp.fromMillis(now),
    };

    /* the order moves to the new phone's count when the staff fixes a wrong number */
    for (const p of phones) {
      const c = custs[p];
      if (!c) continue;
      if (p === phone && oldPhone !== phone) c.orders = (c.orders || 0) + 1;
      if (p === oldPhone && oldPhone !== phone) c.orders = Math.max(0, (c.orders || 0) - 1);
      tx.set(R.customer(p), c);
    }
    if (o) {
      tx.update(R.order(n), { ...fields, edited: Timestamp.fromMillis(now) });
    } else {
      tx.set(R.counter, { seq: n });
      tx.set(R.order(n), {
        ...fields, note: '', pay: 'cod', paid: false, stamped: false, status: 'counted',
        history: ['new', 'accepted', 'counted'].map(s => ({ s, at: now, by: 'staff' })),
        createdAt: Timestamp.fromMillis(now),
      });
    }
    return { n, totals: fields.totals };
  });
});

/**
 * The shop sells a monthly plan at the counter (paid cash or card) and turns it on for a mobile number.
 * It starts a fresh month today: all the plan's pieces, valid for 30 days. Activating again replaces
 * the current plan (pieces left over from the old month do not carry over).
 * Each sale is also kept in shops/{shopId}/planSales so the shop can count what it collected.
 * data: { shopId, phone, plan, name? }
 */
exports.setPlan = onCall(async req => {
  const shopId = shopIdOf(req.data);
  requireStaff(req, shopId);
  const d = req.data || {};
  const phone = F.e164(d.phone);
  if (!phone) fail('invalid-argument', 'phone');
  const name = text(d.name, 60);
  const R = refs(shopId);
  const now = Date.now();
  return db.runTransaction(async tx => {
    const [shopSnap, cSnap] = await Promise.all([tx.get(R.shop), tx.get(R.customer(phone))]);
    if (!shopSnap.exists) fail('not-found', 'shop');
    const plan = (shopSnap.data().plans || []).find(p => p.id === d.plan);
    if (!plan) fail('invalid-argument', 'plan');
    const c = cSnap.exists ? cSnap.data() : newCustomer(phone, name, null, now);
    if (name && !c.name) c.name = name;
    const sub = { plan: plan.id, left: plan.pieces, since: F.riyadhDate(now), renews: F.riyadhDate(now, 30), price: plan.price };
    tx.set(R.customer(phone), { ...c, sub });
    tx.set(R.shop.collection('planSales').doc(), { phone, plan: plan.id, price: plan.price, at: Timestamp.fromMillis(now) });
    return { phone: F.localPhone(phone), name: c.name || '', sub };
  });
});

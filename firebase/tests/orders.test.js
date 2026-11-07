'use strict';
/* The whole order cycle against the emulators: customer app → server functions → shop device. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { seed } = require('../seed/seed');
const demo = require('../seed/demo-shop');
const { PROJECT, phoneSignIn, staffSignIn, call, riyadhDate } = require('./helpers');

const SHOP = demo.id;
const db = getFirestore(initializeApp({ projectId: PROJECT }, 'orders-test'));
const shopRef = db.collection('shops').doc(SHOP);
const orderDoc = async n => (await shopRef.collection('orders').doc(String(n)).get()).data();
const custDoc = async p => (await shopRef.collection('customers').doc(p).get()).data();

/* each test gets fresh phone numbers, because a customer can order only once every 30 seconds */
let nextPhone = 500000100;
const newPhone = () => `+966${nextPhone++}`;

const pickup = extra => ({
  shopId: SHOP, method: 'pickup', slotDate: riyadhDate(1), slot: 'a', speed: 'normal',
  items: [{ id: 'thobe', svc: 'wash', qty: 6 }], name: 'عميل تجربة', district: 'النرجس', address: 'شارع 1، منزل 2',
  ...extra,
});

test.beforeEach(async () => { await seed({ projectId: PROJECT }); });

test('customer places a pickup order; server sets price, number, slot and customer record', async () => {
  const phone = newPhone();
  const tok = await phoneSignIn(phone);
  const r = await call('placeOrder', pickup({ items: [{ id: 'thobe', svc: 'wash', qty: 6, price: 1 }], total: 1 }), tok);
  assert.ok(r.result, JSON.stringify(r));
  assert.equal(r.result.n, 1001);
  // 42 + 15 delivery − 4 first-order discount
  assert.equal(r.result.totals.total, 53);

  const o = await orderDoc(1001);
  assert.equal(o.status, 'new');
  assert.equal(o.customerPhone, phone);
  assert.equal(o.customer.phone, `0${phone.slice(4)}`);
  assert.equal(o.items[0].price, 7);
  assert.equal(o.pay, 'cod');
  assert.equal((await shopRef.collection('slotLoad').doc(`${riyadhDate(1)}_a`).get()).data().count, 1);
  const c = await custDoc(phone);
  assert.equal(c.orders, 1);
  assert.equal(c.name, 'عميل تجربة');

  const r2 = await call('placeOrder', pickup(), tok);
  assert.equal(r2.error.message, 'too-fast');
});

test('orders need a signed-in phone, a known district, the minimum and a free slot', async () => {
  assert.equal((await call('placeOrder', pickup())).error.message, 'sign-in');
  const tok = await phoneSignIn(newPhone());
  assert.equal((await call('placeOrder', pickup({ district: 'حي غير موجود' }), tok)).error.message, 'district');
  assert.equal((await call('placeOrder', pickup({ items: [{ id: 'thobe', svc: 'wash', qty: 1 }] }), tok)).error.message, 'min-pickup');
  assert.equal((await call('placeOrder', pickup({ slotDate: riyadhDate(5) }), tok)).error.message, 'slot-date');
  assert.equal((await call('placeOrder', pickup({ items: [{ id: 'gold', svc: 'wash', qty: 9 }] }), tok)).error.message, 'item-unknown');

  for (let i = 0; i < 3; i++) {
    const r = await call('placeOrder', pickup(), await phoneSignIn(newPhone()));
    assert.ok(r.result, JSON.stringify(r));
  }
  assert.equal((await call('placeOrder', pickup(), tok)).error.message, 'slot-full');
});

test('quick pickup has no items until the shop counts them', async () => {
  const tok = await phoneSignIn(newPhone());
  const r = await call('placeOrder', pickup({ quick: true, items: undefined }), tok);
  assert.ok(r.result, JSON.stringify(r));
  const o = await orderDoc(r.result.n);
  assert.equal(o.counted, false);
  assert.equal(o.items.length, 0);
});

test('customer can cancel only their own new order; the slot is freed', async () => {
  const phone = newPhone();
  const tok = await phoneSignIn(phone);
  const { result } = await call('placeOrder', pickup(), tok);
  const other = await phoneSignIn(newPhone());
  assert.equal((await call('cancelOrder', { shopId: SHOP, n: result.n }, other)).error.message, 'order');
  assert.equal((await call('cancelOrder', { shopId: SHOP, n: result.n }, tok)).result.status, 'cancelled');
  assert.equal((await shopRef.collection('slotLoad').doc(`${riyadhDate(1)}_a`).get()).data().count, 0);
  assert.equal((await call('cancelOrder', { shopId: SHOP, n: result.n }, tok)).error.message, 'not-cancellable');
});

test('shop PIN: wrong PIN refused, five wrong PINs lock the shop', async () => {
  assert.equal((await call('staffLogin', { shopId: SHOP, pin: '0000' })).error.message, 'wrong-pin');
  for (let i = 0; i < 4; i++) await call('staffLogin', { shopId: SHOP, pin: '0000' });
  assert.equal((await call('staffLogin', { shopId: SHOP, pin: demo.pin })).error.message, 'locked');
});

test('full pickup cycle on the shop device, ending with a loyalty stamp', async () => {
  const phone = newPhone();
  const cust = await phoneSignIn(phone);
  const staff = await staffSignIn(SHOP, demo.pin);
  const { result } = await call('placeOrder', pickup({ quick: true, items: undefined }), cust);
  const n = result.n;
  const go = to => call('advanceOrder', { shopId: SHOP, n, to }, staff);

  assert.equal((await call('advanceOrder', { shopId: SHOP, n, to: 'accepted' }, cust)).error.message, 'staff-only');
  assert.equal((await go('cleaning')).error.message, 'wrong-step');
  assert.equal((await go('accepted')).result.status, 'accepted');
  assert.equal((await go('picking')).result.status, 'picking');
  assert.equal((await go('counted')).error.message, 'needs-count');

  const counted = await call('saveCount', { shopId: SHOP, n, items: [{ id: 'abaya', svc: 'wash', qty: 2 }, { id: 'bisht', svc: 'dry', qty: 1 }] }, staff);
  assert.ok(counted.result, JSON.stringify(counted));
  // 24 + 45 = 69, +15 delivery, −7 first order
  assert.equal(counted.result.totals.total, 77);
  assert.equal((await orderDoc(n)).status, 'counted');

  for (const s of ['cleaning', 'ready', 'delivering']) assert.equal((await go(s)).result.status, s);
  const done = await go('done');
  assert.equal(done.result.stamp, 'stamp');
  const o = await orderDoc(n);
  assert.equal(o.paid, true);
  assert.deepEqual(o.history.map(h => h.s), ['new', 'accepted', 'picking', 'counted', 'cleaning', 'ready', 'delivering', 'done']);
  assert.equal((await custDoc(phone)).stamps, 1);
  assert.equal((await go('done')).error.message, 'wrong-step');
});

test('sixth stamp turns into a reward, used on the next order', async () => {
  const phone = newPhone();
  await shopRef.collection('customers').doc(phone).set({ phone, name: 'قديم', uid: null, stamps: 5, rewards: 0, sub: null, orders: 5, lastOrderAt: null });
  const staff = await staffSignIn(SHOP, demo.pin);
  const w = await call('saveWalkin', { shopId: SHOP, phone: `0${phone.slice(4)}`, items: [{ id: 'thobe', svc: 'wash', qty: 2 }] }, staff);
  for (const s of ['cleaning', 'ready', 'done']) await call('advanceOrder', { shopId: SHOP, n: w.result.n, to: s }, staff);
  const c = await custDoc(phone);
  assert.equal(c.stamps, 0);
  assert.equal(c.rewards, 1);

  const next = await call('placeOrder', pickup(), await phoneSignIn(phone));
  // 42 + 15 delivery − 30 reward (not a first order)
  assert.equal(next.result.totals.total, 27);
  assert.equal((await custDoc(phone)).rewards, 0);
});

test('in-store order uses the monthly plan; editing it recalculates', async () => {
  const phone = newPhone();
  await shopRef.collection('customers').doc(phone).set({ phone, name: 'مشترك', uid: null, stamps: 0, rewards: 0, sub: { plan: 'family', left: 5, renews: riyadhDate(20) }, orders: 3, lastOrderAt: null });
  const staff = await staffSignIn(SHOP, demo.pin);
  const w = await call('saveWalkin', { shopId: SHOP, phone: `0${phone.slice(4)}`, items: [{ id: 'thobe', svc: 'wash', qty: 4 }] }, staff);
  assert.ok(w.result, JSON.stringify(w));
  assert.equal(w.result.totals.total, 0);
  assert.equal((await custDoc(phone)).sub.left, 1);
  const o = await orderDoc(w.result.n);
  assert.equal(o.customer.name, 'مشترك');
  assert.equal(o.status, 'counted');

  const e = await call('saveWalkin', { shopId: SHOP, n: w.result.n, phone: `0${phone.slice(4)}`, items: [{ id: 'thobe', svc: 'wash', qty: 7 }] }, staff);
  assert.ok(e.result, JSON.stringify(e));
  // 5 pieces from the plan, 2 paid
  assert.equal(e.result.totals.total, 14);
  assert.equal((await custDoc(phone)).sub.left, 0);
  assert.equal((await custDoc(phone)).orders, 4);

  const anon = await call('saveWalkin', { shopId: SHOP, items: [{ id: 'shirt', svc: 'press', qty: 3 }] }, staff);
  assert.equal((await orderDoc(anon.result.n)).customer.name, 'عميل المحل');
});

test('rejecting gives back the reward and frees the slot', async () => {
  const phone = newPhone();
  await shopRef.collection('customers').doc(phone).set({ phone, name: 'س', uid: null, stamps: 0, rewards: 1, sub: null, orders: 2, lastOrderAt: null });
  const { result } = await call('placeOrder', pickup(), await phoneSignIn(phone));
  assert.equal((await custDoc(phone)).rewards, 0);
  const staff = await staffSignIn(SHOP, demo.pin);
  assert.equal((await call('rejectOrder', { shopId: SHOP, n: result.n, reason: 99 }, staff)).error.message, 'reason');
  assert.equal((await call('rejectOrder', { shopId: SHOP, n: result.n, reason: 1 }, staff)).result.status, 'rejected');
  assert.equal((await custDoc(phone)).rewards, 1);
  assert.equal((await orderDoc(result.n)).rejectReason, 1);
  assert.equal((await shopRef.collection('slotLoad').doc(`${riyadhDate(1)}_a`).get()).data().count, 0);
});

test('shop turns on a monthly plan at the counter; the next order uses it', async () => {
  const phone = newPhone(), local = `0${phone.slice(4)}`;
  const staff = await staffSignIn(SHOP, demo.pin);
  const cust = await phoneSignIn(phone);
  assert.equal((await call('setPlan', { shopId: SHOP, phone: local, plan: 'family' }, cust)).error.message, 'staff-only');
  assert.equal((await call('setPlan', { shopId: SHOP, phone: local, plan: 'gold' }, staff)).error.message, 'plan');
  assert.equal((await call('setPlan', { shopId: SHOP, phone: '0123', plan: 'family' }, staff)).error.message, 'phone');

  const r = await call('setPlan', { shopId: SHOP, phone: local, plan: 'solo', name: 'مشترك جديد' }, staff);
  assert.ok(r.result, JSON.stringify(r));
  assert.equal(r.result.sub.left, 30);
  assert.equal(r.result.sub.renews, riyadhDate(30));
  const c = await custDoc(phone);
  assert.equal(c.name, 'مشترك جديد');
  assert.equal(c.sub.plan, 'solo');
  assert.equal((await shopRef.collection('planSales').where('phone', '==', phone).get()).size, 1);

  // 6 thobes come off the plan: 42 − 42 from the plan + 15 delivery − 4 first order = 11
  const o = await call('placeOrder', pickup(), cust);
  assert.equal(o.result.totals.subFree, 42);
  assert.equal(o.result.totals.total, 11);
  assert.equal((await custDoc(phone)).sub.left, 24);

  // buying again starts a fresh month with all pieces
  await call('setPlan', { shopId: SHOP, phone: local, plan: 'family' }, staff);
  assert.deepEqual([(await custDoc(phone)).sub.plan, (await custDoc(phone)).sub.left], ['family', 70]);
});

test('staff of one shop cannot touch another shop', async () => {
  const staff = await staffSignIn(SHOP, demo.pin);
  const r = await call('saveWalkin', { shopId: 'other-shop', items: [{ id: 'thobe', svc: 'wash', qty: 1 }] }, staff);
  assert.equal(r.error.message, 'staff-only');
});

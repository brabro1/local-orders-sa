'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../functions/src/pricing');
const F = require('../../functions/src/flow');
const { shop } = require('../../seed/demo-shop');

const lines = raw => P.priceLines(shop, raw);

test('prices come from the shop, not the client', () => {
  const items = lines([{ id: 'thobe', svc: 'wash', qty: 6, price: 1 }, { id: 'shmagh', svc: 'wash', qty: 4 }]);
  assert.deepEqual(items.map(l => l.price), [7, 5]);
  assert.equal(P.calc(shop, { items }).sub, 62);
});

test('same item and service twice is merged', () => {
  const items = lines([{ id: 'thobe', svc: 'wash', qty: 2 }, { id: 'thobe', svc: 'wash', qty: 3 }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 5);
});

test('unknown items, missing services and bad quantities are refused', () => {
  assert.throws(() => lines([{ id: 'nope', svc: 'wash', qty: 1 }]), /item-unknown/);
  assert.throws(() => lines([{ id: 'bisht', svc: 'wash', qty: 1 }]), /item-unknown/);
  assert.throws(() => lines([{ id: 'thobe', svc: 'wash', qty: 0 }]), /qty/);
  assert.throws(() => lines([{ id: 'thobe', svc: 'wash', qty: 2.5 }]), /qty/);
  assert.throws(() => lines([{ id: 'thobe', svc: 'wash', qty: 100 }]), /qty/);
  assert.throws(() => lines('thobe'), /items/);
});

test('paused dry cleaning is refused for customers but the shop can still count it', () => {
  const paused = { ...shop, live: { ...shop.live, dryClean: false } };
  assert.throws(() => P.priceLines(paused, [{ id: 'bisht', svc: 'dry', qty: 1 }]), /service-paused/);
  assert.equal(P.priceLines(paused, [{ id: 'bisht', svc: 'dry', qty: 1 }], { allowPaused: true })[0].price, 45);
});

test('delivery fee under 100, urgent +50%, first-order discount capped at 20', () => {
  const items = lines([{ id: 'thobe', svc: 'wash', qty: 6 }]); // 42
  const t = P.calc(shop, { items, method: 'pickup', speed: 'urgent', firstOrder: true });
  assert.equal(t.sub, 42);
  assert.equal(t.urgent, 21);
  assert.equal(t.delivery, 15);
  assert.equal(t.discount, 4);
  assert.equal(t.total, 42 + 21 + 15 - 4);
  const big = P.calc(shop, { items: lines([{ id: 'evening', svc: 'dry', qty: 4 }]), method: 'pickup', firstOrder: true });
  assert.equal(big.delivery, 0);
  assert.equal(big.discount, 20);
  assert.equal(P.calc(shop, { items, method: 'dropoff' }).delivery, 0);
});

test('monthly plan covers clothes it includes, not home linens or dry cleaning', () => {
  const items = lines([{ id: 'blanket2', svc: 'wash', qty: 1 }, { id: 'thobe', svc: 'dry', qty: 1 }, { id: 'thobe', svc: 'wash', qty: 5 }]);
  const customer = { sub: { plan: 'family', left: 3, renews: '2099-01-01' }, rewards: 0 };
  const perks = P.applyPerks(shop, { items, method: 'dropoff' }, customer);
  assert.deepEqual(perks, { subPieces: 3, subValue: 21, reward: false });
  assert.equal(customer.sub.left, 0);
  const t = P.calc(shop, { items, method: 'dropoff', perks });
  assert.equal(t.total, 35 + 12 + 35 - 21);
});

test('press plan only covers pressing', () => {
  const items = lines([{ id: 'thobe', svc: 'wash', qty: 2 }, { id: 'shirt', svc: 'press', qty: 2 }]);
  const c = { sub: { plan: 'press', left: 40 } };
  assert.deepEqual(P.subCover(shop, items, c.sub), { pieces: 2, value: 6 });
});

test('expired plan is ignored', () => {
  const items = lines([{ id: 'thobe', svc: 'wash', qty: 2 }]);
  const c = { sub: { plan: 'solo', left: 30, renews: '2026-01-01' }, rewards: 0 };
  const perks = P.applyPerks(shop, { items, today: '2026-11-07' }, c);
  assert.equal(perks.subPieces, 0);
  assert.equal(c.sub.left, 30);
});

test('loyalty reward takes up to 30 off and is used only when there is something to pay', () => {
  const items = lines([{ id: 'abaya', svc: 'wash', qty: 4 }]); // 48
  const c = { rewards: 1, sub: null };
  const perks = P.applyPerks(shop, { items, method: 'dropoff' }, c);
  assert.equal(perks.reward, true);
  assert.equal(c.rewards, 0);
  assert.equal(P.calc(shop, { items, perks }).total, 18);

  const free = { rewards: 1, sub: { plan: 'family', left: 70 } };
  const p2 = P.applyPerks(shop, { items: lines([{ id: 'thobe', svc: 'wash', qty: 2 }]) }, free);
  assert.equal(p2.reward, false, 'plan already covers everything, keep the reward');
  assert.equal(free.rewards, 1);
});

test('reverting gives back pieces (never above the plan size) and the reward', () => {
  const c = { rewards: 0, sub: { plan: 'solo', left: 29 } };
  P.revertPerks(shop, { subPieces: 5, reward: true }, c);
  assert.equal(c.sub.left, 30);
  assert.equal(c.rewards, 1);
});

test('order steps', () => {
  assert.equal(F.nextStatus({ method: 'pickup', status: 'accepted' }), 'picking');
  assert.equal(F.nextStatus({ method: 'dropoff', status: 'accepted' }), 'counted');
  assert.equal(F.nextStatus({ method: 'pickup', status: 'ready' }), 'delivering');
  assert.equal(F.nextStatus({ method: 'dropoff', status: 'ready' }), 'done');
  assert.equal(F.nextStatus({ method: 'pickup', status: 'done' }), null);
  assert.equal(F.nextStatus({ method: 'pickup', status: 'rejected' }), null);
});

test('Saudi phone numbers', () => {
  assert.equal(F.e164('0551234567'), '+966551234567');
  assert.equal(F.e164('+966 55 123 4567'), '+966551234567');
  assert.equal(F.e164('00966551234567'), '+966551234567');
  assert.equal(F.e164('٠٥٥١٢٣٤٥٦٧'), '+966551234567');
  assert.equal(F.e164('0112345678'), null);
  assert.equal(F.e164('055123'), null);
  assert.equal(F.localPhone('+966551234567'), '0551234567');
});

test('Riyadh date and pickup slots', () => {
  // 2026-11-07 20:30 UTC = 23:30 Riyadh, still the 7th; 21:30 UTC = 00:30 on the 8th
  assert.equal(F.riyadhNow(Date.UTC(2026, 10, 7, 20, 30)).date, '2026-11-07');
  assert.equal(F.riyadhNow(Date.UTC(2026, 10, 7, 21, 30)).date, '2026-11-08');
  const morning = Date.UTC(2026, 10, 7, 6, 0); // 09:00 Riyadh
  assert.equal(F.slotProblem(shop, '2026-11-07', 'a', 0, morning), null);
  assert.equal(F.slotProblem(shop, '2026-11-07', 'm', 0, morning), 'slot-past');
  assert.equal(F.slotProblem(shop, '2026-11-09', 'm', 0, morning), null);
  assert.equal(F.slotProblem(shop, '2026-11-10', 'm', 0, morning), 'slot-date');
  assert.equal(F.slotProblem(shop, '2026-11-07', 'a', 3, morning), 'slot-full');
  assert.equal(F.slotProblem(shop, '2026-11-07', 'x', 0, morning), 'slot-unknown');
  assert.equal(F.slotProblem({ ...shop, live: { ...shop.live, todaySlots: false } }, '2026-11-07', 'a', 0, morning), 'slot-paused');
  assert.equal(F.slotProblem({ ...shop, live: { ...shop.live, todaySlots: false } }, '2026-11-08', 'a', 0, morning), null);
  assert.equal(F.slotProblem({ ...shop, live: { ...shop.live, open: false } }, '2026-11-08', 'a', 0, morning), 'closed');
});

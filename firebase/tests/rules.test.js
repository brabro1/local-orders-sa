'use strict';
/* Who can read and write what, straight against firestore.rules. */
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where } = require('firebase/firestore');
const { PROJECT } = require('./helpers');
const demo = require('../seed/demo-shop');

const SHOP = demo.id;
const ME = '+966500000001';
const OTHER = '+966500000002';
let env;

test.before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'), host, port: Number(port) },
  });
});
test.after(async () => { await env.cleanup(); });

test.beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'shops', SHOP), demo.shop);
    await setDoc(doc(db, 'shops', SHOP, 'private', 'auth'), { salt: '00', hash: '00' });
    await setDoc(doc(db, 'shops', SHOP, 'orders', '1001'), { n: 1001, customerPhone: ME, status: 'new' });
    await setDoc(doc(db, 'shops', SHOP, 'orders', '1002'), { n: 1002, customerPhone: OTHER, status: 'new' });
    await setDoc(doc(db, 'shops', SHOP, 'customers', ME), { phone: ME, stamps: 2 });
    await setDoc(doc(db, 'shops', SHOP, 'customers', OTHER), { phone: OTHER, stamps: 4 });
    await setDoc(doc(db, 'shops', SHOP, 'slotLoad', '2026-11-08_a'), { count: 2 });
  });
});

const anon = () => env.unauthenticatedContext().firestore();
const customer = phone => env.authenticatedContext(`u${phone}`, { phone_number: phone }).firestore();
const staff = (shopId = SHOP) => env.authenticatedContext(`staff-${shopId}`, { role: 'staff', shopId }).firestore();
const orders = db => collection(db, 'shops', SHOP, 'orders');

test('anyone can read the menu and slot load; nobody but the server writes them', async () => {
  await assertSucceeds(getDoc(doc(anon(), 'shops', SHOP)));
  await assertSucceeds(getDoc(doc(anon(), 'shops', SHOP, 'slotLoad', '2026-11-08_a')));
  await assertFails(setDoc(doc(anon(), 'shops', 'new-shop'), { name: 'x' }));
  await assertFails(updateDoc(doc(customer(ME), 'shops', SHOP), { 'live.open': false }));
  await assertFails(setDoc(doc(staff(), 'shops', SHOP, 'slotLoad', '2026-11-08_a'), { count: 0 }));
});

test('shop device can flip its live switches but not prices', async () => {
  await assertSucceeds(updateDoc(doc(staff(), 'shops', SHOP), { live: { open: false, dryClean: true, todaySlots: true } }));
  await assertFails(updateDoc(doc(staff(), 'shops', SHOP), { live: { open: 'no', dryClean: true, todaySlots: true } }));
  await assertFails(updateDoc(doc(staff(), 'shops', SHOP), { live: { open: true, dryClean: true, todaySlots: true, extra: 1 } }));
  await assertFails(updateDoc(doc(staff(), 'shops', SHOP), { 'rules.fee': 0 }));
  await assertFails(updateDoc(doc(staff('other-shop'), 'shops', SHOP), { live: { open: false, dryClean: true, todaySlots: true } }));
});

test('customer sees only their own orders and loyalty card', async () => {
  const db = customer(ME);
  await assertSucceeds(getDoc(doc(db, 'shops', SHOP, 'orders', '1001')));
  await assertFails(getDoc(doc(db, 'shops', SHOP, 'orders', '1002')));
  await assertSucceeds(getDocs(query(orders(db), where('customerPhone', '==', ME))));
  await assertFails(getDocs(orders(db)));
  await assertFails(getDocs(query(orders(db), where('customerPhone', '==', OTHER))));
  await assertSucceeds(getDoc(doc(db, 'shops', SHOP, 'customers', ME)));
  await assertFails(getDoc(doc(db, 'shops', SHOP, 'customers', OTHER)));
  await assertFails(getDocs(collection(db, 'shops', SHOP, 'customers')));
});

test('signed in without a phone (or not at all) sees no orders', async () => {
  await assertFails(getDoc(doc(anon(), 'shops', SHOP, 'orders', '1001')));
  const noPhone = env.authenticatedContext('someone').firestore();
  await assertFails(getDoc(doc(noPhone, 'shops', SHOP, 'orders', '1001')));
});

test('nobody writes orders or customers from the app, not even staff', async () => {
  await assertFails(setDoc(doc(customer(ME), 'shops', SHOP, 'orders', '2000'), { n: 2000, customerPhone: ME, status: 'new' }));
  await assertFails(updateDoc(doc(customer(ME), 'shops', SHOP, 'orders', '1001'), { status: 'cancelled' }));
  await assertFails(updateDoc(doc(staff(), 'shops', SHOP, 'orders', '1001'), { status: 'done' }));
  await assertFails(updateDoc(doc(customer(ME), 'shops', SHOP, 'customers', ME), { stamps: 6 }));
  await assertFails(updateDoc(doc(staff(), 'shops', SHOP, 'customers', ME), { rewards: 9 }));
});

test('staff see all orders and customers of their shop only', async () => {
  await assertSucceeds(getDocs(orders(staff())));
  await assertSucceeds(getDocs(collection(staff(), 'shops', SHOP, 'customers')));
  await assertFails(getDocs(orders(staff('other-shop'))));
});

test('plan sales are for the shop only', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'shops', SHOP, 'planSales', 's1'), { phone: ME, plan: 'solo', price: 149 });
  });
  await assertSucceeds(getDocs(collection(staff(), 'shops', SHOP, 'planSales')));
  await assertFails(getDocs(collection(customer(ME), 'shops', SHOP, 'planSales')));
  await assertFails(setDoc(doc(staff(), 'shops', SHOP, 'planSales', 's2'), { phone: ME, plan: 'solo', price: 0 }));
});

test('PIN hash and counters are never readable', async () => {
  await assertFails(getDoc(doc(staff(), 'shops', SHOP, 'private', 'auth')));
  await assertFails(getDoc(doc(anon(), 'shops', SHOP, 'private', 'auth')));
});

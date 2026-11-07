'use strict';
/*
 * Puts the demo laundry into the local emulator. Refuses to touch a real project.
 * Run with the emulators up:  npm run seed
 */
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { hashPin } = require('../functions/src/pin');
const demo = require('./demo-shop');

async function seed({ projectId = 'demo-local-orders', reset = true } = {}) {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is not set: this script only writes to the emulator.');
  if (!projectId.startsWith('demo-')) throw new Error('Only demo-* projects can be seeded.');
  const app = initializeApp({ projectId }, `seed-${Date.now()}`);
  const db = getFirestore(app);
  const shop = db.collection('shops').doc(demo.id);
  if (reset) await db.recursiveDelete(shop);
  await shop.set(demo.shop);
  await shop.collection('private').doc('auth').set(hashPin(demo.pin));
  await app.delete();
  return demo.id;
}

module.exports = { seed };

if (require.main === module) {
  seed().then(id => console.log(`seeded shops/${id}`)).catch(e => { console.error(e.message); process.exit(1); });
}

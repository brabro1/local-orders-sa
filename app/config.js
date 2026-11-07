/*
 * Which shop this copy of the app serves, and which Firebase project it talks to.
 * On this computer (localhost) it uses the local Firebase emulator: `npm run emulators` in firebase/.
 * For a real shop: put the shop id and the project's web config here (the web config is public by design;
 * what protects the data is firestore.rules and the functions).
 */
export const SHOP_ID = 'demo-laundry';

/* must match REGION in firebase/functions/index.js */
export const REGION = 'me-central2';

export const EMULATOR = ['localhost', '127.0.0.1'].includes(location.hostname);

export const FIREBASE = {
  apiKey: 'demo-key',
  projectId: 'demo-local-orders',
  authDomain: 'demo-local-orders.firebaseapp.com',
};

'use strict';
/* Talks to the local emulators the way the app will: phone sign-in, PIN sign-in, callable functions. */
const PROJECT = 'demo-local-orders';
const REGION = 'me-central2';
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`;
const FUNCTIONS = 'http://127.0.0.1:5001';
const KEY = 'fake-api-key';

async function post(url, body, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Sign in a customer with a phone number and the SMS code the emulator "sent". Returns an ID token. */
async function phoneSignIn(phone) {
  const sent = await post(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=${KEY}`, { phoneNumber: phone, recaptchaToken: 'test' });
  if (!sent.sessionInfo) throw new Error(`sendVerificationCode: ${JSON.stringify(sent)}`);
  const codes = await (await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/verificationCodes`)).json();
  const code = codes.verificationCodes.find(c => c.sessionInfo === sent.sessionInfo).code;
  const signed = await post(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=${KEY}`, { sessionInfo: sent.sessionInfo, code });
  if (!signed.idToken) throw new Error(`signInWithPhoneNumber: ${JSON.stringify(signed)}`);
  return signed.idToken;
}

async function customTokenSignIn(token) {
  const signed = await post(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${KEY}`, { token, returnSecureToken: true });
  if (!signed.idToken) throw new Error(`signInWithCustomToken: ${JSON.stringify(signed)}`);
  return signed.idToken;
}

/** Call a function. Resolves to { result } or { error: { status, message } }. */
function call(name, data, token) {
  return post(`${FUNCTIONS}/${PROJECT}/${REGION}/${name}`, { data }, token);
}

/** Staff sign-in with the shop PIN. Returns an ID token. */
async function staffSignIn(shopId, pin) {
  const r = await call('staffLogin', { shopId, pin });
  if (!r.result) throw new Error(`staffLogin: ${JSON.stringify(r)}`);
  return customTokenSignIn(r.result.token);
}

/** Riyadh date `days` from now, as the server computes it. */
function riyadhDate(days = 0) {
  return new Date(Date.now() + 3 * 3600e3 + days * 864e5).toISOString().slice(0, 10);
}

module.exports = { PROJECT, phoneSignIn, staffSignIn, call, riyadhDate };

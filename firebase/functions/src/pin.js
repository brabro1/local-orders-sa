'use strict';
/* Shop PIN: stored only as a salted scrypt hash in shops/{shopId}/private/auth. */
const crypto = require('node:crypto');

function hashPin(pin, saltHex = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32).toString('hex');
  return { salt: saltHex, hash };
}

function checkPin(pin, { salt, hash }) {
  const got = crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

module.exports = { hashPin, checkPin };

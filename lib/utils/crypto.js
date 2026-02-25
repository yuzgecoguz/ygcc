'use strict';

const crypto = require('crypto');

function hmacSHA256(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function hmacSHA256Base64(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64');
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function krakenSign(path, nonce, body, secret) {
  const secretBuffer = Buffer.from(secret, 'base64');
  const hash = crypto.createHash('sha256').update(nonce + body).digest('binary');
  return crypto.createHmac('sha512', secretBuffer).update(path + hash, 'binary').digest('base64');
}

module.exports = { hmacSHA256, hmacSHA256Base64, sha256, krakenSign };

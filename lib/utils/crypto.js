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

function sha512(data) {
  return crypto.createHash('sha512').update(data).digest('hex');
}

function hmacSHA512Hex(data, secret) {
  return crypto.createHmac('sha512', secret).update(data).digest('hex');
}

function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJWT(apiKey, secret, uri, issuer = 'coinbase-cloud') {
  const header = { alg: 'ES256', typ: 'JWT', kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuer, sub: apiKey, nbf: now, exp: now + 120 };
  if (uri) payload.uri = uri;
  const segments = [
    base64UrlEncode(Buffer.from(JSON.stringify(header))),
    base64UrlEncode(Buffer.from(JSON.stringify(payload))),
  ];
  const signingInput = segments.join('.');
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key: secret, dsaEncoding: 'ieee-p1363' });
  return signingInput + '.' + base64UrlEncode(sig);
}

module.exports = { hmacSHA256, hmacSHA256Base64, sha256, krakenSign, sha512, hmacSHA512Hex, base64UrlEncode, signJWT };

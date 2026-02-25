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

module.exports = { hmacSHA256, hmacSHA256Base64, sha256 };

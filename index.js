'use strict';

const Binance = require('./lib/binance');
const Bybit = require('./lib/bybit');
const Okx = require('./lib/okx');
const BaseExchange = require('./lib/BaseExchange');

// Error classes
const errors = require('./lib/utils/errors');

// Utilities
const { hmacSHA256, hmacSHA256Base64 } = require('./lib/utils/crypto');
const Throttler = require('./lib/utils/throttler');
const WsClient = require('./lib/utils/ws');

module.exports = {
  // Exchanges
  Binance,
  binance: Binance, // lowercase alias (CCXT-style)
  Bybit,
  bybit: Bybit,     // lowercase alias (CCXT-style)
  Okx,
  okx: Okx,         // lowercase alias (CCXT-style)

  // Base class (for extending)
  BaseExchange,

  // Errors
  ...errors,

  // Utilities
  hmacSHA256,
  hmacSHA256Base64,
  Throttler,
  WsClient,

  // Exchange list
  exchanges: ['binance', 'bybit', 'okx'],

  // Version
  version: '1.2.0',
};

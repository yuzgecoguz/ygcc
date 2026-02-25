'use strict';

const Binance = require('./lib/binance');
const Bybit = require('./lib/bybit');
const Okx = require('./lib/okx');
const Kraken = require('./lib/kraken');
const Gateio = require('./lib/gateio');
const BaseExchange = require('./lib/BaseExchange');

// Error classes
const errors = require('./lib/utils/errors');

// Utilities
const { hmacSHA256, hmacSHA256Base64, krakenSign, sha512, hmacSHA512Hex } = require('./lib/utils/crypto');
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
  Kraken,
  kraken: Kraken,   // lowercase alias (CCXT-style)
  Gateio,
  gateio: Gateio,   // lowercase alias (CCXT-style)

  // Base class (for extending)
  BaseExchange,

  // Errors
  ...errors,

  // Utilities
  hmacSHA256,
  hmacSHA256Base64,
  krakenSign,
  sha512,
  hmacSHA512Hex,
  Throttler,
  WsClient,

  // Exchange list
  exchanges: ['binance', 'bybit', 'okx', 'kraken', 'gateio'],

  // Version
  version: '1.4.0',
};

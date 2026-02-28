'use strict';

const Binance = require('./lib/binance');
const Bybit = require('./lib/bybit');
const Okx = require('./lib/okx');
const Kraken = require('./lib/kraken');
const Gateio = require('./lib/gateio');
const KuCoin = require('./lib/kucoin');
const Coinbase = require('./lib/coinbase');
const Bitfinex = require('./lib/bitfinex');
const Bitstamp = require('./lib/bitstamp');
const Bittrex = require('./lib/bittrex');
const LBank = require('./lib/lbank');
const Phemex = require('./lib/phemex');
const BitMart = require('./lib/bitmart');
const Bitrue = require('./lib/bitrue');
const Bitforex = require('./lib/bitforex');
const BaseExchange = require('./lib/BaseExchange');

// Error classes
const errors = require('./lib/utils/errors');

// Utilities
const { hmacSHA256, hmacSHA256Base64, md5, krakenSign, sha512, hmacSHA512Hex, hmacSHA384Hex, base64UrlEncode, signJWT } = require('./lib/utils/crypto');
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
  KuCoin,
  kucoin: KuCoin,   // lowercase alias (CCXT-style)
  Coinbase,
  coinbase: Coinbase, // lowercase alias (CCXT-style)
  Bitfinex,
  bitfinex: Bitfinex, // lowercase alias (CCXT-style)
  Bitstamp,
  bitstamp: Bitstamp, // lowercase alias (CCXT-style)
  Bittrex,
  bittrex: Bittrex,   // lowercase alias (CCXT-style)
  LBank,
  lbank: LBank,       // lowercase alias (CCXT-style)
  Phemex,
  phemex: Phemex,     // lowercase alias (CCXT-style)
  BitMart,
  bitmart: BitMart,   // lowercase alias (CCXT-style)
  Bitrue,
  bitrue: Bitrue,     // lowercase alias (CCXT-style)
  Bitforex,
  bitforex: Bitforex, // lowercase alias (CCXT-style)

  // Base class (for extending)
  BaseExchange,

  // Errors
  ...errors,

  // Utilities
  hmacSHA256,
  hmacSHA256Base64,
  md5,
  krakenSign,
  sha512,
  hmacSHA512Hex,
  hmacSHA384Hex,
  base64UrlEncode,
  signJWT,
  Throttler,
  WsClient,

  // Exchange list
  exchanges: ['binance', 'bybit', 'okx', 'kraken', 'gateio', 'kucoin', 'coinbase', 'bitfinex', 'bitstamp', 'bittrex', 'lbank', 'phemex', 'bitmart', 'bitrue', 'bitforex'],

  // Version
  version: '2.4.0',
};

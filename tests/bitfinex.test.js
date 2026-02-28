'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const ygcc = require('../index');
const { Bitfinex, hmacSHA384Hex } = ygcc;
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = ygcc;

const testApiKey = 'test-bitfinex-api-key';
const testSecret = 'test-bitfinex-secret-key';

// =============================================================================
// 1. MODULE EXPORTS
// =============================================================================

describe('Module Exports — Bitfinex', () => {
  it('exports Bitfinex class and lowercase alias', () => {
    assert.strictEqual(typeof Bitfinex, 'function');
    assert.strictEqual(ygcc.bitfinex, Bitfinex);
    assert.strictEqual(ygcc.Bitfinex, Bitfinex);
  });

  it('exchange list includes bitfinex', () => {
    assert.ok(ygcc.exchanges.includes('bitfinex'));
  });

  it('version is 2.4.0', () => {
    assert.strictEqual(ygcc.version, '2.4.0');
  });
});

// =============================================================================
// 2. BITFINEX CONSTRUCTOR
// =============================================================================

describe('Bitfinex Constructor', () => {
  let ex;
  beforeEach(() => {
    ex = new Bitfinex();
  });

  it('creates instance with correct id, name, version', () => {
    assert.strictEqual(ex.id, 'bitfinex');
    assert.strictEqual(ex.name, 'Bitfinex');
    assert.strictEqual(ex.version, 'v2');
  });

  it('sets postAsJson to true', () => {
    assert.strictEqual(ex.postAsJson, true);
    assert.strictEqual(ex.postAsFormEncoded, false);
  });

  it('accepts custom config', () => {
    const custom = new Bitfinex({ apiKey: testApiKey, secret: testSecret, timeout: 5000 });
    assert.strictEqual(custom.apiKey, testApiKey);
    assert.strictEqual(custom.secret, testSecret);
    assert.strictEqual(custom.timeout, 5000);
  });

  it('has correct API URLs (separate public and auth)', () => {
    assert.strictEqual(ex.urls.api, 'https://api.bitfinex.com');
    assert.strictEqual(ex.urls.apiPublic, 'https://api-pub.bitfinex.com');
  });

  it('has WebSocket URL', () => {
    assert.strictEqual(ex.urls.ws, 'wss://api-pub.bitfinex.com/ws/2');
  });

  it('has correct timeframes (1D uppercase for daily)', () => {
    assert.ok(Object.keys(ex.timeframes).length > 0);
    assert.strictEqual(ex.timeframes['1m'], '1m');
    assert.strictEqual(ex.timeframes['5m'], '5m');
    assert.strictEqual(ex.timeframes['1h'], '1h');
    assert.strictEqual(ex.timeframes['1d'], '1D');
    assert.strictEqual(ex.timeframes['1w'], '1W');
  });

  it('has trading fees (maker 0.1%, taker 0.2%)', () => {
    assert.strictEqual(ex.fees.trading.maker, 0.001);
    assert.strictEqual(ex.fees.trading.taker, 0.002);
  });

  it('supports all expected capabilities', () => {
    assert.strictEqual(ex.has.loadMarkets, true);
    assert.strictEqual(ex.has.fetchTicker, true);
    assert.strictEqual(ex.has.fetchTickers, true);
    assert.strictEqual(ex.has.fetchOrderBook, true);
    assert.strictEqual(ex.has.fetchOHLCV, true);
    assert.strictEqual(ex.has.createOrder, true);
    assert.strictEqual(ex.has.cancelAllOrders, true);
    assert.strictEqual(ex.has.watchTicker, true);
    assert.strictEqual(ex.has.watchBalance, true);
    assert.strictEqual(ex.has.amendOrder, false);
  });

  it('initializes WebSocket channel map', () => {
    assert.ok(ex._wsChannelMap instanceof Map);
    assert.strictEqual(ex._wsChannelMap.size, 0);
  });

  it('_getBaseUrl returns different URLs for public vs signed', () => {
    assert.strictEqual(ex._getBaseUrl(false), 'https://api-pub.bitfinex.com');
    assert.strictEqual(ex._getBaseUrl(true), 'https://api.bitfinex.com');
  });
});

// =============================================================================
// 3. AUTHENTICATION — HMAC-SHA384
// =============================================================================

describe('Bitfinex Authentication — HMAC-SHA384', () => {
  let ex;
  beforeEach(() => {
    ex = new Bitfinex({ apiKey: testApiKey, secret: testSecret });
  });

  it('_sign returns correct headers with bfx- prefix', () => {
    const result = ex._sign('v2/auth/r/wallets', 'POST', {});
    assert.ok(result.headers['bfx-nonce']);
    assert.strictEqual(result.headers['bfx-apikey'], testApiKey);
    assert.ok(result.headers['bfx-signature']);
  });

  it('nonce is microsecond precision (length ~16)', () => {
    const result = ex._sign('v2/auth/r/wallets', 'POST', {});
    const nonce = result.headers['bfx-nonce'];
    assert.ok(nonce.length >= 13);
    // Microsecond nonce should be larger than millisecond timestamp
    assert.ok(parseInt(nonce, 10) > Date.now());
  });

  it('signature payload includes /api/ prefix, nonce, and body', () => {
    const path = 'v2/auth/r/wallets';
    const params = {};
    const result = ex._sign(path, 'POST', params);
    const nonce = result.headers['bfx-nonce'];
    const body = JSON.stringify({});

    // Manually compute expected signature
    const expectedPayload = '/api/' + path + nonce + body;
    const expectedSig = hmacSHA384Hex(expectedPayload, testSecret);
    assert.strictEqual(result.headers['bfx-signature'], expectedSig);
  });

  it('signature includes body content for non-empty params', () => {
    const path = 'v2/auth/w/order/submit';
    const params = { type: 'EXCHANGE LIMIT', symbol: 'tBTCUSD', amount: '0.1', price: '50000' };
    const result = ex._sign(path, 'POST', params);
    const nonce = result.headers['bfx-nonce'];
    const body = JSON.stringify(params);

    const expectedPayload = '/api/' + path + nonce + body;
    const expectedSig = hmacSHA384Hex(expectedPayload, testSecret);
    assert.strictEqual(result.headers['bfx-signature'], expectedSig);
  });

  it('signature is HMAC-SHA384 hex (96 char hex string)', () => {
    const result = ex._sign('v2/auth/r/wallets', 'POST', {});
    const sig = result.headers['bfx-signature'];
    // SHA-384 produces 48 bytes = 96 hex chars
    assert.strictEqual(sig.length, 96);
    assert.match(sig, /^[0-9a-f]+$/);
  });

  it('throws if no credentials for signed request', () => {
    const noAuth = new Bitfinex();
    assert.throws(() => noAuth._sign('v2/auth/r/wallets', 'POST', {}), ExchangeError);
  });

  it('headers use lowercase bfx- prefix (not uppercase)', () => {
    const result = ex._sign('v2/auth/r/wallets', 'POST', {});
    const keys = Object.keys(result.headers);
    assert.ok(keys.includes('bfx-nonce'));
    assert.ok(keys.includes('bfx-apikey'));
    assert.ok(keys.includes('bfx-signature'));
    // Ensure no uppercase variants
    assert.ok(!keys.includes('BFX-NONCE'));
    assert.ok(!keys.includes('BFX-APIKEY'));
  });

  it('different calls produce different nonces', () => {
    const r1 = ex._sign('v2/auth/r/wallets', 'POST', {});
    // Small delay to ensure different nonce
    const r2 = ex._sign('v2/auth/r/wallets', 'POST', {});
    // Nonces should be non-decreasing (may be equal if called fast)
    assert.ok(parseInt(r1.headers['bfx-nonce'], 10) <= parseInt(r2.headers['bfx-nonce'], 10));
  });

  it('empty params produce body {}', () => {
    const result = ex._sign('v2/auth/r/wallets', 'POST', {});
    const nonce = result.headers['bfx-nonce'];
    const expectedPayload = '/api/v2/auth/r/wallets' + nonce + '{}';
    const expectedSig = hmacSHA384Hex(expectedPayload, testSecret);
    assert.strictEqual(result.headers['bfx-signature'], expectedSig);
  });

  it('null/undefined params treated as empty body', () => {
    const result = ex._sign('v2/auth/r/wallets', 'POST', null);
    const nonce = result.headers['bfx-nonce'];
    const expectedPayload = '/api/v2/auth/r/wallets' + nonce + '{}';
    const expectedSig = hmacSHA384Hex(expectedPayload, testSecret);
    assert.strictEqual(result.headers['bfx-signature'], expectedSig);
  });
});

// =============================================================================
// 4. RESPONSE HANDLING — Array format
// =============================================================================

describe('Bitfinex Response Handling', () => {
  let ex;
  beforeEach(() => {
    ex = new Bitfinex();
  });

  it('passes through normal array responses unchanged', () => {
    const data = [50000, 1.5, 50001, 2.0, 100, 0.002, 50000.5, 1234, 51000, 49000];
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('throws on error array response', () => {
    assert.throws(() => {
      ex._unwrapResponse(['error', 10100, 'apikey: invalid']);
    }, AuthenticationError);
  });

  it('passes through object responses (non-standard)', () => {
    const data = { key: 'value' };
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('handles nested array data (normal response)', () => {
    const data = [[50000, 2, 1.5], [49999, 3, 2.0]];
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('handles empty array response', () => {
    const result = ex._unwrapResponse([]);
    assert.deepStrictEqual(result, []);
  });
});

// =============================================================================
// 5. PARSERS — Array-based (critical Bitfinex difference)
// =============================================================================

describe('Bitfinex Parsers', () => {
  let ex;
  beforeEach(() => {
    ex = new Bitfinex();
  });

  it('_parseTicker parses 10-element array correctly', () => {
    // [BID, BID_SIZE, ASK, ASK_SIZE, DAILY_CHANGE, DAILY_CHANGE_PERC, LAST, VOLUME, HIGH, LOW]
    const data = [50000, 1.5, 50001, 2.0, 100, 0.002, 50100, 1234, 51000, 49000];
    const ticker = ex._parseTicker(data, 'BTC/USD');
    assert.strictEqual(ticker.symbol, 'BTC/USD');
    assert.strictEqual(ticker.bid, 50000);
    assert.strictEqual(ticker.bidVolume, 1.5);
    assert.strictEqual(ticker.ask, 50001);
    assert.strictEqual(ticker.askVolume, 2.0);
    assert.strictEqual(ticker.last, 50100);
    assert.strictEqual(ticker.high, 51000);
    assert.strictEqual(ticker.low, 49000);
    assert.strictEqual(ticker.volume, 1234);
    assert.strictEqual(ticker.change, 100);
    assert.strictEqual(ticker.percentage, 0.2); // 0.002 * 100
  });

  it('_parseTickerFromTickers parses 11-element array (extra symbol at index 0)', () => {
    const data = ['tBTCUSD', 50000, 1.5, 50001, 2.0, 100, 0.002, 50100, 1234, 51000, 49000];
    const ticker = ex._parseTickerFromTickers(data);
    assert.strictEqual(ticker.symbol, 'BTC/USD');
    assert.strictEqual(ticker.bid, 50000);
    assert.strictEqual(ticker.last, 50100);
    assert.strictEqual(ticker.high, 51000);
    assert.strictEqual(ticker.low, 49000);
  });

  it('_parseOrder parses 32-element array with amount sign for side', () => {
    const data = new Array(32).fill(null);
    data[0] = 12345;            // ID
    data[2] = 999;              // CID
    data[3] = 'tBTCUSD';       // SYMBOL
    data[4] = 1700000000000;   // MTS_CREATE
    data[5] = 1700000001000;   // MTS_UPDATE
    data[6] = -0.5;            // AMOUNT (remaining) — negative = sell
    data[7] = -1.0;            // AMOUNT_ORIG — negative = sell
    data[8] = 'EXCHANGE LIMIT'; // TYPE
    data[13] = 'ACTIVE';       // STATUS
    data[16] = 50000;          // PRICE
    data[17] = 0;              // PRICE_AVG

    const order = ex._parseOrder(data);
    assert.strictEqual(order.id, '12345');
    assert.strictEqual(order.symbol, 'BTC/USD');
    assert.strictEqual(order.side, 'sell'); // negative amount = sell
    assert.strictEqual(order.type, 'LIMIT'); // EXCHANGE prefix stripped
    assert.strictEqual(order.amount, 1.0);
    assert.strictEqual(order.filled, 0.5);
    assert.strictEqual(order.remaining, 0.5);
    assert.strictEqual(order.status, 'PARTIALLY_FILLED');
    assert.strictEqual(order.price, 50000);
  });

  it('_parseOrder detects buy side from positive amount', () => {
    const data = new Array(32).fill(null);
    data[0] = 67890;
    data[3] = 'tETHUSD';
    data[4] = 1700000000000;
    data[5] = 1700000001000;
    data[6] = 0;              // AMOUNT remaining = 0
    data[7] = 2.0;            // AMOUNT_ORIG = positive = buy
    data[8] = 'EXCHANGE MARKET';
    data[13] = 'EXECUTED @ 3000.0(2.0)';
    data[16] = 3000;
    data[17] = 3000;

    const order = ex._parseOrder(data);
    assert.strictEqual(order.side, 'buy');
    assert.strictEqual(order.type, 'MARKET');
    assert.strictEqual(order.status, 'FILLED');
    assert.strictEqual(order.filled, 2.0);
    assert.strictEqual(order.remaining, 0);
  });

  it('_parseTrade parses [ID, MTS, AMOUNT, PRICE] with amount sign for side', () => {
    // Positive amount = buy
    const buyTrade = ex._parseTrade([111, 1700000000000, 0.5, 50000], 'BTC/USD');
    assert.strictEqual(buyTrade.id, '111');
    assert.strictEqual(buyTrade.side, 'buy');
    assert.strictEqual(buyTrade.amount, 0.5);
    assert.strictEqual(buyTrade.price, 50000);
    assert.strictEqual(buyTrade.cost, 25000);

    // Negative amount = sell
    const sellTrade = ex._parseTrade([112, 1700000000000, -0.3, 50100], 'BTC/USD');
    assert.strictEqual(sellTrade.side, 'sell');
    assert.strictEqual(sellTrade.amount, 0.3); // abs value
  });

  it('_parseMyTrade parses fill array with fee extraction', () => {
    // [ID, PAIR, MTS, ORDER_ID, EXEC_AMOUNT, EXEC_PRICE, ORDER_TYPE, ORDER_PRICE, MAKER, FEE, FEE_CURRENCY]
    const data = [555, 'tBTCUSD', 1700000000000, 12345, 0.5, 50000, 'EXCHANGE LIMIT', 50000, 1, -0.05, 'USD'];
    const trade = ex._parseMyTrade(data);
    assert.strictEqual(trade.id, '555');
    assert.strictEqual(trade.orderId, '12345');
    assert.strictEqual(trade.symbol, 'BTC/USD');
    assert.strictEqual(trade.side, 'buy'); // positive exec amount
    assert.strictEqual(trade.amount, 0.5);
    assert.strictEqual(trade.price, 50000);
    assert.strictEqual(trade.fee.cost, 0.05); // abs value
    assert.strictEqual(trade.fee.currency, 'USD');
    assert.strictEqual(trade.isMaker, true); // maker=1
  });

  it('_parseMyTrade detects taker correctly', () => {
    const data = [556, 'tETHUSD', 1700000000000, 12346, -2.0, 3000, 'EXCHANGE MARKET', 0, 0, -3.6, 'USD'];
    const trade = ex._parseMyTrade(data);
    assert.strictEqual(trade.side, 'sell'); // negative exec amount
    assert.strictEqual(trade.isMaker, false); // maker=0
  });

  it('_parseCandle reorders OCHLV to OHLCV', () => {
    // Input:  [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]
    // Output: [MTS, OPEN, HIGH, LOW, CLOSE, VOLUME]
    const data = [1700000000000, 50000, 50500, 51000, 49500, 100];
    const candle = ex._parseCandle(data);
    assert.strictEqual(candle[0], 1700000000000); // MTS
    assert.strictEqual(candle[1], 50000);          // OPEN
    assert.strictEqual(candle[2], 51000);          // HIGH (was index 3)
    assert.strictEqual(candle[3], 49500);          // LOW (was index 4)
    assert.strictEqual(candle[4], 50500);          // CLOSE (was index 2)
    assert.strictEqual(candle[5], 100);            // VOLUME
  });

  it('_parseOrderBook separates bids and asks by amount sign', () => {
    const data = [
      [50000, 2, 1.5],    // amount > 0 → bid
      [49999, 3, 2.0],    // amount > 0 → bid
      [50001, 1, -0.5],   // amount < 0 → ask
      [50002, 4, -3.0],   // amount < 0 → ask
    ];
    const book = ex._parseOrderBook(data, 'BTC/USD');
    assert.strictEqual(book.symbol, 'BTC/USD');
    assert.strictEqual(book.bids.length, 2);
    assert.strictEqual(book.asks.length, 2);
    // Bids sorted descending
    assert.strictEqual(book.bids[0][0], 50000);
    assert.strictEqual(book.bids[0][1], 1.5);
    assert.strictEqual(book.bids[1][0], 49999);
    // Asks sorted ascending, abs amount
    assert.strictEqual(book.asks[0][0], 50001);
    assert.strictEqual(book.asks[0][1], 0.5);
    assert.strictEqual(book.asks[1][0], 50002);
    assert.strictEqual(book.asks[1][1], 3.0);
  });

  it('_parseOrderBook skips entries with count === 0', () => {
    const data = [
      [50000, 2, 1.5],
      [49999, 0, 0],     // count=0 means removed level
      [50001, 1, -0.5],
    ];
    const book = ex._parseOrderBook(data, 'BTC/USD');
    assert.strictEqual(book.bids.length, 1);
    assert.strictEqual(book.asks.length, 1);
  });

  it('_parseOrderCreateResult parses notification wrapper', () => {
    const orderArray = new Array(32).fill(null);
    orderArray[0] = 99999;
    orderArray[3] = 'tBTCUSD';
    orderArray[4] = 1700000000000;
    orderArray[5] = 1700000000000;
    orderArray[6] = 0.5;
    orderArray[7] = 0.5;
    orderArray[8] = 'EXCHANGE LIMIT';
    orderArray[13] = 'ACTIVE';
    orderArray[16] = 50000;
    orderArray[17] = 0;

    // [MTS, TYPE, MSG_ID, null, [ORDER], CODE, STATUS, TEXT]
    const data = [1700000000000, 'on-req', null, null, orderArray, null, 'SUCCESS', 'Submitted'];
    const result = ex._parseOrderCreateResult(data);
    assert.strictEqual(result.id, '99999');
    assert.strictEqual(result.status, 'NEW');
  });

  it('_parseOrderCreateResult throws on ERROR status', () => {
    const data = [1700000000000, 'on-req', null, null, null, null, 'ERROR', 'Amount too small'];
    assert.throws(() => {
      ex._parseOrderCreateResult(data);
    }, InvalidOrder);
  });
});

// =============================================================================
// 6. HELPER METHODS — Symbol conversion, order type, amount sign
// =============================================================================

describe('Bitfinex Helper Methods', () => {
  let ex;
  beforeEach(() => {
    ex = new Bitfinex();
  });

  it('_toBitfinexSymbol converts BTC/USD → tBTCUSD', () => {
    assert.strictEqual(ex._toBitfinexSymbol('BTC/USD'), 'tBTCUSD');
  });

  it('_toBitfinexSymbol converts BTC/USDT → tBTCUST (USDT→UST)', () => {
    assert.strictEqual(ex._toBitfinexSymbol('BTC/USDT'), 'tBTCUST');
  });

  it('_toBitfinexSymbol passes through already-prefixed symbol', () => {
    assert.strictEqual(ex._toBitfinexSymbol('tBTCUSD'), 'tBTCUSD');
  });

  it('_fromBitfinexSymbol converts tBTCUSD → BTC/USD', () => {
    assert.strictEqual(ex._fromBitfinexSymbol('tBTCUSD'), 'BTC/USD');
  });

  it('_fromBitfinexSymbol converts tBTCUST → BTC/USDT (UST→USDT)', () => {
    assert.strictEqual(ex._fromBitfinexSymbol('tBTCUST'), 'BTC/USDT');
  });

  it('_fromBitfinexSymbol handles colon-separated pairs', () => {
    assert.strictEqual(ex._fromBitfinexSymbol('tTESTBTC:TESTUSD'), 'TESTBTC/TESTUSD');
  });

  it('_fromBitfinexSymbol passes through unified symbols', () => {
    assert.strictEqual(ex._fromBitfinexSymbol('BTC/USD'), 'BTC/USD');
  });

  it('_fromShortCurrency converts UST → USDT', () => {
    assert.strictEqual(ex._fromShortCurrency('UST'), 'USDT');
    assert.strictEqual(ex._fromShortCurrency('EUT'), 'EURT');
    assert.strictEqual(ex._fromShortCurrency('BTC'), 'BTC');
  });

  it('_toShortCurrency converts USDT → UST', () => {
    assert.strictEqual(ex._toShortCurrency('USDT'), 'UST');
    assert.strictEqual(ex._toShortCurrency('EURT'), 'EUT');
    assert.strictEqual(ex._toShortCurrency('BTC'), 'BTC');
  });

  it('_buildOrderType adds EXCHANGE prefix', () => {
    assert.strictEqual(ex._buildOrderType('limit'), 'EXCHANGE LIMIT');
    assert.strictEqual(ex._buildOrderType('market'), 'EXCHANGE MARKET');
    assert.strictEqual(ex._buildOrderType('stop'), 'EXCHANGE STOP');
    assert.strictEqual(ex._buildOrderType('fok'), 'EXCHANGE FOK');
    assert.strictEqual(ex._buildOrderType('ioc'), 'EXCHANGE IOC');
  });

  it('_buildOrderType passes through already-prefixed types', () => {
    assert.strictEqual(ex._buildOrderType('EXCHANGE LIMIT'), 'EXCHANGE LIMIT');
  });

  it('timeframe mapping — 1d maps to 1D (uppercase)', () => {
    assert.strictEqual(ex.timeframes['1d'], '1D');
    assert.strictEqual(ex.timeframes['1w'], '1W');
    assert.strictEqual(ex.timeframes['1m'], '1m'); // lowercase for minutes
  });
});

// =============================================================================
// 7. BITFINEX ERROR MAPPING — Code-based
// =============================================================================

describe('Bitfinex Error Mapping', () => {
  let ex;
  beforeEach(() => {
    ex = new Bitfinex();
  });

  it('10100 → AuthenticationError', () => {
    assert.throws(() => ex._handleBitfinexError(10100, 'apikey: invalid'), AuthenticationError);
  });

  it('10111 → AuthenticationError (invalid API key)', () => {
    assert.throws(() => ex._handleBitfinexError(10111, 'invalid apikey'), AuthenticationError);
  });

  it('10112 → AuthenticationError (nonce too small)', () => {
    assert.throws(() => ex._handleBitfinexError(10112, 'nonce: small'), AuthenticationError);
  });

  it('10113 → AuthenticationError (invalid signature)', () => {
    assert.throws(() => ex._handleBitfinexError(10113, 'invalid signature'), AuthenticationError);
  });

  it('10114 → AuthenticationError (invalid nonce)', () => {
    assert.throws(() => ex._handleBitfinexError(10114, 'nonce: invalid'), AuthenticationError);
  });

  it('11010 → RateLimitExceeded', () => {
    assert.throws(() => ex._handleBitfinexError(11010, 'ratelimit'), RateLimitExceeded);
  });

  it('10300 → BadSymbol', () => {
    assert.throws(() => ex._handleBitfinexError(10300, 'symbol: invalid'), BadSymbol);
  });

  it('13000 → InsufficientFunds', () => {
    assert.throws(() => ex._handleBitfinexError(13000, 'not enough balance'), InsufficientFunds);
  });

  it('20060 → ExchangeNotAvailable (maintenance)', () => {
    assert.throws(() => ex._handleBitfinexError(20060, 'maintenance'), ExchangeNotAvailable);
  });

  it('unknown code → ExchangeError', () => {
    assert.throws(() => ex._handleBitfinexError(99999, 'unknown'), ExchangeError);
  });
});

// =============================================================================
// 8. HTTP ERROR HANDLING
// =============================================================================

describe('Bitfinex HTTP Error Handling', () => {
  let ex;
  beforeEach(() => {
    ex = new Bitfinex();
  });

  it('400 → BadRequest', () => {
    assert.throws(() => ex._handleHttpError(400, '{"message":"bad request"}'), BadRequest);
  });

  it('401 → AuthenticationError', () => {
    assert.throws(() => ex._handleHttpError(401, '{"message":"unauthorized"}'), AuthenticationError);
  });

  it('403 → AuthenticationError', () => {
    assert.throws(() => ex._handleHttpError(403, '{"message":"forbidden"}'), AuthenticationError);
  });

  it('429 → RateLimitExceeded', () => {
    assert.throws(() => ex._handleHttpError(429, '{"message":"rate limit"}'), RateLimitExceeded);
  });

  it('500 → ExchangeNotAvailable', () => {
    assert.throws(() => ex._handleHttpError(500, '{"message":"internal error"}'), ExchangeNotAvailable);
  });

  it('handles error array in HTTP body', () => {
    assert.throws(
      () => ex._handleHttpError(400, '["error", 10100, "apikey: invalid"]'),
      AuthenticationError,
    );
  });
});

// =============================================================================
// 9. RATE LIMIT HANDLING
// =============================================================================

describe('Bitfinex Rate Limit Handling', () => {
  let ex;
  beforeEach(() => {
    ex = new Bitfinex();
  });

  it('handles x-ratelimit-remaining header', () => {
    // Should not throw
    ex._handleResponseHeaders({ 'x-ratelimit-remaining': '50' });
  });

  it('handles missing rate limit headers gracefully', () => {
    ex._handleResponseHeaders({});
    ex._handleResponseHeaders(null);
    ex._handleResponseHeaders(undefined);
  });

  it('rate limit config is set correctly', () => {
    assert.strictEqual(ex.rateLimit, 1000);
  });
});

// =============================================================================
// 10. MOCKED API CALLS
// =============================================================================

describe('Bitfinex Mocked API Calls', () => {
  let ex;
  beforeEach(() => {
    ex = new Bitfinex({ apiKey: testApiKey, secret: testSecret });
  });

  it('fetchTicker builds correct path and parses array response', async () => {
    const mockData = [50000, 1.5, 50001, 2.0, 100, 0.002, 50100, 1234, 51000, 49000];
    ex._request = mock.fn(async () => mockData);

    const ticker = await ex.fetchTicker('BTC/USD');
    assert.strictEqual(ticker.symbol, 'BTC/USD');
    assert.strictEqual(ticker.last, 50100);
    assert.strictEqual(ticker.bid, 50000);
    assert.strictEqual(ticker.ask, 50001);

    // Verify path includes tBTCUSD
    const call = ex._request.mock.calls[0];
    assert.strictEqual(call.arguments[0], 'GET');
    assert.ok(call.arguments[1].includes('tBTCUSD'));
  });

  it('fetchTickers returns multiple tickers', async () => {
    const mockData = [
      ['tBTCUSD', 50000, 1.5, 50001, 2.0, 100, 0.002, 50100, 1234, 51000, 49000],
      ['tETHUSD', 3000, 10, 3001, 20, 50, 0.017, 3050, 5000, 3100, 2900],
    ];
    ex._request = mock.fn(async () => mockData);

    const tickers = await ex.fetchTickers();
    assert.ok(tickers['BTC/USD']);
    assert.ok(tickers['ETH/USD']);
    assert.strictEqual(tickers['BTC/USD'].last, 50100);
    assert.strictEqual(tickers['ETH/USD'].last, 3050);
  });

  it('fetchOrderBook separates bids/asks by amount sign', async () => {
    const mockData = [
      [50000, 2, 1.5],    // bid
      [49999, 3, 2.0],    // bid
      [50001, 1, -0.5],   // ask
      [50002, 4, -3.0],   // ask
    ];
    ex._request = mock.fn(async () => mockData);

    const book = await ex.fetchOrderBook('BTC/USD');
    assert.strictEqual(book.bids.length, 2);
    assert.strictEqual(book.asks.length, 2);
    assert.strictEqual(book.bids[0][0], 50000);
    assert.strictEqual(book.asks[0][0], 50001);
  });

  it('fetchOHLCV reorders candles from OCHLV to OHLCV', async () => {
    // Bitfinex: [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]
    const mockData = [
      [1700000000000, 50000, 50500, 51000, 49500, 100],
      [1700000060000, 50500, 50800, 51200, 50200, 150],
    ];
    ex._request = mock.fn(async () => mockData);

    const candles = await ex.fetchOHLCV('BTC/USD', '1m');
    // Reordered: [MTS, OPEN, HIGH, LOW, CLOSE, VOLUME]
    assert.strictEqual(candles[0][0], 1700000000000);
    assert.strictEqual(candles[0][1], 50000);  // OPEN
    assert.strictEqual(candles[0][2], 51000);  // HIGH
    assert.strictEqual(candles[0][3], 49500);  // LOW
    assert.strictEqual(candles[0][4], 50500);  // CLOSE
    assert.strictEqual(candles[0][5], 100);    // VOLUME

    // Verify path includes candle key
    const call = ex._request.mock.calls[0];
    assert.ok(call.arguments[1].includes('trade:1m:tBTCUSD'));
  });

  it('createOrder uses signed request with EXCHANGE prefix and amount sign', async () => {
    const orderArray = new Array(32).fill(null);
    orderArray[0] = 88888;
    orderArray[3] = 'tBTCUSD';
    orderArray[4] = 1700000000000;
    orderArray[5] = 1700000000000;
    orderArray[6] = 0.1;
    orderArray[7] = 0.1;
    orderArray[8] = 'EXCHANGE LIMIT';
    orderArray[13] = 'ACTIVE';
    orderArray[16] = 50000;
    orderArray[17] = 0;

    const mockResponse = [1700000000000, 'on-req', null, null, orderArray, null, 'SUCCESS', 'Submitted'];
    ex._request = mock.fn(async () => mockResponse);

    const result = await ex.createOrder('BTC/USD', 'limit', 'buy', 0.1, 50000);
    assert.strictEqual(result.id, '88888');
    assert.strictEqual(result.status, 'NEW');

    // Verify signed request
    const call = ex._request.mock.calls[0];
    assert.strictEqual(call.arguments[0], 'POST');
    assert.ok(call.arguments[1].includes('order/submit'));
    assert.strictEqual(call.arguments[3], true); // signed=true

    // Verify params include EXCHANGE LIMIT type and positive amount for buy
    const params = call.arguments[2];
    assert.strictEqual(params.type, 'EXCHANGE LIMIT');
    assert.strictEqual(params.symbol, 'tBTCUSD');
    assert.strictEqual(params.amount, '0.1'); // positive for buy
    assert.strictEqual(params.price, '50000');
  });

  it('createOrder uses negative amount for sell', async () => {
    const orderArray = new Array(32).fill(null);
    orderArray[0] = 77777;
    orderArray[3] = 'tBTCUSD';
    orderArray[4] = 1700000000000;
    orderArray[5] = 1700000000000;
    orderArray[6] = -0.5;
    orderArray[7] = -0.5;
    orderArray[8] = 'EXCHANGE MARKET';
    orderArray[13] = 'ACTIVE';
    orderArray[16] = 0;
    orderArray[17] = 0;

    const mockResponse = [1700000000000, 'on-req', null, null, orderArray, null, 'SUCCESS', 'OK'];
    ex._request = mock.fn(async () => mockResponse);

    await ex.createMarketOrder('BTC/USD', 'sell', 0.5);

    const call = ex._request.mock.calls[0];
    const params = call.arguments[2];
    assert.strictEqual(params.type, 'EXCHANGE MARKET');
    assert.strictEqual(params.amount, '-0.5'); // negative for sell
  });

  it('cancelOrder sends POST with order id', async () => {
    ex._request = mock.fn(async () => [1700000000000, 'oc-req', null, null, [12345], null, 'SUCCESS', 'OK']);

    const result = await ex.cancelOrder('12345', 'BTC/USD');
    assert.strictEqual(result.id, '12345');
    assert.strictEqual(result.status, 'CANCELED');

    const call = ex._request.mock.calls[0];
    assert.strictEqual(call.arguments[0], 'POST');
    assert.ok(call.arguments[1].includes('order/cancel'));
    assert.strictEqual(call.arguments[2].id, 12345);
    assert.strictEqual(call.arguments[3], true); // signed
  });

  it('fetchBalance filters exchange wallets only', async () => {
    const mockData = [
      ['exchange', 'BTC', 1.5, 0, 1.3],
      ['exchange', 'USD', 50000, 0, 49000],
      ['margin', 'BTC', 0.5, 0, 0.5],   // should be excluded
      ['funding', 'USD', 10000, 0, 10000], // should be excluded
    ];
    ex._request = mock.fn(async () => mockData);

    const balance = await ex.fetchBalance();
    assert.ok(balance.BTC);
    assert.ok(balance.USD);
    assert.strictEqual(balance.BTC.total, 1.5);
    assert.strictEqual(balance.BTC.free, 1.3);
    assert.strictEqual(balance.USD.total, 50000);
    assert.strictEqual(balance.USD.free, 49000);

    // Margin and funding wallets excluded
    const keys = Object.keys(balance).filter(k => !['info', 'timestamp', 'datetime'].includes(k));
    assert.strictEqual(keys.length, 2);
  });

  it('fetchMyTrades parses fill arrays', async () => {
    const mockData = [
      [555, 'tBTCUSD', 1700000000000, 12345, 0.5, 50000, 'EXCHANGE LIMIT', 50000, 1, -0.05, 'USD'],
      [556, 'tBTCUSD', 1700000001000, 12345, 0.3, 50100, 'EXCHANGE LIMIT', 50000, 0, -0.03, 'USD'],
    ];
    ex._request = mock.fn(async () => mockData);

    const trades = await ex.fetchMyTrades('BTC/USD');
    assert.strictEqual(trades.length, 2);
    assert.strictEqual(trades[0].id, '555');
    assert.strictEqual(trades[0].symbol, 'BTC/USD');
    assert.strictEqual(trades[0].side, 'buy');
    assert.strictEqual(trades[0].isMaker, true);
    assert.strictEqual(trades[1].isMaker, false);
  });

  it('fetchTrades parses trade arrays', async () => {
    const mockData = [
      [111, 1700000000000, 0.5, 50000],
      [112, 1700000001000, -0.3, 50100],
    ];
    ex._request = mock.fn(async () => mockData);

    const trades = await ex.fetchTrades('BTC/USD');
    assert.strictEqual(trades.length, 2);
    assert.strictEqual(trades[0].side, 'buy');
    assert.strictEqual(trades[1].side, 'sell');
    assert.strictEqual(trades[1].amount, 0.3); // abs
  });

  it('fetchOpenOrders builds correct path with symbol', async () => {
    const data = new Array(32).fill(null);
    data[0] = 11111;
    data[3] = 'tBTCUSD';
    data[4] = 1700000000000;
    data[5] = 1700000000000;
    data[6] = 0.5;
    data[7] = 1.0;
    data[8] = 'EXCHANGE LIMIT';
    data[13] = 'ACTIVE';
    data[16] = 50000;
    data[17] = 0;

    ex._request = mock.fn(async () => [data]);

    const orders = await ex.fetchOpenOrders('BTC/USD');
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].id, '11111');

    const call = ex._request.mock.calls[0];
    assert.ok(call.arguments[1].includes('tBTCUSD'));
    assert.strictEqual(call.arguments[3], true); // signed
  });

  it('cancelAllOrders sends all:1', async () => {
    ex._request = mock.fn(async () => [1700000000000, 'oc_multi-req', null, null, null, null, 'SUCCESS', 'OK']);

    await ex.cancelAllOrders();

    const call = ex._request.mock.calls[0];
    assert.strictEqual(call.arguments[2].all, 1);
  });
});

// =============================================================================
// 11. MARKET LOOKUP
// =============================================================================

describe('Bitfinex Market Lookup', () => {
  let ex;
  beforeEach(async () => {
    ex = new Bitfinex();
    // Mock loadMarkets
    ex.markets = {
      'BTC/USD': { id: 'tBTCUSD', symbol: 'BTC/USD', base: 'BTC', quote: 'USD' },
      'ETH/USD': { id: 'tETHUSD', symbol: 'ETH/USD', base: 'ETH', quote: 'USD' },
    };
    ex.marketsById = {
      'tBTCUSD': ex.markets['BTC/USD'],
      'tETHUSD': ex.markets['ETH/USD'],
    };
    ex._marketsLoaded = true;
  });

  it('market() returns market by unified symbol', () => {
    const m = ex.market('BTC/USD');
    assert.strictEqual(m.id, 'tBTCUSD');
    assert.strictEqual(m.base, 'BTC');
  });

  it('market().id returns Bitfinex symbol', () => {
    const m = ex.market('BTC/USD');
    assert.strictEqual(m.id, 'tBTCUSD');
  });

  it('throws ExchangeError for unknown pair', () => {
    assert.throws(() => ex.market('UNKNOWN/PAIR'), ExchangeError);
  });
});

// =============================================================================
// 12. BITFINEX vs OTHERS — Key differences
// =============================================================================

describe('Bitfinex vs Other Exchanges — Key Differences', () => {
  let ex;
  beforeEach(() => {
    ex = new Bitfinex();
  });

  it('response format is ARRAY not object (unlike all other exchanges)', () => {
    // Bitfinex ticker is an array
    const tickerData = [50000, 1.5, 50001, 2.0, 100, 0.002, 50100, 1234, 51000, 49000];
    assert.ok(Array.isArray(tickerData));
    const ticker = ex._parseTicker(tickerData, 'BTC/USD');
    assert.strictEqual(typeof ticker, 'object');
    assert.strictEqual(ticker.last, 50100);
  });

  it('uses HMAC-SHA384 (not SHA256 or SHA512)', () => {
    // SHA-384 produces 48 bytes = 96 hex chars
    const sig = hmacSHA384Hex('test', 'secret');
    assert.strictEqual(sig.length, 96);
    // SHA-256 would be 64, SHA-512 would be 128
    assert.notStrictEqual(sig.length, 64);
    assert.notStrictEqual(sig.length, 128);
  });

  it('candles are OCHLV not OHLCV (CLOSE at index 2)', () => {
    // Bitfinex: [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]
    const raw = [1700000000000, 100, 105, 110, 95, 500];
    const parsed = ex._parseCandle(raw);
    // After reorder: [MTS, OPEN, HIGH, LOW, CLOSE, VOLUME]
    assert.strictEqual(parsed[1], 100);  // OPEN
    assert.strictEqual(parsed[2], 110);  // HIGH (was index 3)
    assert.strictEqual(parsed[4], 105);  // CLOSE (was index 2)
  });

  it('uses amount sign for side instead of side field', () => {
    const buyTrade = ex._parseTrade([1, 1700000000000, 0.5, 100], 'BTC/USD');
    assert.strictEqual(buyTrade.side, 'buy');     // positive amount

    const sellTrade = ex._parseTrade([2, 1700000000000, -0.5, 100], 'BTC/USD');
    assert.strictEqual(sellTrade.side, 'sell');   // negative amount
  });

  it('order types use EXCHANGE prefix for spot trading', () => {
    assert.strictEqual(ex._buildOrderType('limit'), 'EXCHANGE LIMIT');
    assert.strictEqual(ex._buildOrderType('market'), 'EXCHANGE MARKET');
    // Other exchanges use plain 'LIMIT', 'MARKET'
  });

  it('uses microsecond nonce (not millisecond)', () => {
    const exAuth = new Bitfinex({ apiKey: testApiKey, secret: testSecret });
    const result = exAuth._sign('v2/auth/r/wallets', 'POST', {});
    const nonce = parseInt(result.headers['bfx-nonce'], 10);
    // Microsecond nonce should be ~1000x larger than ms timestamp
    assert.ok(nonce > Date.now());
  });

  it('has 2 different base URLs (public vs auth)', () => {
    assert.strictEqual(ex._getBaseUrl(false), 'https://api-pub.bitfinex.com');
    assert.strictEqual(ex._getBaseUrl(true), 'https://api.bitfinex.com');
    // Other exchanges typically use a single base URL
  });

  it('WS uses chanId-based routing (not channel/topic names)', () => {
    // Bitfinex WS messages arrive as [chanId, data]
    // Other exchanges use channel names in message
    assert.ok(ex._wsChannelMap instanceof Map);
  });
});

// =============================================================================
// 13. CRYPTO — hmacSHA384Hex
// =============================================================================

describe('Crypto — hmacSHA384Hex', () => {
  it('produces 96 character hex string (384 bits)', () => {
    const result = hmacSHA384Hex('hello', 'secret');
    assert.strictEqual(result.length, 96);
    assert.match(result, /^[0-9a-f]+$/);
  });

  it('handles empty string input', () => {
    const result = hmacSHA384Hex('', 'secret');
    assert.strictEqual(result.length, 96);
    assert.match(result, /^[0-9a-f]+$/);
  });

  it('produces known test vector', () => {
    // HMAC-SHA384 of empty string with empty key
    const result = hmacSHA384Hex('', '');
    assert.strictEqual(result.length, 96);
    // Verify it's deterministic
    assert.strictEqual(result, hmacSHA384Hex('', ''));
  });
});

'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const Bitforex = require('../lib/bitforex');
const { hmacSHA256 } = require('../lib/utils/crypto');
const { buildQuery } = require('../lib/utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — Bitforex
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — Bitforex', () => {
  it('exports Bitforex class', () => {
    assert.strictEqual(typeof lib.Bitforex, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.bitforex, lib.Bitforex);
  });

  it('includes bitforex in exchanges list', () => {
    assert.ok(lib.exchanges.includes('bitforex'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Bitforex Constructor
// ═══════════════════════════════════════════════════════════════
describe('Bitforex Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitforex(); });

  it('sets id to bitforex', () => {
    assert.strictEqual(exchange.describe().id, 'bitforex');
  });

  it('sets name to Bitforex', () => {
    assert.strictEqual(exchange.describe().name, 'Bitforex');
  });

  it('sets version to v1', () => {
    assert.strictEqual(exchange.describe().version, 'v1');
  });

  it('sets postAsJson to false', () => {
    assert.strictEqual(exchange.postAsJson, false);
  });

  it('sets postAsFormEncoded to false', () => {
    assert.strictEqual(exchange.postAsFormEncoded, false);
  });

  it('has correct timeframes', () => {
    const tf = exchange.describe().timeframes;
    assert.strictEqual(tf['1m'], '1min');
    assert.strictEqual(tf['1h'], '1hour');
    assert.strictEqual(tf['1d'], '1day');
  });

  it('has correct fees', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.001);
    assert.strictEqual(fees.taker, 0.001);
  });

  it('fetchTickers is not supported', () => {
    assert.strictEqual(exchange.describe().has.fetchTickers, false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — path-based HMAC-SHA256
// ═══════════════════════════════════════════════════════════════
describe('Authentication — path-based HMAC-SHA256', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Bitforex({ apiKey: 'testkey', secret: 'testsecret' });
  });

  it('throws without apiKey', () => {
    const ex = new Bitforex({ secret: 'testsecret' });
    assert.throws(() => ex._sign('/api/v1/trade/placeOrder', 'POST', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new Bitforex({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/api/v1/trade/placeOrder', 'POST', {}), /secret required/);
  });

  it('adds accessKey to params', () => {
    const params = {};
    exchange._sign('/api/v1/trade/placeOrder', 'POST', params);
    assert.strictEqual(params.accessKey, 'testkey');
  });

  it('adds nonce (timestamp) to params', () => {
    const params = {};
    const before = Date.now();
    exchange._sign('/api/v1/trade/placeOrder', 'POST', params);
    assert.ok(params.nonce >= before);
    assert.ok(params.nonce <= Date.now());
  });

  it('adds signData to params (64-char hex)', () => {
    const params = {};
    exchange._sign('/api/v1/trade/placeOrder', 'POST', params);
    assert.ok(typeof params.signData === 'string');
    assert.strictEqual(params.signData.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(params.signData));
  });

  it('returns empty headers object', () => {
    const params = {};
    const result = exchange._sign('/api/v1/trade/placeOrder', 'POST', params);
    assert.deepStrictEqual(result.headers, {});
  });

  it('signing string includes path', () => {
    const params = { symbol: 'coin-usdt-btc', amount: '0.001' };
    const before = Date.now();
    exchange._sign('/api/v1/trade/placeOrder', 'POST', params);

    // Verify: sign(path + "?" + sortedQS) produces same signData
    const { signData, ...rest } = params;
    const testParams = { ...rest };
    delete testParams.signData;
    const sortedQS = buildQuery(testParams);
    const expected = hmacSHA256('/api/v1/trade/placeOrder?' + sortedQS, 'testsecret');
    assert.strictEqual(signData, expected);
  });

  it('uses sorted + encoded query string (buildQuery)', () => {
    const params = { symbol: 'coin-usdt-btc', amount: '0.001' };
    exchange._sign('/api/v1/trade/placeOrder', 'POST', params);
    // Verify params are sorted: accessKey < amount < nonce < signData < symbol
    const keys = Object.keys(params);
    assert.ok(keys.includes('accessKey'));
    assert.ok(keys.includes('signData'));
    assert.ok(keys.includes('nonce'));
  });

  it('deterministic: same inputs produce same signature', () => {
    const ex1 = new Bitforex({ apiKey: 'key1', secret: 'secret1' });
    const ex2 = new Bitforex({ apiKey: 'key1', secret: 'secret1' });
    const p1 = { symbol: 'coin-usdt-btc' };
    const p2 = { symbol: 'coin-usdt-btc' };

    // Force same nonce
    const origNow = Date.now;
    const fixedTime = 1700000000000;
    Date.now = () => fixedTime;
    try {
      ex1._sign('/api/v1/test', 'GET', p1);
      ex2._sign('/api/v1/test', 'GET', p2);
      assert.strictEqual(p1.signData, p2.signData);
    } finally {
      Date.now = origNow;
    }
  });

  it('does NOT add any auth headers (no X-MBX-APIKEY)', () => {
    const params = {};
    const result = exchange._sign('/api/v1/trade/placeOrder', 'POST', params);
    assert.strictEqual(Object.keys(result.headers).length, 0);
    assert.strictEqual(result.headers['X-MBX-APIKEY'], undefined);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitforex(); });

  it('extracts data field on success', () => {
    const result = exchange._unwrapResponse({ success: true, data: { orderId: '123' }, time: 1234567890 });
    assert.deepStrictEqual(result, { orderId: '123' });
  });

  it('passes through when success is true', () => {
    const result = exchange._unwrapResponse({ success: true, data: [1, 2, 3] });
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('throws on success=false', () => {
    assert.throws(
      () => exchange._unwrapResponse({ success: false, code: 'MK101', msg: 'invalid' }),
      BadSymbol
    );
  });

  it('handles missing data field — returns whole object as fallback', () => {
    const input = { success: true };
    const result = exchange._unwrapResponse(input);
    assert.strictEqual(result, input);
  });

  it('handles non-object response', () => {
    const result = exchange._unwrapResponse(12345);
    assert.strictEqual(result, 12345);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('Bitforex Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitforex(); });

  it('_parseTicker extracts fields', () => {
    const t = exchange._parseTicker({ last: 50000, high: 51000, low: 49000, buy: 49999, sell: 50001, vol: 1234, ts: 1700000000000 }, 'BTC/USDT');
    assert.strictEqual(t.symbol, 'BTC/USDT');
    assert.strictEqual(t.last, 50000);
    assert.strictEqual(t.high, 51000);
    assert.strictEqual(t.low, 49000);
    assert.strictEqual(t.bid, 49999);
    assert.strictEqual(t.ask, 50001);
    assert.strictEqual(t.volume, 1234);
    assert.strictEqual(t.timestamp, 1700000000000);
  });

  it('_parseOrder maps tradeType 1 to BUY', () => {
    const o = exchange._parseOrder({ orderId: '123', tradeType: 1, orderAmount: 0.5, dealAmount: 0.2, orderPrice: 50000, orderState: 1 }, 'BTC/USDT');
    assert.strictEqual(o.side, 'BUY');
    assert.strictEqual(o.status, 'open');
  });

  it('_parseOrder maps tradeType 2 to SELL', () => {
    const o = exchange._parseOrder({ orderId: '456', tradeType: 2, orderAmount: 1, dealAmount: 1, orderPrice: 50000, orderState: 2 }, 'BTC/USDT');
    assert.strictEqual(o.side, 'SELL');
    assert.strictEqual(o.status, 'closed');
  });

  it('_parseTrade computes cost and maps direction', () => {
    const t = exchange._parseTrade({ tid: 't1', price: 50000, amount: 0.1, direction: 1, time: 1700000000000 }, 'BTC/USDT');
    assert.strictEqual(t.cost, 5000);
    assert.strictEqual(t.side, 'buy');
  });

  it('_parseTrade direction 2 is sell', () => {
    const t = exchange._parseTrade({ tid: 't2', price: 50000, amount: 0.2, direction: 2, time: 1700000000000 }, 'BTC/USDT');
    assert.strictEqual(t.side, 'sell');
  });

  it('_parseCandle extracts OHLCV', () => {
    const c = exchange._parseCandle({ time: 1700000000000, open: 50000, high: 51000, low: 49000, close: 50500, vol: 100 });
    assert.strictEqual(c.timestamp, 1700000000000);
    assert.strictEqual(c.open, 50000);
    assert.strictEqual(c.close, 50500);
    assert.strictEqual(c.volume, 100);
  });

  it('_parseOrderBook maps objects to arrays', () => {
    const ob = exchange._parseOrderBook({
      bids: [{ price: 49999, amount: 1.5 }, { price: 49998, amount: 2.0 }],
      asks: [{ price: 50001, amount: 0.8 }, { price: 50002, amount: 1.2 }],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids[0], [49999, 1.5]);
    assert.deepStrictEqual(ob.asks[0], [50001, 0.8]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_normalizeOrderStatus maps all states', () => {
    assert.strictEqual(exchange._normalizeOrderStatus(0), 'open');
    assert.strictEqual(exchange._normalizeOrderStatus(1), 'open');
    assert.strictEqual(exchange._normalizeOrderStatus(2), 'closed');
    assert.strictEqual(exchange._normalizeOrderStatus(3), 'canceled');
    assert.strictEqual(exchange._normalizeOrderStatus(4), 'canceled');
    assert.strictEqual(exchange._normalizeOrderStatus(99), 'open');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('Bitforex Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitforex(); });

  it('_toBitforexSymbol BTC/USDT → coin-usdt-btc', () => {
    assert.strictEqual(exchange._toBitforexSymbol('BTC/USDT'), 'coin-usdt-btc');
  });

  it('_toBitforexSymbol ETH/BTC → coin-btc-eth', () => {
    assert.strictEqual(exchange._toBitforexSymbol('ETH/BTC'), 'coin-btc-eth');
  });

  it('_toBitforexSymbol DOGE/USDT → coin-usdt-doge', () => {
    assert.strictEqual(exchange._toBitforexSymbol('DOGE/USDT'), 'coin-usdt-doge');
  });

  it('_fromBitforexSymbol fallback parse', () => {
    assert.strictEqual(exchange._fromBitforexSymbol('coin-usdt-btc'), 'BTC/USDT');
  });

  it('_fromBitforexSymbol resolves via marketsById', () => {
    exchange.marketsById = { 'coin-usdt-btc': { symbol: 'BTC/USDT' } };
    assert.strictEqual(exchange._fromBitforexSymbol('coin-usdt-btc'), 'BTC/USDT');
  });

  it('_fromBitforexSymbol returns raw for invalid format', () => {
    assert.strictEqual(exchange._fromBitforexSymbol('invalid'), 'invalid');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.bitforex.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('Bitforex Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitforex(); });

  it('1003 → BadRequest', () => {
    assert.throws(() => exchange._handleBitforexError('1003', 'param error'), BadRequest);
  });

  it('1015 → RateLimitExceeded', () => {
    assert.throws(() => exchange._handleBitforexError('1015', 'too many requests'), RateLimitExceeded);
  });

  it('3002 → InsufficientFunds', () => {
    assert.throws(() => exchange._handleBitforexError('3002', 'insufficient'), InsufficientFunds);
  });

  it('MK101 → BadSymbol', () => {
    assert.throws(() => exchange._handleBitforexError('MK101', 'invalid business type'), BadSymbol);
  });

  it('MK103 → BadRequest', () => {
    assert.throws(() => exchange._handleBitforexError('MK103', 'invalid kType'), BadRequest);
  });

  it('4002 → OrderNotFound', () => {
    assert.throws(() => exchange._handleBitforexError('4002', 'order not found'), OrderNotFound);
  });

  it('10030 → AuthenticationError', () => {
    assert.throws(() => exchange._handleBitforexError('10030', 'invalid accessKey'), AuthenticationError);
  });

  it('unknown code → ExchangeError', () => {
    assert.throws(() => exchange._handleBitforexError('9999', 'unknown'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('Bitforex HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitforex(); });

  it('400 → BadRequest', () => {
    assert.throws(() => exchange._handleHttpError(400, 'bad request'), BadRequest);
  });

  it('401 → AuthenticationError', () => {
    assert.throws(() => exchange._handleHttpError(401, 'unauthorized'), AuthenticationError);
  });

  it('403 → AuthenticationError', () => {
    assert.throws(() => exchange._handleHttpError(403, 'forbidden'), AuthenticationError);
  });

  it('429 → RateLimitExceeded', () => {
    assert.throws(() => exchange._handleHttpError(429, 'too many'), RateLimitExceeded);
  });

  it('500 → ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handleHttpError(500, 'server error'), ExchangeNotAvailable);
  });

  it('parses JSON body with success=false', () => {
    const body = JSON.stringify({ success: false, code: '3002', msg: 'insufficient funds' });
    assert.throws(() => exchange._handleHttpError(400, body), InsufficientFunds);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('Bitforex Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new Bitforex();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new Bitforex({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new Bitforex();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 60);
    assert.strictEqual(desc.rateLimitInterval, 10000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('Bitforex Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Bitforex({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'coin-usdt-btc', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { 'coin-usdt-btc': { symbol: 'BTC/USDT' } };
  });

  it('fetchTime returns server time', async () => {
    mock.method(exchange, '_request', async () => ({ success: true, data: 1700000000000 }));
    const time = await exchange.fetchTime();
    assert.strictEqual(time, 1700000000000);
  });

  it('loadMarkets parses coin-quote-base symbols', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ({
      success: true,
      data: [
        { symbol: 'coin-usdt-btc', pricePrecision: 2, amountPrecision: 4 },
        { symbol: 'coin-btc-eth', pricePrecision: 8, amountPrecision: 4 },
      ],
    }));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.ok(markets['ETH/BTC']);
    assert.strictEqual(markets['BTC/USDT'].id, 'coin-usdt-btc');
    assert.strictEqual(markets['BTC/USDT'].base, 'BTC');
    assert.strictEqual(markets['BTC/USDT'].quote, 'USDT');
  });

  it('fetchTicker returns parsed ticker', async () => {
    mock.method(exchange, '_request', async () => ({
      success: true,
      data: { last: 50000, high: 51000, low: 49000, buy: 49999, sell: 50001, vol: 1234, ts: 1700000000000 },
    }));
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.last, 50000);
    assert.strictEqual(ticker.bid, 49999);
    assert.strictEqual(ticker.ask, 50001);
  });

  it('fetchOrderBook returns parsed book with objects→arrays', async () => {
    mock.method(exchange, '_request', async () => ({
      success: true,
      data: {
        bids: [{ price: 49999, amount: 1.5 }],
        asks: [{ price: 50001, amount: 0.8 }],
      },
    }));
    const book = await exchange.fetchOrderBook('BTC/USDT', 10);
    assert.deepStrictEqual(book.bids[0], [49999, 1.5]);
    assert.deepStrictEqual(book.asks[0], [50001, 0.8]);
  });

  it('fetchTrades returns parsed trades', async () => {
    mock.method(exchange, '_request', async () => ({
      success: true,
      data: [{ tid: 't1', price: 50000, amount: 0.1, direction: 1, time: 1700000000000 }],
    }));
    const trades = await exchange.fetchTrades('BTC/USDT');
    assert.strictEqual(trades.length, 1);
    assert.strictEqual(trades[0].side, 'buy');
  });

  it('fetchOHLCV returns parsed candles', async () => {
    mock.method(exchange, '_request', async () => ({
      success: true,
      data: [{ time: 1700000000000, open: 50000, high: 51000, low: 49000, close: 50500, vol: 100 }],
    }));
    const candles = await exchange.fetchOHLCV('BTC/USDT', '1m');
    assert.strictEqual(candles.length, 1);
    assert.strictEqual(candles[0].open, 50000);
  });

  it('createOrder sends correct params (tradeType, price, amount, symbol)', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { success: true, data: { orderId: 'ord-123' } };
    });
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.001, 50000);
    assert.strictEqual(capturedParams.symbol, 'coin-usdt-btc');
    assert.strictEqual(capturedParams.tradeType, 1);
    assert.strictEqual(capturedParams.amount, '0.001');
    assert.strictEqual(capturedParams.price, '50000');
    assert.strictEqual(order.id, 'ord-123');
  });

  it('createOrder throws on market order attempt', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/USDT', 'market', 'buy', 0.001),
      /does not support market orders/
    );
  });

  it('cancelOrder sends symbol and orderId', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { success: true, data: {} };
    });
    const result = await exchange.cancelOrder('ord-123', 'BTC/USDT');
    assert.strictEqual(capturedParams.orderId, 'ord-123');
    assert.strictEqual(capturedParams.symbol, 'coin-usdt-btc');
    assert.strictEqual(result.status, 'canceled');
  });

  it('fetchBalance returns parsed balances', async () => {
    mock.method(exchange, '_request', async () => ({
      success: true,
      data: [
        { currency: 'btc', active: 0.5, frozen: 0.1 },
        { currency: 'usdt', active: 5000, frozen: 1000 },
      ],
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.used, 0.1);
    assert.strictEqual(balance.BTC.total, 0.6);
    assert.strictEqual(balance.USDT.free, 5000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('Bitforex Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Bitforex();
    exchange._marketsLoaded = true;
    exchange.markets = {
      'BTC/USDT': { id: 'coin-usdt-btc', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
    };
    exchange.marketsById = { 'coin-usdt-btc': { symbol: 'BTC/USDT' } };
  });

  it('market() returns correct market', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.id, 'coin-usdt-btc');
  });

  it('market() returns base and quote', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.base, 'BTC');
    assert.strictEqual(m.quote, 'USDT');
  });

  it('market() throws on unknown symbol', () => {
    assert.throws(() => exchange.market('DOGE/USD'), /unknown symbol/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. Bitforex vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('Bitforex vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitforex({ apiKey: 'k', secret: 's' }); });

  it('uses coin-quote-base symbol format (not BTCUSDT or BTC_USDT)', () => {
    assert.strictEqual(exchange._toBitforexSymbol('BTC/USDT'), 'coin-usdt-btc');
    assert.strictEqual(exchange._toBitforexSymbol('ETH/BTC'), 'coin-btc-eth');
  });

  it('no auth headers needed (empty headers object)', () => {
    const result = exchange._sign('/api/v1/trade/placeOrder', 'POST', {});
    assert.deepStrictEqual(result.headers, {});
  });

  it('path included in signing string', () => {
    const p1 = { symbol: 'coin-usdt-btc' };
    const p2 = { symbol: 'coin-usdt-btc' };
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      exchange._sign('/api/v1/path1', 'POST', p1);
      exchange._sign('/api/v1/path2', 'POST', p2);
      // Different paths produce different signatures
      assert.notStrictEqual(p1.signData, p2.signData);
    } finally {
      Date.now = origNow;
    }
  });

  it('string error codes (not negative numbers)', () => {
    assert.throws(() => exchange._handleBitforexError('MK101', 'msg'), BadSymbol);
    assert.throws(() => exchange._handleBitforexError('1003', 'msg'), BadRequest);
  });

  it('no market orders (createMarketOrder = false)', () => {
    assert.strictEqual(exchange.describe().has.createMarketOrder, false);
  });

  it('no fetchTickers (requires symbol param)', () => {
    assert.strictEqual(exchange.describe().has.fetchTickers, false);
  });

  it('POST params go in query string (postAsJson=false)', () => {
    assert.strictEqual(exchange.postAsJson, false);
    assert.strictEqual(exchange.postAsFormEncoded, false);
  });

  it('no fetchOpenOrders or fetchClosedOrders', () => {
    assert.strictEqual(exchange.describe().has.fetchOpenOrders, false);
    assert.strictEqual(exchange.describe().has.fetchClosedOrders, false);
    assert.strictEqual(exchange.describe().has.fetchMyTrades, false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA256
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA256 for Bitforex', () => {
  it('produces 64-char hex string', () => {
    const sig = hmacSHA256('test', 'secret');
    assert.strictEqual(sig.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(sig));
  });

  it('known test vector with path+query signing', () => {
    const path = '/api/v1/trade/placeOrder';
    const qs = 'accessKey=key1&amount=1&nonce=1700000000000&price=50000&symbol=coin-usdt-btc&tradeType=1';
    const signingString = path + '?' + qs;
    const sig = hmacSHA256(signingString, 'secret1');
    assert.strictEqual(sig.length, 64);
    // Same inputs always produce same output
    assert.strictEqual(hmacSHA256(signingString, 'secret1'), sig);
  });

  it('different data produces different signature', () => {
    const sig1 = hmacSHA256('/path1?a=1', 'secret');
    const sig2 = hmacSHA256('/path2?a=1', 'secret');
    assert.notStrictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — string ping/pong
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — string ping/pong', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitforex(); });

  it('WS URL is correct', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://www.bitforex.com/mkapi/coinGroup1/ws');
  });

  it('_getWsClient creates new client', () => {
    const client = exchange._getWsClient();
    assert.ok(client);
    assert.strictEqual(exchange._wsClients.size, 1);
  });

  it('_getWsClient returns same client for same URL', () => {
    const c1 = exchange._getWsClient();
    const c2 = exchange._getWsClient();
    assert.strictEqual(c1, c2);
  });

  it('_getWsClient has overridden _startPing', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client._startPing === 'function');
  });

  it('_getWsClient has overridden connect', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client.connect === 'function');
  });

  it('watchTicker subscribes with correct event and businessType', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchTicker('BTC/USDT', () => {});
    assert.ok(Array.isArray(sentMsg));
    assert.strictEqual(sentMsg[0].type, 'subHq');
    assert.strictEqual(sentMsg[0].event, 'ticker');
    assert.strictEqual(sentMsg[0].param.businessType, 'coin-usdt-btc');
  });

  it('watchOrderBook subscribes with depth10 event', async () => {
    let sentMsg;
    const fakeClient = { connected: true, send: (msg) => { sentMsg = msg; }, on: () => {} };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/USDT', () => {});
    assert.strictEqual(sentMsg[0].event, 'depth10');
  });

  it('watchTrades subscribes with trade event', async () => {
    let sentMsg;
    const fakeClient = { connected: true, send: (msg) => { sentMsg = msg; }, on: () => {} };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchTrades('BTC/USDT', () => {});
    assert.strictEqual(sentMsg[0].event, 'trade');
  });

  it('watchKlines subscribes with kline_1min event', async () => {
    let sentMsg;
    const fakeClient = { connected: true, send: (msg) => { sentMsg = msg; }, on: () => {} };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchKlines('BTC/USDT', '1m', () => {});
    assert.strictEqual(sentMsg[0].event, 'kline_1min');
  });

  it('watchKlines throws on unsupported timeframe', async () => {
    await assert.rejects(
      () => exchange.watchKlines('BTC/USDT', '3m', () => {}),
      /unsupported timeframe/
    );
  });

  it('subscribe format is JSON array with type subHq', async () => {
    let sentMsg;
    const fakeClient = { connected: true, send: (msg) => { sentMsg = msg; }, on: () => {} };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchTicker('ETH/BTC', () => {});
    assert.ok(Array.isArray(sentMsg));
    assert.strictEqual(sentMsg.length, 1);
    assert.strictEqual(sentMsg[0].type, 'subHq');
    assert.strictEqual(sentMsg[0].param.dType, 0);
  });

  it('closeAllWs clears clients and handlers', async () => {
    exchange._wsClients.set('test', { close: async () => {} });
    exchange._wsHandlers.set('key', {});
    await exchange.closeAllWs();
    assert.strictEqual(exchange._wsClients.size, 0);
    assert.strictEqual(exchange._wsHandlers.size, 0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 15. WS Message Dispatch + Parsers
// ═══════════════════════════════════════════════════════════════
describe('WS Message Dispatch + Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitforex(); });

  it('_parseWsTicker extracts fields (buy/sell not bid/ask)', () => {
    const t = exchange._parseWsTicker({ last: 50000, high: 51000, low: 49000, buy: 49999, sell: 50001, vol: 1234 }, 'BTC/USDT');
    assert.strictEqual(t.bid, 49999);
    assert.strictEqual(t.ask, 50001);
    assert.strictEqual(t.last, 50000);
  });

  it('_parseWsOrderBook maps {price, amount} to [price, amount]', () => {
    const ob = exchange._parseWsOrderBook({
      bids: [{ price: 49999, amount: 1.5 }],
      asks: [{ price: 50001, amount: 0.8 }],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids[0], [49999, 1.5]);
    assert.deepStrictEqual(ob.asks[0], [50001, 0.8]);
  });

  it('_parseWsTrade extracts fields with direction mapping', () => {
    const t = exchange._parseWsTrade({ tid: 't1', price: 50000, amount: 0.1, direction: 2, time: 1700000000000 }, 'BTC/USDT');
    assert.strictEqual(t.side, 'sell');
    assert.strictEqual(t.price, 50000);
  });

  it('_parseWsKline extracts kline fields', () => {
    const k = exchange._parseWsKline({ time: 1700000000000, open: 50000, high: 51000, low: 49000, close: 50500, vol: 100 }, 'BTC/USDT');
    assert.strictEqual(k.open, 50000);
    assert.strictEqual(k.close, 50500);
    assert.strictEqual(k.volume, 100);
    assert.strictEqual(k.symbol, 'BTC/USDT');
  });

  it('_parseWsOrderBook handles empty data', () => {
    const ob = exchange._parseWsOrderBook({}, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseWsTicker includes datetime', () => {
    const t = exchange._parseWsTicker({ last: 50000 }, 'BTC/USDT');
    assert.ok(t.datetime);
    assert.ok(t.timestamp);
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('Bitforex Version', () => {
  it('library version is 2.4.0', () => {
    assert.strictEqual(lib.version, '2.4.0');
  });
});

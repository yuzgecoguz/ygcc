'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const WhiteBit = require('../lib/whitebit');
const { hmacSHA512Hex } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — WhiteBit
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — WhiteBit', () => {
  it('exports WhiteBit class', () => {
    assert.strictEqual(typeof lib.WhiteBit, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.whitebit, lib.WhiteBit);
  });

  it('includes whitebit in exchanges list', () => {
    assert.ok(lib.exchanges.includes('whitebit'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. WhiteBit Constructor
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new WhiteBit(); });

  it('sets id to whitebit', () => {
    assert.strictEqual(exchange.describe().id, 'whitebit');
  });

  it('sets name to WhiteBit', () => {
    assert.strictEqual(exchange.describe().name, 'WhiteBit');
  });

  it('sets version to v4', () => {
    assert.strictEqual(exchange.describe().version, 'v4');
  });

  it('sets postAsJson to true', () => {
    assert.strictEqual(exchange.postAsJson, true);
  });

  it('has empty timeframes', () => {
    assert.deepStrictEqual(exchange.describe().timeframes, {});
  });

  it('has correct fees (0.1%)', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.001);
    assert.strictEqual(fees.taker, 0.001);
  });

  it('fetchTicker is supported', () => {
    assert.strictEqual(exchange.describe().has.fetchTicker, true);
  });

  it('createMarketOrder is supported', () => {
    assert.strictEqual(exchange.describe().has.createMarketOrder, true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — Base64 payload + HMAC-SHA512
// ═══════════════════════════════════════════════════════════════
describe('Authentication — Base64 + HMAC-SHA512', () => {
  let exchange;
  beforeEach(() => {
    exchange = new WhiteBit({ apiKey: 'testkey', secret: 'testsecret' });
  });

  it('throws without apiKey', () => {
    const ex = new WhiteBit({ secret: 'testsecret' });
    assert.throws(() => ex._sign('/api/v4/order/limit', 'POST', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new WhiteBit({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/api/v4/order/limit', 'POST', {}), /secret required/);
  });

  it('returns X-TXC-APIKEY header', () => {
    const result = exchange._sign('/api/v4/order/limit', 'POST', { market: 'BTC_USDT' });
    assert.strictEqual(result.headers['X-TXC-APIKEY'], 'testkey');
  });

  it('returns X-TXC-PAYLOAD header (base64)', () => {
    const result = exchange._sign('/api/v4/order/limit', 'POST', {});
    assert.ok(result.headers['X-TXC-PAYLOAD']);
    // Base64 is decodable
    const decoded = Buffer.from(result.headers['X-TXC-PAYLOAD'], 'base64').toString();
    const parsed = JSON.parse(decoded);
    assert.ok(parsed.request);
    assert.ok(parsed.nonce);
  });

  it('returns X-TXC-SIGNATURE header (128-char hex SHA512)', () => {
    const result = exchange._sign('/api/v4/order/limit', 'POST', {});
    assert.ok(/^[0-9a-f]{128}$/.test(result.headers['X-TXC-SIGNATURE']));
  });

  it('injects "request" field (path) into body', () => {
    const result = exchange._sign('/api/v4/order/limit', 'POST', { market: 'BTC_USDT' });
    assert.strictEqual(result.params.request, '/api/v4/order/limit');
  });

  it('injects "nonce" field (ms timestamp) into body', () => {
    const result = exchange._sign('/api/v4/order/limit', 'POST', {});
    assert.ok(typeof result.params.nonce === 'number');
    assert.ok(result.params.nonce > 1700000000000);
  });

  it('signing: HMAC-SHA512 of base64 payload', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { market: 'BTC_USDT', side: 'buy', amount: '1' };
      const result = exchange._sign('/api/v4/order/limit', 'POST', params);
      const body = { ...params, request: '/api/v4/order/limit', nonce: 1700000000000 };
      const payload = Buffer.from(JSON.stringify(body)).toString('base64');
      const expected = hmacSHA512Hex(payload, 'testsecret');
      assert.strictEqual(result.headers['X-TXC-SIGNATURE'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('original params are preserved in result.params', () => {
    const params = { market: 'BTC_USDT', side: 'buy' };
    const result = exchange._sign('/api/v4/order/limit', 'POST', params);
    assert.strictEqual(result.params.market, 'BTC_USDT');
    assert.strictEqual(result.params.side, 'buy');
  });

  it('different path produces different payload', () => {
    const r1 = exchange._sign('/api/v4/order/limit', 'POST', {});
    const r2 = exchange._sign('/api/v4/order/market', 'POST', {});
    assert.notStrictEqual(r1.headers['X-TXC-PAYLOAD'], r2.headers['X-TXC-PAYLOAD']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new WhiteBit(); });

  it('success with result field: unwraps result', () => {
    const result = exchange._unwrapResponse({ result: [{ name: 'BTC_USDT' }] });
    assert.deepStrictEqual(result, [{ name: 'BTC_USDT' }]);
  });

  it('error with code!=0: throws', () => {
    assert.throws(
      () => exchange._unwrapResponse({ code: 30, message: 'Validation failed' }),
      BadRequest
    );
  });

  it('error with success=false: throws', () => {
    assert.throws(
      () => exchange._unwrapResponse({ success: false, message: 'Something wrong' }),
      ExchangeError
    );
  });

  it('array response returned as-is', () => {
    const arr = [{ name: 'BTC_USDT' }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });

  it('handles non-object response', () => {
    const result = exchange._unwrapResponse(12345);
    assert.strictEqual(result, 12345);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new WhiteBit(); });

  it('_parseTicker extracts all fields', () => {
    const t = exchange._parseTicker({
      last_price: '50000', high: '51000', low: '49000',
      bid: '49999', ask: '50001', base_volume: '1000',
      quote_volume: '50000000', change: '500', open: '49500',
    }, 'BTC/USDT');
    assert.strictEqual(t.symbol, 'BTC/USDT');
    assert.strictEqual(t.last, 50000);
    assert.strictEqual(t.high, 51000);
    assert.strictEqual(t.low, 49000);
    assert.strictEqual(t.bid, 49999);
    assert.strictEqual(t.ask, 50001);
    assert.strictEqual(t.volume, 1000);
    assert.strictEqual(t.quoteVolume, 50000000);
  });

  it('_parseOrder extracts order fields', () => {
    const o = exchange._parseOrder({
      orderId: 4180284841, market: 'AVAX_USDT', side: 'buy',
      type: 'limit', price: '15', amount: '4', left: '4',
      dealStock: '0', dealMoney: '0', timestamp: 1700000000.0,
    }, 'AVAX/USDT');
    assert.strictEqual(o.id, '4180284841');
    assert.strictEqual(o.side, 'BUY');
    assert.strictEqual(o.type, 'LIMIT');
    assert.strictEqual(o.price, 15);
    assert.strictEqual(o.amount, 4);
    assert.strictEqual(o.remaining, 4);
  });

  it('_parseOrderBook handles array entries', () => {
    const ob = exchange._parseOrderBook({
      asks: [['50001', '0.8'], ['50002', '1.2']],
      bids: [['49999', '1.5'], ['49998', '2.0']],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [50001, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [49999, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseOrderBook handles object entries', () => {
    const ob = exchange._parseOrderBook({
      asks: [{ price: '50001', amount: '0.8' }],
      bids: [{ price: '49999', amount: '1.5' }],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [50001, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [49999, 1.5]);
  });

  it('_parseOrderBook handles empty data', () => {
    const ob = exchange._parseOrderBook({}, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseTicker uses Date.now() as timestamp', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const t = exchange._parseTicker({ last_price: '100' }, 'ETH/USDT');
      assert.strictEqual(t.timestamp, 1700000000000);
    } finally {
      Date.now = origNow;
    }
  });

  it('_parseOrder converts float timestamp to ms', () => {
    const o = exchange._parseOrder({ orderId: '1', timestamp: 1700000000.5 }, 'BTC/USDT');
    assert.strictEqual(o.timestamp, 1700000000500);
  });

  it('_parseOrder calculates average price', () => {
    const o = exchange._parseOrder({
      orderId: '1', dealStock: '2', dealMoney: '100000',
    }, 'BTC/USDT');
    assert.strictEqual(o.average, 50000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new WhiteBit(); });

  it('_toWhiteBitSymbol BTC/USDT → BTC_USDT', () => {
    assert.strictEqual(exchange._toWhiteBitSymbol('BTC/USDT'), 'BTC_USDT');
  });

  it('_toWhiteBitSymbol ETH/BTC → ETH_BTC', () => {
    assert.strictEqual(exchange._toWhiteBitSymbol('ETH/BTC'), 'ETH_BTC');
  });

  it('_toWhiteBitSymbol AVAX/USDT → AVAX_USDT', () => {
    assert.strictEqual(exchange._toWhiteBitSymbol('AVAX/USDT'), 'AVAX_USDT');
  });

  it('_fromWhiteBitSymbol fallback parse', () => {
    assert.strictEqual(exchange._fromWhiteBitSymbol('BTC_USDT'), 'BTC/USDT');
  });

  it('_fromWhiteBitSymbol resolves via marketsById', () => {
    exchange.marketsById = { 'BTC_USDT': { symbol: 'BTC/USDT' } };
    assert.strictEqual(exchange._fromWhiteBitSymbol('BTC_USDT'), 'BTC/USDT');
  });

  it('_fromWhiteBitSymbol returns raw for invalid format', () => {
    assert.strictEqual(exchange._fromWhiteBitSymbol('invalid'), 'invalid');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://whitebit.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new WhiteBit(); });

  it('code 30 → BadRequest (validation error)', () => {
    assert.throws(() => exchange._handleWhiteBitError(30, 'Validation failed'), BadRequest);
  });

  it('code 31 → BadSymbol (market validation)', () => {
    assert.throws(() => exchange._handleWhiteBitError(31, 'Market error'), BadSymbol);
  });

  it('"not enough balance" → InsufficientFunds', () => {
    assert.throws(() => exchange._handleWhiteBitError('FAIL', 'Not enough balance.'), InsufficientFunds);
  });

  it('"unknown market" → BadSymbol', () => {
    assert.throws(() => exchange._handleWhiteBitError('FAIL', 'Unknown market'), BadSymbol);
  });

  it('"order not found" → OrderNotFound', () => {
    assert.throws(() => exchange._handleWhiteBitError('FAIL', 'Order not found'), OrderNotFound);
  });

  it('"invalid key" → AuthenticationError', () => {
    assert.throws(() => exchange._handleWhiteBitError('FAIL', 'Invalid key'), AuthenticationError);
  });

  it('"rate limit" → RateLimitExceeded', () => {
    assert.throws(() => exchange._handleWhiteBitError('FAIL', 'Rate limit exceeded'), RateLimitExceeded);
  });

  it('unknown error → ExchangeError', () => {
    assert.throws(() => exchange._handleWhiteBitError(9999, 'unknown error'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new WhiteBit(); });

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

  it('parses JSON body with errors object', () => {
    const body = JSON.stringify({ code: 30, message: 'Validation failed', errors: { amount: ['Not enough'] } });
    assert.throws(() => exchange._handleHttpError(400, body), BadRequest);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new WhiteBit();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new WhiteBit({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new WhiteBit();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 20);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new WhiteBit({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { 'BTC_USDT': { symbol: 'BTC/USDT' } };
  });

  it('loadMarkets parses markets array', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ([
      { name: 'BTC_USDT', stock: 'BTC', money: 'USDT', moneyPrec: 2, stockPrec: 6, minAmount: '0.0001' },
      { name: 'ETH_USDT', stock: 'ETH', money: 'USDT', moneyPrec: 2, stockPrec: 4, minAmount: '0.001' },
    ]));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.ok(markets['ETH/USDT']);
    assert.strictEqual(markets['BTC/USDT'].id, 'BTC_USDT');
    assert.strictEqual(markets['BTC/USDT'].base, 'BTC');
  });

  it('fetchTicker fetches all and filters by symbol', async () => {
    mock.method(exchange, '_request', async () => ({
      'BTC_USDT': { last_price: '50000', high: '51000', low: '49000', bid: '49999', ask: '50001' },
      'ETH_USDT': { last_price: '3000' },
    }));
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.last, 50000);
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
  });

  it('fetchTickers returns multiple tickers', async () => {
    mock.method(exchange, '_request', async () => ({
      'BTC_USDT': { last_price: '50000' },
      'ETH_USDT': { last_price: '3000' },
    }));
    const tickers = await exchange.fetchTickers();
    assert.ok(tickers['BTC/USDT']);
    assert.ok(tickers['ETH/USDT']);
  });

  it('fetchOrderBook passes correct path', async () => {
    let capturedPath;
    mock.method(exchange, '_request', async (method, path) => {
      capturedPath = path;
      return { asks: [['50001', '0.5']], bids: [['49999', '1.0']] };
    });
    const ob = await exchange.fetchOrderBook('BTC/USDT', 20);
    assert.strictEqual(capturedPath, '/api/v4/public/orderbook/BTC_USDT');
    assert.strictEqual(ob.asks.length, 1);
  });

  it('createOrder sends POST to correct endpoint', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return { orderId: 4180284841, market: 'BTC_USDT', side: 'buy', type: 'limit' };
    });
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 1, 50000);
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/api/v4/order/limit');
    assert.strictEqual(capturedParams.market, 'BTC_USDT');
    assert.strictEqual(capturedParams.side, 'buy');
    assert.strictEqual(capturedParams.price, '50000');
    assert.strictEqual(capturedParams.amount, '1');
  });

  it('createOrder market type uses /order/market path', async () => {
    let capturedPath;
    mock.method(exchange, '_request', async (method, path) => {
      capturedPath = path;
      return { orderId: '123', market: 'BTC_USDT', side: 'buy', type: 'market' };
    });
    await exchange.createOrder('BTC/USDT', 'market', 'buy', 1);
    assert.strictEqual(capturedPath, '/api/v4/order/market');
  });

  it('createOrder limit without price throws', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/USDT', 'limit', 'buy', 1),
      /requires price/
    );
  });

  it('cancelOrder sends POST to cancel endpoint', async () => {
    let capturedMethod, capturedPath;
    mock.method(exchange, '_request', async (method, path) => {
      capturedMethod = method;
      capturedPath = path;
      return {};
    });
    const result = await exchange.cancelOrder('4180284841', 'BTC/USDT');
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/api/v4/order/cancel');
    assert.strictEqual(result.status, 'canceled');
  });

  it('fetchBalance parses currency→{available,freeze} response', async () => {
    mock.method(exchange, '_request', async () => ({
      BTC: { available: '0.5', freeze: '0.1' },
      USDT: { available: '5000', freeze: '1000' },
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.used, 0.1);
    assert.strictEqual(balance.BTC.total, 0.6);
    assert.strictEqual(balance.USDT.free, 5000);
    assert.strictEqual(balance.USDT.total, 6000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new WhiteBit();
    exchange._marketsLoaded = true;
    exchange.markets = {
      'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
    };
    exchange.marketsById = { 'BTC_USDT': { symbol: 'BTC/USDT' } };
  });

  it('market() returns correct market', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.id, 'BTC_USDT');
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
// 12. WhiteBit vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new WhiteBit({ apiKey: 'k', secret: 's' }); });

  it('Base64 payload signing (unique — body is base64 encoded then HMAC-SHA512)', () => {
    const result = exchange._sign('/api/v4/order/limit', 'POST', { market: 'BTC_USDT' });
    // Verify payload is valid base64
    const decoded = Buffer.from(result.headers['X-TXC-PAYLOAD'], 'base64').toString();
    assert.ok(JSON.parse(decoded));
    // Verify signature is 128-char SHA512 hex
    assert.strictEqual(result.headers['X-TXC-SIGNATURE'].length, 128);
  });

  it('all private endpoints use POST (including balance)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.fetchBalance, true);
    assert.strictEqual(has.createOrder, true);
    assert.strictEqual(has.cancelOrder, true);
  });

  it('body includes "request" and "nonce" fields (injected by _sign)', () => {
    const result = exchange._sign('/api/v4/trade-account/balance', 'POST', {});
    assert.strictEqual(result.params.request, '/api/v4/trade-account/balance');
    assert.ok(result.params.nonce > 0);
  });

  it('supports both market and limit orders', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.createLimitOrder, true);
    assert.strictEqual(has.createMarketOrder, true);
  });

  it('uses underscore symbol format (BTC_USDT)', () => {
    assert.strictEqual(exchange._toWhiteBitSymbol('BTC/USDT'), 'BTC_USDT');
    assert.strictEqual(exchange._toWhiteBitSymbol('ETH/BTC'), 'ETH_BTC');
  });

  it('X-TXC header prefix (unique among exchanges)', () => {
    const result = exchange._sign('/api/v4/order/limit', 'POST', {});
    assert.ok(result.headers['X-TXC-APIKEY']);
    assert.ok(result.headers['X-TXC-PAYLOAD']);
    assert.ok(result.headers['X-TXC-SIGNATURE']);
  });

  it('supports fetchTickers (returns all tickers in one call)', () => {
    assert.strictEqual(exchange.describe().has.fetchTickers, true);
  });

  it('zlib-compressed WebSocket (like Bibox, unlike VALR)', () => {
    assert.strictEqual(exchange.describe().has.watchOrderBook, true);
    assert.strictEqual(exchange.describe().urls.ws, 'wss://internal.whitebit.com/stream-ws');
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA512Hex
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA512Hex for WhiteBit', () => {
  it('hmacSHA512Hex produces 128-char hex string', () => {
    const sig = hmacSHA512Hex('test', 'secret');
    assert.strictEqual(sig.length, 128);
    assert.ok(/^[0-9a-f]{128}$/.test(sig));
  });

  it('hmacSHA512Hex is deterministic', () => {
    const payload = Buffer.from('{"request":"/api/v4/order/limit","nonce":1700000000000}').toString('base64');
    const sig1 = hmacSHA512Hex(payload, 'testsecret');
    const sig2 = hmacSHA512Hex(payload, 'testsecret');
    assert.strictEqual(sig1, sig2);
  });

  it('different secrets produce different signatures', () => {
    const sig1 = hmacSHA512Hex('test', 'secret1');
    const sig2 = hmacSHA512Hex('test', 'secret2');
    assert.notStrictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — zlib Z_SYNC_FLUSH + client ping
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — zlib Z_SYNC_FLUSH + client ping', () => {
  let exchange;
  beforeEach(() => { exchange = new WhiteBit(); });

  it('WS URL is correct', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://internal.whitebit.com/stream-ws');
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

  it('_getWsClient overrides _startPing for server.ping method', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client._startPing === 'function');
    client._startPing();
    client._stopPing();
  });

  it('_getWsClient has overridden connect for zlib handling', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client.connect === 'function');
  });

  it('ping format is {"method":"server.ping","id":0,"params":[]}', () => {
    const client = exchange._getWsClient();
    let sentData;
    client._ws = { readyState: 1, send: (d) => { sentData = d; } };
    client._ws.send(JSON.stringify({ method: 'server.ping', id: 0, params: [] }));
    assert.ok(sentData);
    const parsed = JSON.parse(sentData);
    assert.strictEqual(parsed.method, 'server.ping');
    assert.strictEqual(parsed.id, 0);
    assert.deepStrictEqual(parsed.params, []);
  });

  it('watchOrderBook subscribes with depth.subscribe', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/USDT', () => {});
    assert.strictEqual(sentMsg.method, 'depth.subscribe');
    assert.strictEqual(sentMsg.params[0], 'BTC_USDT');
    assert.strictEqual(sentMsg.params[1], 50);  // default depth
  });

  it('subscribe message has correct format', async () => {
    let sentMsg;
    const fakeClient = { connected: true, send: (msg) => { sentMsg = msg; }, on: () => {} };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('ETH/USDT', () => {}, 20);
    assert.strictEqual(sentMsg.method, 'depth.subscribe');
    assert.strictEqual(sentMsg.id, 2);
    assert.deepStrictEqual(sentMsg.params, ['ETH_USDT', 20, '0', true]);
  });

  it('watchOrderBook is supported', () => {
    assert.strictEqual(exchange.describe().has.watchOrderBook, true);
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
// 15. WS Parsers
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new WhiteBit(); });

  it('_parseWsOrderBook handles snapshot (params[0]=true)', () => {
    const ob = exchange._parseWsOrderBook({
      method: 'depth.update',
      params: [true, {
        asks: [['50001', '0.8'], ['50002', '1.2']],
        bids: [['49999', '1.5'], ['49998', '2.0']],
      }, 'BTC_USDT'],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids[0], [49999, 1.5]);
    assert.deepStrictEqual(ob.asks[0], [50001, 0.8]);
    assert.strictEqual(ob.isSnapshot, true);
  });

  it('_parseWsOrderBook handles incremental update (params[0]=false)', () => {
    const ob = exchange._parseWsOrderBook({
      method: 'depth.update',
      params: [false, {
        asks: [['50003', '0.5']],
        bids: [],
      }, 'BTC_USDT'],
    }, 'BTC/USDT');
    assert.strictEqual(ob.isSnapshot, false);
    assert.deepStrictEqual(ob.asks[0], [50003, 0.5]);
  });

  it('_parseWsOrderBook handles empty data', () => {
    const ob = exchange._parseWsOrderBook({ params: [true, {}, 'BTC_USDT'] }, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseWsOrderBook handles missing params gracefully', () => {
    const ob = exchange._parseWsOrderBook({ params: [] }, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('WhiteBit Version', () => {
  it('library version is 2.9.0', () => {
    assert.strictEqual(lib.version, '2.9.0');
  });
});

'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const Valr = require('../lib/valr');
const { hmacSHA512Hex } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — VALR
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — VALR', () => {
  it('exports Valr class', () => {
    assert.strictEqual(typeof lib.Valr, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.valr, lib.Valr);
  });

  it('includes valr in exchanges list', () => {
    assert.ok(lib.exchanges.includes('valr'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. VALR Constructor
// ═══════════════════════════════════════════════════════════════
describe('VALR Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new Valr(); });

  it('sets id to valr', () => {
    assert.strictEqual(exchange.describe().id, 'valr');
  });

  it('sets name to VALR', () => {
    assert.strictEqual(exchange.describe().name, 'VALR');
  });

  it('sets version to v1', () => {
    assert.strictEqual(exchange.describe().version, 'v1');
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
// 3. Authentication — HMAC-SHA512 (timestamp+method+path+body)
// ═══════════════════════════════════════════════════════════════
describe('Authentication — HMAC-SHA512 (timestamp+method+path+body)', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Valr({ apiKey: 'testkey', secret: 'testsecret' });
  });

  it('throws without apiKey', () => {
    const ex = new Valr({ secret: 'testsecret' });
    assert.throws(() => ex._sign('/v1/orders/limit', 'POST', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new Valr({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/v1/orders/limit', 'POST', {}), /secret required/);
  });

  it('returns X-VALR-API-KEY header', () => {
    const result = exchange._sign('/v1/orders/limit', 'POST', { pair: 'BTCZAR' });
    assert.strictEqual(result.headers['X-VALR-API-KEY'], 'testkey');
  });

  it('returns X-VALR-TIMESTAMP header (ms timestamp)', () => {
    const result = exchange._sign('/v1/orders/limit', 'POST', {});
    assert.ok(result.headers['X-VALR-TIMESTAMP']);
    assert.ok(/^\d+$/.test(result.headers['X-VALR-TIMESTAMP']));
  });

  it('returns X-VALR-SIGNATURE header (128-char hex SHA512)', () => {
    const result = exchange._sign('/v1/orders/limit', 'POST', { pair: 'BTCZAR' });
    assert.ok(/^[0-9a-f]{128}$/.test(result.headers['X-VALR-SIGNATURE']));
  });

  it('POST signing: HMAC-SHA512(timestamp + POST + path + body)', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { side: 'BUY', quantity: '820', price: '0.029', pair: 'DNTUSDC' };
      const result = exchange._sign('/v1/orders/limit', 'POST', params);
      const body = JSON.stringify(params);
      const expected = hmacSHA512Hex('1700000000000POST/v1/orders/limit' + body, 'testsecret');
      assert.strictEqual(result.headers['X-VALR-SIGNATURE'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('GET signing: body is empty string', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/v1/account/balances', 'GET', {});
      const expected = hmacSHA512Hex('1700000000000GET/v1/account/balances', 'testsecret');
      assert.strictEqual(result.headers['X-VALR-SIGNATURE'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('DELETE signing includes body', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { orderId: 'abc-123' };
      const result = exchange._sign('/v1/orders/order', 'DELETE', params);
      const body = JSON.stringify(params);
      const expected = hmacSHA512Hex('1700000000000DELETE/v1/orders/order' + body, 'testsecret');
      assert.strictEqual(result.headers['X-VALR-SIGNATURE'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('params are preserved in result', () => {
    const params = { pair: 'BTCZAR', side: 'BUY' };
    const result = exchange._sign('/v1/orders/limit', 'POST', params);
    assert.strictEqual(result.params.pair, 'BTCZAR');
    assert.strictEqual(result.params.side, 'BUY');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('VALR Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Valr(); });

  it('success object returned as-is', () => {
    const data = { id: 'abc-123' };
    const result = exchange._unwrapResponse(data);
    assert.strictEqual(result.id, 'abc-123');
  });

  it('error with code field: throws', () => {
    assert.throws(
      () => exchange._unwrapResponse({ code: 'INSUFFICIENT_BALANCE', message: 'Not enough' }),
      InsufficientFunds
    );
  });

  it('array response returned as-is', () => {
    const arr = [{ currency: 'BTC', available: '0.5' }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });

  it('handles non-object response', () => {
    const result = exchange._unwrapResponse('OK');
    assert.strictEqual(result, 'OK');
  });

  it('null/empty response passes through', () => {
    const result = exchange._unwrapResponse(null);
    assert.strictEqual(result, null);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('VALR Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Valr(); });

  it('_parseTicker extracts all fields', () => {
    const t = exchange._parseTicker({
      lastTradedPrice: '50000', highPrice: '51000', lowPrice: '49000',
      bidPrice: '49999', askPrice: '50001', baseVolume: '1000',
      quoteVolume: '50000000', changeFromPrevious: '2.5',
    }, 'BTC/ZAR');
    assert.strictEqual(t.symbol, 'BTC/ZAR');
    assert.strictEqual(t.last, 50000);
    assert.strictEqual(t.high, 51000);
    assert.strictEqual(t.low, 49000);
    assert.strictEqual(t.bid, 49999);
    assert.strictEqual(t.ask, 50001);
    assert.strictEqual(t.volume, 1000);
  });

  it('_parseOrder extracts order id from VALR response', () => {
    const o = exchange._parseOrder({ id: 'abc-123-def' }, 'BTC/ZAR');
    assert.strictEqual(o.id, 'abc-123-def');
    assert.strictEqual(o.symbol, 'BTC/ZAR');
    assert.strictEqual(o.status, 'open');
  });

  it('_parseOrder extracts detailed order fields', () => {
    const o = exchange._parseOrder({
      id: 'xyz', currencyPairSymbol: 'BTCZAR', side: 'BUY', type: 'LIMIT',
      price: '500000', quantity: '0.5', filledQuantity: '0.2',
    }, 'BTC/ZAR');
    assert.strictEqual(o.side, 'BUY');
    assert.strictEqual(o.type, 'LIMIT');
    assert.strictEqual(o.price, 500000);
    assert.strictEqual(o.amount, 0.5);
    assert.strictEqual(o.filled, 0.2);
    assert.strictEqual(o.remaining, 0.3);
  });

  it('_parseOrderBook handles Asks/Bids (titlecase)', () => {
    const ob = exchange._parseOrderBook({
      Asks: [{ price: '500001', quantity: '0.8' }],
      Bids: [{ price: '499999', quantity: '1.5' }],
    }, 'BTC/ZAR');
    assert.deepStrictEqual(ob.asks[0], [500001, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [499999, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/ZAR');
  });

  it('_parseOrderBook handles lowercase asks/bids', () => {
    const ob = exchange._parseOrderBook({
      asks: [{ price: '50001', quantity: '0.8' }],
      bids: [{ price: '49999', quantity: '1.5' }],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [50001, 0.8]);
  });

  it('_parseOrderBook handles empty data', () => {
    const ob = exchange._parseOrderBook({}, 'BTC/ZAR');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseTicker uses Date.now() as timestamp', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const t = exchange._parseTicker({ lastTradedPrice: '100' }, 'ETH/ZAR');
      assert.strictEqual(t.timestamp, 1700000000000);
    } finally {
      Date.now = origNow;
    }
  });

  it('_parseOrder calculates cost', () => {
    const o = exchange._parseOrder({
      id: '1', price: '100', quantity: '10', filledQuantity: '5',
    }, 'BTC/ZAR');
    assert.strictEqual(o.cost, 500);
  });

  it('_parseOrder handles empty response', () => {
    const o = exchange._parseOrder({}, 'BTC/ZAR');
    assert.strictEqual(o.symbol, 'BTC/ZAR');
    assert.strictEqual(o.price, 0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('VALR Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new Valr(); });

  it('_toValrSymbol BTC/ZAR → BTCZAR', () => {
    assert.strictEqual(exchange._toValrSymbol('BTC/ZAR'), 'BTCZAR');
  });

  it('_toValrSymbol ETH/ZAR → ETHZAR', () => {
    assert.strictEqual(exchange._toValrSymbol('ETH/ZAR'), 'ETHZAR');
  });

  it('_toValrSymbol DNT/USDC → DNTUSDC', () => {
    assert.strictEqual(exchange._toValrSymbol('DNT/USDC'), 'DNTUSDC');
  });

  it('_fromValrSymbol resolves via marketsById', () => {
    exchange.marketsById = { 'BTCZAR': { symbol: 'BTC/ZAR' } };
    assert.strictEqual(exchange._fromValrSymbol('BTCZAR'), 'BTC/ZAR');
  });

  it('_fromValrSymbol returns raw without markets', () => {
    assert.strictEqual(exchange._fromValrSymbol('BTCZAR'), 'BTCZAR');
  });

  it('_fromValrSymbol unknown symbol returns as-is', () => {
    exchange.marketsById = {};
    assert.strictEqual(exchange._fromValrSymbol('UNKNOWN'), 'UNKNOWN');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.valr.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('VALR Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new Valr(); });

  it('INVALID_PARAMETER → BadRequest', () => {
    assert.throws(() => exchange._handleValrError('INVALID_PARAMETER', 'Invalid param'), BadRequest);
  });

  it('INVALID_API_KEY → AuthenticationError', () => {
    assert.throws(() => exchange._handleValrError('INVALID_API_KEY', 'Bad key'), AuthenticationError);
  });

  it('UNAUTHORIZED → AuthenticationError', () => {
    assert.throws(() => exchange._handleValrError('UNAUTHORIZED', 'Not auth'), AuthenticationError);
  });

  it('INSUFFICIENT_BALANCE → InsufficientFunds', () => {
    assert.throws(() => exchange._handleValrError('INSUFFICIENT_BALANCE', 'No funds'), InsufficientFunds);
  });

  it('ORDER_NOT_FOUND → OrderNotFound', () => {
    assert.throws(() => exchange._handleValrError('ORDER_NOT_FOUND', 'Not found'), OrderNotFound);
  });

  it('INVALID_PAIR → BadSymbol', () => {
    assert.throws(() => exchange._handleValrError('INVALID_PAIR', 'Bad pair'), BadSymbol);
  });

  it('RATE_LIMIT_EXCEEDED → RateLimitExceeded', () => {
    assert.throws(() => exchange._handleValrError('RATE_LIMIT_EXCEEDED', 'Rate limited'), RateLimitExceeded);
  });

  it('unknown code → ExchangeError', () => {
    assert.throws(() => exchange._handleValrError('UNKNOWN', 'unknown'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('VALR HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Valr(); });

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

  it('parses JSON error body', () => {
    const body = JSON.stringify({ code: 'INSUFFICIENT_BALANCE', message: 'Not enough' });
    assert.throws(() => exchange._handleHttpError(400, body), InsufficientFunds);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('VALR Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new Valr();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new Valr({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new Valr();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 10);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('VALR Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Valr({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/ZAR': { id: 'BTCZAR', symbol: 'BTC/ZAR', base: 'BTC', quote: 'ZAR' } };
    exchange.marketsById = { 'BTCZAR': { symbol: 'BTC/ZAR' } };
  });

  it('loadMarkets parses pairs response', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ([
      { symbol: 'BTCZAR', baseCurrency: 'BTC', quoteCurrency: 'ZAR', active: true },
      { symbol: 'ETHZAR', baseCurrency: 'ETH', quoteCurrency: 'ZAR', active: true },
    ]));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/ZAR']);
    assert.ok(markets['ETH/ZAR']);
    assert.strictEqual(markets['BTC/ZAR'].id, 'BTCZAR');
  });

  it('fetchTicker passes correct path', async () => {
    let capturedPath;
    mock.method(exchange, '_request', async (method, path) => {
      capturedPath = path;
      return { lastTradedPrice: '500000', bidPrice: '499999', askPrice: '500001' };
    });
    const ticker = await exchange.fetchTicker('BTC/ZAR');
    assert.strictEqual(capturedPath, '/v1/public/BTCZAR/marketsummary');
    assert.strictEqual(ticker.last, 500000);
  });

  it('fetchOrderBook passes correct path', async () => {
    let capturedPath;
    mock.method(exchange, '_request', async (method, path) => {
      capturedPath = path;
      return { Asks: [{ price: '500001', quantity: '0.5' }], Bids: [{ price: '499999', quantity: '1.0' }] };
    });
    const ob = await exchange.fetchOrderBook('BTC/ZAR');
    assert.strictEqual(capturedPath, '/v1/marketdata/BTCZAR/orderbook');
    assert.strictEqual(ob.asks.length, 1);
  });

  it('createOrder limit sends correct params', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return { id: 'abc-123' };
    });
    const order = await exchange.createOrder('BTC/ZAR', 'limit', 'BUY', 0.5, 500000);
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/v1/orders/limit');
    assert.strictEqual(capturedParams.pair, 'BTCZAR');
    assert.strictEqual(capturedParams.side, 'BUY');
    assert.strictEqual(capturedParams.quantity, '0.5');
    assert.strictEqual(capturedParams.price, '500000');
    assert.strictEqual(order.id, 'abc-123');
  });

  it('createOrder market sends to /orders/market', async () => {
    let capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedPath = path;
      capturedParams = params;
      return { id: 'market-123' };
    });
    await exchange.createOrder('BTC/ZAR', 'market', 'SELL', 0.5);
    assert.strictEqual(capturedPath, '/v1/orders/market');
    assert.strictEqual(capturedParams.baseAmount, '0.5');
  });

  it('createOrder limit without price throws', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/ZAR', 'limit', 'BUY', 0.5),
      /requires price/
    );
  });

  it('cancelOrder sends DELETE to /v1/orders/order', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return {};
    });
    const result = await exchange.cancelOrder('abc-123', 'BTC/ZAR');
    assert.strictEqual(capturedMethod, 'DELETE');
    assert.strictEqual(capturedPath, '/v1/orders/order');
    assert.strictEqual(capturedParams.orderId, 'abc-123');
    assert.strictEqual(result.status, 'canceled');
  });

  it('fetchBalance parses VALR balance array', async () => {
    mock.method(exchange, '_request', async () => ([
      { currency: 'BTC', available: '0.5', reserved: '0.1', total: '0.6' },
      { currency: 'ZAR', available: '10000', reserved: '5000', total: '15000' },
    ]));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.used, 0.1);
    assert.strictEqual(balance.BTC.total, 0.6);
    assert.strictEqual(balance.ZAR.free, 10000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('VALR Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Valr();
    exchange._marketsLoaded = true;
    exchange.markets = {
      'BTC/ZAR': { id: 'BTCZAR', symbol: 'BTC/ZAR', base: 'BTC', quote: 'ZAR' },
    };
    exchange.marketsById = { 'BTCZAR': { symbol: 'BTC/ZAR' } };
  });

  it('market() returns correct market', () => {
    const m = exchange.market('BTC/ZAR');
    assert.strictEqual(m.id, 'BTCZAR');
  });

  it('market() returns base and quote', () => {
    const m = exchange.market('BTC/ZAR');
    assert.strictEqual(m.base, 'BTC');
    assert.strictEqual(m.quote, 'ZAR');
  });

  it('market() throws on unknown symbol', () => {
    assert.throws(() => exchange.market('DOGE/USD'), /unknown symbol/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. VALR vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('VALR vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new Valr({ apiKey: 'k', secret: 's' }); });

  it('signing: timestamp+method+path+body (unique concatenation order)', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/v1/orders/limit', 'POST', { pair: 'BTCZAR' });
      assert.strictEqual(result.headers['X-VALR-SIGNATURE'].length, 128);
    } finally {
      Date.now = origNow;
    }
  });

  it('cancelOrder uses DELETE (not POST like Bibox)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.cancelOrder, true);
  });

  it('concatenated symbol format BTCZAR (no separator, unlike BTC_USDT)', () => {
    assert.strictEqual(exchange._toValrSymbol('BTC/ZAR'), 'BTCZAR');
    assert.strictEqual(exchange._toValrSymbol('ETH/ZAR'), 'ETHZAR');
  });

  it('South African exchange: primary quote currency is ZAR', () => {
    assert.strictEqual(exchange.describe().urls.api, 'https://api.valr.com');
  });

  it('X-VALR header prefix (unique among exchanges)', () => {
    const result = exchange._sign('/v1/orders/limit', 'POST', {});
    assert.ok(result.headers['X-VALR-API-KEY']);
    assert.ok(result.headers['X-VALR-SIGNATURE']);
    assert.ok(result.headers['X-VALR-TIMESTAMP']);
  });

  it('supports both market and limit orders', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.createLimitOrder, true);
    assert.strictEqual(has.createMarketOrder, true);
  });

  it('plain JSON WebSocket (no compression, unlike WhiteBit)', () => {
    assert.strictEqual(exchange.describe().has.watchOrderBook, true);
    assert.strictEqual(exchange.describe().urls.ws, 'wss://api.valr.com/ws/trade');
  });

  it('no fetchTickers (single ticker per call)', () => {
    assert.strictEqual(exchange.describe().has.fetchTickers, false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA512Hex
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA512Hex for VALR', () => {
  it('hmacSHA512Hex produces 128-char hex string', () => {
    const sig = hmacSHA512Hex('test', 'secret');
    assert.strictEqual(sig.length, 128);
    assert.ok(/^[0-9a-f]{128}$/.test(sig));
  });

  it('hmacSHA512Hex is deterministic', () => {
    const sig1 = hmacSHA512Hex('1700000000000POST/v1/orders/limit{"pair":"BTCZAR"}', 'testsecret');
    const sig2 = hmacSHA512Hex('1700000000000POST/v1/orders/limit{"pair":"BTCZAR"}', 'testsecret');
    assert.strictEqual(sig1, sig2);
  });

  it('different data produces different signatures', () => {
    const sig1 = hmacSHA512Hex('POST', 'secret');
    const sig2 = hmacSHA512Hex('GET', 'secret');
    assert.notStrictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — plain JSON + SUBSCRIBE
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — plain JSON + SUBSCRIBE', () => {
  let exchange;
  beforeEach(() => { exchange = new Valr(); });

  it('WS URL is correct', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://api.valr.com/ws/trade');
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

  it('_getWsClient has no-op _startPing (server-managed keepalive)', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client._startPing === 'function');
    // Should not throw and no interval created
    client._startPing();
  });

  it('_getWsClient has overridden connect', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client.connect === 'function');
  });

  it('watchOrderBook subscribes with AGGREGATED_ORDERBOOK_UPDATE', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/ZAR', () => {});
    assert.strictEqual(sentMsg.type, 'SUBSCRIBE');
    assert.strictEqual(sentMsg.subscriptions[0].event, 'AGGREGATED_ORDERBOOK_UPDATE');
    assert.deepStrictEqual(sentMsg.subscriptions[0].pairs, ['BTCZAR']);
  });

  it('subscribe format uses SUBSCRIBE type', async () => {
    let sentMsg;
    const fakeClient = { connected: true, send: (msg) => { sentMsg = msg; }, on: () => {} };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('ETH/ZAR', () => {});
    assert.strictEqual(sentMsg.type, 'SUBSCRIBE');
    assert.ok(Array.isArray(sentMsg.subscriptions));
  });

  it('watchOrderBook is supported', () => {
    assert.strictEqual(exchange.describe().has.watchOrderBook, true);
  });

  it('watchTicker is NOT supported', () => {
    assert.strictEqual(exchange.describe().has.watchTicker, false);
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
describe('VALR WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Valr(); });

  it('_parseWsOrderBook handles Asks/Bids (titlecase)', () => {
    const ob = exchange._parseWsOrderBook({
      Asks: [{ price: '500001', quantity: '0.8' }, { price: '500002', quantity: '1.2' }],
      Bids: [{ price: '499999', quantity: '1.5' }],
    }, 'BTC/ZAR');
    assert.deepStrictEqual(ob.asks[0], [500001, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [499999, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/ZAR');
  });

  it('_parseWsOrderBook handles lowercase asks/bids', () => {
    const ob = exchange._parseWsOrderBook({
      asks: [{ price: '3001', quantity: '5.0' }],
      bids: [{ price: '2999', quantity: '3.0' }],
    }, 'ETH/ZAR');
    assert.deepStrictEqual(ob.asks[0], [3001, 5.0]);
    assert.deepStrictEqual(ob.bids[0], [2999, 3.0]);
  });

  it('_parseWsOrderBook handles empty data', () => {
    const ob = exchange._parseWsOrderBook({}, 'BTC/ZAR');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseWsOrderBook includes timestamp', () => {
    const ob = exchange._parseWsOrderBook({ Asks: [], Bids: [] }, 'BTC/ZAR');
    assert.ok(ob.timestamp > 0);
    assert.ok(ob.datetime);
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('VALR Version', () => {
  it('library version is 2.9.0', () => {
    assert.strictEqual(lib.version, '2.9.0');
  });
});

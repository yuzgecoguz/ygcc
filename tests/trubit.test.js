'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const Trubit = require('../lib/trubit');
const { hmacSHA256 } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — Trubit
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — Trubit', () => {
  it('exports Trubit class', () => {
    assert.strictEqual(typeof lib.Trubit, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.trubit, lib.Trubit);
  });

  it('includes trubit in exchanges list', () => {
    assert.ok(lib.exchanges.includes('trubit'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Trubit Constructor
// ═══════════════════════════════════════════════════════════════
describe('Trubit Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new Trubit(); });

  it('sets id to trubit', () => {
    assert.strictEqual(exchange.describe().id, 'trubit');
  });

  it('sets name to Trubit', () => {
    assert.strictEqual(exchange.describe().name, 'Trubit');
  });

  it('sets version to v1', () => {
    assert.strictEqual(exchange.describe().version, 'v1');
  });

  it('does not set postAsJson (params as query string)', () => {
    assert.ok(!exchange.postAsJson);
  });

  it('has empty timeframes', () => {
    assert.deepStrictEqual(exchange.describe().timeframes, {});
  });

  it('has correct fees (0.1% maker/taker)', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.001);
    assert.strictEqual(fees.taker, 0.001);
  });

  it('stores apiKey from config', () => {
    const ex = new Trubit({ apiKey: 'mykey' });
    assert.strictEqual(ex.apiKey, 'mykey');
  });

  it('stores secret from config', () => {
    const ex = new Trubit({ secret: 'mysecret' });
    assert.strictEqual(ex.secret, 'mysecret');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — Binance-compatible HMAC-SHA256 (same as JBEX)
// ═══════════════════════════════════════════════════════════════
describe('Authentication — Binance-compatible HMAC-SHA256', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Trubit({ apiKey: 'testkey', secret: 'testsecret' });
  });

  it('throws without apiKey', () => {
    const ex = new Trubit({ secret: 'testsecret' });
    assert.throws(() => ex._sign('/openapi/v1/account', 'GET', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new Trubit({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/openapi/v1/account', 'GET', {}), /secret required/);
  });

  it('returns X-BH-APIKEY header (same as JBEX)', () => {
    const result = exchange._sign('/openapi/v1/account', 'GET', {});
    assert.strictEqual(result.headers['X-BH-APIKEY'], 'testkey');
  });

  it('adds timestamp to params', () => {
    const result = exchange._sign('/openapi/v1/account', 'GET', {});
    assert.ok(result.params.timestamp);
    assert.ok(/^\d+$/.test(result.params.timestamp));
  });

  it('adds signature to params (64-char hex)', () => {
    const result = exchange._sign('/openapi/v1/account', 'GET', {});
    assert.ok(result.params.signature);
    assert.ok(/^[0-9a-f]{64}$/.test(result.params.signature));
  });

  it('signature = hmacSHA256(sortedQueryString, secret)', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { symbol: 'BTCUSDT' };
      const result = exchange._sign('/openapi/v1/order', 'POST', params);

      const allParams = { symbol: 'BTCUSDT', timestamp: '1700000000000' };
      const sortedKeys = Object.keys(allParams).sort();
      const sorted = {};
      for (const k of sortedKeys) sorted[k] = allParams[k];
      const qs = new URLSearchParams(sorted).toString();
      const expected = hmacSHA256(qs, 'testsecret');

      assert.strictEqual(result.params.signature, expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('params sorted by key before signing', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { z: '1', a: '2' };
      const result = exchange._sign('/openapi/v1/order', 'POST', params);

      const sorted = { a: '2', timestamp: '1700000000000', z: '1' };
      const qs = new URLSearchParams(sorted).toString();
      const expected = hmacSHA256(qs, 'testsecret');

      assert.strictEqual(result.params.signature, expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('works with both apiKey and secret provided', () => {
    const result = exchange._sign('/openapi/v1/account', 'GET', {});
    assert.ok(result.params.signature);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('Trubit Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Trubit(); });

  it('negative code throws error', () => {
    assert.throws(
      () => exchange._unwrapResponse({ code: '-1001', msg: 'Internal error' }),
      ExchangeNotAvailable
    );
  });

  it('no code passes through', () => {
    const data = { orderId: '123', symbol: 'BTCUSDT' };
    const result = exchange._unwrapResponse(data);
    assert.strictEqual(result.orderId, '123');
  });

  it('array data passes through', () => {
    const arr = [{ symbol: 'BTCUSDT' }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('Trubit Parsers', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Trubit();
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' } };
  });

  it('_parseTicker extracts Binance-style fields', () => {
    const t = exchange._parseTicker({
      symbol: 'BTCUSDT', lastPrice: '30000', highPrice: '31000', lowPrice: '29000',
      openPrice: '29500', bidPrice: '29900', askPrice: '30100',
      volume: '1500', quoteVolume: '45000000', priceChange: '500',
      priceChangePercent: '1.69', time: 1700000000000,
    });
    assert.strictEqual(t.symbol, 'BTC/USDT');
    assert.strictEqual(t.last, 30000);
    assert.strictEqual(t.high, 31000);
    assert.strictEqual(t.low, 29000);
    assert.strictEqual(t.open, 29500);
    assert.strictEqual(t.bid, 29900);
    assert.strictEqual(t.ask, 30100);
    assert.strictEqual(t.volume, 1500);
    assert.strictEqual(t.quoteVolume, 45000000);
    assert.strictEqual(t.change, 500);
  });

  it('_parseOrder extracts orderId and maps fields', () => {
    const o = exchange._parseOrder({
      orderId: 'ORD123', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT',
      price: '30000', origQty: '0.5', executedQty: '0.2', status: 'PARTIALLY_FILLED',
    }, 'BTC/USDT');
    assert.strictEqual(o.id, 'ORD123');
    assert.strictEqual(o.side, 'buy');
    assert.strictEqual(o.type, 'limit');
    assert.strictEqual(o.amount, 0.5);
    assert.strictEqual(o.filled, 0.2);
    assert.strictEqual(o.remaining, 0.3);
    assert.strictEqual(o.status, 'open');
  });

  it('_parseOrderStatus maps Binance statuses', () => {
    assert.strictEqual(exchange._parseOrderStatus('NEW'), 'open');
    assert.strictEqual(exchange._parseOrderStatus('PARTIALLY_FILLED'), 'open');
    assert.strictEqual(exchange._parseOrderStatus('FILLED'), 'closed');
    assert.strictEqual(exchange._parseOrderStatus('CANCELED'), 'canceled');
    assert.strictEqual(exchange._parseOrderStatus('REJECTED'), 'rejected');
  });

  it('_parseOrderBook handles array entries', () => {
    const ob = exchange._parseOrderBook({
      asks: [['30100', '0.8'], ['30200', '1.2']],
      bids: [['29900', '1.5'], ['29800', '2.0']],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
  });

  it('_parseBalance extracts asset, free, locked', () => {
    const b = exchange._parseBalance([
      { asset: 'BTC', free: '0.5', locked: '0.3' },
      { asset: 'USDT', free: '10000', locked: '5000' },
    ]);
    assert.strictEqual(b.BTC.free, 0.5);
    assert.strictEqual(b.BTC.used, 0.3);
    assert.strictEqual(b.BTC.total, 0.8);
    assert.strictEqual(b.USDT.free, 10000);
    assert.strictEqual(b.USDT.used, 5000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('Trubit Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new Trubit(); });

  it('_toTrubitSymbol BTC/USDT -> BTCUSDT', () => {
    assert.strictEqual(exchange._toTrubitSymbol('BTC/USDT'), 'BTCUSDT');
  });

  it('_toTrubitSymbol ETH/BTC -> ETHBTC', () => {
    assert.strictEqual(exchange._toTrubitSymbol('ETH/BTC'), 'ETHBTC');
  });

  it('_fromTrubitSymbol resolves via marketsById', () => {
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' } };
    assert.strictEqual(exchange._fromTrubitSymbol('BTCUSDT'), 'BTC/USDT');
  });

  it('_fromTrubitSymbol fallback splits common quotes', () => {
    exchange.marketsById = {};
    assert.strictEqual(exchange._fromTrubitSymbol('ETHUSDT'), 'ETH/USDT');
  });

  it('_fromTrubitSymbol supports MXN quote (Mexican peso)', () => {
    exchange.marketsById = {};
    assert.strictEqual(exchange._fromTrubitSymbol('BTCMXN'), 'BTC/MXN');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api-spot.trubit.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('Trubit Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new Trubit(); });

  it('-1002 -> AuthenticationError', () => {
    assert.throws(() => exchange._handleTrubitError('-1002', 'Unauthorized'), AuthenticationError);
  });

  it('-1003 -> RateLimitExceeded', () => {
    assert.throws(() => exchange._handleTrubitError('-1003', 'Too many requests'), RateLimitExceeded);
  });

  it('-1013 -> InvalidOrder', () => {
    assert.throws(() => exchange._handleTrubitError('-1013', 'Invalid quantity'), InvalidOrder);
  });

  it('-2011 -> OrderNotFound', () => {
    assert.throws(() => exchange._handleTrubitError('-2011', 'Unknown order'), OrderNotFound);
  });

  it('-1121 -> BadSymbol', () => {
    assert.throws(() => exchange._handleTrubitError('-1121', 'Invalid symbol'), BadSymbol);
  });

  it('-1001 -> ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handleTrubitError('-1001', 'Internal error'), ExchangeNotAvailable);
  });

  it('unknown code -> ExchangeError', () => {
    assert.throws(() => exchange._handleTrubitError('-9999', 'Unknown'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('Trubit HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Trubit(); });

  it('400 -> BadRequest', () => {
    assert.throws(() => exchange._handleHttpError(400, 'bad request'), BadRequest);
  });

  it('401 -> AuthenticationError', () => {
    assert.throws(() => exchange._handleHttpError(401, 'unauthorized'), AuthenticationError);
  });

  it('418 -> RateLimitExceeded', () => {
    assert.throws(() => exchange._handleHttpError(418, 'ip banned'), RateLimitExceeded);
  });

  it('429 -> RateLimitExceeded', () => {
    assert.throws(() => exchange._handleHttpError(429, 'too many requests'), RateLimitExceeded);
  });

  it('500 -> ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handleHttpError(500, 'server error'), ExchangeNotAvailable);
  });

  it('parses JSON error body with negative code', () => {
    const body = JSON.stringify({ code: '-1002', msg: 'Unauthorized' });
    assert.throws(() => exchange._handleHttpError(403, body), AuthenticationError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('Trubit Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new Trubit();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new Trubit({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new Trubit();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 10);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('Trubit Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Trubit({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' } };
  });

  it('loadMarkets parses brokerInfo response', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ({
      symbols: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', filters: [
          { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '100000', tickSize: '0.01' },
          { filterType: 'LOT_SIZE', minQty: '0.00001', maxQty: '10000', stepSize: '0.00001' },
        ] },
      ],
    }));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.strictEqual(markets['BTC/USDT'].id, 'BTCUSDT');
    assert.strictEqual(markets['BTC/USDT'].precision.price, 0.01);
  });

  it('fetchTicker parses 24hr ticker response', async () => {
    mock.method(exchange, '_request', async () => ({
      symbol: 'BTCUSDT', lastPrice: '30000', highPrice: '31000',
    }));
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.last, 30000);
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
  });

  it('createOrder sends correct params with timeInForce', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { orderId: 'ORD123', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', status: 'NEW' };
    });
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.5, 30000);
    assert.strictEqual(capturedParams.symbol, 'BTCUSDT');
    assert.strictEqual(capturedParams.side, 'BUY');
    assert.strictEqual(capturedParams.type, 'LIMIT');
    assert.strictEqual(capturedParams.quantity, '0.5');
    assert.strictEqual(capturedParams.price, '30000');
    assert.strictEqual(capturedParams.timeInForce, 'GTC');
    assert.strictEqual(order.id, 'ORD123');
  });

  it('createOrder limit without price throws InvalidOrder', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.5),
      InvalidOrder
    );
  });

  it('cancelOrder sends DELETE with orderId', async () => {
    let capturedMethod, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedParams = params;
      return {};
    });
    const result = await exchange.cancelOrder('12345');
    assert.strictEqual(capturedMethod, 'DELETE');
    assert.strictEqual(capturedParams.orderId, '12345');
    assert.strictEqual(result.status, 'canceled');
  });

  it('fetchBalance parses account response', async () => {
    mock.method(exchange, '_request', async () => ({
      balances: [
        { asset: 'BTC', free: '0.5', locked: '0.3' },
        { asset: 'USDT', free: '10000', locked: '5000' },
      ],
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.total, 0.8);
  });

  it('fetchOpenOrders parses orders response', async () => {
    mock.method(exchange, '_request', async () => ([
      { orderId: 'ORD1', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '30000', origQty: '0.5', executedQty: '0', status: 'NEW' },
    ]));
    const orders = await exchange.fetchOpenOrders('BTC/USDT');
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].id, 'ORD1');
    assert.strictEqual(orders[0].status, 'open');
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('Trubit Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Trubit();
    exchange._marketsLoaded = true;
    exchange.markets = {
      'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
    };
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' } };
  });

  it('market() returns correct market', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.id, 'BTCUSDT');
  });

  it('market() throws on unknown symbol', () => {
    assert.throws(() => exchange.market('DOGE/USD'), /unknown symbol/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. Trubit vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('Trubit vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new Trubit({ apiKey: 'k', secret: 's' }); });

  it('identical auth to JBEX: X-BH-APIKEY + hmacSHA256', () => {
    const result = exchange._sign('/openapi/v1/account', 'GET', {});
    assert.strictEqual(result.headers['X-BH-APIKEY'], 'k');
    assert.ok(result.params.signature);
    assert.ok(result.params.timestamp);
  });

  it('different base URL from JBEX', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api-spot.trubit.com');
    const jbex = new lib.Jbex();
    assert.strictEqual(jbex._getBaseUrl(), 'https://www.jbex.com');
  });

  it('same endpoint structure as JBEX (/openapi/v1/*)', async () => {
    let capturedPath;
    mock.method(exchange, '_request', async (method, path) => {
      capturedPath = path;
      return { balances: [] };
    });
    await exchange.fetchBalance();
    assert.strictEqual(capturedPath, '/openapi/v1/account');
  });

  it('supports MXN quote in fallback', () => {
    exchange.marketsById = {};
    assert.strictEqual(exchange._fromTrubitSymbol('BTCMXN'), 'BTC/MXN');
  });

  it('supports both limit and market orders', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.createLimitOrder, true);
    assert.strictEqual(has.createMarketOrder, true);
  });

  it('same Binance error codes as JBEX', () => {
    assert.throws(() => exchange._handleTrubitError('-1002', 'Auth'), AuthenticationError);
    assert.throws(() => exchange._handleTrubitError('-1003', 'Rate'), RateLimitExceeded);
    assert.throws(() => exchange._handleTrubitError('-1121', 'Symbol'), BadSymbol);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA256 for Binance-compatible signing
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA256 for Trubit', () => {
  it('hmacSHA256 produces 64-char hex string', () => {
    const sig = hmacSHA256('test', 'secret');
    assert.strictEqual(sig.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(sig));
  });

  it('hmacSHA256 is deterministic', () => {
    const sig1 = hmacSHA256('symbol=BTCUSDT&timestamp=1700000000000', 'secret');
    const sig2 = hmacSHA256('symbol=BTCUSDT&timestamp=1700000000000', 'secret');
    assert.strictEqual(sig1, sig2);
  });

  it('different data produces different signatures', () => {
    const sig1 = hmacSHA256('symbol=BTCUSDT', 'secret');
    const sig2 = hmacSHA256('symbol=ETHUSDT', 'secret');
    assert.notStrictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — Binance-compatible depth (same as JBEX)
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — Binance-compatible depth', () => {
  let exchange;
  beforeEach(() => { exchange = new Trubit(); });

  it('WS URL includes trubit', () => {
    assert.ok(exchange.describe().urls.ws.includes('trubit'));
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

  it('watchOrderBook subscribes with depth topic', async () => {
    let sentMsg;
    const fakeWs = { readyState: 1, send: (msg) => { sentMsg = msg; }, removeAllListeners: () => {}, on: () => {} };
    const fakeClient = {
      connected: true,
      _ws: fakeWs,
      on: () => {},
      connect: async () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/USDT', () => {});
    const parsed = JSON.parse(sentMsg);
    assert.strictEqual(parsed.symbol, 'BTCUSDT');
    assert.strictEqual(parsed.topic, 'depth');
    assert.strictEqual(parsed.event, 'sub');
    assert.strictEqual(parsed.params.binary, 'false');
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
describe('Trubit WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Trubit(); });

  it('_parseWsOrderBook handles a/b arrays', () => {
    const ob = exchange._parseWsOrderBook({
      a: [['30100', '0.8'], ['30200', '1.2']],
      b: [['29900', '1.5'], ['29800', '2.0']],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseWsOrderBook handles empty data', () => {
    const ob = exchange._parseWsOrderBook({}, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseWsOrderBook includes nonce from v field', () => {
    const ob = exchange._parseWsOrderBook({ a: [], b: [], v: '12345' }, 'BTC/USDT');
    assert.strictEqual(ob.nonce, '12345');
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('Trubit Version', () => {
  it('library version is 2.9.0', () => {
    assert.strictEqual(lib.version, '2.9.0');
  });
});

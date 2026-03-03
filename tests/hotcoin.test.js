'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const HotCoin = require('../lib/hotcoin');
const { hmacSHA256Base64 } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — HotCoin
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — HotCoin', () => {
  it('exports HotCoin class', () => {
    assert.strictEqual(typeof lib.HotCoin, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.hotcoin, lib.HotCoin);
  });

  it('includes hotcoin in exchanges list', () => {
    assert.ok(lib.exchanges.includes('hotcoin'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. HotCoin Constructor
// ═══════════════════════════════════════════════════════════════
describe('HotCoin Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new HotCoin(); });

  it('sets id to hotcoin', () => {
    assert.strictEqual(exchange.describe().id, 'hotcoin');
  });

  it('sets name to HotCoin', () => {
    assert.strictEqual(exchange.describe().name, 'HotCoin');
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

  it('has correct fees (0.2% maker/taker)', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.002);
    assert.strictEqual(fees.taker, 0.002);
  });

  it('stores apiKey from config', () => {
    const ex = new HotCoin({ apiKey: 'mykey' });
    assert.strictEqual(ex.apiKey, 'mykey');
  });

  it('stores secret from config', () => {
    const ex = new HotCoin({ secret: 'mysecret' });
    assert.strictEqual(ex.secret, 'mysecret');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — Huobi-style HMAC-SHA256 → Base64
// ═══════════════════════════════════════════════════════════════
describe('Authentication — Huobi-style HMAC-SHA256 Base64', () => {
  let exchange;
  beforeEach(() => {
    exchange = new HotCoin({ apiKey: 'testkey', secret: 'testsecret' });
  });

  it('throws without apiKey', () => {
    const ex = new HotCoin({ secret: 'testsecret' });
    assert.throws(() => ex._sign('/v1/balance', 'GET', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new HotCoin({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/v1/balance', 'GET', {}), /secret required/);
  });

  it('GET: returns params with AccessKeyId', () => {
    const result = exchange._sign('/v1/balance', 'GET', {});
    assert.strictEqual(result.params.AccessKeyId, 'testkey');
  });

  it('GET: returns params with SignatureMethod=HmacSHA256', () => {
    const result = exchange._sign('/v1/balance', 'GET', {});
    assert.strictEqual(result.params.SignatureMethod, 'HmacSHA256');
  });

  it('GET: returns params with SignatureVersion=2', () => {
    const result = exchange._sign('/v1/balance', 'GET', {});
    assert.strictEqual(result.params.SignatureVersion, '2');
  });

  it('GET: returns params with Timestamp (ISO format)', () => {
    const result = exchange._sign('/v1/balance', 'GET', {});
    assert.ok(result.params.Timestamp);
    assert.ok(result.params.Timestamp.includes('T'));
    assert.ok(result.params.Timestamp.endsWith('Z'));
  });

  it('GET: returns params with Signature', () => {
    const result = exchange._sign('/v1/balance', 'GET', {});
    assert.ok(result.params.Signature);
    assert.ok(result.params.Signature.length > 0);
  });

  it('GET: headers are empty (auth in query string)', () => {
    const result = exchange._sign('/v1/balance', 'GET', {});
    assert.deepStrictEqual(result.headers, {});
  });

  it('POST: returns _authQuery string', () => {
    const result = exchange._sign('/v1/order/place', 'POST', { symbol: 'btc_usdt' });
    assert.ok(result._authQuery);
    assert.ok(result._authQuery.includes('AccessKeyId=testkey'));
    assert.ok(result._authQuery.includes('Signature='));
  });

  it('POST: params contain only trade params (not auth params)', () => {
    const result = exchange._sign('/v1/order/place', 'POST', { symbol: 'btc_usdt' });
    assert.strictEqual(result.params.symbol, 'btc_usdt');
    assert.strictEqual(result.params.AccessKeyId, undefined);
  });

  it('POST: headers are empty (auth in query string)', () => {
    const result = exchange._sign('/v1/order/place', 'POST', { symbol: 'btc_usdt' });
    assert.deepStrictEqual(result.headers, {});
  });

  it('signature is deterministic for same input', () => {
    const origNow = Date.now;
    Date.now = () => 1704067200000;
    try {
      const r1 = exchange._sign('/v1/balance', 'GET', {});
      const r2 = exchange._sign('/v1/balance', 'GET', {});
      assert.strictEqual(r1.params.Signature, r2.params.Signature);
    } finally {
      Date.now = origNow;
    }
  });

  it('works with both apiKey and secret provided', () => {
    const result = exchange._sign('/v1/balance', 'GET', {});
    assert.ok(result.params.Signature);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('HotCoin Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new HotCoin(); });

  it('unwraps data.data envelope', () => {
    const result = exchange._unwrapResponse({ code: '200', data: { id: '123' } });
    assert.strictEqual(result.id, '123');
  });

  it('code !== "200" and !== "0" throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ code: '500', msg: 'Server error' }),
      ExchangeError
    );
  });

  it('code "200" passes through', () => {
    const result = exchange._unwrapResponse({ code: '200', data: [1, 2, 3] });
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('code "0" passes through', () => {
    const result = exchange._unwrapResponse({ code: '0', data: { ok: true } });
    assert.strictEqual(result.ok, true);
  });

  it('array data passes through', () => {
    const arr = [{ symbol: 'btc_usdt' }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('HotCoin Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new HotCoin(); });

  it('_parseTicker extracts all fields', () => {
    const t = exchange._parseTicker({
      last: '30000', high: '31000', low: '29000',
      buy: '29900', sell: '30100', open: '29500',
      vol: '1500', time: 1700000000000,
    }, 'BTC/USDT');
    assert.strictEqual(t.symbol, 'BTC/USDT');
    assert.strictEqual(t.last, 30000);
    assert.strictEqual(t.high, 31000);
    assert.strictEqual(t.low, 29000);
    assert.strictEqual(t.bid, 29900);
    assert.strictEqual(t.ask, 30100);
    assert.strictEqual(t.open, 29500);
    assert.strictEqual(t.volume, 1500);
    assert.strictEqual(t.timestamp, 1700000000000);
  });

  it('_parseOrder extracts id and symbol', () => {
    const o = exchange._parseOrder({ id: 'ORD123', symbol: 'btc_usdt' }, 'BTC/USDT');
    assert.strictEqual(o.id, 'ORD123');
    assert.strictEqual(o.symbol, 'BTC/USDT');
  });

  it('_parseOrder maps side from type field', () => {
    const buy = exchange._parseOrder({ id: '1', type: 'buy' }, 'BTC/USDT');
    assert.strictEqual(buy.side, 'buy');
    const sell = exchange._parseOrder({ id: '2', type: 'sell' }, 'BTC/USDT');
    assert.strictEqual(sell.side, 'sell');
  });

  it('_parseOrder maps matchType to order type', () => {
    const limit = exchange._parseOrder({ id: '1', matchType: '0' }, 'BTC/USDT');
    assert.strictEqual(limit.type, 'limit');
    const market = exchange._parseOrder({ id: '2', matchType: '1' }, 'BTC/USDT');
    assert.strictEqual(market.type, 'market');
  });

  it('_parseOrderStatus maps statuses correctly', () => {
    assert.strictEqual(exchange._parseOrderStatus('0'), 'open');
    assert.strictEqual(exchange._parseOrderStatus('1'), 'open');
    assert.strictEqual(exchange._parseOrderStatus('2'), 'closed');
    assert.strictEqual(exchange._parseOrderStatus('3'), 'canceled');
    assert.strictEqual(exchange._parseOrderStatus('4'), 'expired');
  });

  it('_parseOrderBook handles array entries', () => {
    const ob = exchange._parseOrderBook({
      asks: [['30100', '0.8'], ['30200', '1.2']],
      bids: [['29900', '1.5'], ['29800', '2.0']],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseOrderBook handles empty data', () => {
    const ob = exchange._parseOrderBook({}, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseBalance extracts currency, free, used', () => {
    const b = exchange._parseBalance([
      { symbol: 'btc', normal: '0.5', lock: '0.3' },
      { symbol: 'usdt', normal: '10000', lock: '5000' },
    ]);
    assert.strictEqual(b.BTC.free, 0.5);
    assert.strictEqual(b.BTC.used, 0.3);
    assert.strictEqual(b.BTC.total, 0.8);
    assert.strictEqual(b.USDT.free, 10000);
    assert.strictEqual(b.USDT.used, 5000);
    assert.strictEqual(b.USDT.total, 15000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('HotCoin Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new HotCoin(); });

  it('_toHotCoinSymbol BTC/USDT -> btc_usdt', () => {
    assert.strictEqual(exchange._toHotCoinSymbol('BTC/USDT'), 'btc_usdt');
  });

  it('_toHotCoinSymbol ETH/BTC -> eth_btc', () => {
    assert.strictEqual(exchange._toHotCoinSymbol('ETH/BTC'), 'eth_btc');
  });

  it('_fromHotCoinSymbol btc_usdt -> BTC/USDT', () => {
    assert.strictEqual(exchange._fromHotCoinSymbol('btc_usdt'), 'BTC/USDT');
  });

  it('_fromHotCoinSymbol eth_btc -> ETH/BTC', () => {
    assert.strictEqual(exchange._fromHotCoinSymbol('eth_btc'), 'ETH/BTC');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.hotcoinfin.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('HotCoin Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new HotCoin(); });

  it('insufficient -> InsufficientFunds', () => {
    assert.throws(() => exchange._handleHotCoinError('1001', 'Insufficient balance'), InsufficientFunds);
  });

  it('order not found -> OrderNotFound', () => {
    assert.throws(() => exchange._handleHotCoinError('1002', 'Order not found'), OrderNotFound);
  });

  it('invalid symbol -> BadSymbol', () => {
    assert.throws(() => exchange._handleHotCoinError('1003', 'Invalid symbol'), BadSymbol);
  });

  it('invalid order -> InvalidOrder', () => {
    assert.throws(() => exchange._handleHotCoinError('1004', 'Invalid order amount'), InvalidOrder);
  });

  it('rate limit -> RateLimitExceeded', () => {
    assert.throws(() => exchange._handleHotCoinError('1005', 'Rate limit exceeded'), RateLimitExceeded);
  });

  it('auth -> AuthenticationError', () => {
    assert.throws(() => exchange._handleHotCoinError('1006', 'Authentication failed'), AuthenticationError);
  });

  it('maintenance -> ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handleHotCoinError('1007', 'Under maintenance'), ExchangeNotAvailable);
  });

  it('unknown -> ExchangeError', () => {
    assert.throws(() => exchange._handleHotCoinError('9999', 'Something happened'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('HotCoin HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new HotCoin(); });

  it('400 -> BadRequest', () => {
    assert.throws(() => exchange._handleHttpError(400, 'bad request'), BadRequest);
  });

  it('401 -> AuthenticationError', () => {
    assert.throws(() => exchange._handleHttpError(401, 'unauthorized'), AuthenticationError);
  });

  it('403 -> AuthenticationError', () => {
    assert.throws(() => exchange._handleHttpError(403, 'forbidden'), AuthenticationError);
  });

  it('429 -> RateLimitExceeded', () => {
    assert.throws(() => exchange._handleHttpError(429, 'too many requests'), RateLimitExceeded);
  });

  it('500 -> ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handleHttpError(500, 'server error'), ExchangeNotAvailable);
  });

  it('parses JSON error body', () => {
    const body = JSON.stringify({ code: '1001', msg: 'Insufficient balance' });
    assert.throws(() => exchange._handleHttpError(400, body), InsufficientFunds);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('HotCoin Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new HotCoin();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new HotCoin({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new HotCoin();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 10);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('HotCoin Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new HotCoin({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'btc_usdt', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { 'btc_usdt': { symbol: 'BTC/USDT' } };
  });

  it('loadMarkets parses symbols response', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ({
      code: '200',
      data: [
        { baseCurrency: 'BTC', quoteCurrency: 'USDT', symbol: 'btc_usdt', pricePrecision: 2, amountPrecision: 6 },
        { baseCurrency: 'ETH', quoteCurrency: 'USDT', symbol: 'eth_usdt', pricePrecision: 2, amountPrecision: 4 },
      ],
    }));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.ok(markets['ETH/USDT']);
    assert.strictEqual(markets['BTC/USDT'].id, 'btc_usdt');
    assert.strictEqual(markets['BTC/USDT'].base, 'BTC');
    assert.strictEqual(markets['BTC/USDT'].quote, 'USDT');
  });

  it('fetchTicker parses ticker response', async () => {
    mock.method(exchange, '_request', async () => ({
      code: '200',
      data: { ticker: { last: '30000', high: '31000', low: '29000', buy: '29900', sell: '30100', vol: '1500' } },
    }));
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.last, 30000);
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
  });

  it('fetchOrderBook parses depth response', async () => {
    mock.method(exchange, '_request', async () => ({
      code: '200',
      data: {
        asks: [['30100', '0.8'], ['30200', '1.2']],
        bids: [['29900', '1.5'], ['29800', '2.0']],
      },
    }));
    const ob = await exchange.fetchOrderBook('BTC/USDT');
    assert.strictEqual(ob.symbol, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
  });

  it('createOrder sends correct params', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { code: '200', data: { id: 'ORD123' } };
    });
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.5, 30000);
    assert.strictEqual(capturedParams.symbol, 'btc_usdt');
    assert.strictEqual(capturedParams.type, 'buy');
    assert.strictEqual(capturedParams.tradeAmount, '0.5');
    assert.strictEqual(capturedParams.tradePrice, '30000');
    assert.strictEqual(capturedParams.matchType, '0');
    assert.strictEqual(order.id, 'ORD123');
  });

  it('createOrder market type sets matchType=1', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { code: '200', data: { id: 'ORD456' } };
    });
    await exchange.createOrder('BTC/USDT', 'market', 'buy', 0.5);
    assert.strictEqual(capturedParams.matchType, '1');
  });

  it('cancelOrder sends id', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { code: '200', data: {} };
    });
    const result = await exchange.cancelOrder('12345', 'BTC/USDT');
    assert.strictEqual(capturedParams.id, '12345');
    assert.strictEqual(result.status, 'canceled');
    assert.strictEqual(result.id, '12345');
  });

  it('fetchBalance parses balance response', async () => {
    mock.method(exchange, '_request', async () => ({
      code: '200',
      data: [
        { symbol: 'btc', normal: '0.5', lock: '0.3' },
        { symbol: 'usdt', normal: '10000', lock: '5000' },
      ],
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.total, 0.8);
    assert.strictEqual(balance.USDT.free, 10000);
    assert.strictEqual(balance.USDT.total, 15000);
  });

  it('fetchOpenOrders parses orders response', async () => {
    mock.method(exchange, '_request', async () => ({
      code: '200',
      data: [
        { id: 'ORD1', symbol: 'btc_usdt', type: 'buy', price: '30000', amount: '0.5', leftAmount: '0.3', status: '0' },
        { id: 'ORD2', symbol: 'btc_usdt', type: 'sell', price: '35000', amount: '1.0', leftAmount: '1.0', status: '1' },
      ],
    }));
    const orders = await exchange.fetchOpenOrders('BTC/USDT');
    assert.strictEqual(orders.length, 2);
    assert.strictEqual(orders[0].id, 'ORD1');
    assert.strictEqual(orders[0].status, 'open');
    assert.strictEqual(orders[1].id, 'ORD2');
    assert.strictEqual(orders[1].status, 'open');
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('HotCoin Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new HotCoin();
    exchange._marketsLoaded = true;
    exchange.markets = {
      'BTC/USDT': { id: 'btc_usdt', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
    };
    exchange.marketsById = { 'btc_usdt': { symbol: 'BTC/USDT' } };
  });

  it('market() returns correct market', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.id, 'btc_usdt');
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
// 12. HotCoin vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('HotCoin vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new HotCoin({ apiKey: 'k', secret: 's' }); });

  it('Huobi-style auth: params in query string, NOT headers', () => {
    const result = exchange._sign('/v1/balance', 'GET', {});
    assert.deepStrictEqual(result.headers, {});
    assert.ok(result.params.AccessKeyId);
    assert.ok(result.params.Signature);
  });

  it('lowercase underscore symbol format btc_usdt', () => {
    assert.strictEqual(exchange._toHotCoinSymbol('BTC/USDT'), 'btc_usdt');
    assert.strictEqual(exchange._toHotCoinSymbol('ETH/BTC'), 'eth_btc');
  });

  it('POST: auth in query string, trade params in JSON body', () => {
    const result = exchange._sign('/v1/order/place', 'POST', { symbol: 'btc_usdt', type: 'buy' });
    assert.ok(result._authQuery);
    assert.strictEqual(result.params.symbol, 'btc_usdt');
    assert.strictEqual(result.params.AccessKeyId, undefined);
  });

  it('separate matchType field for limit/market orders', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { code: '200', data: { id: 'ORD1' } };
    });
    await exchange.createOrder('BTC/USDT', 'market', 'buy', 0.5);
    assert.strictEqual(capturedParams.matchType, '1');
  });

  it('supports both limit and market orders', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.createLimitOrder, true);
    assert.strictEqual(has.createMarketOrder, true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA256Base64 for Huobi-style
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA256Base64 for HotCoin', () => {
  it('hmacSHA256Base64 produces non-empty base64 string', () => {
    const sig = hmacSHA256Base64('test', 'secret');
    assert.ok(sig.length > 0);
    // Base64 characters only
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(sig));
  });

  it('hmacSHA256Base64 is deterministic', () => {
    const sig1 = hmacSHA256Base64('GET\napi.hotcoinfin.com\n/v1/balance\nAccessKeyId=test', 'secret');
    const sig2 = hmacSHA256Base64('GET\napi.hotcoinfin.com\n/v1/balance\nAccessKeyId=test', 'secret');
    assert.strictEqual(sig1, sig2);
  });

  it('different data produces different signatures', () => {
    const sig1 = hmacSHA256Base64('GET\nhost\n/path1\nparams', 'secret');
    const sig2 = hmacSHA256Base64('GET\nhost\n/path2\nparams', 'secret');
    assert.notStrictEqual(sig1, sig2);
  });

  it('different secrets produce different signatures', () => {
    const sig1 = hmacSHA256Base64('same_data', 'secret1');
    const sig2 = hmacSHA256Base64('same_data', 'secret2');
    assert.notStrictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — GZIP compressed, Huobi-style sub
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — GZIP compressed, Huobi-style sub', () => {
  let exchange;
  beforeEach(() => { exchange = new HotCoin(); });

  it('WS URL includes hotcoinfin', () => {
    assert.ok(exchange.describe().urls.ws.includes('hotcoinfin'));
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

  it('watchOrderBook subscribes with market.{symbol}.trade.depth', async () => {
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
    assert.strictEqual(parsed.sub, 'market.btc_usdt.trade.depth');
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
describe('HotCoin WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new HotCoin(); });

  it('_parseWsOrderBook handles array entries', () => {
    const ob = exchange._parseWsOrderBook({
      asks: [['30100', '0.8'], ['30200', '1.2']],
      bids: [['29900', '1.5'], ['29800', '2.0']],
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

  it('_parseWsOrderBook includes timestamp', () => {
    const ob = exchange._parseWsOrderBook({ asks: [], bids: [] }, 'BTC/USDT');
    assert.ok(ob.timestamp > 0);
    assert.ok(ob.datetime);
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('HotCoin Version', () => {
  it('library version is 2.9.0', () => {
    assert.strictEqual(lib.version, '2.9.0');
  });
});

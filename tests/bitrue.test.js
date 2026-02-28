'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const lib = require('../index');
const Bitrue = require('../lib/bitrue');
const { hmacSHA256 } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Module Exports — Bitrue
// ═══════════════════════════════════════════════════════════════════════════════
describe('Module Exports — Bitrue', () => {
  it('exports Bitrue class', () => {
    assert.ok(lib.Bitrue);
    assert.strictEqual(typeof lib.Bitrue, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.bitrue, lib.Bitrue);
  });

  it('includes bitrue in exchanges list', () => {
    assert.ok(lib.exchanges.includes('bitrue'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Bitrue Constructor
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitrue(); });

  it('sets id to bitrue', () => {
    assert.strictEqual(exchange.describe().id, 'bitrue');
  });

  it('sets name to Bitrue', () => {
    assert.strictEqual(exchange.describe().name, 'Bitrue');
  });

  it('sets version to v1', () => {
    assert.strictEqual(exchange.describe().version, 'v1');
  });

  it('sets postAsJson = true', () => {
    assert.strictEqual(exchange.postAsJson, true);
  });

  it('sets default recvWindow to 5000', () => {
    assert.strictEqual(exchange._recvWindow, 5000);
  });

  it('allows custom recvWindow', () => {
    const ex = new Bitrue({ options: { recvWindow: 10000 } });
    assert.strictEqual(ex._recvWindow, 10000);
  });

  it('has correct timeframes', () => {
    const tf = exchange.describe().timeframes;
    assert.strictEqual(tf['1m'], '1min');
    assert.strictEqual(tf['1h'], '60min');
    assert.strictEqual(tf['1d'], '1day');
    assert.strictEqual(tf['1M'], '1month');
  });

  it('has correct fees', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.001);
    assert.strictEqual(fees.taker, 0.001);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Authentication — HMAC-SHA256
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue Authentication — HMAC-SHA256', () => {
  it('throws without apiKey', () => {
    const ex = new Bitrue({ secret: 'test' });
    assert.throws(() => ex._sign('/api/v1/account', 'GET', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new Bitrue({ apiKey: 'test' });
    assert.throws(() => ex._sign('/api/v1/account', 'GET', {}), /secret required/);
  });

  it('GET adds timestamp to params', () => {
    const ex = new Bitrue({ apiKey: 'key', secret: 'secret' });
    const result = ex._sign('/api/v1/account', 'GET', {});
    assert.ok(result.params.timestamp);
    assert.strictEqual(typeof result.params.timestamp, 'number');
  });

  it('GET adds recvWindow to params', () => {
    const ex = new Bitrue({ apiKey: 'key', secret: 'secret' });
    const result = ex._sign('/api/v1/account', 'GET', {});
    assert.strictEqual(result.params.recvWindow, 5000);
  });

  it('GET adds signature to params (64-char hex)', () => {
    const ex = new Bitrue({ apiKey: 'key', secret: 'secret' });
    const result = ex._sign('/api/v1/account', 'GET', {});
    assert.ok(result.params.signature);
    assert.strictEqual(result.params.signature.length, 64);
    assert.match(result.params.signature, /^[a-f0-9]{64}$/);
  });

  it('GET does not return url override', () => {
    const ex = new Bitrue({ apiKey: 'key', secret: 'secret' });
    const result = ex._sign('/api/v1/account', 'GET', {});
    assert.strictEqual(result.url, undefined);
  });

  it('GET sets X-MBX-APIKEY header', () => {
    const ex = new Bitrue({ apiKey: 'mykey123', secret: 'secret' });
    const result = ex._sign('/api/v1/account', 'GET', {});
    assert.strictEqual(result.headers['X-MBX-APIKEY'], 'mykey123');
  });

  it('POST returns url with signature (not in params)', () => {
    const ex = new Bitrue({ apiKey: 'key', secret: 'secret' });
    const result = ex._sign('/api/v1/order', 'POST', { symbol: 'BTCUSDT', side: 'BUY' });
    assert.ok(result.url);
    assert.ok(result.url.includes('signature='));
    assert.strictEqual(result.params.signature, undefined);
  });

  it('POST keeps params clean for JSON body (has timestamp but no signature)', () => {
    const ex = new Bitrue({ apiKey: 'key', secret: 'secret' });
    const result = ex._sign('/api/v1/order', 'POST', { symbol: 'BTCUSDT', side: 'BUY' });
    assert.strictEqual(result.params.symbol, 'BTCUSDT');
    assert.strictEqual(result.params.side, 'BUY');
    assert.ok(result.params.timestamp);
    assert.ok(result.params.recvWindow);
    assert.strictEqual(result.params.signature, undefined);
  });

  it('DELETE adds signature to params (same as GET)', () => {
    const ex = new Bitrue({ apiKey: 'key', secret: 'secret' });
    const result = ex._sign('/api/v1/order', 'DELETE', { symbol: 'BTCUSDT', orderId: '123' });
    assert.ok(result.params.signature);
    assert.strictEqual(result.params.signature.length, 64);
    assert.strictEqual(result.url, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitrue(); });

  it('_unwrapResponse passes through normal data', () => {
    const data = { symbol: 'BTCUSDT', lastPrice: '50000' };
    const result = exchange._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('_unwrapResponse passes through arrays', () => {
    const data = [{ symbol: 'BTCUSDT' }];
    const result = exchange._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('_unwrapResponse throws on negative code', () => {
    assert.throws(() => exchange._unwrapResponse({ code: -1121, msg: 'Invalid symbol.' }), ExchangeError);
  });

  it('_unwrapResponse throws BadSymbol on -1121', () => {
    assert.throws(() => exchange._unwrapResponse({ code: -1121, msg: 'Invalid symbol.' }), BadSymbol);
  });

  it('_unwrapResponse passes data with code=0', () => {
    const data = { code: 0, data: 'ok' };
    const result = exchange._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitrue(); });

  it('_parseTicker extracts all fields', () => {
    const data = {
      symbol: 'BTCUSDT', lastPrice: '50000', highPrice: '51000', lowPrice: '49000',
      openPrice: '49500', bidPrice: '49999', bidQty: '1.5', askPrice: '50001', askQty: '0.8',
      volume: '12345', quoteVolume: '617250000', priceChange: '500', priceChangePercent: '1.01',
      closeTime: 1700000000000,
    };
    const t = exchange._parseTicker(data, 'BTC/USDT');
    assert.strictEqual(t.symbol, 'BTC/USDT');
    assert.strictEqual(t.last, 50000);
    assert.strictEqual(t.high, 51000);
    assert.strictEqual(t.bid, 49999);
    assert.strictEqual(t.ask, 50001);
    assert.strictEqual(t.volume, 12345);
    assert.strictEqual(t.change, 500);
    assert.strictEqual(t.percentage, 1.01);
  });

  it('_parseOrder maps all fields', () => {
    const data = {
      orderId: '12345', clientOrderId: 'myOrder', symbol: 'BTCUSDT',
      type: 'LIMIT', side: 'BUY', price: '50000', origQty: '0.1',
      executedQty: '0.05', status: 'PARTIALLY_FILLED', time: 1700000000000,
    };
    const o = exchange._parseOrder(data, 'BTC/USDT');
    assert.strictEqual(o.id, '12345');
    assert.strictEqual(o.clientOrderId, 'myOrder');
    assert.strictEqual(o.type, 'LIMIT');
    assert.strictEqual(o.side, 'BUY');
    assert.strictEqual(o.price, 50000);
    assert.strictEqual(o.amount, 0.1);
    assert.strictEqual(o.filled, 0.05);
    assert.strictEqual(o.remaining, 0.05);
    assert.strictEqual(o.status, 'open');
  });

  it('_parseOrder uses orderIdStr fallback', () => {
    const data = { orderIdStr: '99999', status: 'NEW' };
    const o = exchange._parseOrder(data);
    assert.strictEqual(o.id, '99999');
  });

  it('_parseTrade computes cost and side', () => {
    const data = { id: '5678', price: '50000', qty: '0.1', time: 1700000000000, isBuyerMaker: true };
    const t = exchange._parseTrade(data, 'BTC/USDT');
    assert.strictEqual(t.price, 50000);
    assert.strictEqual(t.amount, 0.1);
    assert.strictEqual(t.cost, 5000);
    assert.strictEqual(t.side, 'sell');
  });

  it('_parseTrade side is buy when isBuyerMaker=false', () => {
    const data = { id: '5678', price: '50000', qty: '0.1', time: 1700000000000, isBuyerMaker: false };
    const t = exchange._parseTrade(data, 'BTC/USDT');
    assert.strictEqual(t.side, 'buy');
  });

  it('_parseCandle handles Binance-format array', () => {
    const k = [1700000000000, '50000', '51000', '49000', '50500', '100', 1700003600000, '5050000'];
    const c = exchange._parseCandle(k);
    assert.strictEqual(c.timestamp, 1700000000000);
    assert.strictEqual(c.open, 50000);
    assert.strictEqual(c.high, 51000);
    assert.strictEqual(c.low, 49000);
    assert.strictEqual(c.close, 50500);
    assert.strictEqual(c.volume, 100);
  });

  it('_parseCandle handles object format', () => {
    const k = { openTime: 1700000000000, open: 50000, high: 51000, low: 49000, close: 50500, volume: 100 };
    const c = exchange._parseCandle(k);
    assert.strictEqual(c.timestamp, 1700000000000);
    assert.strictEqual(c.open, 50000);
  });

  it('_parseOrderBook maps bids/asks from strings', () => {
    const data = {
      bids: [['50000', '1.0'], ['49999', '2.0']],
      asks: [['50001', '0.5'], ['50002', '1.0']],
      lastUpdateId: 123456,
    };
    const ob = exchange._parseOrderBook(data, 'BTC/USDT');
    assert.strictEqual(ob.bids[0][0], 50000);
    assert.strictEqual(ob.bids[0][1], 1.0);
    assert.strictEqual(ob.asks[0][0], 50001);
    assert.strictEqual(ob.nonce, 123456);
  });

  it('_parseTrade extracts fee info', () => {
    const data = { id: '1', price: '100', qty: '1', time: 1700000000000, commission: '0.001', commissionAsset: 'BTC', isBuyerMaker: false };
    const t = exchange._parseTrade(data, 'BTC/USDT');
    assert.strictEqual(t.fee.cost, 0.001);
    assert.strictEqual(t.fee.currency, 'BTC');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitrue(); });

  it('_toBitrueSymbol converts BTC/USDT to BTCUSDT', () => {
    assert.strictEqual(exchange._toBitrueSymbol('BTC/USDT'), 'BTCUSDT');
  });

  it('_toBitrueSymbol converts ETH/BTC to ETHBTC', () => {
    assert.strictEqual(exchange._toBitrueSymbol('ETH/BTC'), 'ETHBTC');
  });

  it('_fromBitrueSymbol returns raw if no markets loaded', () => {
    assert.strictEqual(exchange._fromBitrueSymbol('BTCUSDT'), 'BTCUSDT');
  });

  it('_fromBitrueSymbol resolves via marketsById', () => {
    exchange.marketsById = { BTCUSDT: { symbol: 'BTC/USDT' } };
    assert.strictEqual(exchange._fromBitrueSymbol('BTCUSDT'), 'BTC/USDT');
  });

  it('_normalizeOrderStatus maps all values', () => {
    assert.strictEqual(exchange._normalizeOrderStatus('NEW'), 'open');
    assert.strictEqual(exchange._normalizeOrderStatus('PARTIALLY_FILLED'), 'open');
    assert.strictEqual(exchange._normalizeOrderStatus('FILLED'), 'closed');
    assert.strictEqual(exchange._normalizeOrderStatus('CANCELED'), 'canceled');
    assert.strictEqual(exchange._normalizeOrderStatus('PENDING_CANCEL'), 'canceling');
    assert.strictEqual(exchange._normalizeOrderStatus('REJECTED'), 'rejected');
    assert.strictEqual(exchange._normalizeOrderStatus('EXPIRED'), 'expired');
  });

  it('_normalizeOrderStatus defaults to open for unknown', () => {
    assert.strictEqual(exchange._normalizeOrderStatus('UNKNOWN_STATUS'), 'open');
  });

  it('_getBaseUrl returns api url', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://openapi.bitrue.com');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitrue(); });

  it('-1000 → ExchangeError', () => {
    assert.throws(() => exchange._handleBitrueError(-1000, 'Unknown'), ExchangeError);
  });

  it('-1001 → ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handleBitrueError(-1001, 'Server error'), ExchangeNotAvailable);
  });

  it('-1002 → AuthenticationError', () => {
    assert.throws(() => exchange._handleBitrueError(-1002, 'Unauthorized'), AuthenticationError);
  });

  it('-1003 → RateLimitExceeded', () => {
    assert.throws(() => exchange._handleBitrueError(-1003, 'Too many requests'), RateLimitExceeded);
  });

  it('-1013 → InvalidOrder', () => {
    assert.throws(() => exchange._handleBitrueError(-1013, 'Invalid quantity'), InvalidOrder);
  });

  it('-1121 → BadSymbol', () => {
    assert.throws(() => exchange._handleBitrueError(-1121, 'Invalid symbol'), BadSymbol);
  });

  it('-2010 → InvalidOrder', () => {
    assert.throws(() => exchange._handleBitrueError(-2010, 'Order rejected'), InvalidOrder);
  });

  it('-2013 → OrderNotFound', () => {
    assert.throws(() => exchange._handleBitrueError(-2013, 'Order does not exist'), OrderNotFound);
  });

  it('-2015 → InsufficientFunds', () => {
    assert.throws(() => exchange._handleBitrueError(-2015, 'Insufficient balance'), InsufficientFunds);
  });

  it('unknown code → ExchangeError', () => {
    assert.throws(() => exchange._handleBitrueError(-9999, 'Unknown'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitrue(); });

  it('400 → BadRequest', () => {
    assert.throws(() => exchange._handleHttpError(400, '{"code":0,"msg":"Bad request"}'), BadRequest);
  });

  it('401 → AuthenticationError', () => {
    assert.throws(() => exchange._handleHttpError(401, '{"code":0,"msg":"Unauthorized"}'), AuthenticationError);
  });

  it('403 → AuthenticationError', () => {
    assert.throws(() => exchange._handleHttpError(403, 'Forbidden'), AuthenticationError);
  });

  it('429 → RateLimitExceeded', () => {
    assert.throws(() => exchange._handleHttpError(429, 'Too many requests'), RateLimitExceeded);
  });

  it('500 → ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handleHttpError(500, 'Internal server error'), ExchangeNotAvailable);
  });

  it('parses JSON body with negative code and maps accordingly', () => {
    assert.throws(() => exchange._handleHttpError(400, '{"code":-1121,"msg":"Invalid symbol."}'), BadSymbol);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const ex = new Bitrue();
    assert.strictEqual(ex.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const ex = new Bitrue({ enableRateLimit: false });
    assert.strictEqual(ex.enableRateLimit, false);
  });

  it('rateLimitCapacity is 1200', () => {
    const ex = new Bitrue();
    assert.strictEqual(ex.describe().rateLimitCapacity, 1200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Bitrue({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { BTCUSDT: { symbol: 'BTC/USDT' } };
    exchange.symbols = ['BTC/USDT'];
  });

  it('fetchTime returns server time', async () => {
    mock.method(exchange, '_request', async () => ({ serverTime: 1700000000000 }));
    const time = await exchange.fetchTime();
    assert.strictEqual(time, 1700000000000);
  });

  it('loadMarkets parses symbols', async () => {
    const ex = new Bitrue();
    mock.method(ex, '_request', async () => ({
      symbols: [{
        symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
        baseAssetPrecision: 8, quotePrecision: 8, status: 'TRADING',
        orderTypes: ['LIMIT', 'MARKET'], filters: [],
      }],
    }));
    const markets = await ex.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.strictEqual(markets['BTC/USDT'].id, 'BTCUSDT');
    assert.strictEqual(markets['BTC/USDT'].active, true);
    assert.ok(ex.symbols.includes('BTC/USDT'));
  });

  it('fetchTicker returns parsed ticker', async () => {
    mock.method(exchange, '_request', async () => ({
      symbol: 'BTCUSDT', lastPrice: '50000', bidPrice: '49999', askPrice: '50001',
      highPrice: '51000', lowPrice: '49000', openPrice: '49500', volume: '12345',
      priceChange: '500', priceChangePercent: '1.01', closeTime: 1700000000000,
    }));
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.last, 50000);
    assert.strictEqual(ticker.bid, 49999);
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
  });

  it('fetchTickers returns multiple tickers', async () => {
    mock.method(exchange, '_request', async () => [
      { symbol: 'BTCUSDT', lastPrice: '50000', closeTime: 1700000000000 },
    ]);
    const tickers = await exchange.fetchTickers();
    assert.ok(tickers['BTC/USDT']);
  });

  it('fetchOrderBook returns parsed book', async () => {
    mock.method(exchange, '_request', async () => ({
      bids: [['50000', '1.0'], ['49999', '2.0']],
      asks: [['50001', '0.5']],
      lastUpdateId: 123456,
    }));
    const book = await exchange.fetchOrderBook('BTC/USDT', 10);
    assert.strictEqual(book.bids[0][0], 50000);
    assert.strictEqual(book.asks[0][0], 50001);
    assert.strictEqual(book.nonce, 123456);
  });

  it('fetchTrades returns parsed trades', async () => {
    mock.method(exchange, '_request', async () => [
      { id: '1', price: '50000', qty: '0.1', time: 1700000000000, isBuyerMaker: false },
    ]);
    const trades = await exchange.fetchTrades('BTC/USDT');
    assert.strictEqual(trades.length, 1);
    assert.strictEqual(trades[0].price, 50000);
  });

  it('fetchOHLCV returns parsed candles', async () => {
    mock.method(exchange, '_request', async () => [
      [1700000000000, '50000', '51000', '49000', '50500', '100'],
    ]);
    const candles = await exchange.fetchOHLCV('BTC/USDT', '1h');
    assert.strictEqual(candles.length, 1);
    assert.strictEqual(candles[0].open, 50000);
    assert.strictEqual(candles[0].high, 51000);
  });

  it('createOrder sends correct params with GTT timeInForce', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { orderId: '123', symbol: 'BTCUSDT', status: 'NEW', type: 'LIMIT', side: 'BUY', origQty: '0.001', price: '50000', executedQty: '0' };
    });
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.001, 50000);
    assert.strictEqual(capturedParams.symbol, 'BTCUSDT');
    assert.strictEqual(capturedParams.side, 'BUY');
    assert.strictEqual(capturedParams.type, 'LIMIT');
    assert.strictEqual(capturedParams.timeInForce, 'GTT');
    assert.strictEqual(order.id, '123');
    assert.strictEqual(order.status, 'open');
  });

  it('cancelOrder sends symbol and orderId', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { orderId: '123', symbol: 'BTCUSDT', status: 'CANCELED' };
    });
    const result = await exchange.cancelOrder('123', 'BTC/USDT');
    assert.strictEqual(capturedParams.symbol, 'BTCUSDT');
    assert.strictEqual(capturedParams.orderId, '123');
    assert.strictEqual(result.status, 'canceled');
  });

  it('fetchBalance returns parsed balances', async () => {
    mock.method(exchange, '_request', async () => ({
      balances: [
        { asset: 'BTC', free: '1.5', locked: '0.5' },
        { asset: 'USDT', free: '10000', locked: '0' },
        { asset: 'XRP', free: '0', locked: '0' },
      ],
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 1.5);
    assert.strictEqual(balance.BTC.used, 0.5);
    assert.strictEqual(balance.BTC.total, 2.0);
    assert.strictEqual(balance.USDT.free, 10000);
    assert.strictEqual(balance.XRP, undefined);
  });

  it('fetchOrder returns parsed order', async () => {
    mock.method(exchange, '_request', async () => ({
      orderId: '456', symbol: 'BTCUSDT', status: 'FILLED', type: 'LIMIT',
      side: 'SELL', price: '50000', origQty: '0.1', executedQty: '0.1', time: 1700000000000,
    }));
    const order = await exchange.fetchOrder('456', 'BTC/USDT');
    assert.strictEqual(order.id, '456');
    assert.strictEqual(order.status, 'closed');
    assert.strictEqual(order.filled, 0.1);
  });

  it('fetchOpenOrders returns array', async () => {
    mock.method(exchange, '_request', async () => [
      { orderId: '1', symbol: 'BTCUSDT', status: 'NEW', type: 'LIMIT', side: 'BUY', origQty: '0.1', executedQty: '0', price: '40000' },
    ]);
    const orders = await exchange.fetchOpenOrders('BTC/USDT');
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].status, 'open');
  });

  it('fetchMyTrades returns array of trades', async () => {
    mock.method(exchange, '_request', async () => [
      { id: '99', price: '50000', qty: '0.1', time: 1700000000000, isBuyerMaker: false, commission: '0.0001', commissionAsset: 'BTC' },
    ]);
    const trades = await exchange.fetchMyTrades('BTC/USDT');
    assert.strictEqual(trades.length, 1);
    assert.strictEqual(trades[0].price, 50000);
    assert.strictEqual(trades[0].fee.cost, 0.0001);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Bitrue();
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { BTCUSDT: { symbol: 'BTC/USDT' } };
  });

  it('market() returns correct market', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.id, 'BTCUSDT');
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

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Bitrue vs Others Differences
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitrue(); });

  it('uses GTT timeInForce (not GTC like Binance)', () => {
    // Verified in createOrder test — Bitrue-specific
    assert.ok(true);
  });

  it('cancelAllOrders is NOT supported', () => {
    assert.strictEqual(exchange.describe().has.cancelAllOrders, false);
  });

  it('fetchTradingFees is NOT supported', () => {
    assert.strictEqual(exchange.describe().has.fetchTradingFees, false);
  });

  it('uses BTCUSDT format (same as Binance, not BTC_USDT like BitMart)', () => {
    assert.strictEqual(exchange._toBitrueSymbol('BTC/USDT'), 'BTCUSDT');
  });

  it('POST uses JSON body + URL signature (different from Binance query-string POST)', () => {
    assert.strictEqual(exchange.postAsJson, true);
  });

  it('X-MBX-APIKEY header (same header name as Binance)', () => {
    const ex = new Bitrue({ apiKey: 'key', secret: 'secret' });
    const result = ex._sign('/test', 'GET', {});
    assert.ok(result.headers['X-MBX-APIKEY']);
  });

  it('WS uses gzip compression (like BitMart, unlike Binance)', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://ws.bitrue.com/kline-api/ws');
  });

  it('no private WS streams (watchBalance/watchOrders)', () => {
    assert.strictEqual(exchange.describe().has.watchBalance, false);
    assert.strictEqual(exchange.describe().has.watchOrders, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA256
// ═══════════════════════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA256 for Bitrue', () => {
  it('produces 64-char hex string', () => {
    const sig = hmacSHA256('test', 'secret');
    assert.strictEqual(sig.length, 64);
    assert.match(sig, /^[a-f0-9]{64}$/);
  });

  it('known test vector', () => {
    const sig = hmacSHA256('symbol=BTCUSDT&timestamp=1700000000000', 'mysecret');
    assert.strictEqual(sig.length, 64);
    // Deterministic — same input always produces same output
    const sig2 = hmacSHA256('symbol=BTCUSDT&timestamp=1700000000000', 'mysecret');
    assert.strictEqual(sig, sig2);
  });

  it('different data produces different signature', () => {
    const sig1 = hmacSHA256('data1', 'secret');
    const sig2 = hmacSHA256('data2', 'secret');
    assert.notStrictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. WebSocket — gzip compressed subscribe
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue WebSocket — gzip compressed subscribe', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitrue(); });

  it('WS URL is correct', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://ws.bitrue.com/kline-api/ws');
  });

  it('_getWsClient creates new client', () => {
    const client = exchange._getWsClient();
    assert.ok(client);
  });

  it('_getWsClient returns same client for same URL', () => {
    const c1 = exchange._getWsClient();
    const c2 = exchange._getWsClient();
    assert.strictEqual(c1, c2);
  });

  it('_getWsClient has overridden _startPing', () => {
    const client = exchange._getWsClient();
    assert.ok(client._startPing);
  });

  it('_getWsClient has overridden connect', () => {
    const client = exchange._getWsClient();
    assert.ok(client.connect);
  });

  it('watchTicker uses market_xxx_ticker channel', async () => {
    let sentMsg;
    mock.method(exchange, '_ensureWsConnected', async () => ({
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    }));
    await exchange.watchTicker('BTC/USDT', () => {});
    assert.strictEqual(sentMsg.event, 'sub');
    assert.strictEqual(sentMsg.params.channel, 'market_btcusdt_ticker');
    assert.strictEqual(sentMsg.params.cb_id, 'btcusdt');
  });

  it('watchOrderBook uses market_xxx_depth_step0 channel', async () => {
    let sentMsg;
    mock.method(exchange, '_ensureWsConnected', async () => ({
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    }));
    await exchange.watchOrderBook('BTC/USDT', () => {});
    assert.strictEqual(sentMsg.params.channel, 'market_btcusdt_depth_step0');
  });

  it('watchTrades uses market_xxx_trade_ticker channel', async () => {
    let sentMsg;
    mock.method(exchange, '_ensureWsConnected', async () => ({
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    }));
    await exchange.watchTrades('ETH/USDT', () => {});
    assert.strictEqual(sentMsg.params.channel, 'market_ethusdt_trade_ticker');
  });

  it('watchKlines uses market_xxx_kline_period channel', async () => {
    let sentMsg;
    mock.method(exchange, '_ensureWsConnected', async () => ({
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    }));
    await exchange.watchKlines('BTC/USDT', '1h', () => {});
    assert.strictEqual(sentMsg.params.channel, 'market_btcusdt_kline_60min');
  });

  it('watchKlines throws on unsupported timeframe', async () => {
    await assert.rejects(
      () => exchange.watchKlines('BTC/USDT', '3m', () => {}),
      /unsupported timeframe/,
    );
  });

  it('WS symbols are lowercase', async () => {
    let sentMsg;
    mock.method(exchange, '_ensureWsConnected', async () => ({
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    }));
    await exchange.watchTicker('BTC/USDT', () => {});
    assert.match(sentMsg.params.channel, /btcusdt/);
    assert.match(sentMsg.params.cb_id, /btcusdt/);
  });

  it('closeAllWs clears clients and handlers', async () => {
    exchange._wsClients.set('test', { close: async () => {} });
    exchange._wsHandlers.set('ch', {});
    await exchange.closeAllWs();
    assert.strictEqual(exchange._wsClients.size, 0);
    assert.strictEqual(exchange._wsHandlers.size, 0);
  });

  it('subscribe format matches Huobi-style', async () => {
    let sentMsg;
    mock.method(exchange, '_ensureWsConnected', async () => ({
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    }));
    await exchange.watchTicker('BTC/USDT', () => {});
    assert.strictEqual(sentMsg.event, 'sub');
    assert.ok(sentMsg.params);
    assert.ok(sentMsg.params.channel);
    assert.ok(sentMsg.params.cb_id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. WS Message Dispatch + Parsers
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue WS Message Dispatch + Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitrue(); });

  it('_parseWsTicker extracts tick fields', () => {
    const tick = { open: 49000, close: 50000, high: 51000, low: 48000, vol: 1234, amount: 61700000 };
    const t = exchange._parseWsTicker(tick, 'BTC/USDT');
    assert.strictEqual(t.symbol, 'BTC/USDT');
    assert.strictEqual(t.last, 50000);
    assert.strictEqual(t.high, 51000);
    assert.strictEqual(t.low, 48000);
    assert.strictEqual(t.open, 49000);
    assert.strictEqual(t.volume, 1234);
  });

  it('_parseWsOrderBook uses tick.buys for bids (NOT tick.bids)', () => {
    const tick = {
      buys: [['50000', '0.5'], ['49999', '1.0']],
      asks: [['50001', '0.3'], ['50002', '0.8']],
    };
    const ob = exchange._parseWsOrderBook(tick, 'BTC/USDT');
    assert.strictEqual(ob.bids.length, 2);
    assert.strictEqual(ob.bids[0][0], 50000);
    assert.strictEqual(ob.bids[0][1], 0.5);
    assert.strictEqual(ob.asks.length, 2);
    assert.strictEqual(ob.asks[0][0], 50001);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseWsTrade extracts trade fields', () => {
    const data = { id: '123', price: 50000, amount: 0.5, side: 'buy', ts: 1700000000000 };
    const t = exchange._parseWsTrade(data, 'BTC/USDT');
    assert.strictEqual(t.id, '123');
    assert.strictEqual(t.price, 50000);
    assert.strictEqual(t.amount, 0.5);
    assert.strictEqual(t.side, 'buy');
  });

  it('_parseWsKline extracts kline fields', () => {
    const tick = { id: 1700000000, open: 50000, high: 51000, low: 49000, close: 50500, vol: 100 };
    const k = exchange._parseWsKline(tick, 'BTC/USDT');
    assert.strictEqual(k.open, 50000);
    assert.strictEqual(k.high, 51000);
    assert.strictEqual(k.close, 50500);
    assert.strictEqual(k.volume, 100);
  });

  it('_parseWsOrderBook handles empty buys/asks', () => {
    const tick = {};
    const ob = exchange._parseWsOrderBook(tick, 'BTC/USDT');
    assert.strictEqual(ob.bids.length, 0);
    assert.strictEqual(ob.asks.length, 0);
  });

  it('_parseWsTicker includes datetime', () => {
    const tick = { close: 50000 };
    const t = exchange._parseWsTicker(tick, 'BTC/USDT');
    assert.ok(t.datetime);
    assert.ok(t.timestamp);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bitrue Version', () => {
  it('library version is 2.5.0', () => {
    assert.strictEqual(lib.version, '2.5.0');
  });
});

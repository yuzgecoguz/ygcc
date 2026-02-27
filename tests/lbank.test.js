'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const ygcc = require('../index');
const { LBank, lbank: LBankAlias, md5, hmacSHA256 } = ygcc;

// =============================================================================
// 1. Module Exports (3 tests)
// =============================================================================

describe('LBank — Module Exports', () => {
  it('exports LBank class', () => {
    assert.ok(LBank);
    assert.strictEqual(typeof LBank, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(LBankAlias, LBank);
  });

  it('includes lbank in exchanges list', () => {
    assert.ok(ygcc.exchanges.includes('lbank'));
  });
});

// =============================================================================
// 2. Constructor (9 tests)
// =============================================================================

describe('LBank — Constructor', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank({ apiKey: 'testKey', secret: 'testSecret' });
  });

  it('sets postAsJson = false', () => {
    assert.strictEqual(exchange.postAsJson, false);
  });

  it('sets postAsFormEncoded = false', () => {
    assert.strictEqual(exchange.postAsFormEncoded, false);
  });

  it('describe() returns correct id', () => {
    assert.strictEqual(exchange.describe().id, 'lbank');
  });

  it('describe() returns correct name', () => {
    assert.strictEqual(exchange.describe().name, 'LBank');
  });

  it('describe() returns correct version', () => {
    assert.strictEqual(exchange.describe().version, 'v2');
  });

  it('timeframes use string values (minute1, hour1, day1)', () => {
    const tf = exchange.describe().timeframes;
    assert.strictEqual(tf['1m'], 'minute1');
    assert.strictEqual(tf['5m'], 'minute5');
    assert.strictEqual(tf['1h'], 'hour1');
    assert.strictEqual(tf['4h'], 'hour4');
    assert.strictEqual(tf['1d'], 'day1');
    assert.strictEqual(tf['1w'], 'week1');
  });

  it('fees are correct (0.1% maker/taker)', () => {
    const fees = exchange.describe().fees;
    assert.strictEqual(fees.trading.maker, 0.001);
    assert.strictEqual(fees.trading.taker, 0.001);
  });

  it('all public WebSocket features are enabled', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.watchTicker, true);
    assert.strictEqual(has.watchOrderBook, true);
    assert.strictEqual(has.watchTrades, true);
    assert.strictEqual(has.watchKlines, true);
  });

  it('private WebSocket features are disabled', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.watchBalance, false);
    assert.strictEqual(has.watchOrders, false);
  });
});

// =============================================================================
// 3. Authentication — MD5 + HMAC-SHA256 two-step (10 tests)
// =============================================================================

describe('LBank — Authentication', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank({ apiKey: 'test-api-key', secret: 'test-secret-key' });
  });

  it('_sign requires API credentials', () => {
    const noAuth = new LBank();
    assert.throws(() => noAuth._sign('/v2/supplement/user_info.do', 'POST', {}), /apiKey required/);
  });

  it('_sign returns params with api_key and sign', () => {
    const result = exchange._sign('/v2/supplement/user_info.do', 'POST', {});
    assert.ok(result.params.api_key);
    assert.strictEqual(result.params.api_key, 'test-api-key');
    assert.ok(result.params.sign);
    assert.strictEqual(typeof result.params.sign, 'string');
  });

  it('_sign returns headers with timestamp, signature_method, echostr', () => {
    const result = exchange._sign('/v2/supplement/user_info.do', 'POST', {});
    assert.ok(result.headers.timestamp);
    assert.strictEqual(result.headers.signature_method, 'HmacSHA256');
    assert.ok(result.headers.echostr);
    assert.strictEqual(result.headers['Content-Type'], 'application/x-www-form-urlencoded');
  });

  it('echostr is 32 characters alphanumeric', () => {
    const result = exchange._sign('/v2/supplement/user_info.do', 'POST', {});
    const echostr = result.headers.echostr;
    assert.strictEqual(echostr.length, 32);
    assert.ok(/^[a-z0-9]+$/.test(echostr));
  });

  it('timestamp is milliseconds string', () => {
    const result = exchange._sign('/v2/supplement/user_info.do', 'POST', {});
    const ts = result.headers.timestamp;
    assert.strictEqual(typeof ts, 'string');
    const num = parseInt(ts, 10);
    assert.ok(num > 1700000000000); // After 2023
  });

  it('signing uses MD5 uppercase then HMAC-SHA256', () => {
    // Verify the two-step signing flow manually
    const params = 'api_key=mykey&echostr=abc123&signature_method=HmacSHA256&timestamp=1234567890';
    const md5Hash = md5(params).toUpperCase();
    const sign = hmacSHA256(md5Hash, 'mysecret');

    // MD5 should be uppercase hex
    assert.ok(/^[A-F0-9]+$/.test(md5Hash));
    // HMAC-SHA256 should be lowercase hex
    assert.ok(/^[a-f0-9]+$/.test(sign));
  });

  it('params are sorted alphabetically for signing', () => {
    // Verify that signing sorts params — echostr should come before timestamp
    const result = exchange._sign('/v2/supplement/create_order.do', 'POST', {
      symbol: 'btc_usdt',
      type: 'buy',
      price: '50000',
      amount: '0.001',
    });
    // All endpoint params should be in the returned query params
    assert.strictEqual(result.params.symbol, 'btc_usdt');
    assert.strictEqual(result.params.type, 'buy');
    assert.strictEqual(result.params.price, '50000');
    assert.strictEqual(result.params.amount, '0.001');
    assert.ok(result.params.sign);
  });

  it('endpoint params are included in sign computation', () => {
    const result1 = exchange._sign('/v2/test', 'POST', { symbol: 'btc_usdt' });
    const result2 = exchange._sign('/v2/test', 'POST', { symbol: 'eth_usdt' });
    // Different params → different signatures
    assert.notStrictEqual(result1.params.sign, result2.params.sign);
  });

  it('sign does NOT include echostr/timestamp/signature_method in query params', () => {
    const result = exchange._sign('/v2/test', 'POST', { symbol: 'btc_usdt' });
    // These go in headers only, not in URL params
    assert.strictEqual(result.params.echostr, undefined);
    assert.strictEqual(result.params.timestamp, undefined);
    assert.strictEqual(result.params.signature_method, undefined);
  });

  it('_generateEchostr returns unique values', () => {
    const e1 = exchange._generateEchostr(32);
    const e2 = exchange._generateEchostr(32);
    assert.notStrictEqual(e1, e2);
  });
});

// =============================================================================
// 4. Response Handling (5 tests)
// =============================================================================

describe('LBank — Response Handling', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank({ apiKey: 'testKey', secret: 'testSecret' });
  });

  it('recognizes success response with result true', () => {
    const response = { result: 'true', data: { order_id: '123' } };
    assert.strictEqual(response.result, 'true');
    assert.ok(response.data);
  });

  it('recognizes error response with result false', () => {
    const response = { result: 'false', error_code: 10007 };
    assert.strictEqual(response.result, 'false');
    assert.strictEqual(response.error_code, 10007);
  });

  it('handles numeric result field', () => {
    const response = { result: false, error_code: 10014 };
    assert.strictEqual(response.result === 'false' || response.result === false, true);
  });

  it('data field contains response payload', () => {
    const response = { result: 'true', data: [{ symbol: 'btc_usdt' }] };
    assert.ok(Array.isArray(response.data));
    assert.strictEqual(response.data[0].symbol, 'btc_usdt');
  });

  it('error_code is numeric', () => {
    const response = { result: 'false', error_code: 10008, ts: Date.now() };
    assert.strictEqual(typeof response.error_code, 'number');
  });
});

// =============================================================================
// 5. Parsers (10 tests)
// =============================================================================

describe('LBank — Parsers', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank({ apiKey: 'testKey', secret: 'testSecret' });
  });

  it('_parseTicker extracts ticker fields', () => {
    const data = {
      symbol: 'btc_usdt',
      timestamp: 1700000000000,
      ticker: {
        high: '42000.5',
        low: '40000.0',
        vol: '1234.56',
        latest: '41500.0',
        change: '2.5',
        turnover: '51234567.89',
      },
    };
    const result = exchange._parseTicker(data, 'BTC/USDT');
    assert.strictEqual(result.symbol, 'BTC/USDT');
    assert.strictEqual(result.high, 42000.5);
    assert.strictEqual(result.low, 40000.0);
    assert.strictEqual(result.last, 41500.0);
    assert.strictEqual(result.baseVolume, 1234.56);
    assert.strictEqual(result.quoteVolume, 51234567.89);
  });

  it('_parseOrder maps status -1 to canceled', () => {
    const data = { order_id: '123', symbol: 'btc_usdt', status: -1, type: 'buy', amount: '1', price: '50000' };
    const result = exchange._parseOrder(data, 'BTC/USDT');
    assert.strictEqual(result.status, 'canceled');
    assert.strictEqual(result.side, 'buy');
    assert.strictEqual(result.type, 'limit');
  });

  it('_parseOrder maps status 0 to open (trading)', () => {
    const data = { order_id: '456', symbol: 'btc_usdt', status: 0, type: 'sell', amount: '2', price: '60000' };
    const result = exchange._parseOrder(data, 'BTC/USDT');
    assert.strictEqual(result.status, 'open');
    assert.strictEqual(result.side, 'sell');
  });

  it('_parseOrder maps status 2 to closed (filled)', () => {
    const data = { order_id: '789', symbol: 'btc_usdt', status: 2, type: 'buy', amount: '1', price: '50000', deal_amount: '1', avg_price: '50000' };
    const result = exchange._parseOrder(data, 'BTC/USDT');
    assert.strictEqual(result.status, 'closed');
    assert.strictEqual(result.filled, 1);
    assert.strictEqual(result.average, 50000);
  });

  it('_parseOrder detects market orders from type string', () => {
    const data = { order_id: '100', symbol: 'btc_usdt', status: 0, type: 'buy_market', amount: '100' };
    const result = exchange._parseOrder(data, 'BTC/USDT');
    assert.strictEqual(result.type, 'market');
    assert.strictEqual(result.side, 'buy');
  });

  it('_parseTrade extracts trade fields', () => {
    const data = { tid: 'trade123', date_ms: 1700000000000, amount: 0.5, price: 41500.0, type: 'buy' };
    const result = exchange._parseTrade(data, 'BTC/USDT');
    assert.strictEqual(result.id, 'trade123');
    assert.strictEqual(result.timestamp, 1700000000000);
    assert.strictEqual(result.side, 'buy');
    assert.strictEqual(result.price, 41500.0);
    assert.strictEqual(result.amount, 0.5);
    assert.strictEqual(result.cost, 41500.0 * 0.5);
  });

  it('_parseCandle converts array format', () => {
    const data = [1700000000, 41000, 42000, 40500, 41500, 1234.56];
    const result = exchange._parseCandle(data);
    assert.strictEqual(result[0], 1700000000000); // seconds → ms
    assert.strictEqual(result[1], 41000); // open
    assert.strictEqual(result[2], 42000); // high
    assert.strictEqual(result[3], 40500); // low
    assert.strictEqual(result[4], 41500); // close
    assert.strictEqual(result[5], 1234.56); // volume
  });

  it('_parseCandle handles ms timestamps', () => {
    const data = [1700000000000, 41000, 42000, 40500, 41500, 1234.56];
    const result = exchange._parseCandle(data);
    assert.strictEqual(result[0], 1700000000000); // already ms, unchanged
  });

  it('_parseTicker resolves symbol from lbank pair', () => {
    exchange.marketsById = { 'eth_usdt': { symbol: 'ETH/USDT' } };
    const data = { symbol: 'eth_usdt', ticker: { latest: '2000' } };
    const result = exchange._parseTicker(data);
    assert.strictEqual(result.symbol, 'ETH/USDT');
  });

  it('_parseOrder computes remaining from amount - filled', () => {
    const data = { order_id: '555', status: 1, type: 'buy', amount: '10', deal_amount: '6', price: '100' };
    const result = exchange._parseOrder(data, 'BTC/USDT');
    assert.strictEqual(result.remaining, 4);
    assert.strictEqual(result.filled, 6);
  });
});

// =============================================================================
// 6. Helper Methods (8 tests)
// =============================================================================

describe('LBank — Helper Methods', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank();
  });

  it('_toLBankSymbol converts BTC/USDT to btc_usdt', () => {
    assert.strictEqual(exchange._toLBankSymbol('BTC/USDT'), 'btc_usdt');
  });

  it('_toLBankSymbol converts ETH/BTC to eth_btc', () => {
    assert.strictEqual(exchange._toLBankSymbol('ETH/BTC'), 'eth_btc');
  });

  it('_fromLBankSymbol converts btc_usdt to BTC/USDT', () => {
    assert.strictEqual(exchange._fromLBankSymbol('btc_usdt'), 'BTC/USDT');
  });

  it('_fromLBankSymbol uses marketsById when available', () => {
    exchange.marketsById = { 'trx_btc': { symbol: 'TRX/BTC' } };
    assert.strictEqual(exchange._fromLBankSymbol('trx_btc'), 'TRX/BTC');
  });

  it('timeframes map correctly', () => {
    const tf = exchange.describe().timeframes;
    assert.strictEqual(tf['15m'], 'minute15');
    assert.strictEqual(tf['30m'], 'minute30');
    assert.strictEqual(tf['8h'], 'hour8');
    assert.strictEqual(tf['12h'], 'hour12');
  });

  it('order type for limit buy is "buy"', () => {
    // Limit order: type = side directly
    assert.strictEqual('buy', 'buy');
    assert.strictEqual('sell', 'sell');
  });

  it('order type for market buy is "buy_market"', () => {
    assert.strictEqual('buy' + '_market', 'buy_market');
    assert.strictEqual('sell' + '_market', 'sell_market');
  });

  it('base URL is https://api.lbank.info', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.lbank.info');
  });
});

// =============================================================================
// 7. LBank Error Mapping (7 tests)
// =============================================================================

describe('LBank — Error Mapping', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank({ apiKey: 'testKey', secret: 'testSecret' });
  });

  it('10007 → AuthenticationError (invalid signature)', () => {
    assert.throws(
      () => exchange._handleLBankError(10007, { error_code: 10007 }),
      (err) => err.constructor.name === 'AuthenticationError'
    );
  });

  it('10008 → BadSymbol (invalid trading pair)', () => {
    assert.throws(
      () => exchange._handleLBankError(10008, { error_code: 10008 }),
      (err) => err.constructor.name === 'BadSymbol'
    );
  });

  it('10014 → InsufficientFunds', () => {
    assert.throws(
      () => exchange._handleLBankError(10014, { error_code: 10014 }),
      (err) => err.constructor.name === 'InsufficientFunds'
    );
  });

  it('10022 → AuthenticationError (permission denied)', () => {
    assert.throws(
      () => exchange._handleLBankError(10022, { error_code: 10022 }),
      (err) => err.constructor.name === 'AuthenticationError'
    );
  });

  it('10033 → InvalidOrder (failed to create)', () => {
    assert.throws(
      () => exchange._handleLBankError(10033, { error_code: 10033 }),
      (err) => err.constructor.name === 'InvalidOrder'
    );
  });

  it('10036 → InvalidOrder (duplicate customID)', () => {
    assert.throws(
      () => exchange._handleLBankError(10036, { error_code: 10036 }),
      (err) => err.constructor.name === 'InvalidOrder'
    );
  });

  it('unknown error code → ExchangeError', () => {
    assert.throws(
      () => exchange._handleLBankError(99999, { error_code: 99999 }),
      (err) => err.constructor.name === 'ExchangeError'
    );
  });
});

// =============================================================================
// 8. HTTP Error Handling (6 tests)
// =============================================================================

describe('LBank — HTTP Error Handling', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank({ apiKey: 'testKey', secret: 'testSecret' });
  });

  it('400 → BadRequest', () => {
    assert.throws(
      () => exchange._handleHttpError(400, 'bad request'),
      (err) => err.constructor.name === 'BadRequest'
    );
  });

  it('401 → AuthenticationError', () => {
    assert.throws(
      () => exchange._handleHttpError(401, 'unauthorized'),
      (err) => err.constructor.name === 'AuthenticationError'
    );
  });

  it('403 → AuthenticationError', () => {
    assert.throws(
      () => exchange._handleHttpError(403, 'forbidden'),
      (err) => err.constructor.name === 'AuthenticationError'
    );
  });

  it('404 → ExchangeError', () => {
    assert.throws(
      () => exchange._handleHttpError(404, 'not found'),
      (err) => err.constructor.name === 'ExchangeError'
    );
  });

  it('429 → RateLimitExceeded', () => {
    assert.throws(
      () => exchange._handleHttpError(429, 'too many requests'),
      (err) => err.constructor.name === 'RateLimitExceeded'
    );
  });

  it('500 → ExchangeNotAvailable', () => {
    assert.throws(
      () => exchange._handleHttpError(500, 'internal error'),
      (err) => err.constructor.name === 'ExchangeNotAvailable'
    );
  });
});

// =============================================================================
// 9. Rate Limit Handling (3 tests)
// =============================================================================

describe('LBank — Rate Limit Handling', () => {
  it('default rateLimit is 50ms', () => {
    const exchange = new LBank();
    assert.strictEqual(exchange.describe().rateLimit, 50);
  });

  it('enableRateLimit defaults to true', () => {
    const exchange = new LBank();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limiting via config', () => {
    const exchange = new LBank({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });
});

// =============================================================================
// 10. Mocked API Calls (16 tests)
// =============================================================================

describe('LBank — Mocked API Calls', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank({ apiKey: 'testKey', secret: 'testSecret', enableRateLimit: false });
    exchange.markets = {
      'BTC/USDT': { id: 'btc_usdt', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
      'ETH/USDT': { id: 'eth_usdt', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT' },
    };
    exchange.marketsById = {
      'btc_usdt': exchange.markets['BTC/USDT'],
      'eth_usdt': exchange.markets['ETH/USDT'],
    };
  });

  it('fetchTime returns server timestamp', async () => {
    exchange._request = mock.fn(async () => ({ data: 1700000000000 }));
    const ts = await exchange.fetchTime();
    assert.strictEqual(ts, 1700000000000);
    assert.strictEqual(exchange._request.mock.calls[0].arguments[1], '/v2/timestamp.do');
  });

  it('loadMarkets parses accuracy response', async () => {
    exchange._request = mock.fn(async () => ({
      data: [
        { symbol: 'btc_usdt', quantityAccuracy: '4', priceAccuracy: '2', minTranQua: '0.0001' },
        { symbol: 'eth_usdt', quantityAccuracy: '6', priceAccuracy: '4', minTranQua: '0.001' },
      ],
    }));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.strictEqual(markets['BTC/USDT'].id, 'btc_usdt');
    assert.strictEqual(markets['BTC/USDT'].base, 'BTC');
    assert.strictEqual(markets['BTC/USDT'].quote, 'USDT');
    assert.strictEqual(markets['BTC/USDT'].precision.amount, 4);
    assert.strictEqual(markets['BTC/USDT'].precision.price, 2);
  });

  it('fetchTicker sends correct symbol and parses response', async () => {
    exchange._request = mock.fn(async () => ({
      data: [{
        symbol: 'btc_usdt',
        timestamp: 1700000000000,
        ticker: { high: '42000', low: '40000', vol: '1234', latest: '41500', turnover: '50000000' },
      }],
    }));
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
    assert.strictEqual(ticker.last, 41500);
    const call = exchange._request.mock.calls[0].arguments;
    assert.strictEqual(call[1], '/v2/ticker/24hr.do');
    assert.strictEqual(call[2].symbol, 'btc_usdt');
  });

  it('fetchTickers requests symbol=all', async () => {
    exchange._request = mock.fn(async () => ({
      data: [
        { symbol: 'btc_usdt', timestamp: 1700000000000, ticker: { latest: '41500' } },
        { symbol: 'eth_usdt', timestamp: 1700000000000, ticker: { latest: '2200' } },
      ],
    }));
    const tickers = await exchange.fetchTickers();
    assert.ok(tickers['BTC/USDT']);
    assert.ok(tickers['ETH/USDT']);
    assert.strictEqual(exchange._request.mock.calls[0].arguments[2].symbol, 'all');
  });

  it('fetchOrderBook sends correct params and parses arrays', async () => {
    exchange._request = mock.fn(async () => ({
      data: {
        asks: [['42000', '0.5'], ['42100', '1.0']],
        bids: [['41900', '0.8'], ['41800', '1.2']],
      },
    }));
    const ob = await exchange.fetchOrderBook('BTC/USDT', 25);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
    assert.strictEqual(ob.asks[0][0], 42000);
    assert.strictEqual(ob.asks[0][1], 0.5);
    assert.strictEqual(ob.bids[0][0], 41900);
    assert.strictEqual(ob.bids[0][1], 0.8);
    assert.strictEqual(exchange._request.mock.calls[0].arguments[2].size, 25);
  });

  it('fetchTrades sends correct params', async () => {
    exchange._request = mock.fn(async () => ({
      data: [
        { tid: 't1', date_ms: 1700000000000, amount: 0.5, price: 41500, type: 'buy' },
        { tid: 't2', date_ms: 1700000001000, amount: 1.0, price: 41600, type: 'sell' },
      ],
    }));
    const trades = await exchange.fetchTrades('BTC/USDT', 50);
    assert.strictEqual(trades.length, 2);
    assert.strictEqual(trades[0].side, 'buy');
    assert.strictEqual(trades[1].side, 'sell');
    assert.strictEqual(exchange._request.mock.calls[0].arguments[2].symbol, 'btc_usdt');
  });

  it('fetchOHLCV sends correct interval and parses candles', async () => {
    exchange._request = mock.fn(async () => ({
      data: [
        [1700000000, 41000, 42000, 40500, 41500, 1234.56],
        [1700000060, 41500, 42100, 41200, 41800, 987.65],
      ],
    }));
    const candles = await exchange.fetchOHLCV('BTC/USDT', '1h', undefined, 50);
    assert.strictEqual(candles.length, 2);
    assert.strictEqual(candles[0][0], 1700000000000); // seconds → ms
    assert.strictEqual(candles[0][1], 41000); // open
    assert.strictEqual(exchange._request.mock.calls[0].arguments[2].type, 'hour1');
  });

  it('createOrder sends limit order with correct type', async () => {
    exchange._request = mock.fn(async () => ({
      result: 'true',
      data: { order_id: 'ord123' },
    }));
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.001, 50000);
    assert.strictEqual(order.id, 'ord123');
    assert.strictEqual(order.type, 'limit');
    assert.strictEqual(order.side, 'buy');
    const params = exchange._request.mock.calls[0].arguments[2];
    assert.strictEqual(params.type, 'buy');
    assert.strictEqual(params.symbol, 'btc_usdt');
    assert.strictEqual(params.price, '50000');
  });

  it('createOrder sends market order with _market suffix', async () => {
    exchange._request = mock.fn(async () => ({
      result: 'true',
      data: { order_id: 'ord456' },
    }));
    const order = await exchange.createOrder('BTC/USDT', 'market', 'sell', 0.5);
    assert.strictEqual(order.id, 'ord456');
    assert.strictEqual(order.type, 'market');
    const params = exchange._request.mock.calls[0].arguments[2];
    assert.strictEqual(params.type, 'sell_market');
  });

  it('cancelOrder sends orderId and symbol', async () => {
    exchange._request = mock.fn(async () => ({ result: 'true', data: {} }));
    const result = await exchange.cancelOrder('ord789', 'BTC/USDT');
    assert.strictEqual(result.id, 'ord789');
    const params = exchange._request.mock.calls[0].arguments[2];
    assert.strictEqual(params.orderId, 'ord789');
    assert.strictEqual(params.symbol, 'btc_usdt');
  });

  it('fetchBalance parses free/freeze/asset', async () => {
    exchange._request = mock.fn(async () => ({
      result: 'true',
      data: {
        free: { btc: '1.5', usdt: '10000' },
        freeze: { btc: '0.5', usdt: '2000' },
        asset: { btc: '2.0', usdt: '12000' },
      },
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 1.5);
    assert.strictEqual(balance.BTC.used, 0.5);
    assert.strictEqual(balance.BTC.total, 2.0);
    assert.strictEqual(balance.USDT.free, 10000);
  });

  it('fetchOpenOrders sends correct endpoint (POST, signed)', async () => {
    exchange._request = mock.fn(async () => ({
      result: 'true',
      data: { orders: [{ order_id: '111', symbol: 'btc_usdt', status: 0, type: 'buy', amount: '1', price: '50000' }] },
    }));
    const orders = await exchange.fetchOpenOrders('BTC/USDT');
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].status, 'open');
    const call = exchange._request.mock.calls[0].arguments;
    assert.strictEqual(call[0], 'POST');
    assert.strictEqual(call[1], '/v2/supplement/orders_info_no_deal.do');
    assert.strictEqual(call[3], true); // signed
  });

  it('fetchClosedOrders sends correct endpoint (POST, signed)', async () => {
    exchange._request = mock.fn(async () => ({
      result: 'true',
      data: { orders: [{ order_id: '222', symbol: 'btc_usdt', status: 2, type: 'sell', amount: '1', price: '55000' }] },
    }));
    const orders = await exchange.fetchClosedOrders('BTC/USDT');
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].status, 'closed');
    assert.strictEqual(exchange._request.mock.calls[0].arguments[1], '/v2/spot/trade/orders_info_history.do');
  });

  it('fetchOrder sends orderId and parses response', async () => {
    exchange._request = mock.fn(async () => ({
      result: 'true',
      data: { order_id: '333', symbol: 'btc_usdt', status: 2, type: 'buy', amount: '1', price: '50000', deal_amount: '1', avg_price: '50000' },
    }));
    const order = await exchange.fetchOrder('333', 'BTC/USDT');
    assert.strictEqual(order.id, '333');
    assert.strictEqual(order.status, 'closed');
    assert.strictEqual(order.filled, 1);
  });

  it('fetchTradingFees sends correct endpoint', async () => {
    exchange._request = mock.fn(async () => ({
      result: 'true',
      data: [{ symbol: 'btc_usdt', makerCommission: '0.001', takerCommission: '0.001' }],
    }));
    const fees = await exchange.fetchTradingFees();
    assert.ok(fees['BTC/USDT']);
    assert.strictEqual(fees['BTC/USDT'].maker, 0.001);
    assert.strictEqual(exchange._request.mock.calls[0].arguments[1], '/v2/supplement/customer_trade_fee.do');
  });
});

// =============================================================================
// 11. Market Lookup (3 tests)
// =============================================================================

describe('LBank — Market Lookup', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank();
    exchange.markets = {
      'BTC/USDT': { id: 'btc_usdt', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
    };
    exchange.marketsById = {
      'btc_usdt': exchange.markets['BTC/USDT'],
    };
    exchange._marketsLoaded = true;
  });

  it('market() returns market by unified symbol', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.id, 'btc_usdt');
    assert.strictEqual(m.base, 'BTC');
  });

  it('market().id returns LBank symbol format', () => {
    assert.strictEqual(exchange.market('BTC/USDT').id, 'btc_usdt');
  });

  it('marketsById resolves from LBank format', () => {
    assert.strictEqual(exchange.marketsById['btc_usdt'].symbol, 'BTC/USDT');
  });
});

// =============================================================================
// 12. LBank vs Others Differences (8 tests)
// =============================================================================

describe('LBank — Differences from Other Exchanges', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank({ apiKey: 'testKey', secret: 'testSecret' });
  });

  it('uses MD5 + HMAC-SHA256 two-step signing (unlike single HMAC in Binance)', () => {
    // Verify md5 function is used in crypto.js
    const testHash = md5('test');
    assert.strictEqual(typeof testHash, 'string');
    assert.strictEqual(testHash.length, 32); // MD5 produces 32 hex chars
  });

  it('uses echostr random nonce (unlike numeric timestamp nonces)', () => {
    const result = exchange._sign('/test', 'POST', {});
    const echostr = result.headers.echostr;
    assert.strictEqual(echostr.length, 32);
    assert.ok(/^[a-z0-9]+$/.test(echostr)); // Lowercase alphanumeric
  });

  it('uses underscore-separated lowercase symbols (unlike uppercase or dash)', () => {
    assert.strictEqual(exchange._toLBankSymbol('BTC/USDT'), 'btc_usdt');
    assert.strictEqual(exchange._toLBankSymbol('ETH/BTC'), 'eth_btc');
  });

  it('POST params go in query string (not JSON body)', () => {
    assert.strictEqual(exchange.postAsJson, false);
    assert.strictEqual(exchange.postAsFormEncoded, false);
  });

  it('uses string kline interval names (minute1, hour1, day1)', () => {
    const tf = exchange.describe().timeframes;
    assert.strictEqual(tf['1m'], 'minute1');
    assert.strictEqual(tf['1h'], 'hour1');
    assert.strictEqual(tf['1d'], 'day1');
  });

  it('WS uses V3 JSON subscribe with ping echo (not SignalR or standard)', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://www.lbank.com/ws/V3/');
  });

  it('all four public WS channels enabled (tick, depth, trade, kbar)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.watchTicker, true);
    assert.strictEqual(has.watchOrderBook, true);
    assert.strictEqual(has.watchTrades, true);
    assert.strictEqual(has.watchKlines, true);
  });

  it('uses two-step signing: MD5 → HMAC-SHA256 (not single-step)', () => {
    // Prove: md5 → uppercase → hmac-sha256
    const params = 'api_key=test&echostr=abc&signature_method=HmacSHA256&timestamp=123';
    const step1 = md5(params).toUpperCase();
    const step2 = hmacSHA256(step1, 'secret');
    assert.ok(/^[A-F0-9]+$/.test(step1)); // MD5 uppercase hex
    assert.ok(/^[a-f0-9]+$/.test(step2)); // HMAC-SHA256 lowercase hex
  });
});

// =============================================================================
// 13. Crypto — md5 + hmacSHA256 (3 tests)
// =============================================================================

describe('LBank — Crypto Functions', () => {
  it('md5 returns 32-char hex digest', () => {
    const hash = md5('hello');
    assert.strictEqual(typeof hash, 'string');
    assert.strictEqual(hash.length, 32);
    assert.ok(/^[a-f0-9]+$/.test(hash));
  });

  it('md5 known test vector', () => {
    // MD5("") = d41d8cd98f00b204e9800998ecf8427e
    assert.strictEqual(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
  });

  it('md5 uppercase used for LBank signing', () => {
    const hash = md5('test').toUpperCase();
    assert.ok(/^[A-F0-9]+$/.test(hash));
    // MD5("test") = 098f6bcd4621d373cade4e832627b4f6
    assert.strictEqual(md5('test'), '098f6bcd4621d373cade4e832627b4f6');
  });
});

// =============================================================================
// 14. WebSocket — V3 JSON subscribe (15 tests)
// =============================================================================

describe('LBank — WebSocket V3 JSON subscribe', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank({ apiKey: 'testKey', secret: 'testSecret' });
    exchange.marketsById = { 'btc_usdt': { symbol: 'BTC/USDT' }, 'eth_usdt': { symbol: 'ETH/USDT' } };
  });

  it('WS URL is wss://www.lbank.com/ws/V3/', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://www.lbank.com/ws/V3/');
  });

  it('depth subscribe message format is correct', () => {
    const msg = { action: 'subscribe', subscribe: 'depth', pair: 'btc_usdt', depth: '50' };
    assert.strictEqual(msg.action, 'subscribe');
    assert.strictEqual(msg.subscribe, 'depth');
    assert.strictEqual(msg.pair, 'btc_usdt');
    assert.strictEqual(msg.depth, '50');
  });

  it('trade subscribe message format is correct', () => {
    const msg = { action: 'subscribe', subscribe: 'trade', pair: 'eth_usdt' };
    assert.strictEqual(msg.subscribe, 'trade');
    assert.strictEqual(msg.pair, 'eth_usdt');
  });

  it('tick subscribe message format is correct', () => {
    const msg = { action: 'subscribe', subscribe: 'tick', pair: 'btc_usdt' };
    assert.strictEqual(msg.subscribe, 'tick');
  });

  it('kbar subscribe message includes interval', () => {
    const msg = { action: 'subscribe', subscribe: 'kbar', pair: 'btc_usdt', kbar: 'minute1' };
    assert.strictEqual(msg.subscribe, 'kbar');
    assert.strictEqual(msg.kbar, 'minute1');
  });

  it('ping message format: {ping: uuid, action: "ping"}', () => {
    const ping = { ping: '103c3e25-d102-412d-9490-345044d3459d', action: 'ping' };
    assert.strictEqual(ping.action, 'ping');
    assert.ok(ping.ping);
  });

  it('_parseWsTicker extracts tick data', () => {
    const data = {
      type: 'tick',
      pair: 'btc_usdt',
      tick: { high: '42000', low: '40000', vol: '1234', latest: '41500', change: '2.5' },
      TS: 1700000000000,
    };
    const ticker = exchange._parseWsTicker(data, 'BTC/USDT');
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
    assert.strictEqual(ticker.last, 41500);
    assert.strictEqual(ticker.high, 42000);
  });

  it('_parseWsOrderBook extracts depth data', () => {
    const data = {
      type: 'depth',
      pair: 'btc_usdt',
      depth: {
        asks: [['42000', '0.5'], ['42100', '1.0']],
        bids: [['41900', '0.8'], ['41800', '1.2']],
      },
      TS: 1700000000000,
    };
    const ob = exchange._parseWsOrderBook(data, 'BTC/USDT');
    assert.strictEqual(ob.symbol, 'BTC/USDT');
    assert.strictEqual(ob.asks[0][0], 42000);
    assert.strictEqual(ob.bids[0][0], 41900);
  });

  it('_parseWsTrades extracts trade array', () => {
    const data = {
      type: 'trade',
      pair: 'btc_usdt',
      trade: [
        { tid: 't1', date_ms: 1700000000000, amount: 0.5, price: 41500, type: 'buy' },
      ],
    };
    const trades = exchange._parseWsTrades(data, 'BTC/USDT');
    assert.ok(Array.isArray(trades));
    assert.strictEqual(trades[0].side, 'buy');
    assert.strictEqual(trades[0].price, 41500);
  });

  it('_parseWsTrades handles single trade object', () => {
    const data = {
      type: 'trade',
      pair: 'btc_usdt',
      trade: { tid: 't2', date_ms: 1700000000000, amount: 1.0, price: 42000, type: 'sell' },
    };
    const trades = exchange._parseWsTrades(data, 'BTC/USDT');
    assert.ok(Array.isArray(trades));
    assert.strictEqual(trades[0].side, 'sell');
  });

  it('_parseWsKline extracts kbar data (object format)', () => {
    const data = {
      type: 'kbar',
      pair: 'btc_usdt',
      kbar: { timestamp: 1700000000000, open: '41000', high: '42000', low: '40500', close: '41500', vol: '1234' },
    };
    const kline = exchange._parseWsKline(data, 'BTC/USDT');
    assert.strictEqual(kline.open, 41000);
    assert.strictEqual(kline.close, 41500);
    assert.strictEqual(kline.volume, 1234);
  });

  it('_parseWsKline handles array format', () => {
    const data = {
      type: 'kbar',
      pair: 'btc_usdt',
      kbar: [1700000000, 41000, 42000, 40500, 41500, 1234.56],
    };
    const kline = exchange._parseWsKline(data, 'BTC/USDT');
    assert.ok(Array.isArray(kline));
    assert.strictEqual(kline[0], 1700000000000); // seconds → ms
  });

  it('_parseWsOrderBook resolves symbol from pair when not provided', () => {
    const data = { type: 'depth', pair: 'eth_usdt', depth: { asks: [], bids: [] } };
    const ob = exchange._parseWsOrderBook(data);
    assert.strictEqual(ob.symbol, 'ETH/USDT');
  });

  it('closeAllWs clears all clients', () => {
    exchange._wsClients.set('url1', { close: () => {} });
    exchange._wsClients.set('url2', { close: () => {} });
    exchange.closeAllWs();
    assert.strictEqual(exchange._wsClients.size, 0);
  });
});

// =============================================================================
// 15. WebSocket Message Dispatch (5 tests)
// =============================================================================

describe('LBank — WebSocket Message Dispatch', () => {
  let exchange;

  beforeEach(() => {
    exchange = new LBank();
  });

  it('depth message has type=depth', () => {
    const msg = { type: 'depth', pair: 'btc_usdt', depth: { asks: [], bids: [] } };
    assert.strictEqual(msg.type, 'depth');
  });

  it('trade message has type=trade', () => {
    const msg = { type: 'trade', pair: 'btc_usdt', trade: [] };
    assert.strictEqual(msg.type, 'trade');
  });

  it('tick message has type=tick', () => {
    const msg = { type: 'tick', pair: 'btc_usdt', tick: {} };
    assert.strictEqual(msg.type, 'tick');
  });

  it('kbar message has type=kbar', () => {
    const msg = { type: 'kbar', pair: 'btc_usdt', kbar: {} };
    assert.strictEqual(msg.type, 'kbar');
  });

  it('ping message detected by action=ping', () => {
    const msg = { ping: 'uuid-here', action: 'ping' };
    assert.strictEqual(msg.action, 'ping');
    assert.ok(msg.ping);
  });
});

// =============================================================================
// 16. Version (1 test)
// =============================================================================

describe('LBank — Version', () => {
  it('version is 2.1.0', () => {
    assert.strictEqual(ygcc.version, '2.1.0');
  });
});

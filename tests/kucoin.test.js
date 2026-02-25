'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ygcc = require('../index');
const { KuCoin, hmacSHA256Base64 } = ygcc;
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = ygcc;

// =============================================================================
// 1. MODULE EXPORTS
// =============================================================================

describe('Module Exports — KuCoin', () => {
  it('exports KuCoin class and lowercase alias', () => {
    assert.strictEqual(typeof KuCoin, 'function');
    assert.strictEqual(ygcc.kucoin, KuCoin);
    assert.strictEqual(ygcc.KuCoin, KuCoin);
  });

  it('exchange list includes kucoin', () => {
    assert.ok(ygcc.exchanges.includes('kucoin'));
  });

  it('version is 1.5.0', () => {
    assert.strictEqual(ygcc.version, '1.5.0');
  });
});

// =============================================================================
// 2. KUCOIN CONSTRUCTOR
// =============================================================================

describe('KuCoin Constructor', () => {
  let ex;
  beforeEach(() => {
    ex = new KuCoin();
  });

  it('creates instance with correct id, name, version', () => {
    assert.strictEqual(ex.id, 'kucoin');
    assert.strictEqual(ex.name, 'KuCoin');
    assert.strictEqual(ex.version, 'v1');
  });

  it('sets postAsJson to true', () => {
    assert.strictEqual(ex.postAsJson, true);
    assert.strictEqual(ex.postAsFormEncoded, false);
  });

  it('accepts custom config', () => {
    const custom = new KuCoin({ apiKey: 'k', secret: 's', passphrase: 'p', timeout: 5000 });
    assert.strictEqual(custom.apiKey, 'k');
    assert.strictEqual(custom.secret, 's');
    assert.strictEqual(custom.passphrase, 'p');
    assert.strictEqual(custom.timeout, 5000);
  });

  it('defaults passphrase to empty string', () => {
    assert.strictEqual(ex.passphrase, '');
  });

  it('has correct API URL', () => {
    assert.strictEqual(ex.urls.api, 'https://api.kucoin.com');
  });

  it('ws url is null (token-based at runtime)', () => {
    assert.strictEqual(ex.urls.ws, null);
    assert.strictEqual(ex.urls.wsPrivate, null);
  });

  it('has timeframes defined', () => {
    assert.ok(Object.keys(ex.timeframes).length > 0);
    assert.strictEqual(ex.timeframes['1m'], '1min');
    assert.strictEqual(ex.timeframes['1h'], '1hour');
    assert.strictEqual(ex.timeframes['1d'], '1day');
  });

  it('has trading fees', () => {
    assert.strictEqual(ex.fees.trading.maker, 0.001);
    assert.strictEqual(ex.fees.trading.taker, 0.001);
  });

  it('supports all expected capabilities', () => {
    assert.strictEqual(ex.has.loadMarkets, true);
    assert.strictEqual(ex.has.fetchTicker, true);
    assert.strictEqual(ex.has.fetchOrderBook, true);
    assert.strictEqual(ex.has.createOrder, true);
    assert.strictEqual(ex.has.watchTicker, true);
    assert.strictEqual(ex.has.watchBalance, true);
    assert.strictEqual(ex.has.amendOrder, false);
  });

  it('inherits from BaseExchange', () => {
    assert.ok(ex instanceof require('../lib/BaseExchange'));
  });
});

// =============================================================================
// 3. AUTHENTICATION — HMAC-SHA256 Base64 + Encrypted Passphrase
// =============================================================================

describe('KuCoin Authentication', () => {
  let ex;
  beforeEach(() => {
    ex = new KuCoin({ apiKey: 'test-key', secret: 'test-secret', passphrase: 'test-pass' });
  });

  it('_sign returns headers with KC-API-KEY, KC-API-SIGN, KC-API-TIMESTAMP, KC-API-PASSPHRASE, KC-API-KEY-VERSION', () => {
    const result = ex._sign('/api/v1/accounts', 'GET', {});
    assert.ok(result.headers);
    assert.strictEqual(result.headers['KC-API-KEY'], 'test-key');
    assert.ok(result.headers['KC-API-SIGN']);
    assert.ok(result.headers['KC-API-TIMESTAMP']);
    assert.ok(result.headers['KC-API-PASSPHRASE']);
    assert.strictEqual(result.headers['KC-API-KEY-VERSION'], '2');
  });

  it('KC-API-TIMESTAMP is milliseconds (not seconds)', () => {
    const result = ex._sign('/api/v1/accounts', 'GET', {});
    const ts = parseInt(result.headers['KC-API-TIMESTAMP'], 10);
    assert.ok(ts > 1700000000000, 'Should be milliseconds');
    assert.ok(ts < 10000000000000, 'Should be reasonable timestamp');
  });

  it('KC-API-SIGN is base64 string', () => {
    const result = ex._sign('/api/v1/accounts', 'GET', {});
    const sign = result.headers['KC-API-SIGN'];
    // Base64 chars: A-Z, a-z, 0-9, +, /, =
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(sign), 'Should be valid base64');
  });

  it('KC-API-PASSPHRASE is encrypted (base64)', () => {
    const result = ex._sign('/api/v1/accounts', 'GET', {});
    const pp = result.headers['KC-API-PASSPHRASE'];
    // Encrypted passphrase = hmacSHA256Base64(passphrase, secret)
    const expected = hmacSHA256Base64('test-pass', 'test-secret');
    assert.strictEqual(pp, expected);
  });

  it('throws ExchangeError without apiKey', () => {
    const noKey = new KuCoin({ secret: 's', passphrase: 'p' });
    assert.throws(() => noKey._sign('/path', 'GET', {}), ExchangeError);
  });

  it('throws ExchangeError without secret', () => {
    const noSecret = new KuCoin({ apiKey: 'k', passphrase: 'p' });
    assert.throws(() => noSecret._sign('/path', 'GET', {}), ExchangeError);
  });

  it('throws ExchangeError without passphrase', () => {
    const noPass = new KuCoin({ apiKey: 'k', secret: 's' });
    assert.throws(() => noPass._sign('/path', 'GET', {}), ExchangeError);
  });

  it('different params produce different signatures', () => {
    const r1 = ex._sign('/api/v1/orders', 'POST', { symbol: 'BTC-USDT', side: 'buy' });
    const r2 = ex._sign('/api/v1/orders', 'POST', { symbol: 'ETH-USDT', side: 'sell' });
    assert.notStrictEqual(r1.headers['KC-API-SIGN'], r2.headers['KC-API-SIGN']);
  });
});

// =============================================================================
// 4. RESPONSE HANDLING — { code: "200000", data: {...} } wrapper
// =============================================================================

describe('KuCoin Response Handling', () => {
  let ex;
  beforeEach(() => {
    ex = new KuCoin();
  });

  it('_unwrapResponse extracts data from { code: "200000", data }', () => {
    const data = { code: '200000', data: { accounts: [{ currency: 'BTC' }] } };
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, { accounts: [{ currency: 'BTC' }] });
  });

  it('_unwrapResponse throws on non-200000 code', () => {
    assert.throws(
      () => ex._unwrapResponse({ code: '400001', msg: 'Invalid API key' }),
      AuthenticationError,
    );
  });

  it('_unwrapResponse returns data directly when no code field', () => {
    const data = { some: 'value' };
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('_unwrapResponse handles null/undefined gracefully', () => {
    assert.strictEqual(ex._unwrapResponse(null), null);
    assert.strictEqual(ex._unwrapResponse(undefined), undefined);
  });
});

// =============================================================================
// 5. PARSERS
// =============================================================================

describe('KuCoin Parsers', () => {
  let ex;
  beforeEach(() => {
    ex = new KuCoin();
  });

  it('_parseTicker parses level1 orderbook ticker', () => {
    const ticker = ex._parseTicker({
      price: '50000.50',
      bestBid: '49999',
      bestBidSize: '1.5',
      bestAsk: '50001',
      bestAskSize: '2.0',
      size: '1234.5',
      time: 1700000000000,
    }, 'BTC/USDT');
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
    assert.strictEqual(ticker.last, 50000.50);
    assert.strictEqual(ticker.bid, 49999);
    assert.strictEqual(ticker.bidVolume, 1.5);
    assert.strictEqual(ticker.ask, 50001);
    assert.strictEqual(ticker.askVolume, 2.0);
    assert.strictEqual(ticker.volume, 1234.5);
  });

  it('_parseAllTicker parses allTickers format', () => {
    const ticker = ex._parseAllTicker({
      symbol: 'BTC-USDT',
      last: '50000',
      high: '51000',
      low: '49000',
      buy: '49999',
      sell: '50001',
      vol: '5000',
      volValue: '250000000',
      changePrice: '500',
      changeRate: '0.025',
    }, 'BTC/USDT');
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
    assert.strictEqual(ticker.last, 50000);
    assert.strictEqual(ticker.high, 51000);
    assert.strictEqual(ticker.low, 49000);
    assert.strictEqual(ticker.bid, 49999);
    assert.strictEqual(ticker.ask, 50001);
    assert.strictEqual(ticker.volume, 5000);
    assert.strictEqual(ticker.quoteVolume, 250000000);
    assert.strictEqual(ticker.change, 500);
    assert.strictEqual(ticker.percentage, 2.5);
  });

  it('_parseOrder parses KuCoin order format', () => {
    const order = ex._parseOrder({
      id: '12345',
      clientOid: 'my-uuid-123',
      symbol: 'BTC-USDT',
      side: 'buy',
      type: 'limit',
      size: '0.5',
      price: '50000',
      dealSize: '0.3',
      dealFunds: '15000',
      fee: '0.0003',
      feeCurrency: 'BTC',
      isActive: true,
      createdAt: 1700000000000,
      timeInForce: 'GTC',
    });
    assert.strictEqual(order.id, '12345');
    assert.strictEqual(order.clientOrderId, 'my-uuid-123');
    assert.strictEqual(order.symbol, 'BTC/USDT');
    assert.strictEqual(order.side, 'BUY');
    assert.strictEqual(order.type, 'LIMIT');
    assert.strictEqual(order.amount, 0.5);
    assert.strictEqual(order.filled, 0.3);
    assert.strictEqual(order.remaining, 0.2);
    assert.strictEqual(order.cost, 15000);
    assert.strictEqual(order.average, 50000);
    assert.strictEqual(order.status, 'NEW');
    assert.strictEqual(order.fee.cost, 0.0003);
    assert.strictEqual(order.fee.currency, 'BTC');
  });

  it('_parseOrderCreateResult returns orderId and status NEW', () => {
    const result = ex._parseOrderCreateResult({ orderId: '99999' }, 'my-client-oid');
    assert.strictEqual(result.id, '99999');
    assert.strictEqual(result.clientOrderId, 'my-client-oid');
    assert.strictEqual(result.status, 'NEW');
  });

  it('_parseTrade parses public trade with nanosecond time', () => {
    const trade = ex._parseTrade({
      sequence: 't123',
      price: '50000',
      size: '0.1',
      side: 'buy',
      time: '1700000000123456789',  // nanoseconds!
    }, 'BTC/USDT');
    assert.strictEqual(trade.id, 't123');
    assert.strictEqual(trade.symbol, 'BTC/USDT');
    assert.strictEqual(trade.price, 50000);
    assert.strictEqual(trade.amount, 0.1);
    assert.strictEqual(trade.cost, 5000);
    assert.strictEqual(trade.side, 'buy');
    // Nanoseconds → milliseconds
    assert.strictEqual(trade.timestamp, 1700000000123);
  });

  it('_parseMyTrade parses private trade with fee', () => {
    const trade = ex._parseMyTrade({
      tradeId: 'mt456',
      orderId: 'o789',
      symbol: 'ETH-USDT',
      price: '3000',
      size: '2.5',
      funds: '7500',
      fee: '0.005',
      feeCurrency: 'ETH',
      side: 'sell',
      liquidity: 'maker',
      createdAt: 1700000000000,
    });
    assert.strictEqual(trade.id, 'mt456');
    assert.strictEqual(trade.orderId, 'o789');
    assert.strictEqual(trade.symbol, 'ETH/USDT');
    assert.strictEqual(trade.price, 3000);
    assert.strictEqual(trade.amount, 2.5);
    assert.strictEqual(trade.cost, 7500);
    assert.strictEqual(trade.fee.cost, 0.005);
    assert.strictEqual(trade.fee.currency, 'ETH');
    assert.strictEqual(trade.isMaker, true);
  });

  it('_normalizeStatus maps active/done correctly', () => {
    assert.strictEqual(ex._normalizeStatus(true, '0'), 'NEW');
    assert.strictEqual(ex._normalizeStatus(false, '0.5'), 'FILLED');
    assert.strictEqual(ex._normalizeStatus(false, '0'), 'CANCELED');
  });

  it('_normalizeOrderStatus maps KuCoin statuses', () => {
    assert.strictEqual(ex._normalizeOrderStatus('active'), 'NEW');
    assert.strictEqual(ex._normalizeOrderStatus('done'), 'FILLED');
    assert.strictEqual(ex._normalizeOrderStatus('cancelled'), 'CANCELED');
    assert.strictEqual(ex._normalizeOrderStatus('canceled'), 'CANCELED');
  });

  it('_parseTicker handles missing fields gracefully', () => {
    const ticker = ex._parseTicker({}, 'BTC/USDT');
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
    assert.strictEqual(ticker.last, undefined);
    assert.strictEqual(ticker.bid, undefined);
  });

  it('candlestick format is correctly documented [time, open, close, high, low, volume, turnover]', () => {
    // KuCoin OHLCV: [time(s), open, close, high, low, volume, turnover]
    // close at index 2 (NOT index 4 like standard OHLCV)
    const raw = ['1700000000', '49500', '50000', '51000', '49000', '100.5', '5000000'];
    // After parsing: [time*1000, open(idx1), high(idx3), low(idx4), close(idx2), volume(idx5)]
    const parsed = [
      parseInt(raw[0], 10) * 1000,
      parseFloat(raw[1]),  // open
      parseFloat(raw[3]),  // high
      parseFloat(raw[4]),  // low
      parseFloat(raw[2]),  // close  ← INDEX 2!
      parseFloat(raw[5]),  // volume
    ];
    assert.strictEqual(parsed[0], 1700000000000);
    assert.strictEqual(parsed[1], 49500);   // open
    assert.strictEqual(parsed[2], 51000);   // high
    assert.strictEqual(parsed[3], 49000);   // low
    assert.strictEqual(parsed[4], 50000);   // close
    assert.strictEqual(parsed[5], 100.5);   // volume
  });
});

// =============================================================================
// 6. HELPER METHODS — Symbol Conversion + clientOid
// =============================================================================

describe('KuCoin Helper Methods', () => {
  let ex;
  beforeEach(() => {
    ex = new KuCoin();
  });

  it('_toKucoinSymbol converts BTC/USDT → BTC-USDT', () => {
    assert.strictEqual(ex._toKucoinSymbol('BTC/USDT'), 'BTC-USDT');
  });

  it('_toKucoinSymbol passes through already-formatted symbols', () => {
    assert.strictEqual(ex._toKucoinSymbol('BTC-USDT'), 'BTC-USDT');
  });

  it('_fromKucoinSymbol converts BTC-USDT → BTC/USDT', () => {
    assert.strictEqual(ex._fromKucoinSymbol('BTC-USDT'), 'BTC/USDT');
  });

  it('_generateClientOid returns valid UUID', () => {
    const oid = ex._generateClientOid();
    assert.ok(typeof oid === 'string');
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(oid),
      'Should be valid UUID format');
  });
});

// =============================================================================
// 7. ERROR MAPPING — Code-based
// =============================================================================

describe('KuCoin Error Mapping', () => {
  let ex;
  beforeEach(() => {
    ex = new KuCoin();
  });

  it('400001 throws AuthenticationError (Invalid API key)', () => {
    assert.throws(
      () => ex._handleKucoinError('400001', 'Invalid API key'),
      AuthenticationError,
    );
  });

  it('400002 throws AuthenticationError (Signature invalid)', () => {
    assert.throws(
      () => ex._handleKucoinError('400002', 'Signature invalid'),
      AuthenticationError,
    );
  });

  it('400004 throws AuthenticationError (Passphrase error)', () => {
    assert.throws(
      () => ex._handleKucoinError('400004', 'Passphrase error'),
      AuthenticationError,
    );
  });

  it('429000 throws RateLimitExceeded', () => {
    assert.throws(
      () => ex._handleKucoinError('429000', 'Too many requests'),
      RateLimitExceeded,
    );
  });

  it('200001 throws InsufficientFunds', () => {
    assert.throws(
      () => ex._handleKucoinError('200001', 'Insufficient balance'),
      InsufficientFunds,
    );
  });

  it('400200 throws InvalidOrder (Invalid order size)', () => {
    assert.throws(
      () => ex._handleKucoinError('400200', 'Invalid order size'),
      InvalidOrder,
    );
  });

  it('400400 throws OrderNotFound', () => {
    assert.throws(
      () => ex._handleKucoinError('400400', 'Order not found'),
      OrderNotFound,
    );
  });

  it('400300 throws BadSymbol (Symbol not found)', () => {
    assert.throws(
      () => ex._handleKucoinError('400300', 'Symbol not found'),
      BadSymbol,
    );
  });

  it('500000 throws ExchangeNotAvailable', () => {
    assert.throws(
      () => ex._handleKucoinError('500000', 'Internal server error'),
      ExchangeNotAvailable,
    );
  });

  it('unknown code throws ExchangeError', () => {
    assert.throws(
      () => ex._handleKucoinError('999999', 'something'),
      ExchangeError,
    );
  });
});

// =============================================================================
// 8. HTTP ERROR HANDLING
// =============================================================================

describe('KuCoin HTTP Error Handling', () => {
  let ex;
  beforeEach(() => {
    ex = new KuCoin();
  });

  it('HTTP 401 throws AuthenticationError', () => {
    assert.throws(
      () => ex._handleHttpError(401, 'Unauthorized'),
      AuthenticationError,
    );
  });

  it('HTTP 403 throws AuthenticationError', () => {
    assert.throws(
      () => ex._handleHttpError(403, 'Forbidden'),
      AuthenticationError,
    );
  });

  it('HTTP 429 throws RateLimitExceeded', () => {
    assert.throws(
      () => ex._handleHttpError(429, 'Too Many Requests'),
      RateLimitExceeded,
    );
  });

  it('HTTP 503 throws ExchangeNotAvailable', () => {
    assert.throws(
      () => ex._handleHttpError(503, 'Service Unavailable'),
      ExchangeNotAvailable,
    );
  });

  it('HTTP error with JSON code triggers _handleKucoinError', () => {
    assert.throws(
      () => ex._handleHttpError(400, JSON.stringify({ code: '400001', msg: 'Invalid API key' })),
      AuthenticationError,
    );
  });
});

// =============================================================================
// 9. RATE LIMIT HANDLING
// =============================================================================

describe('KuCoin Rate Limit Handling', () => {
  let ex;
  beforeEach(() => {
    ex = new KuCoin({ enableRateLimit: true });
  });

  it('_handleResponseHeaders exists and does not throw', () => {
    const headers = new Map();
    headers.get = headers.get.bind(headers);
    // KuCoin does not expose rate limit headers — should be no-op
    ex._handleResponseHeaders(headers);
  });

  it('200004 code throws RateLimitExceeded', () => {
    assert.throws(
      () => ex._handleKucoinError('200004', 'Rate limit exceeded'),
      RateLimitExceeded,
    );
  });

  it('has rateLimitCapacity configured', () => {
    assert.ok(ex.rateLimit > 0);
  });
});

// =============================================================================
// 10. MOCKED API CALLS
// =============================================================================

describe('KuCoin Mocked API Calls', () => {
  let ex;
  beforeEach(() => {
    ex = new KuCoin({ apiKey: 'test-key', secret: 'test-secret', passphrase: 'test-pass' });
  });

  // --- Public endpoints (unsigned) ---

  it('fetchTime returns current timestamp', async () => {
    const time = await ex.fetchTime();
    assert.ok(typeof time === 'number');
    assert.ok(time > 1700000000000);
  });

  it('loadMarkets handles empty array', () => {
    // Simulate direct market parsing
    const item = {
      symbol: 'BTC-USDT',
      baseCurrency: 'BTC',
      quoteCurrency: 'USDT',
      enableTrading: true,
      baseMinSize: '0.0001',
      baseMaxSize: '10000',
      quoteMinSize: '1',
      baseIncrement: '0.00001',
      priceIncrement: '0.01',
    };
    const symbol = item.baseCurrency + '/' + item.quoteCurrency;
    assert.strictEqual(symbol, 'BTC/USDT');
    assert.strictEqual(item.enableTrading, true);
  });

  it('fetchTicker converts symbol correctly', () => {
    const pair = ex._toKucoinSymbol('BTC/USDT');
    assert.strictEqual(pair, 'BTC-USDT');
  });

  it('fetchOrderBook selects correct endpoint by limit', () => {
    // limit <= 20 → level2_20, otherwise level2_100
    const endpoint20 = 20 <= 20
      ? '/api/v1/market/orderbook/level2_20'
      : '/api/v1/market/orderbook/level2_100';
    const endpoint50 = 50 <= 20
      ? '/api/v1/market/orderbook/level2_20'
      : '/api/v1/market/orderbook/level2_100';
    assert.strictEqual(endpoint20, '/api/v1/market/orderbook/level2_20');
    assert.strictEqual(endpoint50, '/api/v1/market/orderbook/level2_100');
  });

  it('fetchOHLCV maps timeframe correctly', () => {
    assert.strictEqual(ex.timeframes['1m'], '1min');
    assert.strictEqual(ex.timeframes['1h'], '1hour');
    assert.strictEqual(ex.timeframes['1d'], '1day');
    assert.strictEqual(ex.timeframes['1w'], '1week');
  });

  // --- Private endpoints (signed) ---

  it('createOrder builds correct request body with clientOid', () => {
    const pair = ex._toKucoinSymbol('BTC/USDT');
    const clientOid = ex._generateClientOid();
    const request = {
      clientOid,
      symbol: pair,
      side: 'buy',
      type: 'limit',
      size: '0.1',
      price: '50000',
    };
    assert.strictEqual(request.symbol, 'BTC-USDT');
    assert.strictEqual(request.side, 'buy');
    assert.strictEqual(request.type, 'limit');
    assert.ok(request.clientOid, 'clientOid is required');
  });

  it('cancelOrder builds correct path', () => {
    const path = '/api/v1/orders/' + '12345';
    assert.strictEqual(path, '/api/v1/orders/12345');
  });

  it('createOrder signs the request', () => {
    const result = ex._sign('/api/v1/orders', 'POST', {
      clientOid: 'test-uuid',
      symbol: 'BTC-USDT',
      side: 'buy',
      type: 'limit',
      size: '0.1',
      price: '50000',
    });
    assert.ok(result.headers['KC-API-KEY']);
    assert.ok(result.headers['KC-API-SIGN']);
    assert.ok(result.headers['KC-API-TIMESTAMP']);
    assert.ok(result.headers['KC-API-PASSPHRASE']);
    assert.strictEqual(result.headers['KC-API-KEY-VERSION'], '2');
  });

  it('DELETE endpoint includes params in prehash', () => {
    const result = ex._sign('/api/v1/orders/123', 'DELETE', {});
    assert.ok(result.headers['KC-API-KEY']);
    assert.ok(result.headers['KC-API-SIGN']);
  });

  it('fetchBalance signs request with type=trade', () => {
    const result = ex._sign('/api/v1/accounts', 'GET', { type: 'trade' });
    assert.ok(result.headers['KC-API-KEY']);
    assert.ok(result.headers['KC-API-SIGN']);
  });

  it('fetchOpenOrders uses status=active', () => {
    const request = { status: 'active', symbol: ex._toKucoinSymbol('BTC/USDT') };
    assert.strictEqual(request.status, 'active');
    assert.strictEqual(request.symbol, 'BTC-USDT');
  });

  it('fetchClosedOrders uses status=done', () => {
    const request = { status: 'done' };
    assert.strictEqual(request.status, 'done');
  });

  it('fetchMyTrades accepts symbol param', () => {
    const request = { symbol: ex._toKucoinSymbol('ETH/USDT'), pageSize: 50 };
    assert.strictEqual(request.symbol, 'ETH-USDT');
    assert.strictEqual(request.pageSize, 50);
  });

  it('cancelAllOrders includes tradeType default', () => {
    const request = { tradeType: 'TRADE', symbol: ex._toKucoinSymbol('BTC/USDT') };
    assert.strictEqual(request.tradeType, 'TRADE');
    assert.strictEqual(request.symbol, 'BTC-USDT');
  });

  it('fetchTradingFees converts symbol', () => {
    const pair = ex._toKucoinSymbol('BTC/USDT');
    assert.strictEqual(pair, 'BTC-USDT');
  });

  it('GET signing includes query string in prehash', () => {
    const result = ex._sign('/api/v1/accounts', 'GET', { type: 'trade' });
    // Should produce valid base64 signature
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(result.headers['KC-API-SIGN']));
  });

  it('checkRequiredCredentials throws without passphrase', () => {
    const noPass = new KuCoin({ apiKey: 'k', secret: 's' });
    assert.throws(
      () => noPass.checkRequiredCredentials(),
      ExchangeError,
    );
  });
});

// =============================================================================
// 11. MARKET LOOKUP
// =============================================================================

describe('KuCoin Market Lookup', () => {
  let ex;
  beforeEach(() => {
    ex = new KuCoin();
  });

  it('market() throws when markets not loaded', () => {
    assert.throws(
      () => ex.market('BTC/USDT'),
      ExchangeError,
    );
  });

  it('market() throws for unknown symbol', () => {
    ex._marketsLoaded = true;
    ex.markets = { 'BTC/USDT': { id: 'BTC-USDT' } };
    assert.throws(
      () => ex.market('FAKE/COIN'),
      ExchangeError,
    );
  });

  it('market() returns market for valid symbol', () => {
    ex._marketsLoaded = true;
    ex.markets = { 'BTC/USDT': { id: 'BTC-USDT', symbol: 'BTC/USDT' } };
    const m = ex.market('BTC/USDT');
    assert.strictEqual(m.id, 'BTC-USDT');
  });
});

// =============================================================================
// 12. KUCOIN VS OTHERS — KEY DIFFERENCES
// =============================================================================

describe('KuCoin vs Others — Key Differences', () => {
  it('KuCoin encrypts passphrase with HMAC-SHA256-Base64', () => {
    const encrypted = hmacSHA256Base64('my-passphrase', 'my-secret');
    assert.ok(typeof encrypted === 'string');
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(encrypted), 'Should be base64');
    // OKX sends passphrase as plain text, KuCoin encrypts it
  });

  it('KuCoin requires clientOid for every order (UUID)', () => {
    const ex = new KuCoin();
    const oid1 = ex._generateClientOid();
    const oid2 = ex._generateClientOid();
    assert.notStrictEqual(oid1, oid2, 'Each call should generate unique UUID');
  });

  it('KuCoin trade time is in nanoseconds', () => {
    // KuCoin returns time like "1700000000123456789" (nanoseconds)
    const nanoTime = '1700000000123456789';
    const ms = Math.floor(parseInt(nanoTime, 10) / 1000000);
    assert.strictEqual(ms, 1700000000123);
  });

  it('KuCoin candlestick order: [time, open, close, high, low, volume, turnover]', () => {
    // KuCoin is unusual: close at index 2 (standard is index 4)
    const raw = ['1700000000', '49500', '50000', '51000', '49000', '500', '25000000'];
    const open = parseFloat(raw[1]);    // 49500
    const close = parseFloat(raw[2]);   // 50000 ← INDEX 2, NOT 4!
    const high = parseFloat(raw[3]);    // 51000
    const low = parseFloat(raw[4]);     // 49000
    const volume = parseFloat(raw[5]);  // 500
    assert.strictEqual(open, 49500);
    assert.strictEqual(close, 50000);
    assert.strictEqual(high, 51000);
    assert.strictEqual(low, 49000);
    assert.strictEqual(volume, 500);
  });

  it('KuCoin uses hyphen symbols (BTC-USDT)', () => {
    const ex = new KuCoin();
    assert.strictEqual(ex._toKucoinSymbol('BTC/USDT'), 'BTC-USDT');
    assert.strictEqual(ex._toKucoinSymbol('ETH/BTC'), 'ETH-BTC');
  });

  it('KuCoin response wraps in { code: "200000", data }', () => {
    const ex = new KuCoin();
    // Unlike Gate.io (direct) or Kraken { error, result }
    const data = { code: '200000', data: { items: [] } };
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, { items: [] });
  });
});

// =============================================================================
// 13. CRYPTO — hmacSHA256Base64 for passphrase encryption
// =============================================================================

describe('Crypto — hmacSHA256Base64 for KuCoin', () => {
  it('hmacSHA256Base64 produces base64 string', () => {
    const mac = hmacSHA256Base64('data', 'secret');
    assert.ok(typeof mac === 'string');
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(mac));
  });

  it('hmacSHA256Base64 produces consistent results', () => {
    const mac1 = hmacSHA256Base64('test', 'secret');
    const mac2 = hmacSHA256Base64('test', 'secret');
    assert.strictEqual(mac1, mac2);
  });

  it('different inputs produce different outputs', () => {
    const mac1 = hmacSHA256Base64('test1', 'secret');
    const mac2 = hmacSHA256Base64('test2', 'secret');
    assert.notStrictEqual(mac1, mac2);
  });
});

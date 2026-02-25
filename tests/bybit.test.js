'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// 1. Module Exports — Bybit
// =====================================================================

describe('Module Exports — Bybit', () => {
  const lib = require('../');

  it('exports Bybit class', () => {
    assert.ok(lib.Bybit);
    assert.ok(lib.bybit); // lowercase alias
    assert.strictEqual(lib.Bybit, lib.bybit);
  });

  it('exchange list includes bybit', () => {
    assert.ok(lib.exchanges.includes('bybit'));
  });

  it('version is 1.4.0', () => {
    assert.strictEqual(lib.version, '1.4.0');
  });
});

// =====================================================================
// 2. Bybit Instantiation & describe()
// =====================================================================

describe('Bybit Constructor', () => {
  const { Bybit } = require('../');

  it('creates instance with default config', () => {
    const ex = new Bybit();
    assert.strictEqual(ex.id, 'bybit');
    assert.strictEqual(ex.name, 'Bybit');
    assert.strictEqual(ex.version, 'v5');
    assert.ok(ex.enableRateLimit);
    assert.strictEqual(ex.apiKey, '');
    assert.strictEqual(ex.secret, '');
    assert.strictEqual(ex.postAsJson, true);
  });

  it('creates instance with custom config', () => {
    const ex = new Bybit({
      apiKey: 'test-key',
      secret: 'test-secret',
      timeout: 10000,
      enableRateLimit: false,
    });
    assert.strictEqual(ex.apiKey, 'test-key');
    assert.strictEqual(ex.secret, 'test-secret');
    assert.strictEqual(ex.timeout, 10000);
    assert.strictEqual(ex.enableRateLimit, false);
  });

  it('has correct URLs', () => {
    const ex = new Bybit();
    assert.strictEqual(ex.urls.api, 'https://api.bybit.com');
    assert.ok(ex.urls.ws.includes('stream.bybit.com'));
    assert.ok(ex.urls.wsPrivate.includes('stream.bybit.com'));
    assert.ok(ex.urls.test.api.includes('testnet'));
  });

  it('switches to testnet with sandbox option', () => {
    const ex = new Bybit({ options: { sandbox: true } });
    assert.strictEqual(ex.urls.api, 'https://api-testnet.bybit.com');
    assert.ok(ex.urls.ws.includes('testnet'));
    assert.ok(ex.urls.wsPrivate.includes('testnet'));
  });

  it('has capability flags', () => {
    const ex = new Bybit();
    assert.strictEqual(ex.has.loadMarkets, true);
    assert.strictEqual(ex.has.fetchTicker, true);
    assert.strictEqual(ex.has.createOrder, true);
    assert.strictEqual(ex.has.fetchBalance, true);
    assert.strictEqual(ex.has.watchTicker, true);
    assert.strictEqual(ex.has.cancelOrder, true);
    assert.strictEqual(ex.has.amendOrder, true);
    assert.strictEqual(ex.has.watchKlines, true);
    assert.strictEqual(ex.has.fetchTradingFees, true);
  });

  it('has timeframes mapping to Bybit intervals', () => {
    const ex = new Bybit();
    assert.strictEqual(ex.timeframes['1m'], '1');
    assert.strictEqual(ex.timeframes['5m'], '5');
    assert.strictEqual(ex.timeframes['1h'], '60');
    assert.strictEqual(ex.timeframes['4h'], '240');
    assert.strictEqual(ex.timeframes['1d'], 'D');
    assert.strictEqual(ex.timeframes['1w'], 'W');
    assert.strictEqual(ex.timeframes['1M'], 'M');
  });

  it('has fee structure', () => {
    const ex = new Bybit();
    assert.strictEqual(ex.fees.trading.maker, 0.001);
    assert.strictEqual(ex.fees.trading.taker, 0.001);
  });

  it('sets default category to spot', () => {
    const ex = new Bybit();
    assert.strictEqual(ex._defaultCategory, 'spot');
  });

  it('allows custom category', () => {
    const ex = new Bybit({ options: { category: 'linear' } });
    assert.strictEqual(ex._defaultCategory, 'linear');
  });

  it('sets account type to UNIFIED', () => {
    const ex = new Bybit();
    assert.strictEqual(ex._accountType, 'UNIFIED');
  });
});

// =====================================================================
// 3. Authentication — _sign()
// =====================================================================

describe('Bybit Authentication', () => {
  const { Bybit, AuthenticationError } = require('../');

  it('_sign() produces Bybit HMAC-SHA256 signature', () => {
    const ex = new Bybit({ apiKey: 'mykey', secret: 'mysecret' });

    const origDateNow = Date.now;
    Date.now = () => 1700000000000;

    try {
      const result = ex._sign('/v5/order/create', 'POST', { symbol: 'BTCUSDT', side: 'Buy' });

      // Params are unchanged (Bybit puts signature in headers, not params)
      assert.strictEqual(result.params.symbol, 'BTCUSDT');
      assert.strictEqual(result.params.side, 'Buy');
      assert.ok(!result.params.signature); // No signature in params

      // Headers contain all Bybit auth fields
      assert.strictEqual(result.headers['X-BAPI-API-KEY'], 'mykey');
      assert.strictEqual(result.headers['X-BAPI-SIGN-TYPE'], '2');
      assert.strictEqual(result.headers['X-BAPI-TIMESTAMP'], '1700000000000');
      assert.strictEqual(result.headers['X-BAPI-RECV-WINDOW'], '5000');
      assert.ok(result.headers['X-BAPI-SIGN']);
      assert.strictEqual(result.headers['X-BAPI-SIGN'].length, 64); // SHA256 hex
    } finally {
      Date.now = origDateNow;
    }
  });

  it('_sign() uses JSON payload for POST', () => {
    const ex = new Bybit({ apiKey: 'key', secret: 'secret' });
    const origDateNow = Date.now;
    Date.now = () => 1700000000000;

    try {
      const params = { symbol: 'BTCUSDT', qty: '0.01' };
      const result1 = ex._sign('/test', 'POST', { ...params });
      const result2 = ex._sign('/test', 'POST', { ...params });

      // Same input → same signature (deterministic)
      assert.strictEqual(result1.headers['X-BAPI-SIGN'], result2.headers['X-BAPI-SIGN']);
    } finally {
      Date.now = origDateNow;
    }
  });

  it('_sign() uses query string payload for GET', () => {
    const ex = new Bybit({ apiKey: 'key', secret: 'secret' });
    const origDateNow = Date.now;
    Date.now = () => 1700000000000;

    try {
      // GET and POST with same params should produce different signatures
      // because GET uses URLSearchParams, POST uses JSON.stringify
      const params = { symbol: 'BTCUSDT', limit: '50' };
      const resultGet = ex._sign('/test', 'GET', { ...params });
      const resultPost = ex._sign('/test', 'POST', { ...params });

      assert.notStrictEqual(
        resultGet.headers['X-BAPI-SIGN'],
        resultPost.headers['X-BAPI-SIGN']
      );
    } finally {
      Date.now = origDateNow;
    }
  });

  it('_sign() throws without credentials', () => {
    const ex = new Bybit();
    assert.throws(() => ex._sign('/test', 'GET', {}), /apiKey required/);
  });

  it('checkRequiredCredentials throws without apiKey', () => {
    const ex = new Bybit();
    assert.throws(() => ex.checkRequiredCredentials(), /apiKey required/);
  });

  it('checkRequiredCredentials passes with both', () => {
    const ex = new Bybit({ apiKey: 'key', secret: 'sec' });
    assert.doesNotThrow(() => ex.checkRequiredCredentials());
  });
});

// =====================================================================
// 4. Response Unwrapping — _unwrapResponse()
// =====================================================================

describe('Bybit Response Unwrapping', () => {
  const { Bybit, ExchangeError, BadRequest, AuthenticationError } = require('../');

  let ex;
  beforeEach(() => { ex = new Bybit(); });

  it('unwraps successful response (retCode=0)', () => {
    const data = { retCode: 0, retMsg: 'OK', result: { list: [1, 2, 3] }, time: 1700000000000 };
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, { list: [1, 2, 3] });
  });

  it('throws on non-zero retCode', () => {
    const data = { retCode: 10001, retMsg: 'Bad request', result: null };
    assert.throws(() => ex._unwrapResponse(data), BadRequest);
  });

  it('returns data as-is if no retCode', () => {
    const data = { foo: 'bar' };
    assert.deepStrictEqual(ex._unwrapResponse(data), { foo: 'bar' });
  });

  it('returns non-object data as-is', () => {
    assert.strictEqual(ex._unwrapResponse('plain text'), 'plain text');
  });
});

// =====================================================================
// 5. Parsers
// =====================================================================

describe('Bybit Parsers', () => {
  const { Bybit } = require('../');
  let ex;

  beforeEach(() => {
    ex = new Bybit({ apiKey: 'k', secret: 's' });
  });

  describe('_parseTicker()', () => {
    it('parses Bybit V5 ticker data', () => {
      const raw = {
        symbol: 'BTCUSDT',
        lastPrice: '97500.00',
        highPrice24h: '98200.00',
        lowPrice24h: '96800.00',
        prevPrice24h: '97000.00',
        bid1Price: '97499.50',
        bid1Size: '1.5',
        ask1Price: '97500.50',
        ask1Size: '0.8',
        volume24h: '12345.678',
        turnover24h: '1204567890.12',
        price24hPcnt: '0.00515',
      };

      const ticker = ex._parseTicker(raw);
      assert.strictEqual(ticker.symbol, 'BTCUSDT');
      assert.strictEqual(ticker.last, 97500);
      assert.strictEqual(ticker.high, 98200);
      assert.strictEqual(ticker.low, 96800);
      assert.strictEqual(ticker.open, 97000);
      assert.strictEqual(ticker.bid, 97499.5);
      assert.strictEqual(ticker.bidVolume, 1.5);
      assert.strictEqual(ticker.ask, 97500.5);
      assert.strictEqual(ticker.askVolume, 0.8);
      assert.strictEqual(ticker.volume, 12345.678);
      assert.strictEqual(ticker.quoteVolume, 1204567890.12);
      assert.strictEqual(ticker.change, 500); // 97500 - 97000
      assert.ok(ticker.percentage); // 0.00515 * 100 = 0.515
      assert.ok(ticker.datetime);
      assert.deepStrictEqual(ticker.info, raw);
    });
  });

  describe('_parseWsTicker()', () => {
    it('delegates to _parseTicker', () => {
      const raw = {
        symbol: 'ETHUSDT', lastPrice: '3500.00',
        bid1Price: '3499.90', ask1Price: '3500.10',
        highPrice24h: '3600', lowPrice24h: '3400',
        volume24h: '500000', turnover24h: '1750000000',
        prevPrice24h: '3450.00', price24hPcnt: '0.01449',
      };
      const ticker = ex._parseWsTicker(raw);
      assert.strictEqual(ticker.symbol, 'ETHUSDT');
      assert.strictEqual(ticker.last, 3500);
      assert.strictEqual(ticker.bid, 3499.9);
    });
  });

  describe('_parseOrder()', () => {
    it('parses Bybit V5 order response', () => {
      const raw = {
        orderId: 'abcdef123456',
        orderLinkId: 'myOrder1',
        symbol: 'BTCUSDT',
        orderType: 'Limit',
        side: 'Buy',
        price: '95000.00',
        qty: '0.01',
        cumExecQty: '0.005',
        cumExecValue: '475.00',
        avgPrice: '95000.00',
        orderStatus: 'PartiallyFilled',
        timeInForce: 'GTC',
        createdTime: '1700000000000',
      };

      const order = ex._parseOrder(raw);
      assert.strictEqual(order.id, 'abcdef123456');
      assert.strictEqual(order.clientOrderId, 'myOrder1');
      assert.strictEqual(order.symbol, 'BTCUSDT');
      assert.strictEqual(order.type, 'LIMIT');    // Normalized to UPPER
      assert.strictEqual(order.side, 'BUY');       // Normalized to UPPER
      assert.strictEqual(order.price, 95000);
      assert.strictEqual(order.amount, 0.01);
      assert.strictEqual(order.filled, 0.005);
      assert.strictEqual(order.remaining, 0.005);
      assert.strictEqual(order.cost, 475);
      assert.strictEqual(order.average, 95000);
      assert.strictEqual(order.status, 'PARTIALLY_FILLED');
      assert.strictEqual(order.timeInForce, 'GTC');
      assert.ok(order.datetime);
      assert.deepStrictEqual(order.info, raw);
    });

    it('handles fully filled order', () => {
      const raw = {
        orderId: '999',
        symbol: 'ETHUSDT',
        orderType: 'Market',
        side: 'Sell',
        price: '0.00',
        qty: '1.00',
        cumExecQty: '1.00',
        cumExecValue: '3500.00',
        avgPrice: '3500.00',
        orderStatus: 'Filled',
        createdTime: '1700000000000',
      };

      const order = ex._parseOrder(raw);
      assert.strictEqual(order.type, 'MARKET');
      assert.strictEqual(order.side, 'SELL');
      assert.strictEqual(order.filled, 1);
      assert.strictEqual(order.remaining, 0);
      assert.strictEqual(order.average, 3500);
      assert.strictEqual(order.status, 'FILLED');
    });

    it('handles canceled order', () => {
      const raw = {
        orderId: '888',
        symbol: 'BTCUSDT',
        orderType: 'Limit',
        side: 'Buy',
        qty: '0.01',
        cumExecQty: '0',
        cumExecValue: '0',
        orderStatus: 'Cancelled',
        createdTime: '1700000000000',
      };
      const order = ex._parseOrder(raw);
      assert.strictEqual(order.status, 'CANCELED');
    });
  });

  describe('_parseOrderCreateResult()', () => {
    it('parses create order response', () => {
      const raw = {
        orderId: 'abc123',
        orderLinkId: 'client-id-1',
        symbol: 'BTCUSDT',
      };
      const result = ex._parseOrderCreateResult(raw);
      assert.strictEqual(result.id, 'abc123');
      assert.strictEqual(result.clientOrderId, 'client-id-1');
      assert.strictEqual(result.status, 'NEW');
    });
  });

  describe('_parseWsOrder()', () => {
    it('parses WebSocket order and adds event field', () => {
      const raw = {
        orderId: 'ws-order-1',
        symbol: 'BTCUSDT',
        orderType: 'Limit',
        side: 'Buy',
        qty: '0.01',
        cumExecQty: '0.01',
        cumExecValue: '950.00',
        avgPrice: '95000.00',
        orderStatus: 'Filled',
        createdTime: '1700000000000',
      };
      const order = ex._parseWsOrder(raw);
      assert.strictEqual(order.event, 'order');
      assert.strictEqual(order.id, 'ws-order-1');
      assert.strictEqual(order.status, 'FILLED');
    });
  });

  describe('_parseTrade()', () => {
    it('parses public trade (REST)', () => {
      const raw = {
        execId: '2100000000070478873',
        symbol: 'BTCUSDT',
        price: '97500.00',
        size: '0.01',
        side: 'Buy',
        time: '1700000000000',
        isBlockTrade: false,
      };

      const trade = ex._parseTrade(raw, 'BTCUSDT');
      assert.strictEqual(trade.id, '2100000000070478873');
      assert.strictEqual(trade.symbol, 'BTCUSDT');
      assert.strictEqual(trade.price, 97500);
      assert.strictEqual(trade.amount, 0.01);
      assert.strictEqual(trade.cost, 975);
      assert.strictEqual(trade.side, 'buy');
      assert.ok(trade.datetime);
    });
  });

  describe('_parseMyTrade()', () => {
    it('parses private trade (execution)', () => {
      const raw = {
        execId: 'e-111',
        orderId: 'o-222',
        symbol: 'BTCUSDT',
        execPrice: '97500.00',
        execQty: '0.01',
        execValue: '975.00',
        execFee: '0.975',
        feeCurrency: 'USDT',
        execTime: '1700000000000',
        side: 'Buy',
        isMaker: false,
      };

      const trade = ex._parseMyTrade(raw);
      assert.strictEqual(trade.id, 'e-111');
      assert.strictEqual(trade.orderId, 'o-222');
      assert.strictEqual(trade.symbol, 'BTCUSDT');
      assert.strictEqual(trade.price, 97500);
      assert.strictEqual(trade.amount, 0.01);
      assert.strictEqual(trade.cost, 975);
      assert.strictEqual(trade.fee.cost, 0.975);
      assert.strictEqual(trade.fee.currency, 'USDT');
      assert.strictEqual(trade.side, 'buy');
      assert.strictEqual(trade.isMaker, false);
    });
  });
});

// =====================================================================
// 6. Helper Methods
// =====================================================================

describe('Bybit Helper Methods', () => {
  const { Bybit } = require('../');

  it('_toTitleCase converts correctly', () => {
    const ex = new Bybit();
    assert.strictEqual(ex._toTitleCase('BUY'), 'Buy');
    assert.strictEqual(ex._toTitleCase('sell'), 'Sell');
    assert.strictEqual(ex._toTitleCase('LIMIT'), 'Limit');
    assert.strictEqual(ex._toTitleCase('market'), 'Market');
  });

  it('_normalizeStatus maps Bybit statuses', () => {
    const ex = new Bybit();
    assert.strictEqual(ex._normalizeStatus('New'), 'NEW');
    assert.strictEqual(ex._normalizeStatus('PartiallyFilled'), 'PARTIALLY_FILLED');
    assert.strictEqual(ex._normalizeStatus('Filled'), 'FILLED');
    assert.strictEqual(ex._normalizeStatus('Cancelled'), 'CANCELED');
    assert.strictEqual(ex._normalizeStatus('Rejected'), 'REJECTED');
    assert.strictEqual(ex._normalizeStatus('Untriggered'), 'NEW');
    assert.strictEqual(ex._normalizeStatus('Deactivated'), 'CANCELED');
  });

  it('_countDecimals counts correctly', () => {
    const ex = new Bybit();
    assert.strictEqual(ex._countDecimals('0.01'), 2);
    assert.strictEqual(ex._countDecimals('0.00001'), 5);
    assert.strictEqual(ex._countDecimals('1'), 0);
    assert.strictEqual(ex._countDecimals('0.00000001'), 8);
  });
});

// =====================================================================
// 7. Error Mapping — _handleBybitError()
// =====================================================================

describe('Bybit Error Mapping', () => {
  const {
    Bybit, AuthenticationError, RateLimitExceeded,
    InsufficientFunds, OrderNotFound, BadSymbol,
    InvalidOrder, ExchangeError, BadRequest,
    ExchangeNotAvailable,
  } = require('../');

  let ex;
  beforeEach(() => { ex = new Bybit(); });

  it('maps 10003 to AuthenticationError', () => {
    assert.throws(
      () => ex._handleBybitError(10003, 'Invalid apiKey'),
      AuthenticationError
    );
  });

  it('maps 10004 to AuthenticationError (invalid sign)', () => {
    assert.throws(
      () => ex._handleBybitError(10004, 'Invalid sign'),
      AuthenticationError
    );
  });

  it('maps 10005 to AuthenticationError (permission denied)', () => {
    assert.throws(
      () => ex._handleBybitError(10005, 'Permission denied'),
      AuthenticationError
    );
  });

  it('maps 10006 to RateLimitExceeded', () => {
    assert.throws(
      () => ex._handleBybitError(10006, 'Too many visits'),
      RateLimitExceeded
    );
  });

  it('maps 10018 to RateLimitExceeded', () => {
    assert.throws(
      () => ex._handleBybitError(10018, 'IP rate limit'),
      RateLimitExceeded
    );
  });

  it('maps 10001 to BadRequest', () => {
    assert.throws(
      () => ex._handleBybitError(10001, 'Bad request'),
      BadRequest
    );
  });

  it('maps 10000 to ExchangeNotAvailable', () => {
    assert.throws(
      () => ex._handleBybitError(10000, 'Server error'),
      ExchangeNotAvailable
    );
  });

  it('maps 110001 to OrderNotFound', () => {
    assert.throws(
      () => ex._handleBybitError(110001, 'Order not found'),
      OrderNotFound
    );
  });

  it('maps 110003 to InvalidOrder', () => {
    assert.throws(
      () => ex._handleBybitError(110003, 'Invalid order'),
      InvalidOrder
    );
  });

  it('maps 110004 to InsufficientFunds', () => {
    assert.throws(
      () => ex._handleBybitError(110004, 'Insufficient balance'),
      InsufficientFunds
    );
  });

  it('maps 170131 to InsufficientFunds', () => {
    assert.throws(
      () => ex._handleBybitError(170131, 'Insufficient balance for spot'),
      InsufficientFunds
    );
  });

  it('maps 170121 to BadSymbol', () => {
    assert.throws(
      () => ex._handleBybitError(170121, 'Invalid symbol'),
      BadSymbol
    );
  });

  it('falls back to ExchangeError for unknown codes', () => {
    assert.throws(
      () => ex._handleBybitError(99999, 'Unknown error'),
      ExchangeError
    );
  });
});

// =====================================================================
// 8. HTTP Error Handling
// =====================================================================

describe('Bybit HTTP Error Handling', () => {
  const {
    Bybit, AuthenticationError, RateLimitExceeded, ExchangeError, InsufficientFunds,
  } = require('../');

  let ex;
  beforeEach(() => { ex = new Bybit(); });

  it('handles 401 as AuthenticationError', () => {
    assert.throws(
      () => ex._handleHttpError(401, 'Unauthorized'),
      AuthenticationError
    );
  });

  it('handles 403 as AuthenticationError', () => {
    assert.throws(
      () => ex._handleHttpError(403, 'Forbidden'),
      AuthenticationError
    );
  });

  it('handles 429 as RateLimitExceeded', () => {
    assert.throws(
      () => ex._handleHttpError(429, 'Too Many Requests'),
      RateLimitExceeded
    );
  });

  it('handles JSON body with retCode', () => {
    assert.throws(
      () => ex._handleHttpError(400, JSON.stringify({ retCode: 110004, retMsg: 'Insufficient' })),
      InsufficientFunds
    );
  });

  it('handles non-JSON body', () => {
    assert.throws(
      () => ex._handleHttpError(500, 'Internal Server Error'),
      ExchangeError
    );
  });
});

// =====================================================================
// 9. Rate Limit Header Handling
// =====================================================================

describe('Bybit Rate Limit Header Handling', () => {
  const { Bybit } = require('../');

  it('updates throttler from response headers', () => {
    const ex = new Bybit();
    const mockHeaders = {
      get: (key) => {
        const map = {
          'x-bapi-limit': '120',
          'x-bapi-limit-status': '100',
          'x-bapi-limit-reset-timestamp': '1700000060000',
        };
        return map[key] || null;
      },
    };

    // Should not throw
    ex._handleResponseHeaders(mockHeaders);
  });

  it('emits rateLimitWarning when remaining < 20%', () => {
    const ex = new Bybit();
    let warned = false;
    ex.on('rateLimitWarning', (data) => {
      warned = true;
      assert.strictEqual(data.limit, 120);
      assert.strictEqual(data.remaining, 10);
      assert.strictEqual(data.used, 110);
    });

    const mockHeaders = {
      get: (key) => {
        const map = {
          'x-bapi-limit': '120',
          'x-bapi-limit-status': '10',  // 10 remaining out of 120 = 8.3% < 20%
          'x-bapi-limit-reset-timestamp': '1700000060000',
        };
        return map[key] || null;
      },
    };

    ex._handleResponseHeaders(mockHeaders);
    assert.ok(warned, 'should have emitted rateLimitWarning');
  });

  it('does NOT emit warning when remaining > 20%', () => {
    const ex = new Bybit();
    let warned = false;
    ex.on('rateLimitWarning', () => { warned = true; });

    const mockHeaders = {
      get: (key) => {
        const map = {
          'x-bapi-limit': '120',
          'x-bapi-limit-status': '100', // 100/120 = 83% remaining, well above 20%
        };
        return map[key] || null;
      },
    };

    ex._handleResponseHeaders(mockHeaders);
    assert.ok(!warned, 'should NOT have emitted rateLimitWarning');
  });
});

// =====================================================================
// 10. Mocked API Calls
// =====================================================================

describe('Bybit API Methods (mocked)', () => {
  const { Bybit, BadSymbol, OrderNotFound, BadRequest } = require('../');
  let ex;

  beforeEach(() => {
    ex = new Bybit({ apiKey: 'testkey', secret: 'testsecret' });
  });

  describe('loadMarkets()', () => {
    it('parses instruments-info into unified market format', async () => {
      ex._request = async () => ({
        retCode: 0, retMsg: 'OK',
        result: {
          list: [
            {
              symbol: 'BTCUSDT',
              baseCoin: 'BTC',
              quoteCoin: 'USDT',
              status: 'Trading',
              lotSizeFilter: {
                basePrecision: '0.000001',
                minOrderQty: '0.000048',
                maxOrderQty: '71.73956243',
                minOrderAmt: '1',
                maxOrderAmt: '4000000',
              },
              priceFilter: {
                tickSize: '0.01',
                minPrice: '0.01',
                maxPrice: '9999999.99',
              },
            },
            {
              symbol: 'ETHUSDT',
              baseCoin: 'ETH',
              quoteCoin: 'USDT',
              status: 'Trading',
              lotSizeFilter: {
                basePrecision: '0.00001',
                minOrderQty: '0.00028',
                maxOrderQty: '1200.00',
                minOrderAmt: '1',
                maxOrderAmt: '4000000',
              },
              priceFilter: {
                tickSize: '0.01',
                minPrice: '0.01',
                maxPrice: '999999.99',
              },
            },
          ],
        },
      });

      const markets = await ex.loadMarkets();

      assert.ok(markets.BTCUSDT);
      assert.ok(markets.ETHUSDT);
      assert.strictEqual(ex.symbols.length, 2);
      assert.ok(ex._marketsLoaded);

      const btc = markets.BTCUSDT;
      assert.strictEqual(btc.base, 'BTC');
      assert.strictEqual(btc.quote, 'USDT');
      assert.strictEqual(btc.active, true);
      assert.strictEqual(btc.tickSize, 0.01);
      assert.strictEqual(btc.limits.amount.min, 0.000048);
      assert.strictEqual(btc.limits.cost.min, 1);
    });

    it('returns cached markets on second call', async () => {
      let callCount = 0;
      ex._request = async () => {
        callCount++;
        return { retCode: 0, retMsg: 'OK', result: { list: [] } };
      };

      await ex.loadMarkets();
      await ex.loadMarkets();
      assert.strictEqual(callCount, 1, 'should only fetch once');
    });

    it('reloads when forced', async () => {
      let callCount = 0;
      ex._request = async () => {
        callCount++;
        return { retCode: 0, retMsg: 'OK', result: { list: [] } };
      };

      await ex.loadMarkets();
      await ex.loadMarkets(true);
      assert.strictEqual(callCount, 2, 'should fetch twice with reload=true');
    });
  });

  describe('fetchTicker()', () => {
    it('returns parsed Bybit ticker', async () => {
      ex._request = async (method, path, params) => {
        assert.strictEqual(method, 'GET');
        assert.strictEqual(path, '/v5/market/tickers');
        assert.strictEqual(params.symbol, 'BTCUSDT');
        assert.strictEqual(params.category, 'spot');
        return {
          retCode: 0, retMsg: 'OK',
          result: {
            list: [{
              symbol: 'BTCUSDT',
              lastPrice: '97500.00',
              highPrice24h: '98000.00',
              lowPrice24h: '97000.00',
              prevPrice24h: '97200.00',
              bid1Price: '97499.00',
              bid1Size: '1.0',
              ask1Price: '97501.00',
              ask1Size: '0.5',
              volume24h: '10000.00',
              turnover24h: '975000000.00',
              price24hPcnt: '0.00308',
            }],
          },
        };
      };

      const ticker = await ex.fetchTicker('BTCUSDT');
      assert.strictEqual(ticker.symbol, 'BTCUSDT');
      assert.strictEqual(ticker.last, 97500);
      assert.strictEqual(ticker.bid, 97499);
      assert.strictEqual(ticker.ask, 97501);
    });

    it('throws BadSymbol when symbol not found', async () => {
      ex._request = async () => ({
        retCode: 0, retMsg: 'OK',
        result: { list: [] },
      });

      await assert.rejects(() => ex.fetchTicker('FAKECOIN'), BadSymbol);
    });
  });

  describe('fetchOrderBook()', () => {
    it('returns unified order book', async () => {
      ex._request = async (method, path, params) => {
        assert.strictEqual(method, 'GET');
        assert.strictEqual(path, '/v5/market/orderbook');
        assert.strictEqual(params.symbol, 'BTCUSDT');
        return {
          retCode: 0, retMsg: 'OK',
          result: {
            s: 'BTCUSDT',
            b: [['97500.00', '1.5'], ['97499.00', '2.0']],
            a: [['97501.00', '0.8'], ['97502.00', '1.2']],
            ts: 1700000000000,
            u: 123456789,
          },
        };
      };

      const book = await ex.fetchOrderBook('BTCUSDT', 50);
      assert.strictEqual(book.symbol, 'BTCUSDT');
      assert.strictEqual(book.bids[0][0], 97500);
      assert.strictEqual(book.bids[0][1], 1.5);
      assert.strictEqual(book.asks[0][0], 97501);
      assert.strictEqual(book.nonce, 123456789);
      assert.ok(book.datetime);
    });
  });

  describe('fetchOHLCV()', () => {
    it('returns OHLCV arrays in chronological order', async () => {
      ex._request = async () => ({
        retCode: 0, retMsg: 'OK',
        result: {
          list: [
            // Bybit returns newest first
            ['1700003600000', '97200.00', '97500.00', '97100.00', '97400.00', '80.00', '7776000.00'],
            ['1700000000000', '97000.00', '97500.00', '96800.00', '97200.00', '100.00', '9720000.00'],
          ],
        },
      });

      const candles = await ex.fetchOHLCV('BTCUSDT', '1h', undefined, 2);
      assert.strictEqual(candles.length, 2);
      // Should be reversed to chronological
      assert.strictEqual(candles[0][0], 1700000000000);  // oldest first
      assert.strictEqual(candles[1][0], 1700003600000);   // newest second
      assert.strictEqual(candles[0][1], 97000);            // open
      assert.strictEqual(candles[0][2], 97500);            // high
      assert.strictEqual(candles[0][3], 96800);            // low
      assert.strictEqual(candles[0][4], 97200);            // close
      assert.strictEqual(candles[0][5], 100);              // volume
    });
  });

  describe('fetchTrades()', () => {
    it('returns parsed public trades', async () => {
      ex._request = async () => ({
        retCode: 0, retMsg: 'OK',
        result: {
          list: [
            { execId: 't-1', symbol: 'BTCUSDT', price: '97500.00', size: '0.5', side: 'Buy', time: '1700000000000' },
          ],
        },
      });

      const trades = await ex.fetchTrades('BTCUSDT', undefined, 1);
      assert.strictEqual(trades.length, 1);
      assert.strictEqual(trades[0].price, 97500);
      assert.strictEqual(trades[0].amount, 0.5);
      assert.strictEqual(trades[0].side, 'buy');
    });
  });

  describe('createOrder()', () => {
    it('builds correct request for Limit order', async () => {
      let capturedRequest;
      ex._request = async (method, path, params) => {
        capturedRequest = { method, path, params };
        return {
          retCode: 0, retMsg: 'OK',
          result: {
            orderId: 'order-abc-123',
            orderLinkId: '',
          },
        };
      };

      const order = await ex.createOrder('btcusdt', 'LIMIT', 'BUY', 0.001, 95000);
      assert.strictEqual(capturedRequest.method, 'POST');
      assert.strictEqual(capturedRequest.path, '/v5/order/create');
      assert.strictEqual(capturedRequest.params.symbol, 'BTCUSDT');
      assert.strictEqual(capturedRequest.params.side, 'Buy');       // Title case
      assert.strictEqual(capturedRequest.params.orderType, 'Limit'); // Title case
      assert.strictEqual(capturedRequest.params.qty, '0.001');
      assert.strictEqual(capturedRequest.params.price, '95000');
      assert.strictEqual(capturedRequest.params.timeInForce, 'GTC');
      assert.strictEqual(capturedRequest.params.category, 'spot');

      assert.strictEqual(order.id, 'order-abc-123');
      assert.strictEqual(order.status, 'NEW');
    });

    it('builds correct request for Market order (no price, no timeInForce)', async () => {
      let capturedParams;
      ex._request = async (method, path, params) => {
        capturedParams = params;
        return {
          retCode: 0, retMsg: 'OK',
          result: { orderId: 'market-order-1', orderLinkId: '' },
        };
      };

      await ex.createMarketOrder('BTCUSDT', 'SELL', 0.01);
      assert.strictEqual(capturedParams.orderType, 'Market');
      assert.strictEqual(capturedParams.side, 'Sell');
      assert.ok(!capturedParams.price);       // No price for market
      assert.ok(!capturedParams.timeInForce);  // No timeInForce for market
    });
  });

  describe('cancelOrder()', () => {
    it('sends POST with correct params (not DELETE)', async () => {
      let capturedRequest;
      ex._request = async (method, path, params) => {
        capturedRequest = { method, path, params };
        return {
          retCode: 0, retMsg: 'OK',
          result: { orderId: 'cancel-123' },
        };
      };

      const result = await ex.cancelOrder('cancel-123', 'BTCUSDT');
      assert.strictEqual(capturedRequest.method, 'POST');  // Bybit uses POST for cancel!
      assert.strictEqual(capturedRequest.path, '/v5/order/cancel');
      assert.strictEqual(capturedRequest.params.orderId, 'cancel-123');
      assert.strictEqual(capturedRequest.params.symbol, 'BTCUSDT');
      assert.strictEqual(result.status, 'CANCELED');
    });

    it('throws without symbol', async () => {
      await assert.rejects(() => ex.cancelOrder('123'), /requires symbol/);
    });
  });

  describe('fetchBalance()', () => {
    it('returns unified balance format', async () => {
      ex._request = async (method, path, params, signed) => {
        assert.strictEqual(signed, true);
        assert.strictEqual(params.accountType, 'UNIFIED');
        return {
          retCode: 0, retMsg: 'OK',
          result: {
            list: [{
              accountType: 'UNIFIED',
              coin: [
                { coin: 'BTC', walletBalance: '0.60000000', availableToWithdraw: '0.50000000', locked: '0.10000000' },
                { coin: 'USDT', walletBalance: '6000.00', availableToWithdraw: '5000.00', locked: '1000.00' },
                { coin: 'ETH', walletBalance: '0', availableToWithdraw: '0', locked: '0' },
              ],
            }],
          },
        };
      };

      const balance = await ex.fetchBalance();
      assert.ok(balance.BTC);
      assert.strictEqual(balance.BTC.free, 0.5);
      assert.strictEqual(balance.BTC.total, 0.6);
      assert.strictEqual(balance.USDT.free, 5000);
      assert.strictEqual(balance.USDT.total, 6000);
      // ETH with zero balance should be excluded
      assert.strictEqual(balance.ETH, undefined);
      assert.ok(balance.timestamp);
    });
  });

  describe('fetchTradingFees()', () => {
    it('returns fee rates for symbol', async () => {
      ex._request = async () => ({
        retCode: 0, retMsg: 'OK',
        result: {
          list: [{ symbol: 'BTCUSDT', makerFeeRate: '0.001', takerFeeRate: '0.001' }],
        },
      });

      const fees = await ex.fetchTradingFees('BTCUSDT');
      assert.strictEqual(fees.symbol, 'BTCUSDT');
      assert.strictEqual(fees.maker, 0.001);
      assert.strictEqual(fees.taker, 0.001);
    });
  });

  describe('fetchOrder()', () => {
    it('returns parsed order', async () => {
      ex._request = async () => ({
        retCode: 0, retMsg: 'OK',
        result: {
          list: [{
            orderId: 'fetch-order-1',
            symbol: 'BTCUSDT',
            orderType: 'Limit',
            side: 'Buy',
            qty: '0.01',
            cumExecQty: '0',
            cumExecValue: '0',
            orderStatus: 'New',
            createdTime: '1700000000000',
          }],
        },
      });

      const order = await ex.fetchOrder('fetch-order-1', 'BTCUSDT');
      assert.strictEqual(order.id, 'fetch-order-1');
      assert.strictEqual(order.status, 'NEW');
    });

    it('throws OrderNotFound when not found', async () => {
      ex._request = async () => ({
        retCode: 0, retMsg: 'OK',
        result: { list: [] },
      });

      await assert.rejects(() => ex.fetchOrder('nonexistent'), OrderNotFound);
    });
  });

  describe('fetchOpenOrders()', () => {
    it('returns array of open orders', async () => {
      ex._request = async () => ({
        retCode: 0, retMsg: 'OK',
        result: {
          list: [
            { orderId: '1', symbol: 'BTCUSDT', orderType: 'Limit', side: 'Buy', qty: '0.01', cumExecQty: '0', cumExecValue: '0', orderStatus: 'New', createdTime: '1700000000000' },
            { orderId: '2', symbol: 'ETHUSDT', orderType: 'Limit', side: 'Sell', qty: '1', cumExecQty: '0', cumExecValue: '0', orderStatus: 'New', createdTime: '1700000000000' },
          ],
        },
      });

      const orders = await ex.fetchOpenOrders();
      assert.strictEqual(orders.length, 2);
      assert.strictEqual(orders[0].id, '1');
      assert.strictEqual(orders[1].id, '2');
    });
  });

  describe('fetchMyTrades()', () => {
    it('returns parsed trades', async () => {
      ex._request = async () => ({
        retCode: 0, retMsg: 'OK',
        result: {
          list: [{
            execId: 'exec-1',
            orderId: 'order-1',
            symbol: 'BTCUSDT',
            execPrice: '97500.00',
            execQty: '0.01',
            execValue: '975.00',
            execFee: '0.975',
            feeCurrency: 'USDT',
            execTime: '1700000000000',
            side: 'Buy',
            isMaker: true,
          }],
        },
      });

      const trades = await ex.fetchMyTrades('BTCUSDT', undefined, 1);
      assert.strictEqual(trades.length, 1);
      assert.strictEqual(trades[0].price, 97500);
      assert.strictEqual(trades[0].fee.cost, 0.975);
      assert.strictEqual(trades[0].isMaker, true);
    });
  });

  describe('fetchTime()', () => {
    it('returns server time in milliseconds', async () => {
      ex._request = async () => ({
        retCode: 0, retMsg: 'OK',
        result: { timeSecond: '1700000000', timeNano: '1700000000000000000' },
      });

      const time = await ex.fetchTime();
      assert.strictEqual(time, 1700000000000);
    });
  });
});

// =====================================================================
// 11. Bybit market() lookup
// =====================================================================

describe('Bybit market() lookup', () => {
  const { Bybit, ExchangeError } = require('../');

  it('throws if markets not loaded', () => {
    const ex = new Bybit();
    assert.throws(() => ex.market('BTCUSDT'), /markets not loaded/);
  });

  it('throws for unknown symbol', async () => {
    const ex = new Bybit();
    ex._request = async () => ({ retCode: 0, retMsg: 'OK', result: { list: [] } });
    await ex.loadMarkets();
    assert.throws(() => ex.market('FAKECOIN'), /unknown symbol/);
  });

  it('returns market for valid symbol', async () => {
    const ex = new Bybit();
    ex._request = async () => ({
      retCode: 0, retMsg: 'OK',
      result: {
        list: [{
          symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'Trading',
          lotSizeFilter: { basePrecision: '0.000001', minOrderQty: '0.000048', maxOrderQty: '71' },
          priceFilter: { tickSize: '0.01' },
        }],
      },
    });
    await ex.loadMarkets();
    const m = ex.market('BTCUSDT');
    assert.strictEqual(m.base, 'BTC');
    assert.strictEqual(m.quote, 'USDT');
    assert.strictEqual(m.active, true);
  });
});

// =====================================================================
// 12. Bybit vs Binance — Key Differences Verified
// =====================================================================

describe('Bybit vs Binance — Key Architectural Differences', () => {
  const { Binance, Bybit } = require('../');

  it('Bybit uses JSON POST body, Binance uses query string', () => {
    const binance = new Binance();
    const bybit = new Bybit();
    assert.strictEqual(binance.postAsJson, false);
    assert.strictEqual(bybit.postAsJson, true);
  });

  it('Bybit cancel is POST, Binance cancel is DELETE', async () => {
    const bybit = new Bybit({ apiKey: 'k', secret: 's' });
    let capturedMethod;
    bybit._request = async (method) => {
      capturedMethod = method;
      return { retCode: 0, retMsg: 'OK', result: { orderId: '1' } };
    };
    await bybit.cancelOrder('1', 'BTCUSDT');
    assert.strictEqual(capturedMethod, 'POST');
  });

  it('Bybit uses Title case side/type, Binance uses UPPERCASE', async () => {
    const bybit = new Bybit({ apiKey: 'k', secret: 's' });
    let capturedParams;
    bybit._request = async (method, path, params) => {
      capturedParams = params;
      return { retCode: 0, retMsg: 'OK', result: { orderId: '1' } };
    };
    await bybit.createOrder('BTCUSDT', 'LIMIT', 'BUY', 0.01, 95000);
    assert.strictEqual(capturedParams.side, 'Buy');          // Title case
    assert.strictEqual(capturedParams.orderType, 'Limit');   // Title case
  });

  it('Bybit requires category parameter', async () => {
    const bybit = new Bybit({ apiKey: 'k', secret: 's' });
    let capturedParams;
    bybit._request = async (method, path, params) => {
      capturedParams = params;
      return { retCode: 0, retMsg: 'OK', result: { orderId: '1' } };
    };
    await bybit.createOrder('BTCUSDT', 'LIMIT', 'BUY', 0.01, 95000);
    assert.strictEqual(capturedParams.category, 'spot');
  });

  it('different signing schemes', () => {
    const binance = new Binance({ apiKey: 'k', secret: 's' });
    const bybit = new Bybit({ apiKey: 'k', secret: 's' });

    const origDateNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const binanceSign = binance._sign('/test', 'GET', { symbol: 'BTCUSDT' });
      const bybitSign = bybit._sign('/test', 'GET', { symbol: 'BTCUSDT' });

      // Binance puts signature in params
      assert.ok(binanceSign.params.signature);
      // Bybit puts signature in headers
      assert.ok(bybitSign.headers['X-BAPI-SIGN']);
      assert.ok(!bybitSign.params.signature); // No signature in params
    } finally {
      Date.now = origDateNow;
    }
  });
});

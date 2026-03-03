# Adding a New Exchange

## Overview

Every exchange in YGCC extends `BaseExchange`. To add a new exchange, you create a single file in `lib/` that implements the exchange's authentication, market loading, parsing logic, and trading methods. The unified API surface means every exchange exposes the same method signatures to consumers.

---

## Minimal Template

Create `lib/myexchange.js` with the following structure:

```javascript
'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA256 } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, safeFloat2, safeString2,
  buildQueryRaw, iso8601, sleep,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class MyExchange extends BaseExchange {

  describe() {
    return {
      id: 'myexchange',
      name: 'MyExchange',
      version: 'v1',
      rateLimit: 50,
      rateLimitCapacity: 1200,
      rateLimitInterval: 60000,
      has: {
        // Public
        loadMarkets: true,
        fetchTicker: true,
        fetchTickers: true,
        fetchOrderBook: true,
        fetchTrades: true,
        fetchOHLCV: true,
        // Private
        createOrder: true,
        createLimitOrder: true,
        createMarketOrder: true,
        cancelOrder: true,
        fetchOrder: true,
        fetchOpenOrders: true,
        fetchBalance: true,
        // WebSocket
        watchTicker: true,
        watchOrderBook: true,
        watchTrades: true,
      },
      urls: {
        api: 'https://api.myexchange.com',
        ws: 'wss://ws.myexchange.com',
        doc: 'https://docs.myexchange.com',
        test: {
          api: 'https://testnet.myexchange.com',
          ws: 'wss://testnet-ws.myexchange.com',
        },
      },
      timeframes: {
        '1m': '1min', '5m': '5min', '15m': '15min',
        '1h': '60min', '4h': '4hour', '1d': '1day',
      },
      fees: {
        trading: { maker: 0.001, taker: 0.001 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    // Use testnet if configured
    if (this.options.test || this.options.sandbox) {
      this.urls.api = this.urls.test.api;
      this.urls.ws = this.urls.test.ws;
    }
  }

  // =========================================================================
  // AUTHENTICATION
  // =========================================================================

  _sign(path, method, params) {
    this.checkRequiredCredentials();
    params.timestamp = Date.now();
    const queryString = buildQueryRaw(params);
    const signature = hmacSHA256(queryString, this.secret);
    params.signature = signature;
    return {
      params,
      headers: { 'X-API-KEY': this.apiKey },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  _handleHttpError(status, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    const code = parsed?.code;
    const msg = parsed?.msg || body;
    const full = this.id + ' ' + (code || status) + ': ' + msg;

    const errorMap = {
      1001: AuthenticationError,
      1002: RateLimitExceeded,
      2001: InsufficientFunds,
      2002: InvalidOrder,
      2003: OrderNotFound,
      3001: BadSymbol,
    };

    const ErrorClass = errorMap[code] || ExchangeError;
    throw new ErrorClass(full);
  }

  // =========================================================================
  // MARKET DATA
  // =========================================================================

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;
    const data = await this._request('GET', '/api/v1/exchangeInfo');
    this.markets = {};
    this.marketsById = {};
    this.symbols = [];
    for (const entry of data.symbols) {
      const base = entry.baseAsset;
      const quote = entry.quoteAsset;
      const symbol = base + '/' + quote;
      const market = {
        id: entry.symbol,
        symbol,
        base,
        quote,
        active: entry.status === 'TRADING',
        precision: { amount: entry.quantityPrecision, price: entry.pricePrecision },
      };
      this.markets[symbol] = market;
      this.marketsById[market.id] = market;
      this.symbols.push(symbol);
    }
    this._marketsLoaded = true;
    return this.markets;
  }

  async fetchTicker(symbol) {
    const market = this.market(symbol);
    const data = await this._request('GET', '/api/v1/ticker/24hr', { symbol: market.id });
    return this._parseTicker(data, market);
  }

  async fetchOrderBook(symbol, limit = 100) {
    const market = this.market(symbol);
    const data = await this._request('GET', '/api/v1/depth', { symbol: market.id, limit });
    return {
      symbol,
      bids: data.bids.map(([p, a]) => [parseFloat(p), parseFloat(a)]),
      asks: data.asks.map(([p, a]) => [parseFloat(p), parseFloat(a)]),
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };
  }

  // =========================================================================
  // TRADING
  // =========================================================================

  async createOrder(symbol, type, side, amount, price = undefined) {
    const market = this.market(symbol);
    const params = { symbol: market.id, side: side.toUpperCase(), type: type.toUpperCase(), quantity: amount };
    if (price) params.price = price;
    const data = await this._request('POST', '/api/v1/order', params, true, 1);
    return this._parseOrder(data, market);
  }

  async cancelOrder(id, symbol) {
    const market = this.market(symbol);
    const data = await this._request('DELETE', '/api/v1/order', { symbol: market.id, orderId: id }, true, 1);
    return this._parseOrder(data, market);
  }

  async fetchBalance() {
    const data = await this._request('GET', '/api/v1/account', {}, true, 10);
    return this._parseBalance(data);
  }

  // =========================================================================
  // PARSERS
  // =========================================================================

  _parseTicker(data, market) {
    return {
      symbol: market.symbol,
      timestamp: safeInteger(data, 'closeTime'),
      datetime: iso8601(safeInteger(data, 'closeTime')),
      high: safeFloat(data, 'highPrice'),
      low: safeFloat(data, 'lowPrice'),
      bid: safeFloat(data, 'bidPrice'),
      ask: safeFloat(data, 'askPrice'),
      last: safeFloat(data, 'lastPrice'),
      open: safeFloat(data, 'openPrice'),
      close: safeFloat(data, 'lastPrice'),
      baseVolume: safeFloat(data, 'volume'),
      quoteVolume: safeFloat(data, 'quoteVolume'),
      change: safeFloat(data, 'priceChange'),
      percentage: safeFloat(data, 'priceChangePercent'),
      info: data,
    };
  }

  _parseOrder(data, market) {
    return {
      id: safeString(data, 'orderId'),
      clientOrderId: safeString(data, 'clientOrderId'),
      symbol: market.symbol,
      type: safeStringUpper(data, 'type'),
      side: safeStringUpper(data, 'side'),
      amount: safeFloat(data, 'origQty'),
      price: safeFloat(data, 'price'),
      filled: safeFloat(data, 'executedQty'),
      status: safeStringUpper(data, 'status'),
      timestamp: safeInteger(data, 'transactTime'),
      datetime: iso8601(safeInteger(data, 'transactTime')),
      info: data,
    };
  }

  _parseBalance(data) {
    const result = { info: data, free: {}, used: {}, total: {} };
    for (const entry of (data.balances || [])) {
      const currency = entry.asset;
      const free = safeFloat(entry, 'free', 0);
      const used = safeFloat(entry, 'locked', 0);
      result.free[currency] = free;
      result.used[currency] = used;
      result.total[currency] = free + used;
    }
    return result;
  }
}

module.exports = MyExchange;
```

---

## Step-by-Step Guide

### Step 1: Study the Exchange API Docs

Before writing any code, read the exchange's official API documentation thoroughly. Identify:

- **Base URL** and API versioning scheme
- **Authentication method** (HMAC-SHA256, JWT, Basic Auth, etc.)
- **Symbol format** (e.g., `BTCUSDT`, `BTC-USDT`, `BTC_USDT`, `tBTCUSD`)
- **Rate limits** (requests per minute, weight system, etc.)
- **Error codes** and response format
- **WebSocket URL** and subscription message format

### Step 2: Create `lib/myexchange.js`

Create a new file extending `BaseExchange`. Import only the crypto, helper, and error modules you need:

```javascript
const BaseExchange = require('./BaseExchange');
const { hmacSHA256 } = require('./utils/crypto');
// ... import only what you need
```

### Step 3: Implement `describe()`

Return the exchange metadata object with accurate `has` flags. Only set a flag to `true` if you are implementing that method:

```javascript
describe() {
  return {
    id: 'myexchange',          // Lowercase identifier
    name: 'MyExchange',        // Display name
    version: 'v1',             // API version
    rateLimit: 50,             // Min ms between requests
    rateLimitCapacity: 1200,   // Token bucket capacity
    rateLimitInterval: 60000,  // Refill interval in ms
    has: {
      loadMarkets: true,
      fetchTicker: true,
      createOrder: true,
      // ... only methods you implement
    },
    urls: { api: '...', ws: '...', doc: '...', test: { api: '...' } },
    timeframes: { '1m': '1min', '1h': '60min', '1d': '1day' },
    fees: { trading: { maker: 0.001, taker: 0.001 } },
  };
}
```

### Step 4: Implement `_sign()`

This is the most exchange-specific part. Study the exchange's authentication docs and implement signing accordingly:

```javascript
_sign(path, method, params) {
  this.checkRequiredCredentials();
  // Build the string to sign
  // Compute the signature using the appropriate crypto function
  // Return { params, headers } with authentication data attached
  return { params, headers };
}
```

Common patterns:
- **HMAC-SHA256 query string** (Binance, Bybit): Sign the query string, append `signature` param
- **HMAC-SHA256 Base64 + passphrase** (OKX, KuCoin): Sign `timestamp + method + path + body`, send as header
- **SHA256 + HMAC-SHA512** (Kraken): Use the `krakenSign()` helper
- **JWT/ES256** (Coinbase): Use the `signJWT()` helper
- **HTTP Basic Auth** (TradeOgre): Base64-encode `apiKey:secret`

### Step 5: Implement Parsers

Create `_parseTicker()`, `_parseOrder()`, `_parseBalance()`, and other parsers that normalize exchange-specific response formats into the unified YGCC format. Use the safe accessor helpers (`safeFloat`, `safeString`, etc.) for resilient parsing:

```javascript
_parseTicker(data, market) {
  return {
    symbol: market.symbol,
    high: safeFloat(data, 'highPrice'),
    low: safeFloat(data, 'lowPrice'),
    last: safeFloat(data, 'lastPrice'),
    // ... other unified fields
    info: data,  // Always include raw response
  };
}
```

### Step 6: Add to `index.js`

Register the new exchange in the main entry point:

```javascript
// At the top with other requires:
const MyExchange = require('./lib/myexchange');

// In module.exports:
module.exports = {
  // ...existing exchanges...
  MyExchange,
  myexchange: MyExchange,  // lowercase alias (CCXT-style)

  // Add to exchange list:
  exchanges: ['binance', ..., 'myexchange'],
};
```

### Step 7: Write Tests

Create `tests/myexchange.test.js` following the established 13-section test pattern:

| # | Section | What it Tests |
|---|---------|---------------|
| 1 | Module Exports | Exchange class and lowercase alias are exported |
| 2 | Constructor & `describe()` | Default and custom config, URLs, capability flags |
| 3 | BaseExchange Abstract Guard | Cannot instantiate `BaseExchange` directly |
| 4 | Authentication (`_sign()`) | Signature generation, header injection, credential checks |
| 5 | Parsers | `_parseTicker`, `_parseOrder`, `_parseTrade`, `_parseBalance` |
| 6 | Error Mapping | `_handleHttpError()` maps codes to correct error classes |
| 7 | Rate Limit Headers | `_handleResponseHeaders()` syncs throttler state |
| 8 | Mocked API Calls | `loadMarkets`, `fetchBalance`, `createOrder`, etc. with stubbed `_request` |
| 9 | Utility Functions | `safeFloat`, `safeString`, `buildQuery`, `iso8601`, etc. |
| 10 | Crypto Utilities | HMAC, SHA, JWT functions produce expected output |
| 11 | Throttler | Token-bucket consume/refill logic |
| 12 | Error Classes | Inheritance hierarchy and `instanceof` checks |
| 13 | Market Lookup | `market()` resolves symbols correctly |

---

## Testing

Run your exchange tests with Node.js built-in test runner:

```bash
node --test tests/myexchange.test.js
```

Run all tests:

```bash
node --test tests/
```

Tests use `node:test` and `node:assert/strict` — no external test framework needed.

---

## Checklist

Before submitting a new exchange, verify:

- [ ] `describe()` returns accurate `has` flags (only `true` for implemented methods)
- [ ] `_sign()` produces valid signatures (test against exchange's reference examples)
- [ ] `_handleHttpError()` maps all known error codes
- [ ] All parsers use `safeFloat`/`safeString` for resilient data extraction
- [ ] Every parser includes `info: data` with the raw response
- [ ] `loadMarkets()` populates `this.markets`, `this.marketsById`, and `this.symbols`
- [ ] Exchange is registered in `index.js` with both PascalCase and lowercase aliases
- [ ] Exchange ID is added to the `exchanges` array in `index.js`
- [ ] Test file covers all 13 sections
- [ ] All tests pass: `node --test tests/myexchange.test.js`

# Architecture

## Project Structure

```
ygcc/
├── index.js                          # Main entry point — exports all exchanges, errors, and utilities
├── package.json
│
├── lib/
│   ├── BaseExchange.js               # Abstract base class (all exchanges extend this)
│   │
│   ├── binance.js                    # Exchange implementations (30 files)
│   ├── bybit.js
│   ├── okx.js
│   ├── kraken.js
│   ├── gateio.js
│   ├── kucoin.js
│   ├── coinbase.js
│   ├── bitfinex.js
│   ├── bitstamp.js
│   ├── bittrex.js
│   ├── bitrue.js
│   ├── lbank.js
│   ├── bitmart.js
│   ├── bitforex.js
│   ├── phemex.js
│   ├── pionex.js
│   ├── bibox.js
│   ├── whitebit.js
│   ├── valr.js
│   ├── bitexen.js
│   ├── btcturk.js
│   ├── btse.js
│   ├── exmo.js
│   ├── cointr.js
│   ├── hotcoin.js
│   ├── icrypex.js
│   ├── jbex.js
│   ├── pointpay.js
│   ├── trubit.js
│   ├── tradeogre.js
│   │
│   └── utils/
│       ├── crypto.js                 # Cryptographic signing functions
│       ├── errors.js                 # Typed error hierarchy
│       ├── helpers.js                # Safe accessors, query builders, date utils
│       ├── throttler.js              # Token-bucket rate limiter
│       └── ws.js                     # WebSocket client with auto-reconnect
│
├── tests/                            # One test file per exchange (30 files)
│   ├── binance.test.js
│   ├── bybit.test.js
│   ├── okx.test.js
│   ├── ...
│   └── tradeogre.test.js
│
├── examples/
│   ├── fetch-ticker.js               # Fetch a ticker from any exchange
│   ├── place-order.js                # Place a limit order
│   └── websocket-stream.js           # Subscribe to real-time WebSocket streams
│
└── docs/                             # Docsify documentation site
    ├── index.html
    ├── README.md
    ├── _sidebar.md
    └── *.md
```

---

## BaseExchange

`BaseExchange` is the abstract base class that every exchange implementation extends. It lives at `lib/BaseExchange.js` and extends Node.js `EventEmitter`. You never instantiate `BaseExchange` directly — doing so throws an error.

### Key Methods

| Method | Purpose |
|--------|---------|
| `describe()` | Returns the exchange metadata object: `id`, `name`, `version`, `rateLimit`, `urls`, `has` flags, `fees`, `timeframes`, etc. Every subclass **must** override this. |
| `_sign(path, method, params)` | Signs a request for authenticated endpoints. Returns `{ params, headers, url? }`. Every subclass **must** override this for private API calls. |
| `_request(method, path, params, signed, weight)` | Unified HTTP client. Handles rate limiting, signing, timeout, error mapping, and JSON parsing. All API calls flow through this single method. |
| `_handleHttpError(status, body)` | Maps HTTP error responses to typed error classes. Subclasses override this to handle exchange-specific error codes. |
| `_handleResponseHeaders(headers)` | Extracts rate limit info from response headers (e.g., Binance's `X-MBX-USED-WEIGHT-1M`). Subclasses override as needed. |
| `_getBaseUrl(signed)` | Returns the base URL for API requests. Subclasses override when public/private endpoints use different base URLs. |
| `market(symbol)` | Looks up a market by unified symbol (e.g., `'BTC/USDT'`). Throws if markets are not loaded. |
| `checkRequiredCredentials()` | Validates that `apiKey` and `secret` are set. Called by `_sign()` before signing. |

### Constructor Config

```javascript
const exchange = new SomeExchange({
  apiKey: 'YOUR_API_KEY',         // API key
  secret: 'YOUR_SECRET',         // API secret
  timeout: 30000,                // Request timeout in ms (default: 30000)
  enableRateLimit: true,         // Enable built-in rate limiter (default: true)
  verbose: false,                // Log requests to console (default: false)
  options: {                     // Exchange-specific options
    sandbox: false,              // Use testnet URLs
    recvWindow: 5000,            // Binance recv window
    // ...
  },
});
```

### Unified API Surface

BaseExchange defines the unified method signatures that all exchanges implement:

**Public (Market Data):**
- `loadMarkets()` — Load and cache all trading pairs
- `fetchTicker(symbol)` — Get current price data
- `fetchTickers(symbols)` — Get price data for multiple symbols
- `fetchOrderBook(symbol, limit)` — Get order book (bids/asks)
- `fetchTrades(symbol, since, limit)` — Get recent trades
- `fetchOHLCV(symbol, timeframe, since, limit)` — Get candlestick data

**Private (Trading):**
- `createOrder(symbol, type, side, amount, price)` — Place an order
- `createLimitOrder(symbol, side, amount, price)` — Place a limit order
- `createMarketOrder(symbol, side, amount)` — Place a market order
- `cancelOrder(id, symbol)` — Cancel an order
- `cancelAllOrders(symbol)` — Cancel all open orders
- `fetchOrder(id, symbol)` — Get order details
- `fetchOpenOrders(symbol)` — List open orders
- `fetchBalance()` — Get account balances

**WebSocket (Streaming):**
- `watchTicker(symbol, callback)` — Stream live ticker updates
- `watchOrderBook(symbol, callback)` — Stream order book updates
- `watchTrades(symbol, callback)` — Stream live trades
- `watchBalance(callback)` — Stream balance changes
- `watchOrders(callback)` — Stream order status changes

---

## Utils

### crypto.js

Cryptographic primitives used by exchange `_sign()` methods. Every function is a thin wrapper around Node.js `crypto`:

| Function | Description |
|----------|-------------|
| `hmacSHA256(data, secret)` | HMAC-SHA256, hex output |
| `hmacSHA256Base64(data, secret)` | HMAC-SHA256, Base64 output (OKX, KuCoin) |
| `sha256(data)` | SHA-256 hash, hex output |
| `hmacSHA384Hex(data, secret)` | HMAC-SHA384, hex output (Bitfinex, BTSE) |
| `hmacSHA512Hex(data, secret)` | HMAC-SHA512, hex output (Gate.io, VALR) |
| `sha512(data)` | SHA-512 hash, hex output |
| `md5(data)` | MD5 hash, hex output (LBANK, Bibox) |
| `hmacMD5(data, secret)` | HMAC-MD5, hex output |
| `krakenSign(path, nonce, body, secret)` | Kraken's SHA256+HMAC-SHA512 chained signature |
| `signJWT(apiKey, secret, uri)` | JWT/ES256 token generation (Coinbase) |
| `base64UrlEncode(buffer)` | URL-safe Base64 encoding |

### errors.js

Typed error hierarchy. See [Error Handling](error-handling.md) for full details.

| Class | Parent | Description |
|-------|--------|-------------|
| `ExchangeError` | `Error` | Base class for all exchange errors |
| `AuthenticationError` | `ExchangeError` | Invalid credentials or signature |
| `RateLimitExceeded` | `ExchangeError` | Rate limit hit |
| `InsufficientFunds` | `ExchangeError` | Not enough balance |
| `InvalidOrder` | `ExchangeError` | Order rejected by filters |
| `OrderNotFound` | `ExchangeError` | Order does not exist |
| `BadSymbol` | `ExchangeError` | Invalid trading pair |
| `BadRequest` | `ExchangeError` | Malformed request |
| `ExchangeNotAvailable` | `ExchangeError` | Exchange down or in maintenance |
| `NetworkError` | `ExchangeError` | Connection / DNS / transport failure |
| `RequestTimeout` | `NetworkError` | Request exceeded timeout |

### helpers.js

Safe data accessors and utility functions used throughout the codebase:

| Function | Description |
|----------|-------------|
| `safeFloat(obj, key, default)` | Safely parse a float from an object property |
| `safeString(obj, key, default)` | Safely extract a string |
| `safeInteger(obj, key, default)` | Safely parse an integer |
| `safeValue(obj, key, default)` | Safely get any value |
| `safeStringUpper(obj, key, default)` | Extract string and uppercase it |
| `safeStringLower(obj, key, default)` | Extract string and lowercase it |
| `safeFloat2(obj, key1, key2, default)` | Try two keys for a float (fallback) |
| `safeString2(obj, key1, key2, default)` | Try two keys for a string (fallback) |
| `buildQuery(params)` | Sort keys + URL-encode into query string |
| `buildQueryRaw(params)` | Build query string without URL encoding (Binance) |
| `iso8601(timestamp)` | Convert millisecond timestamp to ISO 8601 string |
| `parseDate(dateStr)` | Parse date string to millisecond timestamp |
| `deepMerge(target, source)` | Deep merge two objects |
| `sleep(ms)` | Promise-based delay |

### throttler.js

Token-bucket rate limiter. See [Rate Limiting](rate-limiting.md) for full details.

Constructor options:

```javascript
new Throttler({
  capacity: 1200,          // Maximum tokens in the bucket
  refillRate: 1200,        // Tokens added per refill interval
  refillInterval: 60000,   // Refill interval in milliseconds
});
```

### ws.js

WebSocket client with production-grade reliability features. Extends `EventEmitter`.

| Feature | Description |
|---------|-------------|
| **Auto-Reconnect** | Automatically reconnects on disconnect with exponential backoff and jitter |
| **Ping/Pong Heartbeat** | Sends WebSocket pings at a configurable interval; terminates and reconnects if no pong is received |
| **Subscription Recovery** | Stores all active subscriptions and re-sends them on reconnect |
| **Configurable Limits** | `maxReconnectDelay` (default: 60s), `maxReconnectAttempts` (default: Infinity) |

Events emitted: `open`, `close`, `message`, `error`, `reconnecting`

```javascript
const ws = new WsClient({
  url: 'wss://stream.binance.com:9443/ws',
  pingInterval: 30000,       // Send ping every 30s
  pongTimeout: 10000,        // Terminate if no pong in 10s
  maxReconnectDelay: 60000,  // Cap backoff at 60s
});

await ws.connect();
ws.subscribe('btcusdt@ticker', { method: 'SUBSCRIBE', params: ['btcusdt@ticker'] });
ws.on('message', (data) => console.log(data));
```

---

## Request Flow

Every API call — whether fetching a ticker or placing an order — follows the same path through BaseExchange:

```
User Code
  │
  ▼
fetchTicker('BTC/USDT')              // Unified method (in exchange subclass)
  │
  ├── market('BTC/USDT')             // Resolve unified symbol → exchange-native ID
  │
  ▼
_request('GET', '/api/v3/ticker/24hr', { symbol: 'BTCUSDT' }, false, 5)
  │
  ├── Throttler.consume(weight=5)    // Wait if rate limited
  │
  ├── _sign(path, method, params)    // Sign if authenticated (adds headers/signature)
  │
  ├── fetch(url, options)            // Native fetch with AbortSignal timeout
  │
  ├── _handleResponseHeaders()       // Extract rate limit headers
  │
  ├── Status 429/418?  ──→  throw RateLimitExceeded
  │
  ├── Status !ok?  ──→  _handleHttpError()  ──→  throw typed error
  │
  ▼
JSON.parse(response)                 // Return parsed response to caller
```

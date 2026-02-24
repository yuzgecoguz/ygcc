# YGCC — Cryptocurrency Exchange Library

[![npm version](https://img.shields.io/badge/npm-v1.0.0-blue)](https://www.npmjs.com/package/ygcc)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-82%20passing-brightgreen)](tests/)
[![Exchanges](https://img.shields.io/badge/Exchanges-42-orange)](https://github.com/yuzgecoguz/ygcc)

> Lightweight, unified REST & WebSocket API for cryptocurrency exchanges. One interface, 42 exchanges.

## Overview

**YGCC** is a JavaScript library for cryptocurrency trading that provides a unified API across multiple exchanges. Write your trading logic once — it works on every supported exchange without modification.

Built from **5+ years of production trading experience** across 40+ exchanges.

## Features

- **Unified API** — Same method signatures across all exchanges (`fetchTicker`, `createOrder`, `watchOrderBook`, etc.)
- **REST + WebSocket** — Full market data, trading, and real-time streaming support
- **Weight-Aware Rate Limiting** — Token-bucket limiter that syncs with exchange response headers
- **Auto-Reconnect WebSocket** — Exponential backoff with jitter, automatic resubscription
- **Typed Error Hierarchy** — `AuthenticationError`, `InsufficientFunds`, `RateLimitExceeded`, etc.
- **Minimal Dependencies** — Only [`ws`](https://github.com/websockets/ws) for WebSocket support
- **HMAC-SHA256 Authentication** — Secure request signing with timestamp synchronization
- **Testnet Support** — Built-in sandbox mode for safe testing

## Supported Exchanges

### CEX (Centralized)

| # | Exchange | ID | REST | WebSocket | Status |
|---|----------|-----|------|-----------|--------|
| 1 | [Binance](https://www.binance.com) | `binance` | ✅ | ✅ | **Ready** |
| 2 | [Bybit](https://www.bybit.com) | `bybit` | 🔜 | 🔜 | Planned |
| 3 | [OKX](https://www.okx.com) | `okx` | 🔜 | 🔜 | Planned |
| 4 | [Coinbase](https://www.coinbase.com) | `coinbase` | 🔜 | 🔜 | Planned |
| 5 | [KuCoin](https://www.kucoin.com) | `kucoin` | 🔜 | 🔜 | Planned |
| 6 | [Gate.io](https://www.gate.io) | `gateio` | 🔜 | 🔜 | Planned |
| 7 | [Bitfinex](https://www.bitfinex.com) | `bitfinex` | 🔜 | 🔜 | Planned |
| 8 | [Bitstamp](https://www.bitstamp.net) | `bitstamp` | 🔜 | 🔜 | Planned |
| 9 | [Gemini](https://www.gemini.com) | `gemini` | 🔜 | 🔜 | Planned |
| 10 | [Crypto.com](https://crypto.com) | `cryptocom` | 🔜 | 🔜 | Planned |
| 11 | [Bittrex](https://bittrex.com) | `bittrex` | 🔜 | 🔜 | Planned |
| 12 | [Bitrue](https://www.bitrue.com) | `bitrue` | 🔜 | 🔜 | Planned |
| 13 | [LBANK](https://www.lbank.com) | `lbank` | 🔜 | 🔜 | Planned |
| 14 | [BitMart](https://www.bitmart.com) | `bitmart` | 🔜 | 🔜 | Planned |
| 15 | [Bitforex](https://www.bitforex.com) | `bitforex` | 🔜 | 🔜 | Planned |
| 16 | [Phemex](https://phemex.com) | `phemex` | 🔜 | 🔜 | Planned |
| 17 | [Pionex](https://www.pionex.com) | `pionex` | 🔜 | 🔜 | Planned |
| 18 | [Bibox](https://www.bibox.com) | `bibox` | 🔜 | 🔜 | Planned |
| 19 | [Bitexen](https://www.bitexen.com) | `bitexen` | 🔜 | 🔜 | Planned |
| 20 | [VALR](https://www.valr.com) | `valr` | 🔜 | 🔜 | Planned |
| 21 | [WhiteBit](https://whitebit.com) | `whitebit` | 🔜 | 🔜 | Planned |
| 22 | [BtcTurk](https://www.btcturk.com) | `btcturk` | 🔜 | 🔜 | Planned |
| 23 | [BTSE](https://www.btse.com) | `btse` | 🔜 | 🔜 | Planned |
| 24 | [EXMO](https://exmo.com) | `exmo` | 🔜 | 🔜 | Planned |
| 25 | [CoinTR](https://www.cointr.com) | `cointr` | 🔜 | 🔜 | Planned |
| 26 | [Coinzix](https://coinzix.com) | `coinzix` | 🔜 | 🔜 | Planned |
| 27 | [DigiFinex](https://www.digifinex.com) | `digifinex` | 🔜 | 🔜 | Planned |
| 28 | [HotCoin](https://www.hotcoin.com) | `hotcoin` | 🔜 | 🔜 | Planned |
| 29 | [iCrypex](https://icrypex.com) | `icrypex` | 🔜 | 🔜 | Planned |
| 30 | [JBEX](https://www.jbex.com) | `jbex` | 🔜 | 🔜 | Planned |
| 31 | [Kuna](https://kuna.io) | `kuna` | 🔜 | 🔜 | Planned |
| 32 | [Narkasa](https://www.narkasa.com) | `narkasa` | 🔜 | 🔜 | Planned |
| 33 | [NovaDax](https://www.novadax.com) | `novadax` | 🔜 | 🔜 | Planned |
| 34 | [PointPay](https://pointpay.io) | `pointpay` | 🔜 | 🔜 | Planned |
| 35 | [QMall](https://qmall.io) | `qmall` | 🔜 | 🔜 | Planned |
| 36 | [TruBit](https://www.trubit.com) | `trubit` | 🔜 | 🔜 | Planned |
| 37 | [TradeOgre](https://tradeogre.com) | `tradeogre` | 🔜 | 🔜 | Planned |
| 38 | [TIDEX](https://tidex.com) | `tidex` | 🔜 | 🔜 | Planned |
| 39 | [Latoken](https://latoken.com) | `latoken` | 🔜 | 🔜 | Planned |
| 40 | [Polymarket](https://polymarket.com) | `polymarket` | 🔜 | 🔜 | Planned |

### DEX (Decentralized)

| # | Exchange | ID | REST | WebSocket | Status |
|---|----------|-----|------|-----------|--------|
| 41 | [Hyperliquid](https://hyperliquid.xyz) | `hyperliquid` | 🔜 | 🔜 | Planned |
| 42 | [ZKLighter](https://zklighter.com) | `zklighter` | 🔜 | 🔜 | Planned |

> ✅ = Implemented &nbsp;&nbsp; 🔜 = Coming Soon

## Installation

```bash
npm install ygcc
```

Or clone directly:

```bash
git clone https://github.com/yuzgecoguz/ygcc.git
cd ygcc
npm install
```

## Quick Start

### Fetch Market Data (Public — No API Key Needed)

```javascript
const { Binance } = require('ygcc');

const exchange = new Binance();

(async () => {
  // Load all trading pairs
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Get BTC price
  const ticker = await exchange.fetchTicker('BTCUSDT');
  console.log(`BTC: $${ticker.last} (${ticker.percentage}%)`);

  // Order book (top 5 levels)
  const book = await exchange.fetchOrderBook('BTCUSDT', 5);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);

  // OHLCV candlesticks
  const candles = await exchange.fetchOHLCV('BTCUSDT', '1h', undefined, 5);
  console.log(`Last 5 hourly candles:`, candles);
})();
```

### Place Orders (Private — API Key Required)

```javascript
const { Binance } = require('ygcc');

const exchange = new Binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET,
  enableRateLimit: true,
});

(async () => {
  // Check balance
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // Place a limit order
  const order = await exchange.createLimitOrder('BTCUSDT', 'BUY', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  // Cancel it
  const canceled = await exchange.cancelOrder(order.id, 'BTCUSDT');
  console.log(`Canceled: ${canceled.status}`);
})();
```

### WebSocket Streaming (Real-Time)

```javascript
const { Binance } = require('ygcc');

const exchange = new Binance();

// Real-time ticker updates
exchange.watchTicker('BTCUSDT', (ticker) => {
  console.log(`BTC: $${ticker.last} | Bid: $${ticker.bid} | Ask: $${ticker.ask}`);
});

// Real-time trades
exchange.watchTrades('ETHUSDT', (trade) => {
  console.log(`${trade.side.toUpperCase()} ${trade.amount} ETH @ $${trade.price}`);
});

// Real-time order book
exchange.watchOrderBook('BTCUSDT', (book) => {
  const spread = book.asks[0][0] - book.bids[0][0];
  console.log(`Spread: $${spread.toFixed(2)}`);
}, 5);

// Graceful shutdown
process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Testnet / Sandbox Mode

```javascript
const exchange = new Binance({
  apiKey: 'testnet-key',
  secret: 'testnet-secret',
  options: { sandbox: true }, // Uses testnet.binance.vision
});
```

## Unified API Reference

All exchanges implement the same method signatures:

### Market Data (Public)

| Method | Description | Binance |
|--------|-------------|---------|
| `loadMarkets()` | Load trading pairs, filters, precision rules | ✅ |
| `fetchTicker(symbol)` | 24hr price statistics | ✅ |
| `fetchTickers(symbols?)` | All tickers at once | ✅ |
| `fetchOrderBook(symbol, limit?)` | Bids & asks depth | ✅ |
| `fetchTrades(symbol, since?, limit?)` | Recent public trades | ✅ |
| `fetchOHLCV(symbol, timeframe?, since?, limit?)` | Candlestick / kline data | ✅ |
| `fetchAvgPrice(symbol)` | Current average price | ✅ |
| `fetchPrice(symbol?)` | Quick price lookup (lightweight) | ✅ |
| `fetchBookTicker(symbol?)` | Best bid/ask only | ✅ |

### Trading (Private — Signed)

| Method | Description | Binance |
|--------|-------------|---------|
| `createOrder(symbol, type, side, amount, price?, params?)` | Place any order type | ✅ |
| `createLimitOrder(symbol, side, amount, price)` | Limit order shortcut | ✅ |
| `createMarketOrder(symbol, side, amount)` | Market order shortcut | ✅ |
| `cancelOrder(id, symbol)` | Cancel single order | ✅ |
| `cancelAllOrders(symbol)` | Cancel all open orders | ✅ |
| `createOCO(symbol, side, qty, price, stopPrice)` | One-Cancels-Other | ✅ |
| `createOTO(...)` | One-Triggers-Other | ✅ |
| `createOTOCO(...)` | One-Triggers-OCO | ✅ |
| `amendOrder(id, symbol, newQty)` | Modify order quantity | ✅ |
| `testOrder(...)` | Validate without placing | ✅ |

### Account (Private — Signed)

| Method | Description | Binance |
|--------|-------------|---------|
| `fetchBalance()` | Account balances (free, used, total) | ✅ |
| `fetchOrder(id, symbol)` | Single order status | ✅ |
| `fetchOpenOrders(symbol?)` | All open orders | ✅ |
| `fetchAllOrders(symbol, ...)` | Order history | ✅ |
| `fetchMyTrades(symbol, ...)` | Trade history with fees | ✅ |
| `fetchCommission(symbol)` | Maker/taker commission rates | ✅ |

### WebSocket Streams

| Method | Description | Binance |
|--------|-------------|---------|
| `watchTicker(symbol, callback)` | Real-time ticker | ✅ |
| `watchAllTickers(callback)` | All tickers stream | ✅ |
| `watchOrderBook(symbol, callback, levels?)` | Real-time order book | ✅ |
| `watchTrades(symbol, callback)` | Real-time trades | ✅ |
| `watchKlines(symbol, interval, callback)` | Real-time candlesticks | ✅ |
| `watchBookTicker(symbol, callback)` | Real-time best bid/ask | ✅ |
| `watchBalance(callback)` | Balance updates (User Data) | ✅ |
| `watchOrders(callback)` | Order updates (User Data) | ✅ |

## Unified Response Formats

### Ticker

```javascript
{
  symbol: 'BTCUSDT',
  last: 97500.00,
  bid: 97499.50,  bidVolume: 1.5,
  ask: 97500.50,  askVolume: 0.8,
  high: 98200.00, low: 96800.00,
  open: 97000.00, close: 97500.00,
  volume: 12345.678,
  quoteVolume: 1204567890.12,
  change: 500.00,
  percentage: 0.515,
  timestamp: 1700000000000,
  datetime: '2023-11-14T22:13:20.000Z',
}
```

### Order Book

```javascript
{
  symbol: 'BTCUSDT',
  bids: [[97500.00, 1.5], [97499.00, 2.0], ...],  // [price, quantity]
  asks: [[97501.00, 0.8], [97502.00, 1.2], ...],
  timestamp: 1700000000000,
  nonce: 123456789,
}
```

### Order

```javascript
{
  id: '12345678',
  clientOrderId: 'myOrder1',
  symbol: 'BTCUSDT',
  type: 'LIMIT',
  side: 'BUY',
  price: 95000.00,
  amount: 0.01,
  filled: 0.005,
  remaining: 0.005,
  cost: 475.00,
  average: 95000.00,
  status: 'PARTIALLY_FILLED',  // NEW, FILLED, CANCELED, EXPIRED, REJECTED
  timestamp: 1700000000000,
  trades: [{ price, amount, commission, commissionAsset }],
}
```

### Balance

```javascript
{
  BTC:  { free: 0.50, used: 0.10, total: 0.60 },
  USDT: { free: 5000, used: 1000, total: 6000 },
  timestamp: 1700000000000,
}
```

## Error Handling

YGCC provides typed errors for precise error handling:

```javascript
const {
  Binance,
  AuthenticationError,
  InsufficientFunds,
  RateLimitExceeded,
  InvalidOrder,
  OrderNotFound,
  BadSymbol,
  NetworkError,
} = require('ygcc');

try {
  await exchange.createOrder('BTCUSDT', 'LIMIT', 'BUY', 0.001, 95000);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Check your API key and secret');
  } else if (error instanceof InsufficientFunds) {
    console.error('Not enough balance');
  } else if (error instanceof RateLimitExceeded) {
    console.error('Slow down — rate limited');
  } else if (error instanceof InvalidOrder) {
    console.error('Order rejected:', error.message);
  } else if (error instanceof NetworkError) {
    console.error('Connection issue — retry');
  }
}
```

### Error Hierarchy

```
Error
  └── ExchangeError
        ├── AuthenticationError    // Invalid API key, signature, or timestamp
        ├── RateLimitExceeded      // 429 / 418 responses
        ├── InsufficientFunds      // Not enough balance
        ├── InvalidOrder           // Filter violations, bad params
        ├── OrderNotFound          // Order doesn't exist
        ├── BadSymbol              // Invalid trading pair
        ├── BadRequest             // Malformed request
        ├── ExchangeNotAvailable   // Exchange maintenance
        └── NetworkError
              └── RequestTimeout   // Request exceeded timeout
```

## Rate Limiting

YGCC automatically tracks and respects exchange rate limits:

```javascript
const exchange = new Binance({ enableRateLimit: true }); // Default: true

// Monitor rate limit usage
exchange.on('rateLimitWarning', ({ used, limit }) => {
  console.warn(`Rate limit: ${used}/${limit} weight used`);
});
```

Binance uses a **weight-based** system (6000 weight/minute). Each endpoint has a different weight cost. YGCC tracks the `X-MBX-USED-WEIGHT-1M` response header and automatically throttles requests when approaching the limit.

## Architecture

```
ygcc/
├── index.js                    # Entry point: const { Binance } = require('ygcc')
├── lib/
│   ├── BaseExchange.js         # Abstract base class — unified interface
│   ├── binance.js              # Binance implementation (1369 lines, 59 methods)
│   └── utils/
│       ├── crypto.js           # HMAC-SHA256 signing
│       ├── errors.js           # Typed error classes
│       ├── helpers.js          # Safe value extraction, query builders
│       ├── throttler.js        # Token-bucket rate limiter
│       └── ws.js               # WebSocket with auto-reconnect
├── examples/
│   ├── fetch-ticker.js         # Public market data demo
│   ├── place-order.js          # Trading demo
│   └── websocket-stream.js     # Real-time streaming demo
└── tests/
    └── binance.test.js         # 82 tests
```

## Adding a New Exchange

Every exchange extends `BaseExchange` and implements:

```javascript
const BaseExchange = require('./BaseExchange');

class MyExchange extends BaseExchange {
  describe() {
    return {
      id: 'myexchange',
      name: 'My Exchange',
      version: 'v1',
      rateLimit: 100,
      urls: { api: 'https://api.myexchange.com' },
      has: { fetchTicker: true, createOrder: true, ... },
    };
  }

  _sign(path, method, params) {
    // Exchange-specific authentication
  }

  async loadMarkets() { /* ... */ }
  async fetchTicker(symbol) { /* ... */ }
  async createOrder(symbol, type, side, amount, price) { /* ... */ }
  // ... implement all supported methods
}
```

## Tests

```bash
npm test
```

```
▶ Module Exports (4 tests)
▶ Binance Constructor (7 tests)
▶ BaseExchange (1 test)
▶ Binance Authentication (5 tests)
▶ Binance Parsers (8 tests)
▶ Binance Error Mapping (9 tests)
▶ Binance Rate Limit Header Handling (2 tests)
▶ Binance API Methods — mocked (16 tests)
▶ Utility Functions (18 tests)
▶ Crypto Utilities (4 tests)
▶ Throttler (5 tests)
▶ Error Classes (4 tests)
▶ Binance market() lookup (3 tests)

82 passing — 250ms
```

## Roadmap

- [x] Binance Spot — Full REST + WebSocket (59 methods)
- [ ] Bybit — V5 Unified API
- [ ] OKX — REST + WebSocket
- [ ] Gate.io — Spot + Futures
- [ ] KuCoin — REST + WebSocket
- [ ] Futures/Margin support (Binance USDM, COINM)
- [ ] TypeScript type definitions
- [ ] npm publish

## Related Projects

- [crypto-exchange-connector-library](https://github.com/yuzgecoguz/crypto-exchange-connector-library) — Production connector framework for 50+ exchanges (2025)
- [crypto-triangular-arbitrage-engine](https://github.com/yuzgecoguz/crypto-triangular-arbitrage-engine) — 30-40ms triangular arbitrage engine (2022)
- [funding-rate-arbitrage-scanner](https://github.com/yuzgecoguz/funding-rate-arbitrage-scanner) — Delta-neutral funding rate strategy (2025)
- [ethereum-smart-contract-security-audit](https://github.com/yuzgecoguz/ethereum-smart-contract-security-audit) — Smart contract vulnerability detection benchmark (2025)
- [oracle-manipulation-attack-demo](https://github.com/yuzgecoguz/oracle-manipulation-attack-demo) — Flash loan oracle manipulation PoC (2025)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Author

**Oguzhan Yuzgec** — Blockchain Security & Quant Developer

- GitHub: [@yuzgecoguz](https://github.com/yuzgecoguz)
- LinkedIn: [oguzhan-yuzgec](https://www.linkedin.com/in/oguzhan-yuzgec-a72988182/)

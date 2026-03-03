# Unified API Reference

## Overview

Every exchange adapter in YGCC implements the same set of method signatures, regardless of the underlying REST API differences. This means you can switch between Binance, Bybit, OKX, or any other supported exchange without changing your trading logic.

```js
const exchange = ygcc.createExchange('binance', { apiKey, secret });

// Identical call on any exchange
const ticker = await exchange.fetchTicker('BTC/USDT');
```

Methods are grouped into two categories:

- **Market Data (Public)** -- no authentication required.
- **Trading (Private -- Signed)** -- requires `apiKey` and `secret` (and sometimes a `passphrase`).

If a particular method is not supported by an exchange, calling it will throw a `NotSupported` error with a clear message indicating the exchange and method name.

---

## Market Data (Public)

These endpoints do not require authentication and are available on all exchanges unless noted otherwise.

| Method | Description | Parameters | Return Type | Notes |
|--------|-------------|------------|-------------|-------|
| `loadMarkets()` | Fetches and caches all available trading pairs, their limits, precision, and status. Must be called before any symbol-dependent method. | *none* | `Object` -- map of symbol strings to market info objects | All exchanges. Cached after first call; call again to refresh. |
| `fetchTicker(symbol)` | Returns the latest 24 h price statistics for a single symbol. | `symbol` *string* -- e.g. `'BTC/USDT'` | `Ticker` | All exchanges. |
| `fetchTickers(symbols?)` | Returns tickers for multiple symbols in a single request. | `symbols` *string[]* *(optional)* -- omit to fetch all | `Object` -- `{ 'BTC/USDT': Ticker, ... }` | Most exchanges. Some rate-limit bulk calls heavily. |
| `fetchOrderBook(symbol, limit?)` | Returns the current order book (bids and asks) for a symbol. | `symbol` *string*, `limit` *number* *(optional)* -- depth snapshot size (e.g. `50`, `100`) | `OrderBook` | All exchanges. Default limit varies per exchange. |
| `fetchTrades(symbol, since?, limit?)` | Returns recent public trades for a symbol. | `symbol` *string*, `since` *number* *(optional)* -- Unix ms timestamp, `limit` *number* *(optional)* | `Trade[]` | All exchanges. |
| `fetchOHLCV(symbol, timeframe?, since?, limit?)` | Returns candlestick / kline data. | `symbol` *string*, `timeframe` *string* *(optional, default `'1m'`)* -- e.g. `'5m'`, `'1h'`, `'1d'`, `since` *number* *(optional)*, `limit` *number* *(optional)* | `Array[]` -- each entry `[timestamp, open, high, low, close, volume]` | Most exchanges. Timeframe strings are normalised internally. |
| `fetchTime()` | Returns the exchange server time. Useful for clock-sync checks. | *none* | `number` -- Unix ms timestamp | Most exchanges. |

### Example -- Fetching a Ticker

```js
await exchange.loadMarkets();

const ticker = await exchange.fetchTicker('ETH/USDT');
console.log(ticker.last);   // 3 215.40
console.log(ticker.volume); // 24 h base volume
```

### Example -- Fetching OHLCV

```js
const candles = await exchange.fetchOHLCV('BTC/USDT', '1h', undefined, 100);

for (const [ts, o, h, l, c, v] of candles) {
  console.log(new Date(ts).toISOString(), 'O', o, 'H', h, 'L', l, 'C', c, 'V', v);
}
```

---

## Trading (Private -- Signed)

All methods in this section require valid API credentials. Requests are signed automatically by the adapter.

| Method | Description | Parameters | Return Type | Notes |
|--------|-------------|------------|-------------|-------|
| `createOrder(symbol, type, side, amount, price?, params?)` | Places a new order. This is the universal entry point for all order types. | `symbol` *string*, `type` *string* -- `'limit'` or `'market'`, `side` *string* -- `'buy'` or `'sell'`, `amount` *number*, `price` *number* *(optional -- required for limit)*, `params` *object* *(optional)* -- exchange-specific overrides | `Order` | All exchanges. |
| `createLimitOrder(symbol, side, amount, price, params?)` | Convenience wrapper around `createOrder` with `type = 'limit'`. | `symbol` *string*, `side` *string*, `amount` *number*, `price` *number*, `params` *object* *(optional)* | `Order` | All exchanges. |
| `createMarketOrder(symbol, side, amount, params?)` | Convenience wrapper around `createOrder` with `type = 'market'`. | `symbol` *string*, `side` *string*, `amount` *number*, `params` *object* *(optional)* | `Order` | All exchanges. Some spot-only exchanges do not support market orders. |
| `cancelOrder(id, symbol)` | Cancels an open order by its exchange-assigned ID. | `id` *string*, `symbol` *string* | `Order` | All exchanges. |
| `cancelAllOrders(symbol)` | Cancels every open order for the given symbol. | `symbol` *string* | `Order[]` | Most exchanges. Some cancel across all symbols when `symbol` is omitted. |
| `amendOrder(id, symbol, type, side, amount?, price?, params?)` | Modifies an existing order in-place (edit order). | `id` *string*, `symbol` *string*, `type` *string*, `side` *string*, `amount` *number* *(optional)*, `price` *number* *(optional)*, `params` *object* *(optional)* | `Order` | Supported on Binance, Bybit, OKX, and others with native amend endpoints. Falls back to cancel-and-replace where needed. |
| `fetchOrder(id, symbol)` | Retrieves the current state of a single order. | `id` *string*, `symbol` *string* | `Order` | All exchanges. |
| `fetchOpenOrders(symbol?)` | Returns all currently open orders, optionally filtered by symbol. | `symbol` *string* *(optional)* | `Order[]` | All exchanges. |
| `fetchClosedOrders(symbol?, since?, limit?)` | Returns filled and cancelled orders. | `symbol` *string* *(optional)*, `since` *number* *(optional)*, `limit` *number* *(optional)* | `Order[]` | Most exchanges. Retention period varies. |
| `fetchMyTrades(symbol?, since?, limit?)` | Returns your executed fills / trade history. | `symbol` *string* *(optional)*, `since` *number* *(optional)*, `limit` *number* *(optional)* | `Trade[]` | All exchanges. |
| `fetchBalance()` | Returns all non-zero wallet balances. | *none* | `Balance` | All exchanges. |
| `fetchTradingFees(symbol?)` | Returns maker / taker fee rates. | `symbol` *string* *(optional)* | `Object` -- `{ maker: number, taker: number, ... }` | Most exchanges. Some require a symbol, others return a global schedule. |

### Example -- Placing a Limit Order

```js
const order = await exchange.createLimitOrder('BTC/USDT', 'buy', 0.001, 62000);
console.log(order.id, order.status); // '1389274652' 'open'
```

### Example -- Cancel and Fetch

```js
await exchange.cancelOrder(order.id, 'BTC/USDT');

const updated = await exchange.fetchOrder(order.id, 'BTC/USDT');
console.log(updated.status); // 'canceled'
```

---

## Unified Response Formats

All adapters normalise exchange-specific JSON into these common structures. Extra exchange-specific fields may be present in an `info` property (the raw response).

### Ticker

```js
{
  symbol:      'BTC/USDT',
  last:        62345.10,
  bid:         62344.90,
  bidVolume:   1.253,
  ask:         62345.30,
  askVolume:   0.874,
  high:        63100.00,
  low:         61200.00,
  open:        61800.50,
  close:       62345.10,       // same as `last`
  volume:      18420.35,       // 24 h base volume
  quoteVolume: 1148372540.12,  // 24 h quote volume
  change:      544.60,         // absolute change (close - open)
  percentage:  0.88,           // percent change
  timestamp:   1709472000000,  // Unix ms
  datetime:    '2025-03-03T12:00:00.000Z',
}
```

### Order Book

```js
{
  symbol:    'BTC/USDT',
  bids: [
    [62344.90, 1.253],   // [price, quantity]
    [62344.50, 0.500],
    // ...sorted best (highest) to worst
  ],
  asks: [
    [62345.30, 0.874],
    [62345.80, 2.100],
    // ...sorted best (lowest) to worst
  ],
  timestamp: 1709472000000,
  nonce:     48823719,         // exchange sequence number (if provided)
}
```

### Order

```js
{
  id:            '1389274652',
  clientOrderId: 'my-order-001',
  symbol:        'BTC/USDT',
  type:          'limit',
  side:          'buy',
  price:         62000.00,
  amount:        0.001,
  filled:        0.0005,
  remaining:     0.0005,
  cost:          31.00,        // filled * average
  average:       62000.00,     // weighted average fill price
  status:        'open',       // 'open' | 'closed' | 'canceled' | 'expired' | 'rejected'
  timestamp:     1709472000000,
  trades: [                    // individual fills (if available)
    { id: '928371', price: 62000.00, amount: 0.0005, cost: 31.00, fee: { cost: 0.0124, currency: 'USDT' } },
  ],
}
```

### Balance

```js
{
  BTC: {
    free:  0.5230,    // available for trading
    used:  0.0010,    // locked in open orders
    total: 0.5240,    // free + used
  },
  USDT: {
    free:  12500.00,
    used:  62.00,
    total: 12562.00,
  },
  timestamp: 1709472000000,
}
```

> **Tip:** The `info` property on every response contains the raw, unmodified payload from the exchange. Use it when you need access to exchange-specific fields that are not part of the unified schema.

# WebSocket Streams

## Overview

YGCC provides a unified WebSocket layer on top of every supported exchange. All streams share the same callback-based interface, automatic reconnection with exponential backoff, and graceful shutdown helpers.

```js
const exchange = ygcc.createExchange('binance', { apiKey, secret });
await exchange.loadMarkets();

exchange.watchTicker('BTC/USDT', (ticker) => {
  console.log(ticker.last);
});
```

Key characteristics:

- **Auto-reconnect** -- if the connection drops, the client reconnects automatically with exponential backoff (starting at 1 s, capped at 60 s).
- **Unified callbacks** -- every `watch*` method delivers data in the same unified format used by the REST API.
- **Multiple subscriptions** -- you can call `watch*` multiple times; subscriptions are multiplexed over a single connection where the exchange supports it.

---

## Public Streams

Public streams do not require API credentials.

### watchTicker(symbol, callback)

Streams real-time 24 h ticker updates for a single symbol.

```js
exchange.watchTicker('ETH/USDT', (ticker) => {
  console.log(
    ticker.symbol,
    'last:', ticker.last,
    'bid:', ticker.bid,
    'ask:', ticker.ask,
    'vol:', ticker.volume
  );
});
```

The `ticker` object follows the same [Ticker format](/unified-api?id=ticker) as `fetchTicker()`.

---

### watchOrderBook(symbol, callback, levels?)

Streams order book depth updates. The callback receives a full book snapshot that is kept in sync internally via deltas.

```js
exchange.watchOrderBook('BTC/USDT', (book) => {
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];
  console.log(`Spread: ${bestAsk[0] - bestBid[0]}`);
}, 20); // top 20 levels
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `symbol` | *string* | Trading pair, e.g. `'BTC/USDT'` |
| `callback` | *function* | Receives an [OrderBook](/unified-api?id=order-book) object on every update |
| `levels` | *number* *(optional)* | Depth limit. Default varies per exchange. |

---

### watchTrades(symbol, callback)

Streams individual public trades as they happen.

```js
exchange.watchTrades('BTC/USDT', (trade) => {
  console.log(
    trade.datetime,
    trade.side,
    trade.amount, '@', trade.price
  );
});
```

Each `trade` contains `{ id, symbol, side, price, amount, cost, timestamp, datetime }`.

---

### watchKlines(symbol, interval, callback)

Streams candlestick / kline updates in real time.

```js
exchange.watchKlines('BTC/USDT', '1m', (kline) => {
  const { open, high, low, close, volume, timestamp } = kline;
  console.log(new Date(timestamp).toISOString(), 'O', open, 'H', high, 'L', low, 'C', close);
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `symbol` | *string* | Trading pair |
| `interval` | *string* | Kline interval -- `'1m'`, `'5m'`, `'15m'`, `'1h'`, `'4h'`, `'1d'`, etc. |
| `callback` | *function* | Receives a kline object on every update |

---

## Private Streams

Private streams require valid `apiKey` and `secret` (and `passphrase` where applicable). Authentication is handled automatically when the first private subscription is made.

### watchBalance(callback)

Streams wallet balance changes in real time.

```js
exchange.watchBalance((balance) => {
  console.log('USDT free:', balance.USDT.free);
  console.log('BTC total:', balance.BTC.total);
});
```

The `balance` object follows the same [Balance format](/unified-api?id=balance) as `fetchBalance()`.

---

### watchOrders(callback)

Streams order status updates (new, partially filled, filled, cancelled) in real time.

```js
exchange.watchOrders((order) => {
  console.log(
    order.id,
    order.symbol,
    order.side,
    order.status,
    `filled: ${order.filled}/${order.amount}`
  );

  if (order.status === 'closed') {
    console.log('Order fully filled at average price', order.average);
  }
});
```

The `order` object follows the same [Order format](/unified-api?id=order) as `fetchOrder()`.

---

## Connection Management

### closeAllWs()

Gracefully closes every active WebSocket connection on the exchange instance.

```js
await exchange.closeAllWs();
```

Call this before your process exits to ensure clean disconnection and to avoid orphaned connections on the exchange side.

---

### Auto-Reconnect with Exponential Backoff

When a WebSocket connection drops unexpectedly, YGCC automatically attempts to reconnect:

| Attempt | Delay |
|---------|-------|
| 1 | 1 s |
| 2 | 2 s |
| 3 | 4 s |
| 4 | 8 s |
| 5 | 16 s |
| 6 | 32 s |
| 7+ | 60 s (cap) |

After a successful reconnect, all previous subscriptions are re-established automatically. No manual re-subscription is needed.

---

### SIGINT Handler Pattern

For long-running bots and data collectors, use a `SIGINT` handler to shut down cleanly:

```js
const exchange = ygcc.createExchange('binance', { apiKey, secret });
await exchange.loadMarkets();

exchange.watchTicker('BTC/USDT', (ticker) => {
  console.log(ticker.last);
});

exchange.watchOrders((order) => {
  console.log(order.id, order.status);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down WebSocket connections...');
  await exchange.closeAllWs();
  process.exit(0);
});
```

---

## WS Protocol Differences per Exchange

While the unified API hides these details, the table below documents the underlying WebSocket protocol each exchange uses. This is useful for debugging or when extending adapter internals.

| Exchange | Protocol | Notes |
|----------|----------|-------|
| **Binance** | Plain JSON | User data streams use a `listenKey` obtained via REST. The key must be refreshed every 30 minutes (handled automatically). |
| **Bybit** | JSON | Uses JSON `ping`/`pong` frames for keep-alive. |
| **OKX** | JSON | Subscribe/unsubscribe message pattern with channel names. |
| **Bittrex** | SignalR V3 | Microsoft SignalR protocol over WebSocket. Messages are hub invocations. |
| **LBank** | JSON-RPC | Request/response style with `method`, `params`, and `id` fields. |
| **Phemex** | JSON-RPC | Similar to LBank -- `method`, `params`, `id` message structure. |
| **BitMart** | zlib compressed | All incoming frames are zlib-deflated and must be inflated before parsing JSON. |
| **Bibox** | zlib compressed | Same as BitMart -- zlib-deflated frames. |
| **WhiteBit** | zlib compressed | Same as BitMart -- zlib-deflated frames. |
| **Bitrue** | gzip compressed | Incoming frames are gzip-compressed. Must be decompressed before parsing. |
| **Bitforex** | Plain text JSON | Standard JSON over WebSocket with no compression or special framing. |
| **Bitexen** | Socket.IO v2 | Uses the Socket.IO v2 protocol (Engine.IO handshake + Socket.IO event framing). |
| **HotCoin** | GZIP compressed | Incoming frames are GZIP-compressed. A pong response must also be GZIP-compressed. |
| **iCrypex** | Pipe-delimited | Messages use a `|`-delimited text format instead of JSON. Parsed into key-value pairs internally. |
| **JBEX** | Binance-compatible | Uses the same WebSocket protocol and message format as Binance. |
| **Trubit** | Binance-compatible | Uses the same WebSocket protocol and message format as Binance. |
| **PointPay** | JSON (`method`/`params`/`id`) | Custom JSON protocol with `method`, `params`, and `id` fields (similar to JSON-RPC but not fully compliant). |
| **TradeOgre** | **NO WebSocket** | TradeOgre does not provide a WebSocket API. All data must be polled via REST. Calling any `watch*` method on TradeOgre will throw a `NotSupported` error. |

> **Note:** All protocol-level details (compression, framing, authentication handshakes) are handled internally by the adapters. You never need to deal with zlib, gzip, SignalR, or Socket.IO directly -- just use the unified `watch*` methods.

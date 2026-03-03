# Error Handling

## Overview

YGCC provides a typed error hierarchy so you can handle exchange failures with precision. Every error thrown by the library is an instance of `ExchangeError` (or one of its subclasses), which itself extends the native JavaScript `Error`. This means you can use `instanceof` checks to catch exactly the errors you care about and let everything else propagate.

---

## Error Hierarchy

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

Every error class sets `this.name` to the class name automatically, so `error.name` will be `'AuthenticationError'`, `'InsufficientFunds'`, etc.

---

## Usage

Use `try/catch` with `instanceof` checks to handle specific failure modes:

```javascript
const {
  binance,
  AuthenticationError,
  InsufficientFunds,
  InvalidOrder,
  OrderNotFound,
  RateLimitExceeded,
  NetworkError,
  RequestTimeout,
  ExchangeError,
} = require('ygcc');

const exchange = new binance({
  apiKey: 'YOUR_API_KEY',
  secret: 'YOUR_SECRET',
});

async function placeOrder() {
  try {
    await exchange.loadMarkets();
    const order = await exchange.createOrder('BTC/USDT', 'LIMIT', 'buy', 0.001, 50000);
    console.log('Order placed:', order.id);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      console.error('Auth failed — check your API key and secret');
    } else if (error instanceof InsufficientFunds) {
      console.error('Not enough balance to place this order');
    } else if (error instanceof InvalidOrder) {
      console.error('Order rejected — check amount/price filters:', error.message);
    } else if (error instanceof OrderNotFound) {
      console.error('Order does not exist');
    } else if (error instanceof RateLimitExceeded) {
      console.error('Rate limited — slow down and retry later');
    } else if (error instanceof RequestTimeout) {
      console.error('Request timed out — network may be slow');
    } else if (error instanceof NetworkError) {
      console.error('Network error:', error.message);
    } else if (error instanceof ExchangeError) {
      console.error('Exchange error:', error.message);
    } else {
      throw error; // Re-throw unexpected errors
    }
  }
}

placeOrder();
```

> **Tip:** Order your `instanceof` checks from most specific to least specific. `RequestTimeout` extends `NetworkError`, which extends `ExchangeError` — so check `RequestTimeout` before `NetworkError`, and `NetworkError` before `ExchangeError`.

---

## Exchange-Specific Error Codes

Each exchange returns its own error codes in API responses. YGCC maps these codes to the appropriate error class inside each exchange's `_handleHttpError()` method. Below are the mappings for the major exchanges.

### Binance

| Error Code | YGCC Error Class       | Meaning                              |
|------------|------------------------|--------------------------------------|
| -1002      | `AuthenticationError`  | Unauthorized request                 |
| -1003      | `RateLimitExceeded`    | Too many requests                    |
| -1013      | `InvalidOrder`         | Filter failure (LOT_SIZE, etc.)      |
| -1015      | `RateLimitExceeded`    | Order rate limit exceeded            |
| -1021      | `AuthenticationError`  | Timestamp outside recvWindow         |
| -1022      | `AuthenticationError`  | Invalid signature                    |
| -1100      | `BadRequest`           | Illegal characters in parameter      |
| -1111      | `InvalidOrder`         | Bad precision                        |
| -1121      | `BadSymbol`            | Invalid symbol                       |
| -2010      | `InsufficientFunds`    | Insufficient balance                 |
| -2011      | `InvalidOrder`         | Cancel rejected                      |
| -2013      | `OrderNotFound`        | Order does not exist                 |
| -2014      | `AuthenticationError`  | API key format invalid               |
| -2015      | `AuthenticationError`  | Invalid API key / IP / permissions   |

### Bybit

| Error Code | YGCC Error Class       | Meaning                              |
|------------|------------------------|--------------------------------------|
| 10003      | `AuthenticationError`  | Invalid API key                      |
| 10004      | `AuthenticationError`  | Invalid sign                         |
| 10005      | `AuthenticationError`  | Permission denied                    |
| 10006      | `RateLimitExceeded`    | Too many visits                      |
| 10018      | `RateLimitExceeded`    | Rate limit exceeded                  |
| 10001      | `BadRequest`           | Parameter error                      |
| 10000      | `ExchangeNotAvailable` | Server error                         |
| 110001     | `OrderNotFound`        | Order not found                      |
| 110003     | `InvalidOrder`         | Order quantity error                 |
| 110004     | `InsufficientFunds`    | Insufficient wallet balance          |
| 170121     | `BadSymbol`            | Invalid symbol                       |

### OKX

| Error Code | YGCC Error Class       | Meaning                              |
|------------|------------------------|--------------------------------------|
| 50102      | `AuthenticationError`  | Timestamp request expired            |
| 50103      | `AuthenticationError`  | Invalid OK-ACCESS-KEY                |
| 50104      | `AuthenticationError`  | Invalid OK-ACCESS-PASSPHRASE         |
| 50105      | `AuthenticationError`  | Invalid OK-ACCESS-SIGN               |
| 50110      | `AuthenticationError`  | Invalid IP                           |
| 50011      | `RateLimitExceeded`    | Rate limit reached                   |
| 50013      | `RateLimitExceeded`    | System busy, try again later         |
| 50001      | `ExchangeNotAvailable` | Service temporarily unavailable      |
| 51001      | `InsufficientFunds`    | Insufficient balance                 |
| 51002      | `InvalidOrder`         | Order amount exceeds limit           |
| 51006      | `OrderNotFound`        | Order does not exist                 |

---

## Importing Errors

All error classes are exported from the main package:

```javascript
const {
  ExchangeError,
  AuthenticationError,
  RateLimitExceeded,
  InsufficientFunds,
  InvalidOrder,
  OrderNotFound,
  NetworkError,
  BadSymbol,
  BadRequest,
  ExchangeNotAvailable,
  RequestTimeout,
} = require('ygcc');
```

You can also import them directly from the errors module:

```javascript
const {
  AuthenticationError,
  InsufficientFunds,
  // ...
} = require('ygcc/lib/utils/errors');
```

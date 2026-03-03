# Supported Exchanges

YGCC supports **33 exchanges** — 30 centralized exchanges (CEX) in Ready status and 3 decentralized exchanges (DEX) planned.

---

## CEX — Ready

| #  | Exchange   | REST | WebSocket | Status |
|----|------------|:----:|:---------:|--------|
| 1  | Binance    | ✅   | ✅        | Ready  |
| 2  | Bybit      | ✅   | ✅        | Ready  |
| 3  | OKX        | ✅   | ✅        | Ready  |
| 4  | Kraken     | ✅   | ✅        | Ready  |
| 5  | Gate.io    | ✅   | ✅        | Ready  |
| 6  | Coinbase   | ✅   | ✅        | Ready  |
| 7  | KuCoin     | ✅   | ✅        | Ready  |
| 8  | Bitfinex   | ✅   | ✅        | Ready  |
| 9  | Bitstamp   | ✅   | ✅        | Ready  |
| 10 | Bittrex    | ✅   | ✅        | Ready  |
| 11 | Bitrue     | ✅   | ✅        | Ready  |
| 12 | LBANK      | ✅   | ✅        | Ready  |
| 13 | BitMart    | ✅   | ✅        | Ready  |
| 14 | Bitforex   | ✅   | ✅        | Ready  |
| 15 | Phemex     | ✅   | ✅        | Ready  |
| 16 | Pionex     | ✅   | ✅        | Ready  |
| 17 | Bibox      | ✅   | ✅        | Ready  |
| 18 | WhiteBit   | ✅   | ✅        | Ready  |
| 19 | VALR       | ✅   | ✅        | Ready  |
| 20 | Bitexen    | ✅   | ✅        | Ready  |
| 21 | BtcTurk    | ✅   | ✅        | Ready  |
| 22 | BTSE       | ✅   | ✅        | Ready  |
| 23 | EXMO       | ✅   | ✅        | Ready  |
| 24 | CoinTR     | ✅   | ✅        | Ready  |
| 25 | HotCoin    | ✅   | ✅        | Ready  |
| 26 | iCrypex    | ✅   | ✅        | Ready  |
| 27 | JBEX       | ✅   | ✅        | Ready  |
| 28 | PointPay   | ✅   | ✅        | Ready  |
| 29 | TruBit     | ✅   | ✅        | Ready  |
| 30 | TradeOgre  | ✅   | ❌        | Ready  |

## DEX — Planned

| #  | Exchange     | REST | WebSocket | Status  |
|----|--------------|:----:|:---------:|---------|
| 31 | Pollymarket  | —    | —         | Planned |
| 32 | Hyperliquid  | —    | —         | Planned |
| 33 | ZKLighter    | —    | —         | Planned |

---

## Exchange Features Matrix

Each exchange uses a unique authentication pattern and symbol format. The table below summarizes the signing method and native symbol format for every supported exchange.

| #  | Exchange   | Symbol Format      | Auth Method                              |
|----|------------|--------------------|------------------------------------------|
| 1  | Binance    | `BTCUSDT`          | HMAC-SHA256                              |
| 2  | Bybit      | `BTCUSDT`          | HMAC-SHA256                              |
| 3  | OKX        | `BTC-USDT`         | HMAC-SHA256 Base64 + passphrase          |
| 4  | Kraken     | `XBTUSD`           | SHA256 + HMAC-SHA512                     |
| 5  | Gate.io    | `BTC_USDT`         | HMAC-SHA512 + SHA512 body hash           |
| 6  | Coinbase   | `BTC-USD`          | JWT / ES256                              |
| 7  | KuCoin     | `BTC-USDT`         | HMAC-SHA256 Base64 + passphrase          |
| 8  | Bitfinex   | `tBTCUSD`          | HMAC-SHA384                              |
| 9  | Bitstamp   | `BTC/USD`          | HMAC-SHA256 + UUID nonce                 |
| 10 | Bittrex    | `BTC-USDT`         | HMAC-SHA512 + SHA512 content             |
| 11 | Bitrue     | `BTCUSDT`          | HMAC-SHA256 URL-signature                |
| 12 | LBANK      | `btc_usdt`         | MD5 + HMAC-SHA256                        |
| 13 | BitMart    | `BTC_USDT`         | HMAC-SHA256 + memo                       |
| 14 | Bitforex   | `coin-usdt-btc`    | HMAC-SHA256 path-signing                 |
| 15 | Phemex     | `sBTCUSDT`         | Base64-decoded HMAC-SHA256               |
| 16 | Pionex     | `BTCUSDT`          | HMAC-SHA256 header                       |
| 17 | Bibox      | `BTC_USDT`         | Dual V3 MD5 + V4 SHA256                  |
| 18 | WhiteBit   | `BTC_USDT`         | Base64 + HMAC-SHA512                     |
| 19 | VALR       | `BTCZAR`           | HMAC-SHA512                              |
| 20 | Bitexen    | `BTCTRY`           | 4-credential SHA256 uppercase            |
| 21 | BtcTurk    | `BTCTRY`           | Base64-decoded HMAC-SHA256               |
| 22 | BTSE       | `BTC-USDT`         | HMAC-SHA384                              |
| 23 | EXMO       | `BTC_USD`          | HMAC-SHA512 form-encoded                 |
| 24 | CoinTR     | `BTCUSDT`          | Double-layer HMAC-SHA256                 |
| 25 | HotCoin    | `btc_usdt`         | Huobi-style query-string SHA256 Base64   |
| 26 | iCrypex    | `BTCUSDT`          | Base64-decoded HMAC-SHA256               |
| 27 | JBEX       | `BTCUSDT`          | Binance-compat HMAC-SHA256               |
| 28 | PointPay   | `BTC_USDT`         | HMAC-SHA512 payload                      |
| 29 | TruBit     | `BTCUSDT`          | Binance-compat HMAC-SHA256               |
| 30 | TradeOgre  | `BTC-USDT`         | HTTP Basic Auth                          |

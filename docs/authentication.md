# Authentication Guide

This guide covers all 22+ authentication patterns implemented in YGCC. Each cryptocurrency exchange uses its own unique method to sign and verify API requests. YGCC handles all of this internally, so you only need to provide the correct credentials.

---

## 1. Overview

Every private API request (placing orders, fetching balances, managing withdrawals) must be cryptographically signed. The signing process typically involves:

1. **Constructing a message** from the request parameters (timestamp, method, path, body)
2. **Signing the message** using a cryptographic hash function (HMAC-SHA256, HMAC-SHA512, etc.)
3. **Encoding the signature** (hex, Base64, or other format)
4. **Attaching the signature** to the request via headers, query parameters, or both

YGCC abstracts all of this. You provide your credentials, and the library handles the rest. However, understanding the underlying patterns helps with debugging and troubleshooting.

---

## 2. Auth Pattern Categories

### HMAC-SHA256 (Hex Encoding)

The most common pattern. The request payload is signed using HMAC-SHA256, and the resulting signature is encoded as a hexadecimal string.

**Exchanges:** Binance, Bybit, CoinTR, JBEX, Trubit

**How it works:**

1. Build a query string or request body from sorted parameters
2. Append or prepend a timestamp
3. Compute `HMAC-SHA256(secret, message)`
4. Encode the result as a lowercase hex string
5. Attach as a header or query parameter

**Example — Binance signing flow (handled internally by YGCC):**

```
message = "symbol=BTCUSDT&side=BUY&type=LIMIT&timestamp=1700000000000&..."
signature = HMAC-SHA256(secret, message)  ->  hex string
```

**Credential requirements:**

| Exchange | apiKey | secret | Additional |
|----------|--------|--------|------------|
| Binance  | Yes    | Yes    | --         |
| Bybit    | Yes    | Yes    | --         |
| CoinTR   | Yes    | Yes    | --         |
| JBEX     | Yes    | Yes    | --         |
| Trubit   | Yes    | Yes    | --         |

---

### HMAC-SHA256 (Base64 Encoding)

Same HMAC-SHA256 algorithm, but the signature is encoded as a Base64 string instead of hex. Often the message includes a timestamp and HTTP method.

**Exchanges:** OKX, KuCoin, HotCoin

**How it works:**

1. Build a prehash string: `timestamp + method + requestPath + body`
2. Compute `HMAC-SHA256(secret, prehashString)`
3. Encode the result as a Base64 string
4. Send the signature, timestamp, API key, and passphrase (if required) in headers

**Example — OKX signing flow (handled internally by YGCC):**

```
prehash = "2024-01-15T12:00:00.000Z" + "GET" + "/api/v5/account/balance" + ""
signature = Base64(HMAC-SHA256(secret, prehash))
```

**Credential requirements:**

| Exchange | apiKey | secret | passphrase | Additional |
|----------|--------|--------|------------|------------|
| OKX      | Yes    | Yes    | Yes        | --         |
| KuCoin   | Yes    | Yes    | Yes        | --         |
| HotCoin  | Yes    | Yes    | No         | --         |

---

### HMAC-SHA256 (Base64-Decoded Key)

The secret key is first Base64-decoded before being used as the HMAC key. This adds a layer of key transformation before signing.

**Exchanges:** Phemex, BtcTurk, iCrypex

**How it works:**

1. Decode the API secret from Base64 to get the raw binary key
2. Build the message from request parameters and timestamp
3. Compute `HMAC-SHA256(base64Decode(secret), message)`
4. Encode the result as hex or Base64 depending on the exchange

**Example — BtcTurk signing flow (handled internally by YGCC):**

```
decodedKey = Base64Decode(secret)
message = apiKey + timestamp
signature = Base64(HMAC-SHA256(decodedKey, message))
```

**Credential requirements:**

| Exchange | apiKey | secret       | Additional           |
|----------|--------|-------------|----------------------|
| Phemex   | Yes    | Yes (B64)   | --                   |
| BtcTurk  | Yes    | Yes (B64)   | Public key also used |
| iCrypex  | Yes    | Yes (B64)   | --                   |

---

### HMAC-SHA384

A less common variant using SHA-384 for a longer hash output (384 bits). Provides a higher security margin.

**Exchanges:** Bitfinex, BTSE

**How it works:**

1. Build a JSON payload or query string
2. Construct a signature message from nonce/timestamp and payload
3. Compute `HMAC-SHA384(secret, message)`
4. Encode as hex

**Example — Bitfinex signing flow (handled internally by YGCC):**

```
nonce = Date.now().toString()
body = JSON.stringify(payload)
message = "/api/v2/" + path + nonce + body
signature = HMAC-SHA384(secret, message)  ->  hex string
```

**Credential requirements:**

| Exchange | apiKey | secret | Additional |
|----------|--------|--------|------------|
| Bitfinex | Yes    | Yes    | --         |
| BTSE     | Yes    | Yes    | --         |

---

### HMAC-SHA512

Uses the full SHA-512 hash for maximum hash length (512 bits). Some exchanges combine this with SHA-256 in a two-step process.

**Exchanges:** Gate.io, Bittrex, VALR, EXMO, PointPay, WhiteBit

**How it works:**

1. Build the signing message from request details
2. Compute `HMAC-SHA512(secret, message)`
3. Encode as hex (most exchanges) or Base64

**Kraken variation (SHA-256 + HMAC-SHA512):**

```
hash = SHA256(nonce + body)
message = path + hash
signature = Base64(HMAC-SHA512(Base64Decode(secret), message))
```

**Credential requirements:**

| Exchange  | apiKey | secret | Additional |
|-----------|--------|--------|------------|
| Gate.io   | Yes    | Yes    | --         |
| Bittrex   | Yes    | Yes    | --         |
| VALR      | Yes    | Yes    | --         |
| EXMO      | Yes    | Yes    | --         |
| PointPay  | Yes    | Yes    | --         |
| WhiteBit  | Yes    | Yes    | --         |

---

### JWT / ES256 (JSON Web Token with ECDSA)

Coinbase uses ES256 (Elliptic Curve Digital Signature Algorithm with P-256 and SHA-256) to sign JWTs for API authentication. This is fundamentally different from HMAC-based approaches.

**Exchanges:** Coinbase

**How it works:**

1. Build a JWT header: `{"alg": "ES256", "typ": "JWT", "kid": apiKey, "nonce": cryptoNonce}`
2. Build a JWT payload with subject, issuer, timestamps, and the request URI
3. Sign the JWT using the EC private key (PEM format) with ES256
4. Send the signed JWT as a Bearer token in the Authorization header

**Example — Coinbase signing flow (handled internally by YGCC):**

```
header  = { alg: "ES256", typ: "JWT", kid: apiKey, nonce: randomHex }
payload = { sub: apiKey, iss: "coinbase-cloud", aud: "cdp", exp: now+120, nbf: now, uri: "GET api.coinbase.com/api/v3/..." }
token   = JWT.sign(header + payload, ecPrivateKey, "ES256")
```

**Credential requirements:**

| Exchange | apiKey      | secret             | Additional        |
|----------|------------|--------------------|--------------------|
| Coinbase | Yes (kid)  | Yes (EC PEM key)   | Nonce per request  |

---

### MD5 + HMAC Combination

These exchanges use a two-step process combining MD5 hashing with HMAC signing, or use MD5 as part of their signature chain.

**Exchanges:** LBank, Bibox

**How it works (LBank):**

1. Sort parameters alphabetically and build query string
2. Compute `MD5(queryString)` to produce an intermediate hash
3. Compute `HMAC-SHA256(secret, md5Hash)` or use the MD5 result directly
4. Encode and attach to the request

**How it works (Bibox):**

1. Stringify the request parameters as JSON
2. Compute `HMAC-MD5(secret, jsonString)` or a similar MD5-based HMAC
3. Attach the signature to the request

**Credential requirements:**

| Exchange | apiKey | secret | Additional |
|----------|--------|--------|------------|
| LBank    | Yes    | Yes    | --         |
| Bibox    | Yes    | Yes    | --         |

---

### Multi-Credential Authentication

Some exchanges require more than just an API key and secret. Additional credentials such as passphrases, memos, or multiple keys are needed.

**Exchanges:** Bitexen (4 credentials), BitMart (memo), OKX (passphrase), KuCoin (passphrase)

#### Bitexen (4 Credentials)

Bitexen requires four separate credentials to authenticate:

```js
const { Bitexen } = require('@ygcc/ygcc');

const exchange = new Bitexen({
    apiKey: process.env.BITEXEN_API_KEY,
    secret: process.env.BITEXEN_SECRET,
    uid: process.env.BITEXEN_USERNAME,
    password: process.env.BITEXEN_PASSWORD,
});
```

#### BitMart (Memo)

BitMart uses a memo field alongside the standard API key and secret:

```js
const { BitMart } = require('@ygcc/ygcc');

const exchange = new BitMart({
    apiKey: process.env.BITMART_API_KEY,
    secret: process.env.BITMART_SECRET,
    uid: process.env.BITMART_MEMO,  // memo from API key creation
});
```

#### OKX & KuCoin (Passphrase)

Both OKX and KuCoin require a passphrase that you set when creating the API key:

```js
const { OKX } = require('@ygcc/ygcc');

const exchange = new OKX({
    apiKey: process.env.OKX_API_KEY,
    secret: process.env.OKX_SECRET,
    password: process.env.OKX_PASSPHRASE,
});
```

```js
const { KuCoin } = require('@ygcc/ygcc');

const exchange = new KuCoin({
    apiKey: process.env.KUCOIN_API_KEY,
    secret: process.env.KUCOIN_SECRET,
    password: process.env.KUCOIN_PASSPHRASE,
});
```

---

### HTTP Basic Auth

The simplest authentication method. Credentials are sent as a Base64-encoded `username:password` pair in the `Authorization` header.

**Exchanges:** TradeOgre

**How it works:**

1. Combine API key and secret as `apiKey:secret`
2. Base64-encode the combined string
3. Send as `Authorization: Basic <encoded>` header

```js
const { TradeOgre } = require('@ygcc/ygcc');

const exchange = new TradeOgre({
    apiKey: process.env.TRADEOGRE_API_KEY,
    secret: process.env.TRADEOGRE_SECRET,
});
```

---

## 3. Credential Setup — Top 5 Exchanges

### Binance

1. Log in to [Binance](https://www.binance.com) and go to **API Management**
2. Click **Create API** and choose **System Generated**
3. Name your API key and complete 2FA verification
4. Copy the **API Key** and **Secret Key** (the secret is shown only once)
5. Configure permissions: enable **Reading** and **Spot Trading** as needed
6. Restrict access by IP address for production use

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET,
});
```

### Bybit

1. Log in to [Bybit](https://www.bybit.com) and go to **API** under your profile
2. Click **Create New Key** and select **System-generated API Keys**
3. Set permissions (Read-Write for trading)
4. Copy the **API Key** and **Secret**
5. Optionally restrict by IP address

```js
const { Bybit } = require('@ygcc/ygcc');

const exchange = new Bybit({
    apiKey: process.env.BYBIT_API_KEY,
    secret: process.env.BYBIT_SECRET,
});
```

### OKX

1. Log in to [OKX](https://www.okx.com) and go to **API** under your profile
2. Click **Create V5 API Key**
3. Set a **passphrase** (you must remember this -- it cannot be recovered)
4. Configure permissions and optionally bind IP addresses
5. Copy the **API Key**, **Secret Key**, and remember your **Passphrase**

```js
const { OKX } = require('@ygcc/ygcc');

const exchange = new OKX({
    apiKey: process.env.OKX_API_KEY,
    secret: process.env.OKX_SECRET,
    password: process.env.OKX_PASSPHRASE,
});
```

### KuCoin

1. Log in to [KuCoin](https://www.kucoin.com) and go to **API Management**
2. Click **Create API**
3. Set a **passphrase** and configure permissions
4. Complete security verification
5. Copy the **API Key**, **Secret**, and remember your **Passphrase**

```js
const { KuCoin } = require('@ygcc/ygcc');

const exchange = new KuCoin({
    apiKey: process.env.KUCOIN_API_KEY,
    secret: process.env.KUCOIN_SECRET,
    password: process.env.KUCOIN_PASSPHRASE,
});
```

### Kraken

1. Log in to [Kraken](https://www.kraken.com) and go to **Settings > API**
2. Click **Generate New Key**
3. Set a description and configure permissions
4. Enable 2FA for the API key if desired
5. Copy the **API Key** and **Private Key** (Base64-encoded)

```js
const { Kraken } = require('@ygcc/ygcc');

const exchange = new Kraken({
    apiKey: process.env.KRAKEN_API_KEY,
    secret: process.env.KRAKEN_SECRET,
});
```

---

## 4. Security Best Practices

### Use Environment Variables

Never hardcode API keys in your source code. Always use environment variables:

```bash
# .env file (add to .gitignore!)
BINANCE_API_KEY=your_api_key_here
BINANCE_SECRET=your_secret_here
OKX_API_KEY=your_api_key_here
OKX_SECRET=your_secret_here
OKX_PASSPHRASE=your_passphrase_here
```

```js
// Load environment variables
require('dotenv').config();

const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET,
});
```

### Never Hardcode Keys

This is dangerous and should never be done:

```js
// NEVER DO THIS
const exchange = new Binance({
    apiKey: 'aB3dE5fG7hI9jK...',   // exposed in source control
    secret: 'xY1zW2vU3tS4rQ...',   // anyone with repo access can see this
});
```

### IP Whitelist

Most exchanges allow you to restrict API key usage to specific IP addresses. This is strongly recommended for production environments:

- **Binance:** Set under API Management > IP access restrictions
- **Bybit:** Configure when creating or editing the API key
- **OKX:** Bind IP addresses during API key creation
- **KuCoin:** Set IP restrictions in API Management
- **Kraken:** Available as an optional security setting

If your server has a static IP, always bind your API keys to that IP. This prevents stolen keys from being used on other machines.

### Principle of Least Privilege

Only enable the permissions you need:

- If you only need market data, do not enable trading permissions
- If you only need spot trading, do not enable withdrawal permissions
- Never enable withdrawal permissions on API keys used in automated systems unless absolutely necessary

### Rotate Keys Regularly

Periodically delete old API keys and generate new ones. This limits the window of exposure if a key is compromised.

### Secure Storage for Production

For production deployments, consider using:

- **AWS Secrets Manager** or **AWS Parameter Store**
- **HashiCorp Vault**
- **Google Cloud Secret Manager**
- **Azure Key Vault**
- **Docker secrets** or **Kubernetes secrets**

These services provide encryption at rest, audit logging, and access control for sensitive credentials.

---

## Quick Reference: Auth Patterns by Exchange

| Exchange   | Algorithm         | Encoding | Extra Credentials     |
|------------|-------------------|----------|-----------------------|
| Binance    | HMAC-SHA256       | Hex      | --                    |
| Bybit      | HMAC-SHA256       | Hex      | --                    |
| CoinTR     | HMAC-SHA256       | Hex      | --                    |
| JBEX       | HMAC-SHA256       | Hex      | --                    |
| Trubit     | HMAC-SHA256       | Hex      | --                    |
| OKX        | HMAC-SHA256       | Base64   | Passphrase            |
| KuCoin     | HMAC-SHA256       | Base64   | Passphrase            |
| HotCoin    | HMAC-SHA256       | Base64   | --                    |
| Phemex     | HMAC-SHA256       | B64 Key  | --                    |
| BtcTurk    | HMAC-SHA256       | B64 Key  | Public key            |
| iCrypex    | HMAC-SHA256       | B64 Key  | --                    |
| Bitfinex   | HMAC-SHA384       | Hex      | --                    |
| BTSE       | HMAC-SHA384       | Hex      | --                    |
| Gate.io    | HMAC-SHA512       | Hex      | --                    |
| Bittrex    | HMAC-SHA512       | Hex      | --                    |
| VALR       | HMAC-SHA512       | Hex      | --                    |
| EXMO       | HMAC-SHA512       | Hex      | --                    |
| PointPay   | HMAC-SHA512       | Hex      | --                    |
| WhiteBit   | HMAC-SHA512       | Hex      | --                    |
| Coinbase   | JWT / ES256       | JWT      | EC PEM private key    |
| LBank      | MD5 + HMAC        | Hex      | --                    |
| Bibox      | MD5 + HMAC        | Hex      | --                    |
| Bitexen    | HMAC-SHA256       | Hex      | Username + Password   |
| BitMart    | HMAC-SHA256       | Hex      | Memo                  |
| TradeOgre  | HTTP Basic Auth   | Base64   | --                    |

---

## Next Steps

- **[Quick Start](quick-start.md)** -- Get up and running with your first API calls.
- **[API Reference](api-reference.md)** -- Full method documentation for all exchange classes.
- **[Error Handling](error-handling.md)** -- Learn how to handle authentication errors and rate limits.

'use strict';

const EventEmitter = require('events');
const Throttler = require('./utils/throttler');
const { ExchangeError, NetworkError, RequestTimeout, RateLimitExceeded } = require('./utils/errors');
const { sleep, iso8601 } = require('./utils/helpers');

/**
 * Abstract base class for all exchange implementations.
 * Every exchange extends this class and implements its own:
 *   - describe()    → endpoint definitions, capabilities, rate limits
 *   - _sign()       → authentication / request signing
 *   - parse*()      → response normalization
 *
 * CCXT-style unified interface: loadMarkets, fetchTicker, createOrder, etc.
 */
class BaseExchange extends EventEmitter {
  constructor(config = {}) {
    super();
    if (new.target === BaseExchange) {
      throw new Error('BaseExchange is abstract — instantiate a subclass (e.g., Binance)');
    }

    this.apiKey = config.apiKey || '';
    this.secret = config.secret || '';
    this.timeout = config.timeout || 30000;
    this.enableRateLimit = config.enableRateLimit !== false;
    this.verbose = config.verbose || false;
    this.options = config.options || {};
    this.postAsJson = false; // Bybit/OKX=true
    this.postAsFormEncoded = false; // Kraken=true

    // Populated by loadMarkets()
    this.markets = {};       // symbol → market object
    this.marketsById = {};   // exchangeId → market object
    this.symbols = [];
    this.currencies = {};
    this._marketsLoaded = false;

    // Rate limiter
    this._throttler = null;

    // WebSocket
    this._ws = null;
    this._wsHandlers = new Map();

    // Apply describe()
    const desc = this.describe();
    this.id = desc.id || 'base';
    this.name = desc.name || 'Base Exchange';
    this.version = desc.version || 'v1';
    this.rateLimit = desc.rateLimit || 50;
    this.has = desc.has || {};
    this.urls = desc.urls || {};
    this.api = desc.api || {};
    this.timeframes = desc.timeframes || {};
    this.fees = desc.fees || {};

    // Override options from config
    if (config.options) {
      this.options = { ...this.options, ...config.options };
    }

    // Initialize throttler
    if (this.enableRateLimit) {
      this._throttler = new Throttler({
        capacity: desc.rateLimitCapacity || 1200,
        refillRate: desc.rateLimitCapacity || 1200,
        refillInterval: desc.rateLimitInterval || 60000,
      });
    }
  }

  /**
   * Exchange-specific configuration. Subclasses MUST override.
   * @returns {Object} Exchange descriptor
   */
  describe() {
    return {
      id: 'base',
      name: 'Base Exchange',
      version: 'v1',
      rateLimit: 50,
      has: {},
      urls: {},
      api: {},
      timeframes: {},
      fees: {},
    };
  }

  // ===========================================================================
  // Unified Public API — Market Data
  // ===========================================================================

  async loadMarkets(reload = false) {
    throw new ExchangeError(this.id + ' loadMarkets() not implemented');
  }

  async fetchTicker(symbol, params = {}) {
    throw new ExchangeError(this.id + ' fetchTicker() not implemented');
  }

  async fetchTickers(symbols = undefined, params = {}) {
    throw new ExchangeError(this.id + ' fetchTickers() not implemented');
  }

  async fetchOrderBook(symbol, limit = undefined, params = {}) {
    throw new ExchangeError(this.id + ' fetchOrderBook() not implemented');
  }

  async fetchTrades(symbol, since = undefined, limit = undefined, params = {}) {
    throw new ExchangeError(this.id + ' fetchTrades() not implemented');
  }

  async fetchOHLCV(symbol, timeframe = '1m', since = undefined, limit = undefined, params = {}) {
    throw new ExchangeError(this.id + ' fetchOHLCV() not implemented');
  }

  // ===========================================================================
  // Unified Private API — Trading
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    throw new ExchangeError(this.id + ' createOrder() not implemented');
  }

  async createLimitOrder(symbol, side, amount, price, params = {}) {
    return this.createOrder(symbol, 'LIMIT', side, amount, price, params);
  }

  async createMarketOrder(symbol, side, amount, params = {}) {
    return this.createOrder(symbol, 'MARKET', side, amount, undefined, params);
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    throw new ExchangeError(this.id + ' cancelOrder() not implemented');
  }

  async cancelAllOrders(symbol = undefined, params = {}) {
    throw new ExchangeError(this.id + ' cancelAllOrders() not implemented');
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    throw new ExchangeError(this.id + ' fetchOrder() not implemented');
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    throw new ExchangeError(this.id + ' fetchOpenOrders() not implemented');
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    throw new ExchangeError(this.id + ' fetchClosedOrders() not implemented');
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    throw new ExchangeError(this.id + ' fetchMyTrades() not implemented');
  }

  // ===========================================================================
  // Unified Private API — Account
  // ===========================================================================

  async fetchBalance(params = {}) {
    throw new ExchangeError(this.id + ' fetchBalance() not implemented');
  }

  async fetchTradingFees(params = {}) {
    throw new ExchangeError(this.id + ' fetchTradingFees() not implemented');
  }

  // ===========================================================================
  // WebSocket — Streaming
  // ===========================================================================

  async watchTicker(symbol, callback) {
    throw new ExchangeError(this.id + ' watchTicker() not implemented');
  }

  async watchOrderBook(symbol, callback, limit = undefined) {
    throw new ExchangeError(this.id + ' watchOrderBook() not implemented');
  }

  async watchTrades(symbol, callback) {
    throw new ExchangeError(this.id + ' watchTrades() not implemented');
  }

  async watchBalance(callback) {
    throw new ExchangeError(this.id + ' watchBalance() not implemented');
  }

  async watchOrders(callback) {
    throw new ExchangeError(this.id + ' watchOrders() not implemented');
  }

  // ===========================================================================
  // Internal — HTTP Request Engine
  // ===========================================================================

  /**
   * Core HTTP request method. All API calls flow through here.
   */
  async _request(method, path, params = {}, signed = false, weight = 1) {
    // Rate limiting
    if (this.enableRateLimit && this._throttler) {
      await this._throttler.consume(weight);
    }

    const baseUrl = this._getBaseUrl(signed);
    let url = baseUrl + path;
    const headers = {};

    // Signing
    if (signed) {
      const signResult = this._sign(path, method, { ...params });
      params = signResult.params || params;
      if (signResult.headers) Object.assign(headers, signResult.headers);
      if (signResult.url) url = signResult.url;
    }

    // Build fetch options
    const fetchOptions = { method, headers, signal: AbortSignal.timeout(this.timeout) };

    if (method === 'GET' || method === 'DELETE' || method === 'PUT') {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += '?' + qs;
    } else {
      if (this.postAsJson) {
        // Bybit, OKX — JSON body for POST
        headers['Content-Type'] = 'application/json';
        if (Object.keys(params).length > 0) {
          fetchOptions.body = JSON.stringify(params);
        }
      } else if (this.postAsFormEncoded) {
        // Kraken — form-urlencoded POST body
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        const body = new URLSearchParams(params).toString();
        if (body) fetchOptions.body = body;
      } else {
        // Binance — POST params go in query string
        const qs = new URLSearchParams(params).toString();
        if (qs) url += '?' + qs;
      }
    }

    if (this.verbose) {
      console.log(method, url);
    }

    let response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new RequestTimeout(this.id + ' request timed out (' + this.timeout + 'ms)');
      }
      throw new NetworkError(this.id + ' ' + err.message);
    }

    // Rate limit header tracking
    this._handleResponseHeaders(response.headers);

    // 429 — Rate limited
    if (response.status === 429 || response.status === 418) {
      const retryAfter = response.headers.get('Retry-After') || '60';
      throw new RateLimitExceeded(
        this.id + ' rate limited. Retry after ' + retryAfter + 's'
      );
    }

    const text = await response.text();

    if (!response.ok) {
      this._handleHttpError(response.status, text);
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /**
   * Get base URL for requests. Subclasses override for different API families.
   */
  _getBaseUrl(signed = false) {
    return this.urls.api || '';
  }

  /**
   * Sign a request. Subclasses MUST override for authenticated endpoints.
   * @returns {{ params, headers, url? }}
   */
  _sign(path, method, params) {
    throw new ExchangeError(this.id + ' _sign() not implemented');
  }

  /**
   * Parse response headers for rate limit info. Subclasses override.
   */
  _handleResponseHeaders(headers) {
    // Override in subclass
  }

  /**
   * Handle HTTP error responses. Subclasses override for exchange-specific error codes.
   */
  _handleHttpError(status, body) {
    throw new ExchangeError(this.id + ' HTTP ' + status + ': ' + body);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  market(symbol) {
    if (!this._marketsLoaded) {
      throw new ExchangeError(this.id + ' markets not loaded. Call loadMarkets() first');
    }
    const market = this.markets[symbol];
    if (!market) throw new ExchangeError(this.id + ' unknown symbol: ' + symbol);
    return market;
  }

  checkRequiredCredentials() {
    if (!this.apiKey) throw new ExchangeError(this.id + ' apiKey required');
    if (!this.secret) throw new ExchangeError(this.id + ' secret required');
  }

  milliseconds() {
    return Date.now();
  }
}

module.exports = BaseExchange;

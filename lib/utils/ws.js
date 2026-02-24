'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');
const { sleep } = require('./helpers');

/**
 * Production WebSocket manager with auto-reconnect, heartbeat, and subscription recovery.
 */
class WsClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = options.url || '';
    this.pingInterval = options.pingInterval || 30000;
    this.pongTimeout = options.pongTimeout || 10000;
    this.maxReconnectDelay = options.maxReconnectDelay || 60000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || Infinity;

    this._ws = null;
    this._connected = false;
    this._reconnectAttempts = 0;
    this._pingTimer = null;
    this._pongTimer = null;
    this._subscriptions = new Map();   // id → { msg, handler }
    this._handlers = new Map();        // stream → handler
    this._intentionalClose = false;
  }

  get connected() { return this._connected; }

  async connect(url) {
    if (url) this.url = url;
    this._intentionalClose = false;
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this.url);

      this._ws.on('open', () => {
        this._connected = true;
        this._reconnectAttempts = 0;
        this._startPing();
        this.emit('open');
        // Re-subscribe
        for (const [, sub] of this._subscriptions) {
          this._ws.send(JSON.stringify(sub.msg));
        }
        resolve();
      });

      this._ws.on('message', (raw) => {
        this._resetPongTimer();
        try {
          const data = JSON.parse(raw.toString());
          this.emit('message', data);
        } catch (err) {
          this.emit('error', err);
        }
      });

      this._ws.on('close', (code) => {
        this._connected = false;
        this._stopPing();
        this.emit('close', code);
        if (!this._intentionalClose) {
          this._reconnect();
        }
      });

      this._ws.on('error', (err) => {
        this.emit('error', err);
        if (!this._connected) reject(err);
      });

      this._ws.on('pong', () => {
        this._resetPongTimer();
      });
    });
  }

  send(data) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }

  subscribe(id, msg, handler) {
    this._subscriptions.set(id, { msg, handler });
    if (this._connected) {
      this.send(msg);
    }
  }

  unsubscribe(id) {
    this._subscriptions.delete(id);
  }

  async close() {
    this._intentionalClose = true;
    this._stopPing();
    if (this._ws) {
      this._ws.close(1000);
      this._ws = null;
    }
    this._connected = false;
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.ping();
        this._pongTimer = setTimeout(() => {
          // No pong received — force reconnect
          if (this._ws) this._ws.terminate();
        }, this.pongTimeout);
      }
    }, this.pingInterval);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
  }

  _resetPongTimer() {
    if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
  }

  async _reconnect() {
    this._reconnectAttempts++;
    if (this._reconnectAttempts > this.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnect attempts exceeded'));
      return;
    }
    const baseDelay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), this.maxReconnectDelay);
    const jitter = Math.random() * baseDelay * 0.25;
    const delay = baseDelay + jitter;
    this.emit('reconnecting', { attempt: this._reconnectAttempts, delay: Math.round(delay) });
    await sleep(delay);
    try {
      await this.connect();
    } catch {
      this._reconnect();
    }
  }
}

module.exports = WsClient;

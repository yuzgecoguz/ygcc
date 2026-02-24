'use strict';

class ExchangeError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

class AuthenticationError extends ExchangeError {}
class RateLimitExceeded extends ExchangeError {}
class InsufficientFunds extends ExchangeError {}
class InvalidOrder extends ExchangeError {}
class OrderNotFound extends ExchangeError {}
class NetworkError extends ExchangeError {}
class BadSymbol extends ExchangeError {}
class BadRequest extends ExchangeError {}
class ExchangeNotAvailable extends ExchangeError {}
class RequestTimeout extends NetworkError {}

module.exports = {
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
};

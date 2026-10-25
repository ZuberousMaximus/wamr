import { describe, it, expect } from 'vitest';
import express from 'express';
import {
  DEFAULT_TRUST_PROXY,
  isAllowedCorsOrigin,
  parseTrustProxy,
} from '../../../src/config/http-security';

describe('parseTrustProxy', () => {
  it('defaults to private-network proxies', () => {
    expect(parseTrustProxy(undefined)).toBe(DEFAULT_TRUST_PROXY);
    expect(parseTrustProxy('  ')).toBe(DEFAULT_TRUST_PROXY);
  });

  it.each([
    ['true', true],
    ['false', false],
    ['1', 1],
    ['10.0.0.0/8, 172.16.0.0/12', '10.0.0.0/8, 172.16.0.0/12'],
  ])('parses %j', (input, expected) => {
    expect(parseTrustProxy(input)).toEqual(expected);
  });
});

/**
 * Drive Express's real req.ip / req.secure getters (proxy-addr) with a fake
 * socket, so this checks the behaviour the login rate limit relies on.
 */
function requestFrom(remoteAddress: string, headers: Record<string, string>, trust: unknown) {
  const app = express();
  app.set('trust proxy', trust);
  const req = Object.create(app.request);
  req.app = app;
  req.headers = headers;
  req.connection = req.socket = { remoteAddress, encrypted: false };
  return req as express.Request;
}

describe('default trust proxy setting', () => {
  const trust = parseTrustProxy(undefined);
  const spoof = { 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'https' };

  it('ignores X-Forwarded-For from a client on a public address', () => {
    const req = requestFrom('203.0.113.9', spoof, trust);
    expect(req.ip).toBe('203.0.113.9');
    expect(req.secure).toBe(false);
  });

  it.each([
    ['the same host', '127.0.0.1'],
    ['the Docker network', '172.18.0.2'],
    ['the LAN', '192.168.2.20'],
  ])('honours a reverse proxy on %s', (_where, proxyAddress) => {
    const req = requestFrom(
      proxyAddress,
      { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' },
      trust
    );
    expect(req.ip).toBe('198.51.100.7');
    expect(req.secure).toBe(true);
  });

  it('keeps the direct client address when there is no proxy', () => {
    expect(requestFrom('192.168.2.30', {}, trust).ip).toBe('192.168.2.30');
  });

  it('a spoofed hop before a trusted proxy does not replace the real client', () => {
    // Client 203.0.113.9 sends "X-Forwarded-For: 6.6.6.6"; the LAN proxy appends the real address
    const req = requestFrom('192.168.2.20', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, trust);
    expect(req.ip).toBe('203.0.113.9');
  });

  it('documents the old behaviour: trust proxy=true let any client pick its IP', () => {
    expect(requestFrom('203.0.113.9', spoof, true).ip).toBe('6.6.6.6');
  });
});

describe('isAllowedCorsOrigin', () => {
  it('allows requests without an Origin header', () => {
    expect(isAllowedCorsOrigin(undefined, 'http://localhost:3000')).toBe(true);
  });

  it('allows any origin when CORS_ORIGIN is *', () => {
    expect(isAllowedCorsOrigin('https://anything.example', '*')).toBe(true);
  });

  it('allows the configured origin exactly', () => {
    expect(isAllowedCorsOrigin('https://wamr.example.com', 'https://wamr.example.com')).toBe(true);
    expect(
      isAllowedCorsOrigin('https://wamr.example.com.evil.io', 'https://wamr.example.com')
    ).toBe(false);
  });

  it.each([
    'http://localhost',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3001',
  ])('allows local dev server %s', (origin) => {
    expect(isAllowedCorsOrigin(origin, 'https://wamr.example.com')).toBe(true);
  });

  it.each([
    'http://localhost.evil.com',
    'http://localhost.evil.com:3000',
    'http://localhost@evil.com',
    'https://evil.com',
    'not a url',
  ])('rejects %s', (origin) => {
    expect(isAllowedCorsOrigin(origin, 'https://wamr.example.com')).toBe(false);
  });
});

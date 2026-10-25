/**
 * HTTP-layer security decisions, kept pure so they can be unit tested.
 */

/**
 * Proxies whose X-Forwarded-* headers are believed: loopback, link-local and
 * private ranges. That covers a reverse proxy on the same host, the Docker
 * network or the LAN, while a client on a public address can no longer pick
 * its own req.ip (which keys the login rate limit) by sending X-Forwarded-For.
 */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

/**
 * Convert TRUST_PROXY into Express's `trust proxy` setting: "true"/"false",
 * a hop count, or a comma-separated list of addresses, subnets or the named
 * ranges above.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return DEFAULT_TRUST_PROXY;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

// Dev servers (Vite, CRA) on any port
const LOCAL_DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a cross-origin request from `origin` may carry credentials.
 * Requests without an Origin header (same-origin GETs, curl) are allowed.
 */
export function isAllowedCorsOrigin(origin: string | undefined, corsOrigin: string): boolean {
  if (!origin) return true;
  if (corsOrigin === '*' || origin === corsOrigin) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // Compare the parsed hostname: a prefix check also let http://localhost.example.com in
  return url.protocol === 'http:' && LOCAL_DEV_HOSTNAMES.has(url.hostname);
}

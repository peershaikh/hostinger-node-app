import net from 'net';

/**
 * Normalizes an IP address by:
 * - Stripping IPv6-mapped IPv4 prefix (::ffff:)
 * - Normalizing IPv6 loopback (::1) to 127.0.0.1
 * - Stripping port number if present (e.g., 203.0.113.195:44321 -> 203.0.113.195)
 * - Trimming whitespace and validating format with net.isIP()
 */
export function normalizeIp(rawIp: string | null | undefined): string | null {
  if (!rawIp || typeof rawIp !== 'string') return null;
  let ip = rawIp.trim();

  // Strip enclosing brackets for IPv6 like [2001:db8::1]
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }

  // Strip port from IPv4 if present (e.g. 1.2.3.4:5678)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(ip)) {
    ip = ip.split(':')[0];
  }

  // Handle IPv6-mapped IPv4 (::ffff:192.0.2.1)
  if (ip.startsWith('::ffff:')) {
    const candidate = ip.substring(7);
    if (net.isIPv4(candidate)) {
      return candidate;
    }
  }

  if (ip === '::1') {
    return '127.0.0.1';
  }

  if (net.isIP(ip)) {
    return ip;
  }

  return null;
}

/**
 * Resolves the client IP address in a secure, non-spoofable manner.
 *
 * CRITICAL SECURITY INVARIANTS:
 * 1. NEVER blindly trust arbitrary headers like 'CF-Connecting-IP' or 'X-Vercel-Forwarded-For'
 *    when supplied directly by untrusted clients. An attacker could forge these headers
 *    to bypass rate limiters and manufacture unlimited IP buckets.
 * 2. NEVER blindly take the leftmost entry of 'X-Forwarded-For' via .split(',')[0].
 *    The leftmost entry is client-controlled and easily forged.
 * 3. Authoritatively rely on Express's configured trusted proxy resolution (`req.ip`),
 *    which uses `proxy-addr` to walk the proxy chain backwards from right to left,
 *    stopping at the first untrusted boundary.
 * 4. Gracefully fall back to req.socket.remoteAddress, or '127.0.0.1' if no valid IP can be resolved.
 */
export function resolveClientIp(req: any): string {
  if (!req) return '127.0.0.1';

  // 1. Authoritative: Express req.ip (evaluated via app.set('trust proxy', ...))
  if (req.ip) {
    const normalized = normalizeIp(req.ip);
    if (normalized) return normalized;
  }

  // 2. Direct socket address fallback (when req.ip is undefined or unparsed)
  const socketAddress = req.socket?.remoteAddress || req.connection?.remoteAddress;
  if (socketAddress) {
    const normalized = normalizeIp(socketAddress);
    if (normalized) return normalized;
  }

  // 3. Fallback to loopback
  return '127.0.0.1';
}


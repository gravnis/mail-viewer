import { config } from './config.js';

const SCHEMES = new Set(['socks5', 'socks5h', 'socks4', 'socks4a', 'socks', 'http', 'https']);

/**
 * Accepts the formats proxy sellers usually hand out:
 *   socks5://user:pass@host:port   http://host:port
 *   user:pass@host:port            host:port:user:pass            host:port
 * Bare forms get PROXY_DEFAULT_SCHEME. Returns a normalized URL string or null.
 */
export function parseProxyLine(line, defaultScheme = config.proxyDefaultScheme) {
    const raw = String(line || '').trim();
    if (!raw || raw.startsWith('#')) return null;

    let candidate = raw;
    if (!/^[a-z0-9]+:\/\//i.test(raw)) {
        const parts = raw.split(':');
        if (!raw.includes('@') && parts.length === 4) {
            const [host, port, user, pass] = parts;
            candidate = `${defaultScheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
        } else {
            candidate = `${defaultScheme}://${raw}`;
        }
    }

    let url;
    try {
        url = new URL(candidate);
    } catch {
        return null;
    }
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    if (!SCHEMES.has(scheme) || !url.hostname || !url.port) return null;
    if (scheme === 'socks5h') {
        url = new URL(url.href.replace(/^socks5h:/i, 'socks5:'));
    }
    return url.href.replace(/\/$/, '');
}

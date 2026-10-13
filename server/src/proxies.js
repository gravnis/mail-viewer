import { enabledProxyUrls } from './store.js';

// Rotation pointer. The proxy is chosen only when a connection is made
// (see connect() in imap.js), by rotation, not bound to any mailbox.
let rotation = 0;

export function nextProxies(maxAttempts = 2) {
    const pool = enabledProxyUrls();
    if (!pool.length) return [];
    const ordered = [];
    const count = Math.min(maxAttempts, pool.length);
    for (let i = 0; i < count; i++) {
        ordered.push(pool[rotation % pool.length]);
        rotation = (rotation + 1) % pool.length;
    }
    return ordered;
}

import crypto from 'node:crypto';
import { config } from './config.js';
import { sign, verify, passwordVersion } from './secret.js';

const COOKIE = '__Host-mv_admin';

export function checkAdminPassword(password) {
    if (!config.adminPassword) return false;
    // Compare fixed-length HMACs so the password length is not leaked by timing.
    const a = crypto.createHmac('sha256', 'cmp').update(String(password)).digest();
    const b = crypto.createHmac('sha256', 'cmp').update(config.adminPassword).digest();
    return crypto.timingSafeEqual(a, b);
}

export function makeSessionCookie() {
    const exp = Date.now() + config.sessionTtlHours * 3600_000;
    // pv binds the session to the current admin password: changing ADMIN_PASSWORD
    // invalidates every outstanding cookie.
    const token = sign({ exp, pv: passwordVersion(config.adminPassword), r: crypto.randomBytes(6).toString('hex') });
    // __Host- prefix requires Secure + Path=/ + no Domain, and pins the cookie to this host.
    const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure', `Max-Age=${config.sessionTtlHours * 3600}`];
    // __Host- cookies must be Secure; only usable over HTTPS. For plain-http dev use a plain name.
    if (config.cookieInsecure) return makeDevCookie(token);
    return attrs.join('; ');
}

function makeDevCookie(token) {
    return [`mv_admin=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${config.sessionTtlHours * 3600}`].join('; ');
}

export function clearSessionCookie() {
    const name = config.cookieInsecure ? 'mv_admin' : COOKIE;
    const attrs = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (!config.cookieInsecure) attrs.push('Secure');
    return attrs.join('; ');
}

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
}

export function isAdmin(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = config.cookieInsecure ? cookies['mv_admin'] : cookies[COOKIE];
    const payload = verify(token);
    return (
        !!payload &&
        typeof payload.exp === 'number' &&
        payload.exp > Date.now() &&
        payload.pv === passwordVersion(config.adminPassword)
    );
}

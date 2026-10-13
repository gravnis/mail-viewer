import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateConfig } from './config.js';
import { listFolders, listMessages, getMessage } from './imap.js';
import { toClientError, UserError } from './errors.js';
import { checkAdminPassword, makeSessionCookie, clearSessionCookie, isAdmin } from './auth.js';
import * as store from './store.js';

const ADMIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin');
const MAX_BODY = 2 * 1024 * 1024;

// A crash must never take the service down from one bad request.
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err?.code || err?.message || err));
process.on('uncaughtException', err => console.error('[uncaughtException]', err?.code || err?.message || err));

function log(event, extra = '') {
    console.log(`[${new Date().toISOString()}] ${event}${extra ? ' ' + extra : ''}`);
}

// ---------- client IP ----------
function clientIp(req) {
    // Only honor forwarding headers when a trusted proxy sets them; otherwise a direct
    // client could spoof its address and dodge the rate limiter.
    if (config.trustProxyHeaders) {
        const cf = req.headers['cf-connecting-ip'];
        if (cf) return String(cf).trim();
        const xff = req.headers['x-forwarded-for'];
        if (xff) {
            const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
            // Rightmost entry is the one added by the nearest (trusted) proxy.
            if (parts.length) return parts[parts.length - 1];
        }
    }
    return req.socket.remoteAddress || 'unknown';
}

// ---------- rate limiting (prune, never wholesale clear) ----------
function makeLimiter(windowMs, max) {
    const hits = new Map();
    return ip => {
        const nowT = Date.now();
        const arr = (hits.get(ip) || []).filter(t => t > nowT - windowMs);
        arr.push(nowT);
        hits.set(ip, arr);
        if (hits.size > 50_000) {
            for (const [k, v] of hits) if (!v.some(t => t > nowT - windowMs)) hits.delete(k);
        }
        return arr.length > max;
    };
}
const apiLimited = makeLimiter(60_000, config.rateLimitPerMinute);
const loginLimited = makeLimiter(config.loginWindowMinutes * 60_000, config.loginAttemptsPerWindow);

// ---------- body ----------
function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new UserError('Слишком большой запрос', 413, 'TOO_LARGE'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            let parsed;
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                return reject(new UserError('Некорректный JSON', 400, 'BAD_JSON'));
            }
            // Must be a plain object: guards every handler that reads body.<field>.
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return reject(new UserError('Ожидался объект JSON', 400, 'BAD_BODY'));
            }
            resolve(parsed);
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, body) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
    });
    res.end(JSON.stringify(body));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
function serveStatic(res, file) {
    const full = path.join(ADMIN_DIR, file);
    // Must be a real file strictly inside ADMIN_DIR (not the dir itself, not a sibling).
    if (!full.startsWith(ADMIN_DIR + path.sep)) return sendJson(res, 404, { error: 'NOT_FOUND' });
    let stat;
    try {
        stat = fs.statSync(full);
    } catch {
        return sendJson(res, 404, { error: 'NOT_FOUND' });
    }
    if (!stat.isFile()) return sendJson(res, 404, { error: 'NOT_FOUND' });
    res.writeHead(200, {
        'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'X-Frame-Options': 'DENY'
    });
    res.end(fs.readFileSync(full));
}

// Defense-in-depth against cross-site state change: a browser form POST either omits
// these or carries a foreign Origin.
function sameOriginPost(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) return false;
    return true;
}

// ---------- extension API ----------
function authKey(req) {
    return store.accessKeyByValue(req.headers['x-access-key']);
}

// The employee pastes a full account line; it is admitted only if that exact line is
// in the admin's inventory. Connection settings (MS token or password) come from there.
function relayAccount(line) {
    if (!line || typeof line !== 'string') throw new UserError('Не передана строка аккаунта', 400, 'NO_LINE');
    const acc = store.mailboxByLine(line);
    if (!acc) throw new UserError('Этот аккаунт недоступен', 404, 'NO_MAILBOX');
    return acc;
}

const EXT_ROUTES = {
    '/api/folders': body => listFolders(relayAccount(body.line)).then(folders => ({ folders })),
    '/api/messages': body =>
        listMessages(relayAccount(body.line), { folder: body.folder, limit: body.limit, unseenOnly: !!body.unseenOnly }),
    '/api/message': body => getMessage(relayAccount(body.line), { folder: body.folder, uid: body.uid })
};

// ---------- admin API ----------
const ADMIN_ROUTES = {
    '/admin/api/state': () => ({
        counts: store.counts(),
        mailboxes: store.listMailboxesAdmin(),
        proxies: store.listProxiesAdmin(),
        keys: store.listAccessKeys()
    }),
    '/admin/api/mailboxes/import': body => store.importMailboxes(body.text),
    '/admin/api/mailboxes/delete': body => (store.deleteMailbox(body.id), { ok: true }),
    '/admin/api/proxies/add': body => ({ ok: true, masked: store.addProxy(body.url, body.label) }),
    '/admin/api/proxies/import': body => store.importProxies(body.text),
    '/admin/api/proxies/delete': body => (store.deleteProxy(body.id), { ok: true }),
    '/admin/api/proxies/toggle': body => (store.toggleProxy(body.id, body.enabled), { ok: true }),
    '/admin/api/keys/add': body => (log('key.create', `label=${JSON.stringify(String(body.label || ''))}`), store.createAccessKey(body.label)),
    '/admin/api/keys/delete': body => (log('key.delete', `id=${Number(body.id)}`), store.deleteAccessKey(body.id), { ok: true })
};

// ---------- server ----------
const server = http.createServer(async (req, res) => {
    try {
        let url;
        try {
            url = new URL(req.url, 'http://localhost');
        } catch {
            return sendJson(res, 400, { error: 'BAD_REQUEST' });
        }
        const pathName = url.pathname;

        if (req.method === 'GET' && pathName === '/health') return sendJson(res, 200, { ok: true });

        if (req.method === 'GET' && (pathName === '/' || pathName === '/admin')) {
            return serveStatic(res, isAdmin(req) ? 'index.html' : 'login.html');
        }
        if (req.method === 'GET' && pathName.startsWith('/admin/static/')) {
            return serveStatic(res, pathName.slice('/admin/static/'.length));
        }

        const ip = clientIp(req);

        // Admin login (stricter, separate limiter).
        if (req.method === 'POST' && pathName === '/admin/login') {
            if (loginLimited(ip)) return sendJson(res, 429, { error: 'RATE_LIMITED', message: 'Слишком много попыток входа. Подождите.' });
            if (!sameOriginPost(req)) return sendJson(res, 400, { error: 'BAD_ORIGIN' });
            const body = await readJson(req).catch(() => ({}));
            if (!checkAdminPassword(body.password)) {
                log('login.fail', `ip=${ip}`);
                return sendJson(res, 401, { error: 'BAD_PASSWORD', message: 'Неверный пароль' });
            }
            log('login.ok', `ip=${ip}`);
            res.setHeader('Set-Cookie', makeSessionCookie());
            return sendJson(res, 200, { ok: true });
        }

        if (apiLimited(ip)) return sendJson(res, 429, { error: 'RATE_LIMITED', message: 'Слишком много запросов.' });

        if (req.method === 'POST' && pathName === '/admin/logout') {
            res.setHeader('Set-Cookie', clearSessionCookie());
            return sendJson(res, 200, { ok: true });
        }

        // Admin API (session + same-origin).
        if (pathName.startsWith('/admin/api/')) {
            if (!isAdmin(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Войдите в админку' });
            if (!sameOriginPost(req)) return sendJson(res, 400, { error: 'BAD_ORIGIN' });
            const handler = ADMIN_ROUTES[pathName];
            if (!handler || req.method !== 'POST') return sendJson(res, 404, { error: 'NOT_FOUND' });
            try {
                return sendJson(res, 200, await handler(await readJson(req)));
            } catch (err) {
                const mapped = toClientError(err);
                return sendJson(res, mapped.status, mapped.body);
            }
        }

        // Extension API (access-key).
        if (pathName.startsWith('/api/')) {
            const handler = EXT_ROUTES[pathName];
            if (!handler || req.method !== 'POST') return sendJson(res, 404, { error: 'NOT_FOUND' });
            if (!authKey(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Нет доступа (неверный ключ).' });
            try {
                return sendJson(res, 200, await handler(await readJson(req)));
            } catch (err) {
                const mapped = toClientError(err);
                return sendJson(res, mapped.status, mapped.body);
            }
        }

        return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
        console.error('[handler]', err?.code || err?.message || err);
        if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL' });
    }
});

const problems = validateConfig();
if (problems.length) {
    console.error('Ошибки конфигурации:\n  - ' + problems.join('\n  - '));
    process.exit(1);
}

server.listen(config.port, config.host, () => {
    console.log(`Mail Viewer сервер: http://${config.host}:${config.port} (админка на /, API расширения на /api)`);
});

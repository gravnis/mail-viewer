import crypto from 'node:crypto';
import { db } from './db.js';
import { encrypt, decrypt, keyFingerprint, lineFingerprint } from './secret.js';
import { parseProxyLine } from './proxy-parse.js';
import { resolveServer, checkServerAllowed } from './providers.js';
import { UserError } from './errors.js';

const now = () => Date.now();
const pwAad = email => 'pw:' + email;
const rtAad = email => 'rt:' + email;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses one account line as handed out by sellers. Microsoft (Outlook/Hotmail) lines
 * use '----' and carry an OAuth token, since Microsoft disabled password IMAP:
 *   email----password----client_id(UUID)----refresh_token(M.*)----recovery...----...
 * client_id and refresh_token are detected by shape, so their order may vary and extra
 * trailing fields (recovery email etc.) are ignored. A plain line is basic auth:
 *   email:password   (password = everything after the first separator)
 */
export function parseAccountLine(raw) {
    const line = String(raw || '').trim();
    if (!line) throw new UserError('Пустая строка', 400, 'EMPTY');

    if (line.includes('----')) {
        const parts = line.split('----').map(s => s.trim());
        const email = parts.find(p => EMAIL_RE.test(p));
        if (!email) throw new UserError('Не найден email в строке', 400, 'NO_EMAIL');
        const password = parts[parts.indexOf(email) + 1] || '';
        const clientId = parts.find(p => UUID_RE.test(p));
        const refreshToken =
            parts.find(p => /^M\.[A-Za-z0-9]/.test(p)) ||
            parts.find(p => p.length > 60 && !UUID_RE.test(p) && !p.includes('@') && p !== password);
        if (!clientId) throw new UserError('Не найден client_id (UUID) в строке', 400, 'NO_CLIENT_ID');
        if (!refreshToken) throw new UserError('Не найден refresh_token в строке', 400, 'NO_REFRESH');
        return { email: email.toLowerCase(), password, clientId, refreshToken, isMs: true };
    }

    const m = line.match(/^(\S+?)[\s:,;]+([\s\S]+)$/);
    if (!m) throw new UserError('Нет пароля в строке', 400, 'NO_PASS');
    const email = m[1].toLowerCase();
    if (!EMAIL_RE.test(email)) throw new UserError('Некорректный адрес: ' + m[1], 400, 'BAD_EMAIL');
    return { email, password: m[2].trim(), isMs: false };
}

// ---------- access keys (gate who may use the relay at all) ----------
export function createAccessKey(label) {
    const key = 'mv_' + crypto.randomBytes(24).toString('base64url');
    const hint = key.slice(0, 5) + '…' + key.slice(-3);
    const info = db
        .prepare('INSERT INTO access_keys (label, fingerprint, hint, created_at) VALUES (?,?,?,?)')
        .run(String(label || 'Без названия').slice(0, 80), keyFingerprint(key), hint, now());
    return { id: Number(info.lastInsertRowid), key, hint };
}

export function listAccessKeys() {
    return db.prepare('SELECT id, label, hint, created_at FROM access_keys ORDER BY id').all();
}

export function deleteAccessKey(id) {
    db.prepare('DELETE FROM access_keys WHERE id = ?').run(Number(id));
}

export function accessKeyByValue(key) {
    if (!key) return null;
    return db.prepare('SELECT id, label FROM access_keys WHERE fingerprint = ?').get(keyFingerprint(key)) || null;
}

// ---------- mailbox inventory (admin only) ----------
// Stores one account per uploaded line. line_fp is a keyed hash of the exact line, so
// the relay can admit only an employee who pastes that same line.
function addAccountLine(raw) {
    const rec = parseAccountLine(raw);
    const server = resolveServer(rec.email, '', undefined);
    const problem = checkServerAllowed(server);
    if (problem) throw new UserError(`${problem} (${rec.email})`, 400, 'BAD_SERVER');

    db.prepare(
        `INSERT INTO mailboxes (email, label, password_enc, refresh_enc, client_id, host, port, line_fp, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(email) DO UPDATE SET
            password_enc=excluded.password_enc, refresh_enc=excluded.refresh_enc,
            client_id=excluded.client_id, line_fp=excluded.line_fp`
    ).run(
        rec.email,
        '',
        rec.isMs ? '' : encrypt(rec.password || '', pwAad(rec.email)),
        rec.isMs ? encrypt(rec.refreshToken, rtAad(rec.email)) : '',
        rec.isMs ? rec.clientId : '',
        '',
        null,
        lineFingerprint(String(raw).trim()),
        now()
    );
}

/** Paste of one or many account lines. Returns { added, errors:[{line,reason}] }. */
export function importMailboxes(text) {
    const lines = String(text || '').split(/\r?\n/);
    let added = 0;
    const errors = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;
        try {
            addAccountLine(line);
            added++;
        } catch (e) {
            errors.push({ line: i + 1, reason: e.message });
        }
    }
    return { added, errors };
}

export function listMailboxesAdmin() {
    return db
        .prepare(
            `SELECT id, email, host, port, created_at, (refresh_enc <> '') AS is_ms
             FROM mailboxes ORDER BY email`
        )
        .all()
        .map(r => ({ ...r, is_ms: !!r.is_ms }));
}

export function deleteMailbox(id) {
    db.prepare('DELETE FROM mailboxes WHERE id = ?').run(Number(id));
}

/**
 * Relay gate: the employee pastes a full account line; it is admitted only if that exact
 * line is in the inventory. Returns the connect settings (Microsoft token or password),
 * or null when the line is not in the inventory.
 */
export function mailboxByLine(rawLine) {
    const fp = lineFingerprint(String(rawLine || '').trim());
    const m = db.prepare('SELECT email, refresh_enc, client_id, password_enc, host, port FROM mailboxes WHERE line_fp = ?').get(fp);
    if (!m) return null;
    const isMs = !!m.refresh_enc;
    const account = { email: m.email, host: m.host || undefined, port: m.port || undefined };
    if (isMs) {
        account.refreshToken = decrypt(m.refresh_enc, rtAad(m.email));
        account.clientId = m.client_id || undefined;
    } else {
        account.password = decrypt(m.password_enc, pwAad(m.email));
    }
    return account;
}

// ---------- proxies ----------
const PROXY_AAD = 'proxy';

export function addProxy(line, label) {
    const url = parseProxyLine(line);
    if (!url) throw new UserError('Не удалось разобрать прокси', 400, 'BAD_PROXY');
    db.prepare('INSERT INTO proxies (url_enc, label, enabled, created_at) VALUES (?,?,1,?)').run(
        encrypt(url, PROXY_AAD),
        String(label || '').slice(0, 80),
        now()
    );
    return maskProxy(url);
}

export function importProxies(text) {
    const lines = String(text || '').split(/\r?\n/);
    let added = 0;
    const errors = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;
        try {
            addProxy(line, '');
            added++;
        } catch (e) {
            errors.push({ line: i + 1, reason: e.message });
        }
    }
    return { added, errors };
}

// Masks a proxy URL for display: scheme + dotted host, no port digits, no credentials.
function maskProxy(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/[^.]/g, '•');
        return `${u.protocol}//${u.username ? '•••@' : ''}${host}`;
    } catch {
        return '••••';
    }
}

export function listProxiesAdmin() {
    return db
        .prepare('SELECT id, url_enc, label, enabled, created_at FROM proxies ORDER BY id')
        .all()
        .map(r => {
            let masked = '••••';
            try {
                masked = maskProxy(decrypt(r.url_enc, PROXY_AAD));
            } catch {
                masked = '⚠ не читается';
            }
            return { id: r.id, label: r.label, enabled: !!r.enabled, masked, created_at: r.created_at };
        });
}

export function enabledProxyUrls() {
    return db
        .prepare('SELECT url_enc FROM proxies WHERE enabled = 1 ORDER BY id')
        .all()
        .map(r => {
            try {
                return decrypt(r.url_enc, PROXY_AAD);
            } catch {
                return '';
            }
        })
        .filter(Boolean);
}

export function deleteProxy(id) {
    db.prepare('DELETE FROM proxies WHERE id = ?').run(Number(id));
}

export function toggleProxy(id, enabled) {
    db.prepare('UPDATE proxies SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, Number(id));
}

export function counts() {
    return {
        mailboxes: db.prepare('SELECT COUNT(*) c FROM mailboxes').get().c,
        proxies: db.prepare('SELECT COUNT(*) c FROM proxies WHERE enabled = 1').get().c,
        keys: db.prepare('SELECT COUNT(*) c FROM access_keys').get().c
    };
}

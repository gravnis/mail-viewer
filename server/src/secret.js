import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';

// Loads the 32-byte secret: from SECRET_KEY, else a persisted random key.
// Used both to encrypt stored credentials and to sign admin session cookies.
function loadKey() {
    if (config.secretKey) return Buffer.from(config.secretKey, 'hex');
    let saved;
    try {
        saved = fs.readFileSync(config.secretFile, 'utf8').trim();
    } catch {
        saved = null;
    }
    if (saved !== null) {
        // A key file exists but is malformed: refuse to run rather than silently
        // minting a new key, which would make every stored password undecryptable.
        if (!/^[0-9a-f]{64}$/i.test(saved)) {
            throw new Error(`secret.key повреждён (${config.secretFile}). Восстановите его из бэкапа или задайте SECRET_KEY.`);
        }
        return Buffer.from(saved, 'hex');
    }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(config.secretFile, key.toString('hex'), { mode: 0o600 });
    return key;
}

const KEY = loadKey();
// Separate derived keys so the cookie HMAC and the data cipher never share bytes.
const DATA_KEY = Buffer.from(crypto.hkdfSync('sha256', KEY, Buffer.alloc(0), Buffer.from('mv-data'), 32));
const SIGN_KEY = Buffer.from(crypto.hkdfSync('sha256', KEY, Buffer.alloc(0), Buffer.from('mv-sign'), 32));

/**
 * AES-256-GCM. Output: base64(iv | tag | ciphertext). Empty input -> ''.
 * `aad` binds the ciphertext to its context (e.g. "pw:user@host"), so a blob
 * cannot be lifted from one record and replayed in another.
 */
export function encrypt(plain, aad = '') {
    if (plain === undefined || plain === null || plain === '') return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', DATA_KEY, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(blob, aad = '') {
    if (!blob) return '';
    const raw = Buffer.from(blob, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', DATA_KEY, iv);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function sign(payloadObj) {
    const body = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    const mac = crypto.createHmac('sha256', SIGN_KEY).update(body).digest('base64url');
    return `${body}.${mac}`;
}

export function verify(token) {
    if (!token || !token.includes('.')) return null;
    const [body, mac] = token.split('.');
    const expected = crypto.createHmac('sha256', SIGN_KEY).update(body).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

// Opaque access-key lookup token: a keyed hash so keys are not stored in clear.
export function keyFingerprint(key) {
    return crypto.createHmac('sha256', SIGN_KEY).update('key:' + String(key)).digest('hex');
}

// Keyed hash of a full account line, so the exact line can be matched without storing
// it in clear and without a timing oracle on lookup.
export function lineFingerprint(line) {
    return crypto.createHmac('sha256', SIGN_KEY).update('line:' + String(line)).digest('hex');
}

// Short, non-reversible marker of the current admin password, embedded in sessions
// so that changing ADMIN_PASSWORD invalidates all existing cookies.
export function passwordVersion(password) {
    return crypto.createHmac('sha256', SIGN_KEY).update('pv:' + String(password)).digest('base64url').slice(0, 16);
}

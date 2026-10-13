import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = process.env.ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
}

const bool = (value, fallback) => {
    if (value === undefined || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};
const int = (value, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
};

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');

export const config = {
    root: ROOT,
    dataDir,
    dbFile: path.join(dataDir, 'mailviewer.db'),
    secretFile: path.join(dataDir, 'secret.key'),

    host: process.env.HOST || '127.0.0.1',
    port: int(process.env.PORT, 8787),

    // Admin panel login. Set in .env; the panel is useless until it is set.
    adminPassword: process.env.ADMIN_PASSWORD || '',
    sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 12),

    // Hex-encoded 32-byte key for encrypting stored passwords/tokens. If empty,
    // a key is generated and persisted to data/secret.key on first run.
    secretKey: process.env.SECRET_KEY || '',

    proxyDefaultScheme: (process.env.PROXY_DEFAULT_SCHEME || 'socks5').toLowerCase(),
    requireProxy: bool(process.env.REQUIRE_PROXY, true),

    // Only trust client-IP headers (CF-Connecting-IP / X-Forwarded-For) when a trusted
    // proxy actually sets them. Off by default so a direct client cannot spoof its IP.
    trustProxyHeaders: bool(process.env.TRUST_PROXY_HEADERS, false),
    rateLimitPerMinute: int(process.env.RATE_LIMIT_PER_MINUTE, 240),
    loginAttemptsPerWindow: int(process.env.LOGIN_ATTEMPTS, 8),
    loginWindowMinutes: int(process.env.LOGIN_WINDOW_MINUTES, 15),

    connectTimeoutMs: int(process.env.IMAP_CONNECT_TIMEOUT_MS, 20000),
    maxMessageBytes: int(process.env.MAX_MESSAGE_BYTES, 8 * 1024 * 1024),
    maxListLimit: int(process.env.MAX_LIST_LIMIT, 100),
    maxConcurrentImap: int(process.env.MAX_CONCURRENT_IMAP, 20),

    // Set when the panel is served over plain HTTP in dev, so the session cookie
    // is not marked Secure (otherwise the browser drops it).
    cookieInsecure: bool(process.env.COOKIE_INSECURE, false),
    devInsecure: bool(process.env.DEV_INSECURE, false)
};

export function validateConfig() {
    const problems = [];
    if (!config.adminPassword) {
        problems.push('ADMIN_PASSWORD не задан — без него нельзя войти в админку. Задайте его в .env.');
    } else if (config.adminPassword.length < 8) {
        problems.push('ADMIN_PASSWORD слишком короткий (минимум 8 символов).');
    }
    if (config.secretKey && !/^[0-9a-f]{64}$/i.test(config.secretKey)) {
        problems.push('SECRET_KEY должен быть 64 hex-символа (32 байта). Сгенерируйте: openssl rand -hex 32.');
    }
    return problems;
}

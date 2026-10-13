import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { resolveServer, checkServerAllowed } from './providers.js';
import { nextProxies } from './proxies.js';
import { microsoftAccessToken } from './oauth.js';
import { UserError, isProxyFailure } from './errors.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function buildAuth(account, accessToken) {
    if (account.isMicrosoft) {
        if (!account.refreshToken || !account.clientId) {
            throw new UserError('Для Outlook/Hotmail нужны refresh_token и client_id', 400, 'MS_AUTH_REQUIRED');
        }
        return { user: account.email, accessToken };
    }
    if (!account.password) {
        throw new UserError('Не указан пароль', 400, 'PASSWORD_REQUIRED');
    }
    return { user: account.email, pass: account.password };
}

/**
 * Opens a connection, trying proxies from the pool in turn. The proxy is picked here,
 * only at connect time. With REQUIRE_PROXY on, a run with no working proxy fails
 * rather than exposing the server's own address to the mail provider.
 */
async function connect(account) {
    const { host, port, secure, isMicrosoft } = resolveServer(account.email, account.host, account.port);
    const serverProblem = checkServerAllowed({ host, port });
    if (serverProblem) throw new UserError(serverProblem, 400, 'BAD_SERVER');
    account.isMicrosoft = isMicrosoft;

    const proxies = nextProxies(3);
    if (!proxies.length && config.requireProxy) {
        throw new UserError('На сервере не настроен пул прокси', 503, 'NO_PROXY');
    }

    // When a proxy is required we never fall through to a direct connection.
    const attempts = proxies.length ? proxies : [null];
    let lastErr;

    for (const proxyUrl of attempts) {
        let client;
        try {
            // Token fetch goes through the same proxy, so a proxy failure here also
            // falls through to the next proxy instead of aborting.
            const accessToken = isMicrosoft
                ? await microsoftAccessToken({ refreshToken: account.refreshToken, clientId: account.clientId }, proxyUrl)
                : undefined;
            client = new ImapFlow({
                host,
                port,
                secure,
                auth: buildAuth(account, accessToken),
                proxy: proxyUrl || undefined,
                connectionTimeout: config.connectTimeoutMs,
                greetingTimeout: config.connectTimeoutMs,
                socketTimeout: Math.max(config.connectTimeoutMs, 60000),
                disableAutoIdle: true,
                logger: silentLogger,
                tls: config.devInsecure ? { rejectUnauthorized: false } : undefined
            });
            await client.connect();
            return client;
        } catch (err) {
            if (client) {
                try {
                    await client.logout();
                } catch {
                    client.close();
                }
            }
            lastErr = err;
            // Only a proxy-level failure is worth another proxy. Auth failures and the
            // like repeat on every proxy, so stop and report them.
            if (isProxyFailure(err) && proxyUrl) continue;
            throw err;
        }
    }
    throw lastErr;
}

// Cap simultaneous IMAP connections so a flood of requests cannot exhaust the
// proxy pool, sockets or memory. Extra requests wait briefly, then fail cleanly.
let active = 0;
const MAX_ACTIVE = config.maxConcurrentImap;
async function withSlot(fn) {
    if (active >= MAX_ACTIVE) {
        throw new UserError('Сервер занят, попробуйте через несколько секунд', 503, 'BUSY');
    }
    active++;
    try {
        return await fn();
    } finally {
        active--;
    }
}

const FOLDER_ALIASES = {
    inbox: 'INBOX',
    spam: '\\Junk',
    junk: '\\Junk',
    trash: '\\Trash',
    sent: '\\Sent',
    drafts: '\\Drafts',
    archive: '\\Archive',
    all: '\\All'
};

async function openFolder(client, folder) {
    const requested = (folder || 'inbox').trim();
    const specialFlag = FOLDER_ALIASES[requested.toLowerCase()];
    let path = requested;
    if (specialFlag) {
        if (specialFlag === 'INBOX') {
            path = 'INBOX';
        } else {
            const list = await client.list({ statusQuery: false });
            const match = list.find(box => (box.specialUse || '').toLowerCase() === specialFlag.toLowerCase());
            if (!match) throw new UserError(`Папка «${requested}» не найдена`, 404, 'NO_FOLDER');
            path = match.path;
        }
    }
    // readOnly keeps the mailbox untouched: nothing is marked read, moved or deleted.
    return client.mailboxOpen(path, { readOnly: true });
}

function addressText(addr) {
    if (!addr?.value?.length) return '';
    return addr.value.map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}

/** Lists folders with their names and special-use role, for the extension's folder picker. */
async function doListFolders(account) {
    const client = await connect(account);
    try {
        const boxes = await client.list({ statusQuery: { messages: true, unseen: true } });
        return boxes
            .filter(b => !b.flags?.has('\\Noselect'))
            .map(b => ({
                path: b.path,
                name: b.name,
                specialUse: b.specialUse || null,
                messages: b.status?.messages ?? null,
                unseen: b.status?.unseen ?? null
            }));
    } finally {
        await client.logout().catch(() => client.close());
    }
}

/**
 * Returns the newest messages in a folder (envelope + flags only, no bodies).
 * `unseenOnly` powers the "new mail" view.
 */
async function doListMessages(account, { folder = 'inbox', limit = 25, unseenOnly = false } = {}) {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 25), config.maxListLimit);
    const client = await connect(account);
    try {
        const box = await openFolder(client, folder);
        const total = box.exists || 0;
        if (!total) return { folder: box.path, total: 0, unseen: 0, messages: [] };

        let seqRange;
        let unseen = 0;
        if (unseenOnly) {
            const uids = await client.search({ seen: false }, { uid: true });
            unseen = uids.length;
            if (!uids.length) return { folder: box.path, total, unseen: 0, messages: [] };
            seqRange = uids.slice(-safeLimit);
        } else {
            const from = Math.max(1, total - safeLimit + 1);
            seqRange = `${from}:${total}`;
        }

        const messages = [];
        const fetchOpts = unseenOnly ? { uid: true } : {};
        for await (const msg of client.fetch(seqRange, { uid: true, flags: true, envelope: true, size: true }, fetchOpts)) {
            const env = msg.envelope || {};
            messages.push({
                uid: msg.uid,
                subject: env.subject || '(без темы)',
                from: addressText({ value: env.from }),
                to: addressText({ value: env.to }),
                date: env.date || null,
                seen: msg.flags?.has('\\Seen') ?? false,
                size: msg.size ?? null
            });
        }
        messages.reverse(); // newest first
        return { folder: box.path, total, unseen: unseenOnly ? unseen : undefined, messages };
    } finally {
        await client.logout().catch(() => client.close());
    }
}

/** Fetches and parses one message by UID. Read-only: the \Seen flag is not set. */
async function doGetMessage(account, { folder = 'inbox', uid } = {}) {
    if (!uid) throw new UserError('Не указан uid письма', 400, 'UID_REQUIRED');
    const client = await connect(account);
    try {
        await openFolder(client, folder);
        const downloaded = await client.download(`${uid}`, undefined, { uid: true });
        if (!downloaded?.content) throw new UserError('Письмо не найдено', 404, 'NOT_FOUND');

        const chunks = [];
        let bytes = 0;
        for await (const chunk of downloaded.content) {
            bytes += chunk.length;
            if (bytes > config.maxMessageBytes) {
                downloaded.content.destroy();
                throw new UserError('Письмо слишком большое для просмотра', 413, 'TOO_LARGE');
            }
            chunks.push(chunk);
        }
        const parsed = await simpleParser(Buffer.concat(chunks), { skipImageLinks: true });
        return {
            uid: Number(uid),
            subject: parsed.subject || '(без темы)',
            from: parsed.from?.text || '',
            to: parsed.to?.text || '',
            cc: parsed.cc?.text || '',
            date: parsed.date || null,
            text: parsed.text || '',
            html: parsed.html || null,
            attachments: (parsed.attachments || []).map(a => ({
                filename: a.filename || 'attachment',
                contentType: a.contentType,
                size: a.size
            }))
        };
    } finally {
        await client.logout().catch(() => client.close());
    }
}

// Public entry points, each bounded by the concurrency slot.
export const listFolders = account => withSlot(() => doListFolders(account));
export const listMessages = (account, opts) => withSlot(() => doListMessages(account, opts));
export const getMessage = (account, opts) => withSlot(() => doGetMessage(account, opts));

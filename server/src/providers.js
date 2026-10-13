import net from 'node:net';
import { config } from './config.js';

// Domain -> IMAP server. Anything not listed falls back to imap.<domain>.
const KNOWN = {
    'gmail.com': 'imap.gmail.com',
    'googlemail.com': 'imap.gmail.com',
    'outlook.com': 'outlook.office365.com',
    'hotmail.com': 'outlook.office365.com',
    'live.com': 'outlook.office365.com',
    'msn.com': 'outlook.office365.com',
    'yahoo.com': 'imap.mail.yahoo.com',
    'ymail.com': 'imap.mail.yahoo.com',
    'aol.com': 'imap.aol.com',
    'icloud.com': 'imap.mail.me.com',
    'me.com': 'imap.mail.me.com',
    'mac.com': 'imap.mail.me.com',
    'yandex.ru': 'imap.yandex.ru',
    'yandex.com': 'imap.yandex.com',
    'ya.ru': 'imap.yandex.ru',
    'mail.ru': 'imap.mail.ru',
    'inbox.ru': 'imap.mail.ru',
    'list.ru': 'imap.mail.ru',
    'bk.ru': 'imap.mail.ru',
    'internet.ru': 'imap.mail.ru',
    'rambler.ru': 'imap.rambler.ru',
    'gmx.com': 'imap.gmx.com',
    'gmx.net': 'imap.gmx.net',
    'gmx.de': 'imap.gmx.net',
    'web.de': 'imap.web.de',
    'zoho.com': 'imap.zoho.com',
    'o2.pl': 'poczta.o2.pl',
    'wp.pl': 'imap.wp.pl',
    'onet.pl': 'imap.poczta.onet.pl',
    'qq.com': 'imap.qq.com',
    '163.com': 'imap.163.com',
    'firstmail.ltd': 'imap.firstmail.ltd'
};

// Outlook.com / Hotmail no longer accept plain passwords over IMAP (Microsoft removed
// basic auth in 2024); these need the refresh_token + client_id login.
const MICROSOFT_HOSTS = new Set(['outlook.office365.com']);

export function resolveServer(email, hostOverride, portOverride) {
    const domain = email.split('@')[1].toLowerCase();
    const host = (hostOverride || KNOWN[domain] || `imap.${domain}`).toLowerCase();
    const port = Number(portOverride) || 993;
    return { host, port, secure: port === 993, isMicrosoft: MICROSOFT_HOSTS.has(host) };
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * Users can type a custom IMAP host, so it must not become a way to make our
 * server (or the proxy) poke internal services: only public hostnames, only IMAP ports.
 */
export function checkServerAllowed({ host, port }) {
    if (config.devInsecure) return null;
    // Only implicit-TLS IMAP (993). Port 143 is cleartext until STARTTLS and can be
    // stripped by a MITM, so it is not allowed.
    if (port !== 993) return 'Разрешён только защищённый IMAP-порт 993';
    if (host.length > 253) return 'Слишком длинное имя IMAP-сервера';
    if (net.isIP(host)) return 'Укажите IMAP-сервер доменным именем, а не IP-адресом';
    if (!HOSTNAME_RE.test(host)) return 'Некорректное имя IMAP-сервера';
    if (/(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(host)) return 'Недопустимый IMAP-сервер';
    return null;
}

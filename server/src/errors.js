export class UserError extends Error {
    constructor(message, status = 400, code = 'BAD_REQUEST') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const PROXY_SETUP_MESSAGE = 'Failed to setup proxy connection';

/** True when the failure happened before we reached the mail server (worth trying another proxy). */
export function isProxyFailure(err) {
    return (
        err?.message === PROXY_SETUP_MESSAGE ||
        err?.stage === 'proxy' ||
        err?.code === 'EPROXY' ||
        err?.code === 'ProxyError'
    );
}
/**
 * Maps any failure to a message that is safe to show in the extension.
 * Raw error text is never forwarded: it can contain proxy or server addresses.
 */
export function toClientError(err) {
    if (err instanceof UserError) {
        return { status: err.status, body: { error: err.code, message: err.message } };
    }
    if (err?.authenticationFailed) {
        return {
            status: 401,
            body: {
                error: 'AUTH_FAILED',
                message:
                    'Почтовый сервер не принял логин или пароль. Для Gmail, Yandex, Mail.ru, Yahoo, iCloud нужен «пароль приложения», и в настройках ящика должен быть включён IMAP.'
            }
        };
    }
    if (err?.code === 'OAUTH_FAILED') {
        return {
            status: 401,
            body: {
                error: 'OAUTH_FAILED',
                message: 'Microsoft отклонил refresh_token: токен устарел или client_id не подходит.'
            }
        };
    }
    if (isProxyFailure(err)) {
        return { status: 502, body: { error: 'PROXY_FAILED', message: 'Прокси-сервер не отвечает. Попробуйте позже.' } };
    }
    if (err?.code === 'CONNECT_TIMEOUT' || err?.code === 'ETIMEDOUT') {
        return { status: 504, body: { error: 'TIMEOUT', message: 'Почтовый сервер не ответил вовремя.' } };
    }
    if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED' || err?.code === 'NoConnection') {
        return {
            status: 502,
            body: { error: 'CONNECT_FAILED', message: 'Не удалось подключиться к IMAP-серверу. Проверьте адрес сервера.' }
        };
    }
    if (err?.serverResponseCode === 'NONEXISTENT' || err?.mailboxMissing) {
        return { status: 404, body: { error: 'NO_FOLDER', message: 'Такой папки нет в ящике.' } };
    }
    return { status: 502, body: { error: 'IMAP_ERROR', message: 'Ошибка почтового сервера.' } };
}

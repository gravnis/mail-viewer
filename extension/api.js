// Thin client for the Mail Viewer server. The extension only reads. The employee's
// mailbox address + password are sent per request (the server is stateless and uses
// them to connect via a proxy, then forgets). There is no "send" call anywhere.

const SETTINGS_KEYS = ['serverUrl', 'accessKey'];

export async function getSettings() {
    const s = await chrome.storage.local.get(SETTINGS_KEYS);
    return { serverUrl: (s.serverUrl || '').replace(/\/$/, ''), accessKey: s.accessKey || '' };
}

export async function saveSettings({ serverUrl, accessKey }) {
    await chrome.storage.local.set({ serverUrl: serverUrl.replace(/\/$/, ''), accessKey });
}

export class ApiError extends Error {
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

async function call(path, payload) {
    const { serverUrl, accessKey } = await getSettings();
    if (!serverUrl || !accessKey) {
        throw new ApiError('Не настроен адрес сервера или ключ доступа. Откройте настройки.', 'NOT_CONFIGURED', 0);
    }
    let res;
    try {
        res = await fetch(serverUrl + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Access-Key': accessKey },
            body: JSON.stringify(payload || {})
        });
    } catch {
        throw new ApiError('Сервер недоступен. Проверьте адрес и соединение.', 'NETWORK', 0);
    }
    let data = {};
    try {
        data = await res.json();
    } catch {
        // leave empty
    }
    if (!res.ok) {
        throw new ApiError(data.message || `Ошибка сервера (${res.status})`, data.error || 'ERROR', res.status);
    }
    return data;
}

export const listFolders = acc => call('/api/folders', { line: acc.line });
export const listMessages = (acc, opts = {}) => call('/api/messages', { line: acc.line, ...opts });
export const getMessage = (acc, folder, uid) => call('/api/message', { line: acc.line, folder, uid });

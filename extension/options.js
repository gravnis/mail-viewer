import { getSettings, saveSettings } from './api.js';

const $ = id => document.getElementById(id);
const msg = (text, kind) => {
    $('msg').textContent = text;
    $('msg').className = 'status show ' + (kind || 'info');
};

function originPattern(url) {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
}

async function ensurePermission(url) {
    // Request access to just the configured origin, instead of baking a broad
    // host permission into the manifest.
    const pattern = originPattern(url);
    const has = await chrome.permissions.contains({ origins: [pattern] });
    if (has) return true;
    return chrome.permissions.request({ origins: [pattern] });
}

(async function init() {
    const s = await getSettings();
    $('serverUrl').value = s.serverUrl;
    $('accessKey').value = s.accessKey;
})();

$('saveBtn').addEventListener('click', async () => {
    const serverUrl = $('serverUrl').value.trim().replace(/\/$/, '');
    const accessKey = $('accessKey').value.trim();
    if (!/^https:\/\//i.test(serverUrl)) {
        msg('Адрес сервера должен начинаться с https://', 'error');
        return;
    }
    if (!accessKey) {
        msg('Введите ключ доступа', 'error');
        return;
    }
    try {
        const granted = await ensurePermission(serverUrl);
        if (!granted) {
            msg('Нужно разрешить доступ к адресу сервера', 'error');
            return;
        }
    } catch {
        msg('Некорректный адрес сервера', 'error');
        return;
    }
    await saveSettings({ serverUrl, accessKey });
    msg('Сохранено', 'ok');
});

$('testBtn').addEventListener('click', async () => {
    const serverUrl = $('serverUrl').value.trim().replace(/\/$/, '');
    if (!/^https:\/\//i.test(serverUrl)) {
        msg('Сначала укажите https-адрес сервера', 'error');
        return;
    }
    try {
        await ensurePermission(serverUrl);
        const res = await fetch(serverUrl + '/health');
        if (res.ok) msg('Сервер отвечает ✓', 'ok');
        else msg(`Сервер ответил с кодом ${res.status}`, 'error');
    } catch {
        msg('Сервер недоступен', 'error');
    }
});

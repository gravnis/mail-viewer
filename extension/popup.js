import { listFolders, listMessages, getMessage, getSettings } from './api.js';
import { getAccounts, saveAccount, removeAccount, emailFromLine } from './accounts.js';

const $ = id => document.getElementById(id);
const el = {
    accountSelect: $('accountSelect'),
    addAccountBtn: $('addAccountBtn'),
    refreshBtn: $('refreshBtn'),
    settingsBtn: $('settingsBtn'),
    addForm: $('addForm'),
    tabs: $('tabs'),
    folderSelect: $('folderSelect'),
    list: $('list'),
    reader: $('reader'),
    readerHead: $('readerHead'),
    readerBody: $('readerBody'),
    backBtn: $('backBtn'),
    status: $('status'),
    saveAccountBtn: $('saveAccountBtn'),
    cancelAccountBtn: $('cancelAccountBtn'),
    deleteAccountBtn: $('deleteAccountBtn')
};

const state = { accounts: [], current: null, view: 'unseen', folder: 'inbox', editing: null };

function setStatus(msg, kind = 'info') {
    el.status.textContent = msg || '';
    el.status.className = 'status' + (msg ? ` show ${kind}` : '');
}

function fmtDate(d) {
    if (!d) return '';
    const date = new Date(d);
    if (Number.isNaN(date.getTime())) return '';
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
        ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function currentAccount() {
    return state.accounts.find(a => a.email === state.current) || null;
}

async function loadAccounts() {
    state.accounts = await getAccounts();
    el.accountSelect.innerHTML = '';
    for (const a of state.accounts) {
        const opt = document.createElement('option');
        opt.value = a.email;
        opt.textContent = a.label ? `${a.email} — ${a.label}` : a.email;
        el.accountSelect.appendChild(opt);
    }
    if (state.accounts.length) {
        const keep = state.accounts.find(a => a.email === state.current);
        state.current = (keep || state.accounts[0]).email;
        el.accountSelect.value = state.current;
        showMail();
        el.folderSelect.innerHTML = '';
        await refresh();
    } else {
        state.current = null;
        openAddForm();
    }
}

// ---- add/edit ----
function openAddForm(edit = null) {
    state.editing = edit;
    el.addForm.classList.remove('hidden');
    el.tabs.classList.add('hidden');
    el.list.classList.add('hidden');
    el.reader.classList.add('hidden');
    el.deleteAccountBtn.classList.toggle('hidden', !edit);
    $('f_line').value = edit?.line || '';
    $('f_label').value = edit?.label || '';
    $('f_line').focus();
}

function closeAddForm() {
    el.addForm.classList.add('hidden');
    if (state.current) showMail();
}

function showMail() {
    el.addForm.classList.add('hidden');
    el.reader.classList.add('hidden');
    el.tabs.classList.remove('hidden');
    el.list.classList.remove('hidden');
}

async function onSaveAccount() {
    const line = $('f_line').value.trim();
    const email = emailFromLine(line);
    if (!email) {
        setStatus('В строке не найден адрес почты', 'error');
        return;
    }
    await saveAccount({ line, label: $('f_label').value.trim() });
    state.current = email;
    await loadAccounts();
    el.accountSelect.value = email;
    setStatus('Ящик сохранён', 'ok');
}

async function onDeleteAccount() {
    if (!state.editing) return;
    await removeAccount(state.editing.email);
    state.current = null;
    await loadAccounts();
    setStatus('Ящик удалён', 'ok');
}

// ---- folders ----
async function loadFolders() {
    try {
        const { folders } = await listFolders(currentAccount());
        el.folderSelect.innerHTML = '';
        for (const f of folders) {
            const opt = document.createElement('option');
            opt.value = f.path;
            const role = f.specialUse ? ` (${f.specialUse.replace('\\', '')})` : '';
            opt.textContent = `${f.name}${role}`;
            el.folderSelect.appendChild(opt);
        }
        const inbox = folders.find(f => f.specialUse === '\\Inbox' || /^inbox$/i.test(f.path));
        state.folder = inbox ? inbox.path : folders[0]?.path || 'inbox';
        el.folderSelect.value = state.folder;
    } catch {
        el.folderSelect.innerHTML = '<option value="inbox">Входящие</option>';
        state.folder = 'inbox';
    }
}

function renderList(data) {
    el.list.innerHTML = '';
    if (!data.messages.length) {
        const div = document.createElement('div');
        div.className = 'empty';
        div.textContent = state.view === 'unseen' ? 'Новых писем нет' : 'Писем нет';
        el.list.appendChild(div);
        return;
    }
    for (const m of data.messages) {
        const item = document.createElement('div');
        item.className = 'mail' + (m.seen ? '' : ' unread');
        const from = document.createElement('div');
        from.className = 'mail-from';
        from.textContent = m.from || '(без отправителя)';
        const date = document.createElement('div');
        date.className = 'mail-date';
        date.textContent = fmtDate(m.date);
        const subj = document.createElement('div');
        subj.className = 'mail-subject';
        subj.textContent = m.subject;
        const top = document.createElement('div');
        top.className = 'mail-top';
        top.append(from, date);
        item.append(top, subj);
        item.addEventListener('click', () => openMessage(m.uid));
        el.list.appendChild(item);
    }
}

function showError(container, message) {
    container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'empty error';
    div.textContent = message;
    container.appendChild(div);
}

async function refresh() {
    if (!currentAccount()) return;
    setStatus('Загрузка…');
    el.tabs.classList.remove('hidden');
    el.refreshBtn.classList.add('spin');
    try {
        if (!el.folderSelect.options.length) await loadFolders();
        const data = await listMessages(currentAccount(), {
            folder: state.folder,
            limit: 30,
            unseenOnly: state.view === 'unseen'
        });
        renderList(data);
        const label = state.view === 'unseen' ? `новых: ${data.messages.length}` : `всего: ${data.total}`;
        setStatus(`${state.current} — ${label}`, 'ok');
    } catch (e) {
        showError(el.list, e.message);
        setStatus(e.message, 'error');
    } finally {
        el.refreshBtn.classList.remove('spin');
    }
}

function openMessage(uid) {
    if (!currentAccount()) return;
    el.list.classList.add('hidden');
    el.tabs.classList.add('hidden');
    el.reader.classList.remove('hidden');
    el.readerHead.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'loading';
    loading.textContent = 'Открываю письмо…';
    el.readerHead.appendChild(loading);
    el.readerBody.innerHTML = '';

    getMessage(currentAccount(), state.folder, uid)
        .then(msg => {
            el.readerHead.innerHTML = '';
            const subj = document.createElement('div');
            subj.className = 'r-subject';
            subj.textContent = msg.subject;
            const meta = document.createElement('div');
            meta.className = 'r-meta';
            meta.textContent = `От: ${msg.from}   ${fmtDate(msg.date)}`;
            el.readerHead.append(subj, meta);
            if (msg.attachments?.length) {
                const att = document.createElement('div');
                att.className = 'r-att';
                att.textContent = '📎 ' + msg.attachments.map(a => a.filename).join(', ');
                el.readerHead.appendChild(att);
            }
            renderBody(msg);
        })
        .catch(e => showError(el.readerBody, e.message));
}

function renderBody(msg) {
    el.readerBody.innerHTML = '';
    if (msg.html) {
        // Sandboxed, scriptless iframe + strict CSP: the email cannot run JS, submit
        // forms, redirect the frame, or auto-load remote content/trackers.
        const frame = document.createElement('iframe');
        frame.className = 'html-frame';
        frame.setAttribute('sandbox', '');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;">
<style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;margin:8px;word-break:break-word}img{max-width:100%}a{pointer-events:none;color:#2563eb;text-decoration:underline}</style>
</head><body>${msg.html}</body></html>`;
        el.readerBody.appendChild(frame);
    } else {
        const pre = document.createElement('div');
        pre.className = 'r-text';
        pre.textContent = msg.text || '(пустое письмо)';
        el.readerBody.appendChild(pre);
    }
}

// ---- events ----
el.accountSelect.addEventListener('change', () => {
    state.current = el.accountSelect.value;
    el.folderSelect.innerHTML = '';
    refresh();
});
el.addAccountBtn.addEventListener('click', () => openAddForm(null));
el.refreshBtn.addEventListener('click', refresh);
el.settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
el.saveAccountBtn.addEventListener('click', onSaveAccount);
el.cancelAccountBtn.addEventListener('click', closeAddForm);
el.deleteAccountBtn.addEventListener('click', onDeleteAccount);
el.backBtn.addEventListener('click', showMail);
el.folderSelect.addEventListener('change', () => {
    state.folder = el.folderSelect.value;
    refresh();
});
el.accountSelect.addEventListener('dblclick', () => {
    const acc = currentAccount();
    if (acc) openAddForm(acc);
});
for (const tab of el.tabs.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
        el.tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.view = tab.dataset.view;
        refresh();
    });
}

(async function init() {
    const { serverUrl, accessKey } = await getSettings();
    if (!serverUrl || !accessKey) {
        setStatus('Сначала откройте настройки (⚙)', 'error');
        el.tabs.classList.add('hidden');
        showError(el.list, 'Нажмите ⚙ и введите адрес сервера и ключ доступа от администратора.');
        return;
    }
    await loadAccounts();
})();

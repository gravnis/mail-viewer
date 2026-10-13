// Accounts the employee pasted, stored only in this browser. Each is the full account
// line the admin handed out in DM; the server admits it only if that exact line is in
// the admin's database. The email is extracted just for the dropdown label.

const KEY = 'accounts';

export function emailFromLine(line) {
    const parts = String(line || '').split(/----|[\s:,;]+/);
    return (parts.find(p => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p)) || '').toLowerCase();
}

export async function getAccounts() {
    const s = await chrome.storage.local.get(KEY);
    return Array.isArray(s[KEY]) ? s[KEY] : [];
}

export async function saveAccount({ line, label }) {
    const accounts = await getAccounts();
    const clean = String(line || '').trim();
    const email = emailFromLine(clean);
    const entry = { line: clean, email, label: label || '' };
    // Dedup by the extracted email (one entry per mailbox).
    const idx = accounts.findIndex(a => a.email && a.email === email);
    if (idx >= 0) accounts[idx] = entry;
    else accounts.push(entry);
    await chrome.storage.local.set({ [KEY]: accounts });
    return email || clean;
}

export async function removeAccount(email) {
    const accounts = (await getAccounts()).filter(a => a.email !== email);
    await chrome.storage.local.set({ [KEY]: accounts });
}

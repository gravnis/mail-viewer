'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let STATE = { counts: {}, mailboxes: [], proxies: [], keys: [] };

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (res.status === 401) {
    location.href = '/';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'Ошибка');
  return data;
}

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => (t.className = 'toast'), 2600);
}

// ---------- tabs ----------
$$('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $$('.tab').forEach(s => s.classList.toggle('active', s.dataset.tab === tab));
  });
});

$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/admin/logout', { method: 'POST' });
  location.href = '/';
});

// ---------- modal ----------
function openModal(title, bodyHtml, footButtons) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  const foot = $('#modalFoot');
  foot.innerHTML = '';
  for (const b of footButtons) {
    const el = document.createElement('button');
    el.className = 'btn ' + (b.cls || '');
    el.textContent = b.label;
    el.addEventListener('click', b.onClick);
    foot.appendChild(el);
  }
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

// ---------- load & render ----------
async function reload() {
  STATE = await api('/admin/api/state');
  renderCounts();
  renderMailboxes();
  renderProxies();
  renderKeys();
}

function renderCounts() {
  $('#stMailboxes').textContent = STATE.counts.mailboxes ?? 0;
  $('#stProxies').textContent = STATE.counts.proxies ?? 0;
  $('#stKeys').textContent = STATE.counts.keys ?? 0;
}

function renderMailboxes() {
  const tbody = $('#mailboxTable tbody');
  tbody.innerHTML = '';
  $('#mailboxEmpty').classList.toggle('hidden', STATE.mailboxes.length > 0);
  $('#mailboxTable').classList.toggle('hidden', STATE.mailboxes.length === 0);
  for (const m of STATE.mailboxes) {
    const type = m.is_ms ? '<span class="badge badge-ms">Microsoft</span>' : '<span class="badge badge-neutral">пароль</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="email-cell">${esc(m.email)}</td>
      <td class="muted">${esc(m.label) || '—'}</td>
      <td>${type}</td>
      <td><div class="row-actions">
        <button class="btn btn-sm btn-danger" data-act="delmail" data-id="${m.id}">Удалить</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
}

function renderProxies() {
  const tbody = $('#proxyTable tbody');
  tbody.innerHTML = '';
  $('#proxyEmpty').classList.toggle('hidden', STATE.proxies.length > 0);
  $('#proxyTable').classList.toggle('hidden', STATE.proxies.length === 0);
  for (const p of STATE.proxies) {
    const status = p.enabled ? '<span class="badge badge-ok">активен</span>' : '<span class="badge badge-off">выключен</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${esc(p.masked)}</td>
      <td class="muted">${esc(p.label) || '—'}</td>
      <td>${status}</td>
      <td><div class="row-actions">
        <button class="btn btn-sm btn-ghost" data-act="toggleproxy" data-id="${p.id}" data-on="${p.enabled ? 0 : 1}">${p.enabled ? 'Выключить' : 'Включить'}</button>
        <button class="btn btn-sm btn-danger" data-act="delproxy" data-id="${p.id}">Удалить</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
}

function renderKeys() {
  const tbody = $('#keyTable tbody');
  tbody.innerHTML = '';
  $('#keyEmpty').classList.toggle('hidden', STATE.keys.length > 0);
  $('#keyTable').classList.toggle('hidden', STATE.keys.length === 0);
  for (const k of STATE.keys) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="email-cell">${esc(k.label)}</td>
      <td class="mono muted">${esc(k.hint)}</td>
      <td><div class="row-actions">
        <button class="btn btn-sm btn-danger" data-act="delkey" data-id="${k.id}">Удалить</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
}

// ---------- row actions (delegated) ----------
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  try {
    if (act === 'delmail') {
      if (!confirm('Удалить этот ящик?')) return;
      await api('/admin/api/mailboxes/delete', { id });
      toast('Ящик удалён'); await reload();
    } else if (act === 'delproxy') {
      if (!confirm('Удалить этот прокси?')) return;
      await api('/admin/api/proxies/delete', { id });
      toast('Прокси удалён'); await reload();
    } else if (act === 'toggleproxy') {
      await api('/admin/api/proxies/toggle', { id, enabled: btn.dataset.on === '1' });
      await reload();
    } else if (act === 'delkey') {
      if (!confirm('Удалить ключ? Расширения с этим ключом потеряют доступ.')) return;
      await api('/admin/api/keys/delete', { id });
      toast('Ключ удалён'); await reload();
    }
  } catch (err) { toast(err.message, true); }
});

// ---------- add / import mailboxes (paste lines) ----------
function openImportMailboxes() {
  openModal('Добавить почты', `
    <p class="hint">Вставьте аккаунты — по одной строке на аккаунт. Поддерживаются форматы:</p>
    <p class="hint mono">Outlook/Hotmail:&nbsp;email----password----client_id----refresh_token----…<br>Обычная почта:&nbsp;email:password</p>
    <p class="hint">Разделитель для Outlook — четыре дефиса <b>----</b>. Лишние поля (резервная почта и т.п.) можно оставить — они не используются, но строка должна совпадать с той, что вы выдадите сотруднику.</p>
    <textarea id="bulkMailboxes" placeholder="log@outlook.com----пароль----9e5f94bc-...-63364c29d753----M.C505_...----..."></textarea>
    <div class="import-result" id="mailImportResult"></div>`,
    [
      { label: 'Закрыть', onClick: closeModal },
      { label: 'Добавить', cls: 'btn-primary', onClick: async () => {
        try {
          const r = await api('/admin/api/mailboxes/import', { text: $('#bulkMailboxes').value });
          let html = `Добавлено/обновлено: <b>${r.added}</b>.`;
          if (r.errors.length) html += '<br>' + r.errors.map(e => `<span class="err">строка ${e.line}: ${esc(e.reason)}</span>`).join('<br>');
          $('#mailImportResult').innerHTML = html;
          toast(`Добавлено: ${r.added}`); await reload();
        } catch (err) { toast(err.message, true); }
      } }
    ]);
}
$('#addMailboxBtn').addEventListener('click', openImportMailboxes);

// ---------- add proxy ----------
$('#addProxyBtn').addEventListener('click', () => {
  openModal('Добавить прокси', `
    <label class="field"><span>Прокси</span><input id="pUrl" placeholder="socks5://user:pass@host:port" autocomplete="off"></label>
    <label class="field"><span>Метка (необязательно)</span><input id="pLabel" placeholder="например: DE-1"></label>
    <p class="hint">Форматы: socks5://user:pass@host:port, http://host:port, host:port:user:pass, host:port</p>`,
    [
      { label: 'Отмена', onClick: closeModal },
      { label: 'Добавить', cls: 'btn-primary', onClick: async () => {
        try {
          await api('/admin/api/proxies/add', { url: $('#pUrl').value.trim(), label: $('#pLabel').value.trim() });
          closeModal(); toast('Прокси добавлен'); await reload();
        } catch (err) { toast(err.message, true); }
      } }
    ]);
});

// ---------- import proxies ----------
$('#importProxiesBtn').addEventListener('click', () => {
  openModal('Импорт прокси списком', `
    <p class="hint">Один прокси на строку. Рекомендуется socks5 (удалённый DNS).</p>
    <textarea id="bulkProxies" placeholder="socks5://user:pass@1.2.3.4:1080&#10;5.6.7.8:1080:user:pass"></textarea>
    <div class="import-result" id="proxyImportResult"></div>`,
    [
      { label: 'Закрыть', onClick: closeModal },
      { label: 'Импортировать', cls: 'btn-primary', onClick: async () => {
        try {
          const r = await api('/admin/api/proxies/import', { text: $('#bulkProxies').value });
          let html = `Добавлено: <b>${r.added}</b>.`;
          if (r.errors.length) html += '<br>' + r.errors.map(e => `<span class="err">строка ${e.line}: ${esc(e.reason)}</span>`).join('<br>');
          $('#proxyImportResult').innerHTML = html;
          toast(`Импортировано: ${r.added}`); await reload();
        } catch (err) { toast(err.message, true); }
      } }
    ]);
});

// ---------- create key ----------
$('#addKeyBtn').addEventListener('click', () => {
  openModal('Создать ключ доступа', `
    <label class="field"><span>Название (для кого этот ключ)</span><input id="kLabel" placeholder="например: Иван / Отдел 1"></label>`,
    [
      { label: 'Отмена', onClick: closeModal },
      { label: 'Создать', cls: 'btn-primary', onClick: async () => {
        try {
          const r = await api('/admin/api/keys/add', { label: $('#kLabel').value.trim() || 'Без названия' });
          openModal('Ключ создан', `
            <p class="hint">Скопируйте ключ сейчас — целиком он больше не показывается. Впишите его в расширении (настройки).</p>
            <div class="key-reveal" id="keyReveal">${esc(r.key)}</div>`,
            [
              { label: 'Скопировать', onClick: () => { navigator.clipboard.writeText(r.key); toast('Скопировано'); } },
              { label: 'Готово', cls: 'btn-primary', onClick: async () => { closeModal(); await reload(); } }
            ]);
        } catch (err) { toast(err.message, true); }
      } }
    ]);
});

reload().catch(err => toast(err.message, true));

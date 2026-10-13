const form = document.getElementById('loginForm');
form.addEventListener('submit', async e => {
    e.preventDefault();
    const err = document.getElementById('loginError');
    err.textContent = '';
    const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('password').value })
    });
    if (res.ok) location.href = '/';
    else err.textContent = 'Неверный пароль';
});

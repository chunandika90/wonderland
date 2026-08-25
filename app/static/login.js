// window.APP_BASE is injected server-side (defaults to "/") so login works whether the app is
// mounted at the domain root or under a real subfolder like /compass.
const APP_BASE = (window.APP_BASE || '/');

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errBox = document.getElementById('login-error');
  errBox.textContent = '';
  try {
    const res = await fetch(APP_BASE.replace(/\/$/, '') + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.ok) {
      window.location.href = APP_BASE;
    } else {
      errBox.textContent = data.error || 'Invalid username or password.';
    }
  } catch (err) {
    errBox.textContent = 'Could not reach the server.';
  }
});

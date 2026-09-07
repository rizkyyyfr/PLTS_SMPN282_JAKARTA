document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.querySelector('#loginError');
  error.textContent = '';
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: document.querySelector('#username').value,
      password: document.querySelector('#password').value,
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    error.textContent = payload.error || 'Login gagal. Silakan coba lagi.';
    return;
  }
  window.location.href = '/index.html';
});

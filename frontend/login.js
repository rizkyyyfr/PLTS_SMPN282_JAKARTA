document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.querySelector('#loginError');
  const submitButton = document.querySelector('.login-submit');
  error.textContent = '';
  submitButton.disabled = true;
  submitButton.textContent = 'Memeriksa…';

  const { error: authError } = await supabaseClient.auth.signInWithPassword({
    email: document.querySelector('#username').value,
    password: document.querySelector('#password').value,
  });

  submitButton.disabled = false;
  submitButton.textContent = 'Masuk';

  if (authError) {
    error.textContent = authError.message === 'Invalid login credentials'
      ? 'Email atau kata sandi salah.'
      : authError.message;
    return;
  }

  window.location.href = '/index.html';
});

// Kalau sudah login (sesi masih aktif), langsung lempar ke dashboard
// supaya tidak perlu login ulang tiap buka /login.html.
supabaseClient.auth.getSession().then(({ data }) => {
  if (data.session) window.location.href = '/index.html';
});

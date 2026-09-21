import { el, icon, toast } from '../ui.js';
import { config } from '../config.js';
import { api, ping } from '../api.js';

/**
 * The API URLs the wizard accepts: the Supabase Edge Function (and a local
 * `supabase start`), or — until it is retired — the Apps Script Web App.
 */
const API_URL_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/[A-Za-z0-9_-]+\/?$/,
  /^http:\/\/(localhost|127\.0\.0\.1):\d+\/functions\/v1\/[A-Za-z0-9_-]+\/?$/,
  /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/
];

/** First-run wizard: point the site at the backend and seed an admin. */
export function setupView(onDone) {
  const urlInput = el('input', {
    class: 'input', type: 'url', placeholder: 'https://<project>.supabase.co/functions/v1/api',
    value: config.apiUrl, autocomplete: 'off', spellcheck: 'false'
  });
  const status = el('p', { class: 'form-error', hidden: true });
  const seedBox = el('div', { hidden: true });

  const nameInput = el('input', { class: 'input', placeholder: 'Administrator' });
  const phoneInput = el('input', { class: 'input', type: 'tel', placeholder: '+91 98800 11111',
                                   autocomplete: 'tel' });
  const emailInput = el('input', { class: 'input', type: 'email', placeholder: 'you@example.com (optional)' });
  const passInput = el('input', { class: 'input', type: 'password', placeholder: 'At least 10 characters',
                                  autocomplete: 'new-password' });
  const keyInput = el('input', { class: 'input', type: 'password', placeholder: 'Setup key' });

  // Only shown if the deployment has a SETUP_KEY script property set.
  const keyField = el('label', { hidden: true }, [
    'Setup key',
    keyInput,
    el('small', { class: 'help', text: 'This deployment requires the SETUP_KEY set among its secrets.' })
  ]);

  seedBox.append(el('div', { class: 'stack' }, [
    el('h3', { text: 'Create the first administrator' }),
    el('p', { class: 'muted', text: 'Only shown once — after this, sign in normally.' }),
    el('label', {}, ['Name', nameInput]),
    el('label', {}, [
      'Phone number', phoneInput,
      el('small', { class: 'help', text: 'This is how you sign in. Country code optional.' })
    ]),
    el('label', {}, [
      'Email ', el('span', { class: 'muted', text: '(optional)' }), emailInput
    ]),
    el('label', {}, ['Password', passInput]),
    keyField
  ]));

  const connectBtn = el('button', { class: 'btn btn-primary btn-block', onClick: connect }, ['Connect']);
  const finishBtn = el('button', { class: 'btn btn-primary btn-block', hidden: true, onClick: finish },
    ['Create admin & finish']);

  async function connect() {
    const url = urlInput.value.trim();
    status.hidden = true;
    if (!API_URL_PATTERNS.some(re => re.test(url))) {
      status.hidden = false;
      status.textContent = 'That does not look like the API URL. It looks like ' +
        'https://<project>.supabase.co/functions/v1/api.';
      return;
    }
    connectBtn.disabled = true; connectBtn.textContent = 'Connecting…';
    try {
      await ping(url);
      config.apiUrl = url;
      const res = await api('setup', {});
      if (res.alreadySeeded) { toast('Connected', 'ok'); onDone(); return; }
      seedBox.hidden = false;
      finishBtn.hidden = false;
      connectBtn.hidden = true;
      toast('Tables ready — now create your admin account', 'ok');
    } catch (err) {
      // On a sheet with no users yet, setup without admin details answers with
      // a request for the admin's phone — or for the setup key, when one is
      // configured. Either is the cue to show the form, not a failure. (This
      // used to look for "adminEmail", which the server stopped sending when
      // sign-in moved to phone numbers, so a fresh sheet could not be set up.)
      const needsKey = /setup key/i.test(err.message);
      if (/adminPhone|adminEmail/.test(err.message) || needsKey) {
        seedBox.hidden = false; finishBtn.hidden = false; connectBtn.hidden = true;
        if (needsKey) keyField.hidden = false;
        return;
      }
      status.hidden = false;
      status.textContent = err.message;
      config.apiUrl = null;
    } finally {
      connectBtn.disabled = false; connectBtn.textContent = 'Connect';
    }
  }

  async function finish() {
    status.hidden = true;
    finishBtn.disabled = true; finishBtn.textContent = 'Creating…';
    try {
      await api('setup', {
        adminName: nameInput.value.trim() || 'Administrator',
        adminPhone: phoneInput.value.trim(),
        adminEmail: emailInput.value.trim(),
        adminPassword: passInput.value,
        setupKey: keyInput.value
      });
      toast('Administrator created — sign in to continue', 'ok');
      onDone();
    } catch (err) {
      if (/setup key/i.test(err.message)) {
        keyField.hidden = false;
        keyInput.focus();
      }
      status.hidden = false; status.textContent = err.message;
    } finally {
      finishBtn.disabled = false; finishBtn.textContent = 'Create admin & finish';
    }
  }

  return el('div', { class: 'auth-screen' }, [
    el('div', { class: 'auth-card auth-wide' }, [
      el('div', { class: 'brand brand-lg' }, [icon('building', 26), el('span', { text: 'Property Manager' })]),
      el('div', { class: 'auth-intro' }, [
        el('span', { class: 'eyebrow', text: 'Secure setup' }),
        el('h2', { text: 'Connect your database' }),
        el('p', { class: 'muted' }, [
          'Your portfolio lives in your own database. Paste the API URL from your Supabase project below and we’ll connect the dashboard.'
        ])
      ]),
      status,
      el('label', {}, ['API URL', urlInput]),
      seedBox,
      connectBtn,
      finishBtn
    ])
  ]);
}

/**
 * Phone + password sign-in. `onSignedIn` receives the workbook when the server
 * sent it with the sign-in, so the app does not have to ask for it again.
 */
export function loginView(onSignedIn) {
  const phone = el('input', {
    class: 'input', type: 'tel', required: true, autocomplete: 'tel',
    placeholder: '+91 98800 11111', inputmode: 'tel'
  });
  const password = el('input', { class: 'input', type: 'password', required: true, autocomplete: 'current-password' });
  const error = el('p', { class: 'form-error', hidden: true });
  const btn = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, ['Sign in']);

  const form = el('form', {
    class: 'stack',
    onSubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const data = await api('login', { phone: phone.value.trim(), password: password.value,
                                          withSnapshot: true });
        config.token = data.token;
        config.user = data.user;
        onSignedIn(data.snapshot);
      } catch (err) {
        error.hidden = false; error.textContent = err.message;
        password.value = '';
      } finally {
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    }
  }, [
    error,
    el('label', {}, ['Phone number', phone]),
    el('label', {}, ['Password', password]),
    btn
  ]);

  return el('div', { class: 'auth-screen' }, [
    el('div', { class: 'auth-card' }, [
      el('div', { class: 'brand brand-lg' }, [icon('building', 26), el('span', { text: 'Property Manager' })]),
      el('div', { class: 'auth-intro' }, [
        el('span', { class: 'eyebrow', text: 'Welcome back' }),
        el('h2', { text: 'Sign in' })
      ]),
      form,
      el('button', {
        class: 'link-btn',
        onClick: () => { config.apiUrl = null; location.reload(); }
      }, ['Connect a different sheet'])
    ])
  ]);
}

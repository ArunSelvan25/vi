/** Small DOM + formatting toolkit. No framework, no build step. */
import { STATUS_COLORS } from './schema.js';

let settings = { currency_symbol: '₹', locale: 'en-IN', currency: 'INR' };
export function setFormatterSettings(s) { settings = { ...settings, ...s }; }

// ── DOM ───────────────────────────────────────────────────────────────────

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

export function icon(name, size = 18) {
  const paths = {
    dashboard: '<path d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"/>',
    building: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M14 21V9h4a2 2 0 0 1 2 2v10M3 21h18M7 7h2M7 11h2M7 15h2"/>',
    grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M9 13h6M9 17h6"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1ZM8 8h8M8 12h8M8 16h4"/>',
    card: '<path d="M2 6h20v12H2zM2 10h20"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5l-9.3 9.3a2.1 2.1 0 0 1-3-3l9.3-9.3a4 4 0 0 0-2-2Z"/>',
    wallet: '<path d="M3 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM16 12h3"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    chart: '<path d="M3 3v18h18M7 15l3-4 3 3 5-7"/>',
    settings: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H7a1.7 1.7 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V7a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    refresh: '<path d="M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
    print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
    mail: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM22 6l-10 7L2 6"/>',
    bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
    whatsapp: '<path d="M3 21l1.7-4.9A8.5 8.5 0 1 1 8 19.4L3 21Z"/><path d="M9 9.5c.3 1.9 2.6 4.3 4.6 4.7l1.2-1.2 2 .9c-.2 1.2-1.3 2-2.5 1.8-3.5-.5-6.4-3.4-6.9-6.9C7.2 7.6 8 6.5 9.2 6.3l.9 2L9 9.5Z"/>',
    renew: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/>',
    gauge: '<path d="M12 14l4-4M3.5 17a9 9 0 1 1 17 0"/>',
    wallet2: '<path d="M3 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM16 12h3"/>'
  };
  const svg = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
  return el('span', { class: 'icon', html: svg });
}

// ── formatting ────────────────────────────────────────────────────────────

export function money(v, { compact = false } = {}) {
  const n = Number(v || 0);
  if (!isFinite(n)) return '—';
  // the sign belongs outside the currency symbol: -₹4,000, not ₹-4,000
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const symbol = settings.currency_symbol ?? '';

  if (compact && abs >= 1000) {
    const indian = [[1e7, 'Cr'], [1e5, 'L'], [1e3, 'K']];
    const western = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    const scale = String(settings.locale || '').endsWith('IN') ? indian : western;
    for (const [div, suffix] of scale) {
      if (abs >= div) {
        const scaled = abs / div;
        return sign + symbol + scaled.toFixed(scaled >= 100 ? 0 : 1) + suffix;
      }
    }
  }
  return sign + symbol + abs.toLocaleString(settings.locale || 'en-IN',
    { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function num(v) {
  const n = Number(v || 0);
  return isFinite(n) ? n.toLocaleString(settings.locale || 'en-IN') : '—';
}

/**
 * Render a date using the organisation's `date_format` setting. Only the few
 * patterns the settings page offers are supported; anything else falls back to
 * the locale's own short form.
 */
const DATE_PATTERNS = {
  'dd MMM yyyy': { day: '2-digit', month: 'short', year: 'numeric' },
  'dd/MM/yyyy':  { day: '2-digit', month: '2-digit', year: 'numeric' },
  'MM/dd/yyyy':  { month: '2-digit', day: '2-digit', year: 'numeric' },
  'yyyy-MM-dd':  null,
  'd MMMM yyyy': { day: 'numeric', month: 'long', year: 'numeric' }
};

export function date(v) {
  if (!v) return '—';
  const iso = String(v).slice(0, 10);
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return String(v);

  const pattern = settings.date_format || 'dd MMM yyyy';
  if (pattern === 'yyyy-MM-dd') return iso;
  const opts = DATE_PATTERNS[pattern] || DATE_PATTERNS['dd MMM yyyy'];
  return d.toLocaleDateString(settings.locale || 'en-IN', opts);
}

/**
 * Local calendar date as yyyy-MM-dd. Never use toISOString() for this: it
 * converts to UTC first, so local midnight in any positive-offset timezone
 * reports the *previous* day.
 */
export function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local year-month as yyyy-MM. */
export function isoMonth(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function today() { return isoDate(); }

export function daysBetween(a, b) {
  const d1 = new Date(String(a).slice(0, 10)), d2 = new Date(String(b).slice(0, 10));
  return Math.round((d2 - d1) / 86400000);
}

export function addDays(iso, n) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/**
 * Status pill. The tone is normally derived from the status word itself; pass
 * an explicit tone for labels that aren't statuses (e.g. "in 12 days").
 */
export function badge(value, tone) {
  const map = {
    ok: 'badge-ok', warn: 'badge-warn', danger: 'badge-danger', info: 'badge-info', muted: 'badge-muted'
  };
  const resolved = tone || STATUS_COLORS[value] || 'muted';
  return el('span', { class: 'badge ' + map[resolved], text: value || '—' });
}

// ── toasts ────────────────────────────────────────────────────────────────

export function toast(message, tone = 'info', ms = 4000, action = null) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { id: 'toasts', class: 'toasts' });
    document.body.append(host);
  }
  const dismiss = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 250);
  };
  const node = el('div', { class: `toast toast-${tone}` }, [
    icon(tone === 'danger' ? 'alert' : tone === 'ok' ? 'check' : 'bolt', 16),
    el('span', { text: message }),
    // an optional call to action, e.g. "Update now" when a new build is ready
    action
      ? el('button', {
          class: 'toast-action',
          onClick: () => { dismiss(); action.onClick(); }
        }, [action.label])
      : null
  ]);
  host.append(node);
  setTimeout(dismiss, ms);
}

// ── modal ─────────────────────────────────────────────────────────────────

export function modal({ title, body, actions = [], width = 560, onClose }) {
  const backdrop = el('div', { class: 'backdrop' });
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const sheet = el('div', { class: 'modal', style: `max-width:${width}px` }, [
    el('header', { class: 'modal-head' }, [
      el('h2', { text: title }),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: close }, [icon('close', 18)])
    ]),
    el('div', { class: 'modal-body' }, [body]),
    actions.length
      ? el('footer', { class: 'modal-foot' }, actions.map(a =>
          el('button', {
            class: 'btn ' + (a.variant || 'btn-ghost'),
            type: a.type || 'button',
            onClick: a.onClick ? (e) => a.onClick(e, close) : close
          }, [a.label])))
      : null
  ]);

  backdrop.append(sheet);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);

  // Focus the first real field, not the header's ✕ button: that button comes
  // first in DOM order, and a focused button swallows the next space keypress
  // as a click — which would silently discard whatever is being typed.
  const focusTarget =
    sheet.querySelector('.modal-body input:not([disabled]):not([type=hidden]), ' +
                        '.modal-body select:not([disabled]), .modal-body textarea:not([disabled])') ||
    sheet.querySelector('.modal-foot .btn-primary') ||
    sheet.querySelector('.modal-head button');
  focusTarget?.focus({ preventScroll: true });

  return { close, sheet };
}

export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Confirm', danger = true }) {
  return new Promise(resolve => {
    modal({
      title,
      width: 440,
      body: el('p', { class: 'muted', text: message }),
      actions: [
        { label: 'Cancel', onClick: (e, close) => { close(); resolve(false); } },
        { label: confirmLabel, variant: danger ? 'btn-danger' : 'btn-primary',
          onClick: (e, close) => { close(); resolve(true); } }
      ],
      onClose: () => resolve(false)
    });
  });
}

// ── misc ──────────────────────────────────────────────────────────────────

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/**
 * Excel and Google Sheets execute a cell that begins with = + - or @, so an
 * exported CSV can carry a formula out of the app and into someone's machine.
 * Prefix those values with an apostrophe, which imports them as literal text.
 * Plain negative numbers are exempt so money columns stay readable.
 */
export function csvSafeValue(s) {
  if (!/^[=+\-@\t\r]/.test(s)) return s;
  if (/^-[^\dA-Za-z]{0,3}\d[\d,. ]*$/.test(s)) return s;   // -₹4,000  -1234.5
  return "'" + s;
}

export function downloadCsv(filename, rows, columns) {
  const esc = (v) => {
    const s = csvSafeValue(v === null || v === undefined ? '' : String(v));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = columns.map(c => esc(c.label)).join(',');
  const body = rows.map(r => columns.map(c => esc(c.value(r))).join(',')).join('\n');
  const blob = new Blob(['﻿' + head + '\n' + body], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/** An http(s) URL as a string, or '' for anything else (javascript:, data:, junk). */
export function safeUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch { return ''; }
}

/**
 * A WhatsApp "click to chat" link with the message filled in. Numbers stored
 * without a country code get the organisation's (India's 91 by default), since
 * wa.me needs the full international number.
 */
export function whatsappLink(phone, text, countryCode = '91') {
  let digits = String(phone || '').replace(/[^0-9]/g, '').replace(/^0+/, '');
  if (!digits) return '';
  if (digits.length <= 10) digits = String(countryCode || '').replace(/[^0-9]/g, '') + digits;
  return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(text);
}

/** A UPI payment link (upi://pay) that opens the payer's UPI app with the amount filled in. */
export function upiLink({ vpa, name, amount, note }) {
  if (!vpa) return '';
  const q = new URLSearchParams({ pa: vpa, pn: name || '', cu: 'INR' });
  if (Number(amount) > 0) q.set('am', (Math.round(Number(amount) * 100) / 100).toFixed(2));
  if (note) q.set('tn', String(note).slice(0, 80));
  return 'upi://pay?' + q.toString();
}

/** Print the document inside a modal, and only it. */
export function printDocument() {
  document.body.classList.add('printing');
  window.print();
  setTimeout(() => document.body.classList.remove('printing'), 500);
}

export function spinner(label = 'Loading…') {
  return el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', { text: label })]);
}

export function emptyState(message, action, iconName = 'folder') {
  return el('div', { class: 'empty' }, [
    icon(iconName, 28),
    el('p', { text: message }),
    action || null
  ]);
}

/** Shimmering placeholder blocks shown while the first load is in flight. */
export function skeletonDashboard() {
  const block = (h, w = '100%') => el('div', { class: 'skeleton', style: `height:${h};width:${w}` });
  return el('div', { class: 'view' }, [
    el('div', { class: 'kpi-row' },
      Array.from({ length: 6 }, () => el('div', { class: 'panel', style: 'padding:var(--s4)' }, [
        block('12px', '60%'), el('div', { style: 'height:8px' }), block('26px', '75%')
      ]))),
    el('div', { class: 'grid-2' }, [
      el('div', { class: 'panel', style: 'padding:var(--s4)' }, [block('240px')]),
      el('div', { class: 'panel', style: 'padding:var(--s4)' }, [block('240px')])
    ])
  ]);
}

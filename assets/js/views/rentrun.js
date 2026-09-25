import { el, icon, money, date, badge, toast, confirmDialog, modal, whatsappLink } from '../ui.js';
import { store } from '../store.js';
import { api } from '../api.js';
import { ITEM_CATEGORIES, RENT_DAY_OPTIONS, rentDayLabel } from '../schema.js';
import { openEntityForm } from '../components/form.js';
import { showInvoice, invoiceMessage } from './invoices.js';
import { refreshView } from '../router.js';

/**
 * Generate rent — three steps, then the result:
 *
 *   ① Select leases   every lease and what it can be billed today. This
 *                     month's rent is ticked; older unbilled months (backlog)
 *                     are offered unticked; a first part month asks whether to
 *                     bill it on its own or with the next invoice.
 *   ② Edit invoices   electricity units in a quick grid, a charge added to all
 *                     at once, other charges, overdue invoices' late fees
 *                     (unticked), and a logged change to the rent.
 *   ③ Review          totals, warnings, a preview of any invoice; then issue
 *                     them or save them as drafts.
 *
 * The periods and rent come from the server (rentCandidates) and are worked
 * out again there when the invoices are raised (generateRent), so nothing here
 * decides an amount that is charged. What is entered is kept on this device
 * as it is typed, so a closed tab can carry on where it left off.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const figure = (v) => Number(String(v ?? '').replace(/,/g, '').trim());
const isFigure = (v) => String(v ?? '').trim() !== '' && Number.isFinite(figure(v));
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;

/** Charges typed in here; rent, late fees and deposits have their own paths. */
const EXTRA_CATEGORIES = ITEM_CATEGORIES.filter(c => !['Rent', 'Late Fee', 'Deposit'].includes(c));

const SAVED_KEY = 'vipm.generateRent.v1';
const saved = {
  read() { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || 'null'); } catch (e) { return null; } },
  write(v) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(v)); } catch (e) { /* private mode: not kept */ } },
  clear() { try { localStorage.removeItem(SAVED_KEY); } catch (e) { /* nothing to clear */ } }
};

const STATE_LABEL = {
  ready: ['Ready', 'ok'], backlog: ['Backlog', 'warn'], billed: ['Already billed', 'muted'],
  not_due: ['Not due yet', 'muted'], missing_rent_day: ['Rent day missing', 'danger'],
  open_termination: ['Needs end date', 'danger']
};

const range = (a, b) => (a === b ? date(a) : `${date(a)} – ${date(b)}`);
const tenantName = (c) => store.label('tenants', c.tenant_id);
const unitName = (c) => store.label('units', c.unit_id);

/**
 * @param opts.leaseId open with only this lease (the lease page's "Raise now")
 */
export async function openGenerateRent({ leaseId } = {}) {
  const run = {
    step: 1,
    asOf: '',
    list: [],
    /** lease_id → { include, choice: null|'separate'|'join', on: Set of offer keys } */
    pick: {},
    /** key → the invoice being written in step 2 */
    work: new Map(),
    filter: { q: '', property: '', others: false },
    only: leaseId || '',
    resumable: null,
    busy: false,
    result: null
  };

  // ── the dialog ────────────────────────────────────────────────────────────
  const backdrop = el('div', { class: 'backdrop' });
  const stepBar = el('ol', { class: 'rr-steps', 'aria-label': 'Steps' });
  const body = el('div', { class: 'modal-body rr-body' });
  const foot = el('footer', { class: 'modal-foot rr-foot' });
  const sheet = el('div', { class: 'modal rr-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Generate rent' }, [
    el('header', { class: 'modal-head' }, [
      el('div', { class: 'rr-title' }, [el('h2', { text: 'Generate rent' }), stepBar]),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: () => tryClose() }, [icon('close', 18)])
    ]),
    body,
    foot
  ]);
  backdrop.append(sheet);
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelectorAll('.backdrop');
    if (open[open.length - 1] === backdrop) tryClose();
  };
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);

  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const dirty = () => run.step > 1 || run.work.size > 0;
  async function tryClose() {
    if (run.result) { close(); refreshView(); return; }
    if (run.busy) return;
    if (dirty()) {
      const leave = await confirmDialog({
        title: 'Leave Generate rent?',
        message: 'Nothing has been billed yet. What you entered is kept on this device, so you can continue where you left off.',
        confirmLabel: 'Leave', danger: false
      });
      if (!leave) return;
    }
    close();
  }

  // ── loading ─────────────────────────────────────────────────────────────
  async function load() {
    body.textContent = '';
    body.append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', { text: 'Working out what is due…' })]));
    foot.textContent = '';
    try {
      const res = await api('rentCandidates', {});
      run.asOf = res.as_of;
      run.list = res.leases;
      for (const c of run.list) if (!run.pick[c.lease_id]) run.pick[c.lease_id] = defaultPick(c);
      // drop what is no longer offered (billed elsewhere since)
      for (const [key, w] of run.work) if (!findOffer(w.lease_id, w.start)) run.work.delete(key);
      const prior = saved.read();
      run.resumable = !run.work.size && prior && prior.asOf && prior.asOf.slice(0, 7) === run.asOf.slice(0, 7) &&
                      prior.work && prior.work.length ? prior : null;
      draw();
    } catch (err) {
      body.textContent = '';
      // a site deployed ahead of its API: say so, rather than show the raw error
      const outdated = /Unknown action/.test(err.message);
      body.append(el('div', { class: 'load-error' }, [
        el('p', { class: 'form-error', text: outdated
          ? 'Generate rent needs the latest version of the server, which has not been deployed yet. '
            + 'Deploy the database migration and the API function, then try again.'
          : 'Could not work out the rent due: ' + err.message }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: load }, ['Try again'])
      ]));
    }
  }

  function defaultPick(c) {
    const pick = { include: c.state === 'ready' && (!run.only || run.only === c.lease_id), choice: null, on: new Set() };
    if (run.only === c.lease_id && c.state === 'backlog') pick.include = true;
    for (const o of offersOf(c, pick.choice)) if (o.kind === 'current') pick.on.add(o.start);
    return pick;
  }

  /**
   * The invoices a lease can have today. A first part month is either an
   * invoice of its own, or joined with the one after it — and until that is
   * answered, it is shown with the question instead.
   */
  function offersOf(c, choice) {
    const ps = c.periods;
    if (ps[0] && ps[0].first_stub) {
      if (choice === 'join') {
        if (!c.joined || c.joined.kind === 'future') return ps.slice(2).map(p => ({ ...p }));
        return [{ ...c.joined, join: true }, ...ps.slice(2).map(p => ({ ...p }))];
      }
      if (choice === 'separate') return ps.map((p, i) => ({ ...p, separate: i === 0 }));
      return ps.slice(1).map(p => ({ ...p }));
    }
    return ps.map(p => ({ ...p }));
  }

  const candidateOf = (id) => run.list.find(c => c.lease_id === id);
  function findOffer(leaseId, start) {
    const c = candidateOf(leaseId);
    const pick = run.pick[leaseId];
    return c && pick ? offersOf(c, pick.choice).find(o => o.start === start) || null : null;
  }

  /** The invoices chosen in step 1, in the order they will be numbered. */
  function chosen() {
    const out = [];
    for (const c of run.list) {
      const pick = run.pick[c.lease_id];
      if (!pick || !pick.include) continue;
      for (const o of offersOf(c, pick.choice)) if (pick.on.has(o.start)) out.push({ c, o });
    }
    return out;
  }

  /** Leases ticked whose first part month has not been answered. */
  const unanswered = () => run.list.filter(c => run.pick[c.lease_id]?.include && c.periods[0]?.first_stub &&
                                                !run.pick[c.lease_id].choice);

  // ── step 2's invoices ─────────────────────────────────────────────────────
  const keyOf = (c, o) => c.lease_id + '|' + o.start;

  function workFor(c, o) {
    const key = keyOf(c, o);
    let w = run.work.get(key);
    if (!w) {
      w = { key, lease_id: c.lease_id, start: o.start, eb: { units: '', rate: c.last_eb_rate ?? '' }, extras: [],
            adjust: null, fees: new Set(), notes: '', open: false };
      run.work.set(key, w);
    }
    return w;
  }

  /** Syncs the step-2 list with what is chosen in step 1, keeping what was typed. */
  function syncWork() {
    const keep = new Set();
    for (const { c, o } of chosen()) keep.add(workFor(c, o).key);
    for (const key of [...run.work.keys()]) if (!keep.has(key)) run.work.delete(key);
  }

  /** The late fees each lease can carry sit on its last invoice of this run. */
  function feeHolder(leaseId) {
    const mine = chosen().filter(x => x.c.lease_id === leaseId);
    return mine.length ? keyOf(mine[mine.length - 1].c, mine[mine.length - 1].o) : '';
  }

  /** Every line an invoice will carry, priced as the server will price it. */
  function linesOf(w) {
    const c = candidateOf(w.lease_id), o = findOffer(w.lease_id, w.start);
    const rate = c.gst_rate;
    const lines = o.lines.map(l => ({ description: l.text, category: 'Rent', quantity: 1, unit_amount: l.amount, tax_rate: rate,
                                      locked: true, explain: l }));
    if (w.adjust && isFigure(w.adjust.amount) && round2(figure(w.adjust.amount)) !== o.amount) {
      lines.push({ description: 'Rent adjustment', category: 'Rent', quantity: 1,
                   unit_amount: round2(figure(w.adjust.amount) - o.amount), tax_rate: rate, locked: true });
    }
    if (feeHolder(w.lease_id) === w.key) {
      for (const f of c.late_fees) {
        if (w.fees.has(f.invoice_id)) {
          lines.push({ description: `Late fee · ${f.invoice_id} overdue since ${f.due_date}`, category: 'Late Fee',
                       quantity: 1, unit_amount: f.fee, tax_rate: rate, locked: true });
        }
      }
    }
    if (isFigure(w.eb.units) && figure(w.eb.units) > 0 && isFigure(w.eb.rate)) {
      lines.push({ description: ebText(w.eb), category: 'Electricity', quantity: figure(w.eb.units),
                   unit_amount: figure(w.eb.rate), tax_rate: 0, eb: true });
    }
    for (const x of w.extras) lines.push({ ...x, extra: true });
    return lines.map(l => {
      const amount = round2((isFigure(l.quantity) ? figure(l.quantity) : 1) * (isFigure(l.unit_amount) ? figure(l.unit_amount) : 0));
      const rateOf = isFigure(l.tax_rate) ? figure(l.tax_rate) : 0;
      return { ...l, amount, tax: round2(amount * rateOf / 100) };
    });
  }
  const ebText = (eb) => `Electricity · ${figure(eb.units)} units @ ${store.settings.currency_symbol || '₹'}${figure(eb.rate)}`;

  function totalsOf(w) {
    const lines = linesOf(w);
    const rent = round2(lines.filter(l => l.category === 'Rent').reduce((s, l) => s + l.amount, 0));
    const other = round2(lines.filter(l => l.category !== 'Rent').reduce((s, l) => s + l.amount, 0));
    const tax = round2(lines.reduce((s, l) => s + l.tax, 0));
    return { lines, rent, other, tax, total: round2(rent + other + tax) };
  }

  /** What is wrong with an invoice's entries, if anything; the first problem is enough. */
  function problemOf(w) {
    const who = tenantName(candidateOf(w.lease_id));
    if (String(w.eb.units).trim() !== '' && !(isFigure(w.eb.units) && figure(w.eb.units) >= 0)) return `${who}: electricity units must be a number.`;
    if (isFigure(w.eb.units) && figure(w.eb.units) > 0 && !(isFigure(w.eb.rate) && figure(w.eb.rate) > 0)) {
      return `${who}: enter the rate per electricity unit.`;
    }
    if (w.adjust) {
      if (!(isFigure(w.adjust.amount) && figure(w.adjust.amount) >= 0)) return `${who}: the adjusted rent must be a number of 0 or more.`;
      if (!String(w.adjust.reason || '').trim()) return `${who}: give a reason for changing the rent.`;
    }
    for (const x of w.extras) {
      if (!String(x.description || '').trim()) return `${who}: every added charge needs a description.`;
      if (!isFigure(x.unit_amount)) return `${who}: "${x.description}" needs an amount.`;
      if (String(x.quantity).trim() !== '' && !isFigure(x.quantity)) return `${who}: "${x.description}" has a quantity that is not a number.`;
      if (String(x.tax_rate).trim() !== '' && !(isFigure(x.tax_rate) && figure(x.tax_rate) >= 0 && figure(x.tax_rate) <= 100)) {
        return `${who}: GST on "${x.description}" must be between 0 and 100%.`;
      }
    }
    if (totalsOf(w).total < 0) return `${who}: the invoice cannot come to less than zero.`;
    return '';
  }

  // ── keeping work on this device ───────────────────────────────────────────
  let saveTimer = null;
  function remember() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!run.work.size) return;
      saved.write({
        asOf: run.asOf, savedAt: new Date().toISOString(),
        pick: Object.fromEntries(Object.entries(run.pick).map(([k, p]) => [k, { include: p.include, choice: p.choice, on: [...p.on] }])),
        work: [...run.work.values()].map(w => ({ ...w, fees: [...w.fees], open: false }))
      });
    }, 300);
  }

  function resume(prior) {
    for (const [id, p] of Object.entries(prior.pick || {})) {
      if (!candidateOf(id)) continue;
      run.pick[id] = { include: !!p.include, choice: p.choice || null, on: new Set(p.on || []) };
    }
    let dropped = 0;
    for (const w of prior.work || []) {
      if (!findOffer(w.lease_id, w.start)) { dropped++; continue; }
      run.work.set(w.key, { ...w, fees: new Set(w.fees || []), open: false });
    }
    // what step 1 now chooses decides the list; anything no longer offered goes
    syncWork();
    run.resumable = null;
    run.step = run.work.size ? 2 : 1;
    if (dropped) toast(`${plural(dropped, 'invoice')} from before ${dropped === 1 ? 'is' : 'are'} no longer due — billed since, or changed.`, 'info', 6000);
    draw();
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  function draw() {
    const labels = ['Select leases', 'Edit invoices', 'Review'];
    stepBar.textContent = '';
    labels.forEach((label, i) => {
      const n = i + 1;
      const state = run.result ? 'done' : n < run.step ? 'done' : n === run.step ? 'current' : '';
      stepBar.append(el('li', { class: 'rr-step' + (state ? ' is-' + state : ''), 'aria-current': state === 'current' ? 'step' : null }, [
        el('span', { class: 'rr-step-n', text: state === 'done' ? '✓' : String(n) }),
        el('span', { class: 'rr-step-label', text: label })
      ]));
    });
    body.textContent = '';
    foot.textContent = '';
    if (run.result) drawResult();
    else if (run.step === 1) drawSelect();
    else if (run.step === 2) drawEdit();
    else drawReview();
    body.scrollTop = 0;
  }

  const footSummary = (parts) => el('div', { class: 'rr-foot-summary' }, [].concat(parts).flat());
  const footBtn = (label, onClick, variant = 'btn-ghost', attrs = {}) =>
    el('button', { class: 'btn ' + variant, type: 'button', onClick, ...attrs }, [label]);

  // ── ① select leases ───────────────────────────────────────────────────────
  function drawSelect() {
    if (run.resumable) {
      const prior = run.resumable;
      const mins = Math.max(1, Math.round((Date.now() - Date.parse(prior.savedAt)) / 60000));
      body.append(el('div', { class: 'notice notice-info notice-row rr-resume' }, [
        icon('clock', 16),
        el('span', { class: 'notice-text', text: `You have unfinished work: ${plural(prior.work.length, 'invoice')}, ` +
          `last edited ${mins < 60 ? mins + ' min' : Math.round(mins / 60) + ' h'} ago.` }),
        el('div', { class: 'rr-resume-actions' }, [
          footBtn('Discard', () => { saved.clear(); run.resumable = null; draw(); }, 'btn-ghost btn-sm'),
          footBtn('Continue', () => resume(prior), 'btn-primary btn-sm')
        ])
      ]));
    }

    const props = [...new Set(run.list.map(c => c.property_id).filter(Boolean))];
    const search = el('input', { class: 'input search-input', type: 'search', placeholder: 'Search tenant, unit or lease',
                                 value: run.filter.q, 'aria-label': 'Search leases' });
    const propSel = el('select', { class: 'input', 'aria-label': 'Property' }, [
      el('option', { value: '', text: 'All properties' }),
      ...props.map(p => el('option', { value: p, selected: run.filter.property === p || null }, [store.label('properties', p)]))
    ]);
    const listHost = el('div', { class: 'rr-lease-list' });
    const readyCount = run.list.filter(c => c.state === 'ready').length;

    body.append(el('div', { class: 'rr-toolbar' }, [
      el('div', { class: 'search-box rr-search' }, [icon('search', 15), search]),
      props.length > 1 ? propSel : null,
      footBtn(`Select all ready (${readyCount})`, () => {
        for (const c of run.list) {
          if (c.state !== 'ready') continue;
          const pick = run.pick[c.lease_id];
          pick.include = true;
          for (const o of offersOf(c, pick.choice)) if (o.kind === 'current') pick.on.add(o.start);
        }
        paint(); remember();
      }, 'btn-ghost btn-sm', { disabled: readyCount ? null : true })
    ]), listHost);

    const matches = (c) => {
      const q = run.filter.q.trim().toLowerCase();
      if (run.only && c.lease_id !== run.only) return false;
      if (run.filter.property && c.property_id !== run.filter.property) return false;
      if (!q) return true;
      return [tenantName(c), unitName(c), c.lease_id].some(s => String(s).toLowerCase().includes(q));
    };

    function paint() {
      listHost.textContent = '';
      const shown = run.list.filter(matches);
      const billable = shown.filter(c => ['ready', 'backlog', 'missing_rent_day', 'open_termination'].includes(c.state) && !c.ended);
      const ended = shown.filter(c => c.ended && ['ready', 'backlog', 'open_termination'].includes(c.state));
      const quiet = shown.filter(c => ['billed', 'not_due'].includes(c.state));
      if (run.only && shown.length === 0) {
        listHost.append(el('p', { class: 'muted rr-empty', text: 'Nothing on this lease is waiting to be billed.' }));
      }
      if (billable.length) listHost.append(section('To bill', billable.map(leaseRow)));
      if (ended.length) listHost.append(section('Ended leases with rent to bill', ended.map(leaseRow)));
      if (quiet.length) {
        const open = run.filter.others || run.only;
        listHost.append(el('details', { class: 'rr-quiet', open: open || null,
                                        onToggle: (e) => { run.filter.others = e.target.open; } }, [
          el('summary', {}, [`Nothing due this month (${quiet.length})`]),
          el('div', { class: 'rr-quiet-list' }, quiet.map(quietRow))
        ]));
      }
      if (!billable.length && !ended.length && !quiet.length && !run.only) {
        listHost.append(el('p', { class: 'muted rr-empty', text: run.list.length ? 'No lease matches.' : 'There are no leases to bill.' }));
      }
      paintFoot();
    }

    const section = (title, rows) => el('section', { class: 'rr-section' }, [
      el('h4', { class: 'rr-section-title', text: title }), ...rows
    ]);

    function leaseRow(c) {
      const pick = run.pick[c.lease_id];
      const [label, tone] = STATE_LABEL[c.state] || ['', 'muted'];
      const canBill = ['ready', 'backlog'].includes(c.state);
      const offers = canBill ? offersOf(c, pick.choice) : [];
      const total = offers.filter(o => pick.on.has(o.start)).reduce((s, o) => s + o.amount, 0);

      const master = el('input', { type: 'checkbox', checked: pick.include || null, disabled: canBill ? null : true,
                                   'aria-label': 'Bill ' + tenantName(c) });
      master.addEventListener('change', () => {
        pick.include = master.checked;
        if (pick.include && ![...pick.on].length) {
          for (const o of offersOf(c, pick.choice)) if (o.kind === 'current') pick.on.add(o.start);
        }
        paint(); remember();
      });

      const row = el('article', { class: 'rr-lease' + (pick.include ? ' is-on' : '') + (canBill ? '' : ' is-blocked') }, [
        el('label', { class: 'rr-lease-head' }, [
          master,
          el('span', { class: 'rr-lease-who' }, [
            el('strong', { text: tenantName(c) }),
            el('small', { class: 'muted', text: [unitName(c), c.lease_id].join(' · ') })
          ]),
          el('span', { class: 'rr-lease-meta' }, [
            el('small', { class: 'muted', text: [c.frequency, c.rent_day ? 'rent day ' + rentDayLabel(c.rent_day) : ''].filter(Boolean).join(' · ') }),
            badge(label, tone)
          ]),
          el('strong', { class: 'rr-lease-total num', text: pick.include && total ? money(total) : '' })
        ])
      ]);

      if (c.state === 'missing_rent_day') row.append(rentDayFixer(c));
      if (c.state === 'open_termination') {
        row.append(el('div', { class: 'rr-lease-body' }, [
          el('p', { class: 'muted small', text: 'This lease was terminated, but its end date is not set to the day the tenant left, so where billing stops is not known.' }),
          footBtn('Set the end date', () => openEntityForm('leases', store.byId('leases', c.lease_id), { onSaved: () => load() }), 'btn-ghost btn-sm')
        ]));
      }
      if (canBill) row.append(periodsBlock(c, pick, offers));
      return row;
    }

    function periodsBlock(c, pick, offers) {
      const blockBody = el('div', { class: 'rr-lease-body' });
      const stub = c.periods[0] && c.periods[0].first_stub ? c.periods[0] : null;
      if (stub) {
        const name = 'stub-' + c.lease_id;
        const opt = (value, title, sub) => el('label', { class: 'rr-choice' + (pick.choice === value ? ' is-on' : '') }, [
          el('input', { type: 'radio', name, value, checked: pick.choice === value || null, onChange: () => {
            pick.choice = value;
            pick.include = true;
            pick.on = new Set(offersOf(c, value).filter(o => o.kind !== 'backlog' || o.start === stub.start).map(o => o.start));
            paint(); remember();
          } }),
          el('span', {}, [el('strong', { text: title }), el('small', { class: 'muted', text: sub })])
        ]);
        const j = c.joined;
        blockBody.append(el('fieldset', { class: 'rr-stub' + (pick.include && !pick.choice ? ' needs-answer' : '') }, [
          el('legend', { text: `First part month: ${range(stub.start, stub.end)} (${stub.lines.map(l => l.days).reduce((a, b) => a + b, 0)} days)` }),
          el('div', { class: 'rr-choices' }, [
            opt('separate', `Bill it now on its own · ${money(stub.amount)}`, `Due ${date(stub.due)}`),
            j ? opt('join', `Add it to the next invoice · ${money(j.amount)}`,
                    `${range(j.start, j.end)}, due ${date(j.due)}` + (j.kind === 'future' ? ` · can be raised from ${date(j.raise_from)}` : ''))
              : null
          ])
        ]));
        if (pick.choice === 'join' && j && j.kind === 'future') {
          blockBody.append(el('p', { class: 'muted small', text: `Nothing to bill today: it will be billed with the invoice due ${date(j.due)}, from ${date(j.raise_from)}.` }));
        }
      }

      const olderHost = el('div', { class: 'rr-older-list' });
      const older = offers.filter(o => o.kind === 'backlog' && !o.join && !o.separate);
      const collapse = older.length > 2;
      if (collapse) {
        const ticked = older.filter(o => pick.on.has(o.start)).length;
        const sum = older.reduce((t, o) => t + o.amount, 0);
        const open = run.filter.openOlder?.has(c.lease_id) || ticked > 0;
        blockBody.append(el('details', { class: 'rr-older', open: open || null, onToggle: (e) => {
          run.filter.openOlder = run.filter.openOlder || new Set();
          e.target.open ? run.filter.openOlder.add(c.lease_id) : run.filter.openOlder.delete(c.lease_id);
        } }, [
          el('summary', {}, [
            el('span', { text: `${older.length} older months never billed` + (ticked ? ` · ${ticked} ticked` : '') }),
            el('strong', { class: 'num', text: money(sum) })
          ]),
          olderHost
        ]));
      }
      for (const o of offers) {
        const box = el('input', { type: 'checkbox', checked: pick.on.has(o.start) || null,
                                  'aria-label': `${range(o.start, o.end)}` });
        box.addEventListener('change', () => {
          if (box.checked) { pick.on.add(o.start); pick.include = true; } else pick.on.delete(o.start);
          paint(); remember();
        });
        (collapse && older.includes(o) ? olderHost : blockBody).append(el('label', { class: 'rr-period' }, [
          box,
          el('span', { class: 'rr-period-dates' }, [
            el('strong', { text: range(o.start, o.end) }),
            el('small', { class: 'muted', text: `due ${date(o.due)}` + (o.cycles > 1 ? ` · ${o.cycles} months` : '') })
          ]),
          el('span', { class: 'rr-period-tags' }, [
            o.kind === 'backlog' ? badge('Backlog', 'warn') : o.due < run.asOf ? badge('Past due', 'danger') : null,
            o.final ? badge('Final bill', 'info') : null,
            o.join ? badge('Part month + next', 'info') : o.lines.some(l => l.month_days) ? badge('Part month', 'muted') : null
          ]),
          el('strong', { class: 'num', text: money(o.amount) })
        ]));
      }

      const backlog = offers.filter(o => o.kind === 'backlog');
      if (backlog.length) {
        blockBody.append(el('div', { class: 'rr-inline-actions' }, [
          el('button', { class: 'link', type: 'button', onClick: () => markOutside(c, backlog) },
             [icon('check', 14), `Mark ${backlog.length === 1 ? 'it' : 'older months'} as billed outside the app…`])
        ]));
      }
      for (const u of c.unperioded) {
        blockBody.append(el('div', { class: 'notice notice-warn notice-row rr-note' }, [
          icon('alert', 16),
          el('span', { class: 'notice-text' }, [
            'Rent invoice ', el('a', { href: '#/invoices/' + encodeURIComponent(u.id), target: '_blank', rel: 'noopener', text: u.id }),
            ` (${money(u.total)}${u.issue_date ? ', issued ' + date(u.issue_date) : ''}) has no period. Check it is not for one of these months before billing.`
          ])
        ]));
      }
      for (const off of c.offline) {
        blockBody.append(el('div', { class: 'rr-offline' }, [
          el('small', { class: 'muted', text: `Billed outside the app: ${range(off.start, off.end)} — ${off.reason}` }),
          el('button', { class: 'link small', type: 'button', onClick: async () => {
            try { await api('undoRentOffline', { id: off.id }); toast('Offered for billing again', 'ok'); await load(); }
            catch (err) { toast(err.message, 'danger'); }
          } }, ['Undo'])
        ]));
      }
      return blockBody;
    }

    function rentDayFixer(c) {
      const sel = el('select', { class: 'input', 'aria-label': 'Rent day' }, [
        el('option', { value: '', text: 'Choose…' }),
        ...RENT_DAY_OPTIONS.map(o => el('option', { value: o.value }, [o.label]))
      ]);
      const save = footBtn('Save rent day', async (e) => {
        if (!sel.value) { sel.focus(); return; }
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const lease = store.byId('leases', c.lease_id);
          await store.update('leases', c.lease_id, { rent_day: sel.value }, { expectedVersion: lease?._v });
          toast(`Rent day set for ${tenantName(c)}`, 'ok');
          await load();
        } catch (err) { btn.disabled = false; toast(err.message, 'danger'); }
      }, 'btn-ghost btn-sm');
      return el('div', { class: 'rr-lease-body rr-fix' }, [
        el('p', { class: 'muted small', text: 'Every lease needs a rent day: the day of the month its rent is due.' }),
        el('div', { class: 'rr-fix-row' }, [sel, save])
      ]);
    }

    function quietRow(c) {
      const [label, tone] = STATE_LABEL[c.state];
      const n = c.next;
      return el('div', { class: 'rr-quiet-row' }, [
        el('span', { class: 'rr-lease-who' }, [el('strong', { text: tenantName(c) }), el('small', { class: 'muted', text: unitName(c) })]),
        el('small', { class: 'muted', text: [
          c.last_billed ? `billed to ${date(c.last_billed.end)} (${c.last_billed.invoice_id})` : '',
          n ? `next ${range(n.start, n.end)} from ${date(n.raise_from)}` : ''
        ].filter(Boolean).join(' · ') }),
        badge(label, tone)
      ]);
    }

    function paintFoot() {
      foot.textContent = '';
      const list = chosen();
      const total = list.reduce((s, x) => s + x.o.amount, 0);
      const waiting = unanswered();
      const hint = waiting.length
        ? el('span', { class: 'rr-foot-warn', text: `Choose how to bill the first part month for ${waiting.map(tenantName).join(', ')}.` })
        : null;
      foot.append(
        footSummary([el('strong', { text: plural(list.length, 'invoice') }), ' · rent ', el('strong', { text: money(total) }), hint]),
        footBtn('Cancel', tryClose),
        footBtn('Next: edit invoices', () => {
          if (unanswered().length) return;
          syncWork(); run.step = 2; remember(); draw();
        }, 'btn-primary', { disabled: list.length && !waiting.length ? null : true })
      );
    }

    search.addEventListener('input', () => { run.filter.q = search.value; paint(); });
    propSel.addEventListener('change', () => { run.filter.property = propSel.value; paint(); });
    paint();
  }

  /** Mark periods as billed outside the app, with the reason. */
  function markOutside(c, periods) {
    const boxes = periods.map(p => ({ p, box: el('input', { type: 'checkbox', checked: true }) }));
    const reason = el('textarea', { class: 'input', rows: 2, placeholder: 'e.g. collected in cash before we started using the app' });
    const error = el('p', { class: 'form-error', hidden: true });
    modal({
      title: 'Billed outside the app · ' + tenantName(c),
      width: 520,
      body: el('div', { class: 'stack' }, [
        error,
        el('p', { class: 'muted', text: 'These months will not be offered again. No invoice is created and nothing counts as income. You can undo this.' }),
        ...boxes.map(({ p, box }) => el('label', { class: 'check' }, [box, ` ${range(p.start, p.end)} · ${money(p.amount)}`])),
        el('label', {}, ['Reason *', reason])
      ]),
      actions: [
        { label: 'Cancel' },
        { label: 'Mark as billed', variant: 'btn-primary', onClick: async (e, closeIt) => {
          const starts = boxes.filter(b => b.box.checked).map(b => b.p.start);
          error.hidden = true;
          if (!starts.length) { error.hidden = false; error.textContent = 'Choose at least one month.'; return; }
          if (!reason.value.trim()) { error.hidden = false; error.textContent = 'Give a reason — it is kept with the record.'; return; }
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await api('markRentOffline', { lease_id: c.lease_id, period_starts: starts, reason: reason.value.trim() });
            run.pick[c.lease_id].on = new Set([...run.pick[c.lease_id].on].filter(s => !starts.includes(s)));
            closeIt();
            toast(`${plural(starts.length, 'month')} marked as billed outside the app`, 'ok');
            await load();
          } catch (err) { btn.disabled = false; error.hidden = false; error.textContent = err.message; }
        } }
      ]
    });
  }

  // ── ② edit invoices ───────────────────────────────────────────────────────
  function drawEdit() {
    const works = chosen().map(({ c, o }) => ({ c, o, w: workFor(c, o) }));

    // add a charge to every invoice at once
    const allCat = el('select', { class: 'input', 'aria-label': 'Category' },
                      EXTRA_CATEGORIES.map(cat => el('option', { value: cat, selected: cat === 'Maintenance' || null }, [cat])));
    const allDesc = el('input', { class: 'input', placeholder: 'Description, e.g. Maintenance charge', 'aria-label': 'Description' });
    const allAmt = el('input', { class: 'input', inputmode: 'decimal', placeholder: 'Amount', 'aria-label': 'Amount' });
    const allGst = el('input', { class: 'input', inputmode: 'decimal', placeholder: 'GST %', 'aria-label': 'GST %' });
    const allErr = el('p', { class: 'form-error', hidden: true });
    const addAll = footBtn('Add to all', () => {
      allErr.hidden = true;
      const desc = allDesc.value.trim() || allCat.value;
      if (!isFigure(allAmt.value)) { allErr.hidden = false; allErr.textContent = 'Enter the amount to add to every invoice.'; return; }
      if (allGst.value.trim() && !(isFigure(allGst.value) && figure(allGst.value) >= 0 && figure(allGst.value) <= 100)) {
        allErr.hidden = false; allErr.textContent = 'GST must be between 0 and 100%.'; return;
      }
      for (const { w } of works) {
        w.extras.push({ id: 'x' + Math.random().toString(36).slice(2, 9), description: desc, category: allCat.value,
                        quantity: 1, unit_amount: allAmt.value.trim(), tax_rate: allGst.value.trim() });
      }
      toast(`Added “${desc}” to ${plural(works.length, 'invoice')}`, 'ok');
      remember(); draw();
    }, 'btn-ghost');

    body.append(el('section', { class: 'rr-addall' }, [
      el('div', { class: 'rr-addall-head' }, [el('strong', { text: 'Add a charge to every invoice' }),
        el('small', { class: 'muted', text: 'Each invoice can still remove it below.' })]),
      allErr,
      el('div', { class: 'rr-addall-row' }, [allCat, allDesc, allAmt, allGst, addAll])
    ]));

    const grid = el('div', { class: 'rr-grid', role: 'table', 'aria-label': 'Invoices' }, [
      el('div', { class: 'rr-grid-head', role: 'row' }, [
        el('span', { role: 'columnheader', text: 'Tenant · period' }),
        el('span', { role: 'columnheader', class: 'num', text: 'Rent' }),
        el('span', { role: 'columnheader', text: 'EB units' }),
        el('span', { role: 'columnheader', text: 'Rate / unit' }),
        el('span', { role: 'columnheader', class: 'num', text: 'Other' }),
        el('span', { role: 'columnheader', class: 'num', text: 'Total' }),
        el('span', { role: 'columnheader' })
      ])
    ]);
    const footTotal = el('strong');
    const refreshFoot = () => {
      const sum = works.reduce((s, x) => s + totalsOf(x.w).total, 0);
      footTotal.textContent = money(sum);
    };

    for (const { c, o, w } of works) grid.append(invoiceBlock(c, o, w, refreshFoot));
    body.append(grid);

    const error = el('p', { class: 'form-error rr-foot-error', hidden: true });
    foot.append(
      footSummary([el('strong', { text: plural(works.length, 'invoice') }), ' · total ', footTotal, error]),
      footBtn('Back', () => { run.step = 1; draw(); }),
      footBtn('Next: review', () => {
        const problem = works.map(x => problemOf(x.w)).find(Boolean);
        if (problem) { error.hidden = false; error.textContent = problem; return; }
        run.step = 3; remember(); draw();
      }, 'btn-primary')
    );
    refreshFoot();
  }

  function invoiceBlock(c, o, w, onChange) {
    const rentCell = el('span', { class: 'num rr-cell-rent' });
    const otherCell = el('span', { class: 'num' });
    const totalCell = el('strong', { class: 'num' });
    const units = el('input', { class: 'input rr-eb-units', inputmode: 'decimal', placeholder: '0', value: w.eb.units,
                                'aria-label': 'Electricity units for ' + tenantName(c) });
    const rate = el('input', { class: 'input rr-eb-rate', inputmode: 'decimal', placeholder: 'Rate', value: w.eb.rate,
                               'aria-label': 'Rate per unit for ' + tenantName(c) });
    const detail = el('div', { class: 'rr-detail', hidden: !w.open || null });
    const toggle = el('button', { class: 'btn btn-ghost btn-sm rr-toggle', type: 'button', 'aria-expanded': String(!!w.open) },
                      [w.open ? 'Hide' : 'Details']);

    const update = () => {
      const t = totalsOf(w);
      rentCell.textContent = money(t.rent);
      otherCell.textContent = t.other ? money(t.other) : '—';
      totalCell.textContent = money(t.total);
      onChange();
      remember();
    };
    units.addEventListener('input', () => { w.eb.units = units.value; update(); paintDetail(); });
    rate.addEventListener('input', () => { w.eb.rate = rate.value; update(); paintDetail(); });
    toggle.addEventListener('click', () => {
      w.open = !w.open;
      detail.hidden = !w.open;
      toggle.textContent = w.open ? 'Hide' : 'Details';
      toggle.setAttribute('aria-expanded', String(w.open));
      if (w.open) paintDetail();
    });

    const fees = feeHolder(c.lease_id) === w.key ? c.late_fees : [];
    const flags = [
      o.kind === 'backlog' ? badge('Backlog', 'warn') : null,
      o.final ? badge('Final bill', 'info') : null,
      fees.length ? badge(plural(fees.length, 'late fee') + ' to decide', 'warn') : null
    ];

    const row = el('div', { class: 'rr-grid-row', role: 'row' }, [
      el('span', { class: 'rr-cell-who', role: 'cell' }, [
        el('strong', { text: tenantName(c) }),
        el('small', { class: 'muted', text: `${unitName(c)} · ${range(o.start, o.end)} · due ${date(o.due)}` }),
        el('span', { class: 'rr-flags' }, flags)
      ]),
      el('span', { role: 'cell', class: 'rr-cell', dataset: { label: 'Rent' } }, [rentCell]),
      el('span', { role: 'cell', class: 'rr-cell', dataset: { label: 'EB units' } }, [units]),
      el('span', { role: 'cell', class: 'rr-cell', dataset: { label: 'Rate / unit' } }, [rate]),
      el('span', { role: 'cell', class: 'rr-cell', dataset: { label: 'Other' } }, [otherCell]),
      el('span', { role: 'cell', class: 'rr-cell', dataset: { label: 'Total' } }, [totalCell]),
      el('span', { role: 'cell', class: 'rr-cell-toggle' }, [toggle])
    ]);

    function paintDetail() {
      if (!w.open) return;
      detail.textContent = '';
      const t = totalsOf(w);
      // the rent, locked, with how it is worked out
      detail.append(el('div', { class: 'rr-block' }, [
        el('div', { class: 'rr-block-head' }, [
          el('strong', { text: 'Rent' }),
          w.adjust ? null : el('button', { class: 'link', type: 'button', onClick: () => {
            w.adjust = { amount: String(o.amount), reason: '' }; update(); paintDetail();
          } }, [icon('edit', 14), 'Adjust rent…'])
        ]),
        explainRent(c, o),
        w.adjust ? adjustEditor() : null
      ]));

      if (fees.length) {
        detail.append(el('div', { class: 'rr-block' }, [
          el('div', { class: 'rr-block-head' }, [el('strong', { text: 'Late fees' }),
            el('small', { class: 'muted', text: 'Tick a fee to charge it on this invoice. Unticked fees are offered again next time.' })]),
          ...fees.map(f => {
            const box = el('input', { type: 'checkbox', checked: w.fees.has(f.invoice_id) || null });
            box.addEventListener('change', () => { box.checked ? w.fees.add(f.invoice_id) : w.fees.delete(f.invoice_id); update(); paintDetail(); });
            return el('div', { class: 'rr-fee' }, [
              el('label', { class: 'check' }, [box, el('span', {}, [
                `Late fee ${money(f.fee)} · `,
                el('a', { href: '#/invoices/' + encodeURIComponent(f.invoice_id), target: '_blank', rel: 'noopener', text: f.invoice_id }),
                ` was due ${date(f.due_date)}, ${money(f.balance)} still owing`
              ])]),
              el('button', { class: 'link small', type: 'button', onClick: () => waive(c, f, () => { w.fees.delete(f.invoice_id); update(); paintDetail(); }) },
                 ['Waive…'])
            ]);
          })
        ]));
      }

      detail.append(el('div', { class: 'rr-block' }, [
        el('div', { class: 'rr-block-head' }, [el('strong', { text: 'Other charges' }),
          el('button', { class: 'link', type: 'button', onClick: () => {
            w.extras.push({ id: 'x' + Math.random().toString(36).slice(2, 9), description: '', category: 'Water', quantity: 1,
                            unit_amount: '', tax_rate: '' });
            update(); paintDetail();
            detail.querySelector('.rr-extra:last-child .rr-x-desc')?.focus();
          } }, [icon('plus', 14), 'Add charge'])]),
        isFigure(w.eb.units) && figure(w.eb.units) > 0
          ? el('p', { class: 'muted small', text: `${ebText(w.eb)} = ${money(figure(w.eb.units) * figure(w.eb.rate || 0))} (from the grid above)` })
          : null,
        w.extras.length ? el('div', { class: 'rr-extras' }, w.extras.map(extraRow)) : el('p', { class: 'muted small', text: 'None.' })
      ]));

      const notes = el('textarea', { class: 'input', rows: 2, placeholder: 'Printed on the invoice' }, [w.notes]);
      notes.addEventListener('input', () => { w.notes = notes.value; remember(); });
      detail.append(el('div', { class: 'rr-block' }, [el('label', {}, ['Notes', notes])]));

      detail.append(el('div', { class: 'rr-detail-totals' }, [
        el('div', { class: 'kv' }, [el('span', { text: 'Rent' }), el('strong', { text: money(t.rent) })]),
        el('div', { class: 'kv' }, [el('span', { text: 'Other charges' }), el('strong', { text: money(t.other) })]),
        el('div', { class: 'kv' }, [el('span', { text: 'GST' }), el('strong', { text: money(t.tax) })]),
        el('div', { class: 'kv kv-strong' }, [el('span', { text: 'Total' }), el('strong', { text: money(t.total) })])
      ]));
    }

    function adjustEditor() {
      const amount = el('input', { class: 'input', inputmode: 'decimal', value: w.adjust.amount, 'aria-label': 'Adjusted rent' });
      const reason = el('input', { class: 'input', value: w.adjust.reason, placeholder: 'e.g. agreed discount for repairs',
                                   'aria-label': 'Reason for the change' });
      amount.addEventListener('input', () => { w.adjust.amount = amount.value; update(); });
      reason.addEventListener('input', () => { w.adjust.reason = reason.value; remember(); });
      return el('div', { class: 'rr-adjust' }, [
        el('div', { class: 'form-grid' }, [
          el('div', { class: 'field' }, [el('label', { text: 'Rent to charge' }), amount,
            el('small', { class: 'help', text: `Worked out: ${money(o.amount)}. The difference is its own line, "Rent adjustment".` })]),
          el('div', { class: 'field' }, [el('label', {}, ['Reason ', el('span', { class: 'req', text: '*' })]), reason,
            el('small', { class: 'help', text: 'Kept with the invoice and in the activity log; not printed.' })])
        ]),
        el('button', { class: 'link small', type: 'button', onClick: () => { w.adjust = null; update(); paintDetail(); } },
           ['Keep the worked-out rent'])
      ]);
    }

    function extraRow(x) {
      const desc = el('input', { class: 'input rr-x-desc', value: x.description, placeholder: 'Description', 'aria-label': 'Description' });
      const cat = el('select', { class: 'input', 'aria-label': 'Category' },
                     EXTRA_CATEGORIES.map(cc => el('option', { value: cc, selected: cc === x.category || null }, [cc])));
      const qty = el('input', { class: 'input', inputmode: 'decimal', value: x.quantity, 'aria-label': 'Quantity' });
      const amt = el('input', { class: 'input', inputmode: 'decimal', value: x.unit_amount, placeholder: 'Amount', 'aria-label': 'Amount' });
      const gst = el('input', { class: 'input', inputmode: 'decimal', value: x.tax_rate, placeholder: 'GST %', 'aria-label': 'GST %' });
      const lineAmt = el('span', { class: 'num rr-x-amount' });
      const recalc = () => {
        lineAmt.textContent = money((isFigure(x.quantity) ? figure(x.quantity) : 1) * (isFigure(x.unit_amount) ? figure(x.unit_amount) : 0));
      };
      const bind = (input, key) => input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input',
        () => { x[key] = input.value; recalc(); update(); });
      bind(desc, 'description'); bind(cat, 'category'); bind(qty, 'quantity'); bind(amt, 'unit_amount'); bind(gst, 'tax_rate');
      recalc();
      return el('div', { class: 'rr-extra line-row' }, [desc, cat, qty, amt, gst, lineAmt,
        el('button', { class: 'icon-btn danger', type: 'button', title: 'Remove this charge', 'aria-label': 'Remove this charge',
                       onClick: () => { w.extras = w.extras.filter(e => e !== x); update(); paintDetail(); } }, [icon('trash', 15)])]);
    }

    update();
    if (w.open) paintDetail();
    return el('div', { class: 'rr-grid-item' }, [row, detail]);
  }

  /** How a rent figure is made up, in words. */
  function explainRent(c, o) {
    const lines = o.lines.map(l => el('div', { class: 'kv' }, [
      el('span', { text: l.month_days
        ? `${range(l.start, l.end)}: ${l.days} of ${l.month_days} days × ${money(l.rent)}`
        : `${range(l.start, l.end)}: one month` }),
      el('strong', { text: money(l.amount) })
    ]));
    const partial = o.lines.some(l => l.month_days);
    const lease = store.byId('leases', c.lease_id);
    const escalated = lease && Number(lease.escalation_pct) && o.lines.some(l => l.rent !== Number(lease.rent_amount));
    const graceText = c.late_fee ? ` A late fee of ${money(c.late_fee)} can be charged from ${plural(c.grace_days, 'day')} after the due date (or after the day it is issued, if later).` : '';
    return el('div', { class: 'rr-explain' }, [
      ...lines,
      el('p', { class: 'muted small', text:
        (partial ? 'A part month is charged day by day: each calendar month at the monthly rent divided by its own number of days. ' : '') +
        (o.cycles > 1 ? `${o.cycles} months are billed together (${c.frequency}). ` : '') +
        (escalated ? `The rent includes the ${lease.escalation_pct}% yearly increase. ` : '') +
        `Due ${date(o.due)}, the rent day.` + graceText })
    ]);
  }

  function waive(c, f, done) {
    const reason = el('textarea', { class: 'input', rows: 2, placeholder: 'e.g. medical emergency; paid late with notice' });
    const error = el('p', { class: 'form-error', hidden: true });
    modal({
      title: 'Waive late fee · ' + f.invoice_id,
      width: 480,
      body: el('div', { class: 'stack' }, [
        error,
        el('p', { class: 'muted', text: `${tenantName(c)} will not be charged the ${money(f.fee)} late fee for ${f.invoice_id}, now or later. This is logged.` }),
        el('label', {}, ['Reason *', reason])
      ]),
      actions: [
        { label: 'Cancel' },
        { label: 'Waive late fee', variant: 'btn-primary', onClick: async (e, closeIt) => {
          if (!reason.value.trim()) { error.hidden = false; error.textContent = 'Give a reason.'; return; }
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await api('waiveLateFee', { invoice_id: f.invoice_id, reason: reason.value.trim() });
            c.late_fees = c.late_fees.filter(x => x.invoice_id !== f.invoice_id);
            closeIt(); done();
            toast('Late fee waived', 'ok');
          } catch (err) { btn.disabled = false; error.hidden = false; error.textContent = err.message; }
        } }
      ]
    });
  }

  // ── ③ review ──────────────────────────────────────────────────────────────
  function drawReview() {
    const works = chosen().map(({ c, o }) => ({ c, o, w: workFor(c, o), t: totalsOf(workFor(c, o)) }));
    const total = round2(works.reduce((s, x) => s + x.t.total, 0));
    const byProperty = {};
    for (const x of works) byProperty[x.c.property_id] = round2((byProperty[x.c.property_id] || 0) + x.t.total);

    const warnings = [];
    const pastDue = works.filter(x => x.o.due < run.asOf);
    if (pastDue.length) {
      warnings.push(`${plural(pastDue.length, 'invoice is', 'invoices are')} already past the due date and will show as Overdue. ` +
                    'Their late-fee grace days count from today.');
    }
    const noEb = works.filter(x => x.c.last_eb_rate !== null && !(isFigure(x.w.eb.units) && figure(x.w.eb.units) > 0));
    if (noEb.length) warnings.push(`No electricity charge for ${noEb.map(x => unitName(x.c)).join(', ')}, which had one before.`);
    for (const x of works.filter(x => x.w.adjust && round2(figure(x.w.adjust.amount)) !== x.o.amount)) {
      warnings.push(`${unitName(x.c)}: rent changed ${money(x.o.amount)} → ${money(figure(x.w.adjust.amount))} (${x.w.adjust.reason.trim()}).`);
    }
    const fees = works.reduce((n, x) => n + x.t.lines.filter(l => l.category === 'Late Fee').length, 0);
    if (fees) warnings.push(`${plural(fees, 'late fee')} will be charged.`);

    body.append(el('div', { class: 'stat-row rr-review-stats' }, [
      el('div', { class: 'stat' }, [el('span', { class: 'stat-label', text: 'Invoices' }), el('strong', { class: 'stat-value', text: String(works.length) })]),
      el('div', { class: 'stat' }, [el('span', { class: 'stat-label', text: 'Total' }), el('strong', { class: 'stat-value', text: money(total) })]),
      ...Object.entries(byProperty).map(([p, v]) => el('div', { class: 'stat' }, [
        el('span', { class: 'stat-label', text: store.label('properties', p) }), el('strong', { class: 'stat-value', text: money(v) })]))
    ]));
    if (warnings.length) {
      body.append(el('div', { class: 'notice notice-warn rr-warnings' }, [
        icon('alert', 16),
        warnings.length === 1 ? el('span', { text: warnings[0] }) : el('ul', {}, warnings.map(w => el('li', { text: w })))
      ]));
    }

    const table = el('div', { class: 'table-scroll rr-review-table' }, [el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {}, ['Tenant', 'Period', 'Due', 'Rent', 'Other', 'GST', 'Total', ''].map((h, i) =>
        el('th', { class: i >= 3 && i <= 6 ? 'num' : '', text: h })))]),
      el('tbody', {}, works.map(x => el('tr', {}, [
        el('td', { class: 'rr-r-who' }, [el('strong', { text: tenantName(x.c) }), el('br'), el('small', { class: 'muted', text: unitName(x.c) })]),
        el('td', { dataset: { label: 'Period' }, text: range(x.o.start, x.o.end) }),
        el('td', { dataset: { label: 'Due' }, text: date(x.o.due) }),
        el('td', { class: 'num', dataset: { label: 'Rent' }, text: money(x.t.rent) }),
        el('td', { class: 'num', dataset: { label: 'Other' }, text: x.t.other ? money(x.t.other) : '—' }),
        el('td', { class: 'num', dataset: { label: 'GST' }, text: x.t.tax ? money(x.t.tax) : '—' }),
        el('td', { class: 'num', dataset: { label: 'Total' } }, [el('strong', { text: money(x.t.total) })]),
        el('td', { class: 'rr-r-act' }, [footBtn('Preview', () => preview(x), 'btn-ghost btn-sm')])
      ])))
    ])]);
    body.append(table);
    body.append(el('p', { class: 'muted small rr-review-note', text:
      'The rent is worked out again when you confirm. If a lease was changed or billed by someone else in the meantime, that invoice is skipped and named.' }));

    const error = el('p', { class: 'form-error rr-foot-error', hidden: true });
    const go = (mode) => async (e) => {
      const btns = foot.querySelectorAll('button');
      btns.forEach(b => { b.disabled = true; });
      const label = e.currentTarget.textContent;
      e.currentTarget.textContent = mode === 'issue' ? 'Issuing…' : 'Saving…';
      run.busy = true;
      error.hidden = true;
      try {
        const res = await store.act('generateRent', { mode, invoices: works.map(x => payloadOf(x)) });
        run.result = res;
        run.busy = false;
        saved.clear();
        draw();
      } catch (err) {
        run.busy = false;
        btns.forEach(b => { b.disabled = false; });
        e.currentTarget.textContent = label;
        error.hidden = false; error.textContent = err.message;
      }
    };
    foot.append(
      footSummary([el('strong', { text: plural(works.length, 'invoice') }), ' · ', el('strong', { text: money(total) }), error]),
      footBtn('Back', () => { run.step = 2; draw(); }),
      footBtn('Save as drafts', go('draft'), 'btn-ghost'),
      footBtn(`Issue ${plural(works.length, 'invoice')}`, go('issue'), 'btn-primary')
    );
  }

  function payloadOf({ c, o, w }) {
    const extras = [];
    if (isFigure(w.eb.units) && figure(w.eb.units) > 0) {
      extras.push({ description: ebText(w.eb), category: 'Electricity', quantity: figure(w.eb.units), unit_amount: figure(w.eb.rate), tax_rate: 0 });
    }
    for (const x of w.extras) {
      extras.push({ description: x.description.trim(), category: x.category, quantity: String(x.quantity).trim() === '' ? 1 : x.quantity,
                    unit_amount: x.unit_amount, tax_rate: x.tax_rate });
    }
    return {
      lease_id: c.lease_id, period_start: o.start, period_end: o.end, rent: o.amount,
      join_first: o.join ? true : o.separate ? false : undefined,
      extras,
      adjust: w.adjust && round2(figure(w.adjust.amount)) !== o.amount ? { amount: w.adjust.amount, reason: w.adjust.reason.trim() } : null,
      late_fees: feeHolder(c.lease_id) === w.key ? [...w.fees] : [],
      notes: w.notes.trim()
    };
  }

  /** The invoice as the tenant will see it, before it has a number. */
  function preview({ c, o, t }) {
    const inv = {
      id: 'Preview', status: 'Unpaid', type: 'Rent', tenant_id: c.tenant_id, unit_id: c.unit_id, property_id: c.property_id,
      lease_id: c.lease_id, period_start: o.start, period_end: o.end, issue_date: run.asOf, due_date: o.due,
      amount: round2(t.rent + t.other), tax: t.tax, total: t.total, amount_paid: 0, balance: t.total,
      notes: workFor(c, o).notes
    };
    showInvoice(inv, { items: t.lines.map(l => ({ description: l.description, category: l.category, quantity: l.quantity,
                                                   unit_amount: l.unit_amount, amount: l.amount, tax_rate: l.tax_rate })),
                       payments: [] });
  }

  // ── the result ────────────────────────────────────────────────────────────
  function drawResult() {
    const res = run.result;
    const issued = res.mode === 'issue';
    body.append(el('div', { class: 'rr-result-head' }, [
      el('span', { class: 'rr-result-icon' + (res.created.length ? '' : ' is-empty') }, [icon(res.created.length ? 'check' : 'alert', 22)]),
      el('div', {}, [
        el('h3', { text: res.created.length
          ? `${plural(res.created.length, 'invoice')} ${issued ? 'issued' : 'saved as drafts'} · ${money(res.total)}`
          : 'No invoices were created' }),
        el('p', { class: 'muted', text: issued ? 'Share each one with the tenant, or print them.'
          : 'Drafts are not sent to anyone and nothing is owed on them yet. Issue them from Billing → Drafts.' })
      ])
    ]));
    if (res.skipped.length) {
      body.append(el('div', { class: 'notice notice-warn rr-warnings' }, [
        icon('alert', 16),
        el('div', {}, [el('strong', { text: `${plural(res.skipped.length, 'invoice')} skipped` }),
          el('ul', {}, res.skipped.map(s => {
            const c = candidateOf(s.lease_id);
            return el('li', { text: `${c ? tenantName(c) : s.lease_id}: ${s.reason}` });
          }))])
      ]));
    }
    if (res.fees_dropped && res.fees_dropped.length) {
      body.append(el('p', { class: 'muted small', text: `${plural(res.fees_dropped.length, 'late fee')} could no longer be charged (paid or settled meanwhile) and ${res.fees_dropped.length === 1 ? 'was' : 'were'} left off.` }));
    }
    if (res.created.length) {
      body.append(el('ul', { class: 'rr-result-list' }, res.created.map(inv => {
        const tenant = store.byId('tenants', inv.tenant_id);
        const wa = issued && tenant?.phone ? whatsappLink(tenant.phone, invoiceMessage(inv), store.settings.whatsapp_country_code || '91') : '';
        return el('li', { class: 'rr-result-row' }, [
          el('span', { class: 'rr-lease-who' }, [
            el('a', { href: '#/invoices/' + encodeURIComponent(inv.id), text: inv.id, onClick: () => close() }),
            el('small', { class: 'muted', text: `${store.label('tenants', inv.tenant_id)} · ${store.label('units', inv.unit_id)} · ${range(inv.period_start, inv.period_end)}` })
          ]),
          badge(inv.status),
          el('strong', { class: 'num', text: money(inv.total) }),
          el('span', { class: 'rr-result-actions' }, [
            wa ? el('a', { class: 'btn btn-ghost btn-sm', href: wa, target: '_blank', rel: 'noopener noreferrer' }, [icon('whatsapp', 14), ' WhatsApp']) : null,
            footBtn('Print', () => showInvoice(inv), 'btn-ghost btn-sm')
          ])
        ]);
      })));
    }
    foot.append(footBtn('Done', () => { close(); refreshView(); }, 'btn-primary'));
  }

  load();
  return { close };
}

/** "Generate rent" as a button, for Billing, a lease page and the dashboard. */
export function generateRentButton({ leaseId, label = 'Generate rent', variant = 'btn-primary' } = {}) {
  if (!store.can('manager')) return null;
  return el('button', { class: 'btn ' + variant, type: 'button', onClick: () => openGenerateRent({ leaseId }) },
            [icon('bolt', 16), ' ' + label]);
}


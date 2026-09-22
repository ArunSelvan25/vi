import { el, icon, money, num, date, badge, debounce, downloadCsv, emptyState, isoDate, safeUrl, toast } from '../ui.js';
import { store } from '../store.js';
import { entities, tableFields } from '../schema.js';
import { DETAIL_ENTITIES, ref, copyable } from './detail.js';

const PAGE_SIZE = 25;

/** Render one cell according to its schema field type. */
export function cellValue(field, row) {
  const raw = row[field.key];
  if (field.type === 'ref') {
    return field.short ? store.shortLabel(field.optionsFrom, raw)
                       : store.label(field.optionsFrom, raw);
  }
  if (field.type === 'money') return money(raw);
  if (field.type === 'date') return date(raw);
  if (field.type === 'number') return raw === '' || raw === undefined ? '—' : num(raw);
  return raw === '' || raw === null || raw === undefined ? '—' : String(raw);
}

/**
 * What a cell shows on screen: its text, or for a link field an actual link.
 * Documents are stored as links precisely so they can be opened, but the list
 * only printed the address. Anything that is not http(s) stays plain text, so
 * a `javascript:` value typed into a record can never become clickable.
 *
 * A reference to another record links to that record's page (with a hover
 * card), and identifiers people read out or paste elsewhere — ids, phone
 * numbers, emails — carry a copy button.
 */
function cellContent(entity, field, row) {
  const raw = row[field.key];
  if (field.type === 'url') {
    const href = safeUrl(raw);
    if (href) {
      return el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'link',
                       onClick: (e) => e.stopPropagation() }, ['Open ↗']);
    }
  }
  if (raw === '' || raw === null || raw === undefined) return cellValue(field, row);
  if (field.type === 'ref' && DETAIL_ENTITIES.has(field.optionsFrom)) {
    return ref(field.optionsFrom, raw, { short: field.short });
  }
  if (field.key === 'id' && DETAIL_ENTITIES.has(entity)) {
    return copyable(raw, { label: entities[entity].singular + ' ID', mono: true, compact: true });
  }
  if (field.type === 'email' || field.type === 'tel') {
    return copyable(raw, { label: field.type === 'email' ? 'Email' : 'Phone', compact: true });
  }
  return cellValue(field, row);
}

function isStatusField(field) {
  return field.key === 'status' || field.key === 'priority';
}

/**
 * Generic sortable / searchable / filterable table with paging, CSV export
 * and row actions. Used by every list view.
 *
 * Two ways to fill it:
 *   rows     the rows themselves — for the small tables the browser keeps
 *   source   { scope, preset, filters } — the server searches, filters, sorts
 *            and pages (store.page), and the table only ever holds one page.
 *            An export asks for every matching row.
 *
 * @param onTotal called with the number of matching rows after each load
 */
export function dataTable({
  entity,
  rows,
  source,
  columns,
  onRowClick,
  actions = [],
  emptyMessage = 'Nothing here yet.',
  filters = [],
  exportName,
  onTotal
}) {
  const def = entities[entity];
  const cols = columns || tableFields(entity);
  const remote = !!source;
  const state = { q: '', sort: null, dir: 1, page: 1, facets: {} };

  const host = el('div', { class: 'table-wrap' + (remote ? ' is-remote' : '') });
  const searchInput = el('input', {
    class: 'input search-input', type: 'search', placeholder: `Search ${def.title.toLowerCase()}…`,
    onInput: debounce(e => { state.q = e.target.value.trim().toLowerCase(); state.page = 1; draw(); }, remote ? 300 : 200)
  });

  const facetBar = el('div', { class: 'facets' });
  for (const f of filters) {
    const select = el('select', {
      class: 'input select-sm',
      onChange: e => { state.facets[f.key] = e.target.value; state.page = 1; draw(); }
    }, [el('option', { value: '', text: f.label })]);
    for (const o of f.options) select.append(el('option', { value: o, text: o }));
    facetBar.append(select);
  }

  const exportBtn = el('button', {
    class: 'btn btn-ghost btn-sm', type: 'button', title: 'Export matching rows to CSV',
    onClick: async () => {
      const name = (exportName || def.title.toLowerCase()) + '-' + isoDate() + '.csv';
      const columnsOut = cols.map(c => ({ label: c.label, value: r => cellValue(c, r) }));
      if (!remote) { downloadCsv(name, filtered(), columnsOut); return; }
      exportBtn.disabled = true;
      try { downloadCsv(name, await store.everything(entity, query()), columnsOut); }
      catch (err) { toast(err.message, 'danger'); }
      finally { exportBtn.disabled = false; }
    }
  }, [icon('download', 15), ' CSV']);

  const toolbar = el('div', { class: 'table-toolbar' }, [
    el('div', { class: 'search-box' }, [icon('search', 16), searchInput]),
    facetBar,
    exportBtn
  ]);

  const tableEl = el('table', { class: 'data-table' });
  const info = el('div', { class: 'table-info' });
  const pager = el('div', { class: 'pager' });
  // Kept out of the scrolling area on purpose. As a cell inside the table it
  // was centred across the full width of the columns, which on a phone put it
  // off to one side of the screen instead of in front of the reader.
  const emptyHost = el('div', { class: 'table-empty' });
  const scrollEl = el('div', { class: 'table-scroll' }, [tableEl]);

  host.append(toolbar, scrollEl, emptyHost,
              el('div', { class: 'table-foot' }, [info, pager]));

  const narrowed = () => !!state.q || Object.values(state.facets).some(Boolean);

  /** What the server is asked for: the table's own limits, then the reader's. */
  function query() {
    const facets = Object.fromEntries(Object.entries(state.facets).filter(([, v]) => v));
    return {
      scope: source.scope, preset: source.preset,
      filters: { ...(source.filters || {}), ...facets },
      q: state.q, sort: state.sort || undefined, dir: state.dir === 1 ? 'asc' : 'desc'
    };
  }

  function filtered() {
    let out = rows.slice();
    if (state.q) {
      const keys = def.search || cols.map(c => c.key);
      out = out.filter(r =>
        keys.some(k => String(r[k] ?? '').toLowerCase().includes(state.q)) ||
        cols.some(c => cellValue(c, r).toLowerCase().includes(state.q))
      );
    }
    for (const [k, v] of Object.entries(state.facets)) {
      if (v) out = out.filter(r => String(r[k]) === v);
    }
    if (state.sort) {
      const field = cols.find(c => c.key === state.sort);
      out.sort((a, b) => {
        const av = a[state.sort], bv = b[state.sort];
        if (field && (field.type === 'money' || field.type === 'number')) {
          return ((Number(av) || 0) - (Number(bv) || 0)) * state.dir;
        }
        return String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true }) * state.dir;
      });
    }
    return out;
  }

  // a newer request supersedes one still in flight
  let requestNo = 0;

  function draw() {
    if (!remote) {
      const all = filtered();
      const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
      state.page = Math.min(state.page, pages);
      render(all.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE), all.length);
      return;
    }
    const mine = ++requestNo;
    host.classList.add('is-loading');
    host.setAttribute('aria-busy', 'true');
    store.page(entity, { ...query(), page: state.page, pageSize: PAGE_SIZE })
      .then(res => {
        if (mine !== requestNo) return;
        state.page = res.page;
        render(res.rows, res.total);
        if (onTotal) onTotal(res.total, narrowed());
      })
      .catch(err => {
        if (mine !== requestNo) return;
        scrollEl.hidden = true;
        emptyHost.hidden = false;
        emptyHost.textContent = '';
        emptyHost.append(el('p', { class: 'form-error', text: 'Could not load ' + def.title.toLowerCase() + ': ' + err.message }));
        info.textContent = '';
      })
      .finally(() => {
        if (mine !== requestNo) return;
        host.classList.remove('is-loading');
        host.removeAttribute('aria-busy');
      });
  }

  /** Draw one page of rows, out of `total` that match. */
  function render(page, total) {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    tableEl.textContent = '';
    const head = el('tr');
    for (const c of cols) {
      const active = state.sort === c.key;
      head.append(el('th', {
        style: c.width ? `width:${c.width}px` : null,
        class: 'sortable' + (active ? ' sorted' : ''),
        onClick: () => {
          if (state.sort === c.key) state.dir *= -1; else { state.sort = c.key; state.dir = 1; }
          state.page = 1;
          draw();
        }
      }, [c.label, active ? (state.dir === 1 ? ' ▲' : ' ▼') : '']));
    }
    if (actions.length) head.append(el('th', { class: 'col-actions', text: '' }));
    tableEl.append(el('thead', {}, [head]));

    emptyHost.textContent = '';
    if (!total) {
      // Column headers over nothing are noise, and they are what forced the
      // sideways scrollbar on an empty table.
      scrollEl.hidden = true;
      emptyHost.hidden = false;
      const anyRows = remote ? narrowed() : rows.length;
      emptyHost.append(emptyState(anyRows ? 'No rows match your filters.' : emptyMessage));
    } else {
      scrollEl.hidden = false;
      emptyHost.hidden = true;
      const body = el('tbody');
      for (const row of page) {
        const tr = el('tr', {
          class: onRowClick ? 'clickable' : null,
          onClick: onRowClick ? (e) => { if (!e.target.closest('.row-actions')) onRowClick(row); } : null
        });
        for (const c of cols) {
          const content = isStatusField(c) ? badge(row[c.key]) : cellContent(entity, c, row);
          tr.append(el('td', { class: c.type === 'money' || c.type === 'number' ? 'num' : null,
                               title: typeof content === 'string' ? content : null },
                      [content]));
        }
        if (actions.length) {
          tr.append(el('td', { class: 'col-actions' }, [
            el('div', { class: 'row-actions' }, actions
              .filter(a => !a.visible || a.visible(row))
              .map(a => el('button', {
                class: 'icon-btn' + (a.danger ? ' danger' : ''), type: 'button', title: a.label,
                onClick: (e) => { e.stopPropagation(); a.onClick(row); }
              }, [icon(a.icon, 16)])))
          ]));
        }
        body.append(tr);
      }
      tableEl.append(body);
    }

    info.textContent = total
      ? `${(state.page - 1) * PAGE_SIZE + 1}–${Math.min(state.page * PAGE_SIZE, total)} of ${total}`
      : '0 rows';

    pager.textContent = '';
    if (pages > 1) {
      pager.append(
        el('button', { class: 'btn btn-ghost btn-sm', disabled: state.page === 1 || null,
                       onClick: () => { state.page--; draw(); } }, ['‹ Prev']),
        el('span', { class: 'pager-label', text: `Page ${state.page} / ${pages}` }),
        el('button', { class: 'btn btn-ghost btn-sm', disabled: state.page === pages || null,
                       onClick: () => { state.page++; draw(); } }, ['Next ›'])
      );
    }
  }

  if (remote) {
    // nothing to show until the first page arrives
    scrollEl.hidden = true;
    emptyHost.append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', { text: 'Loading…' })]));
  }
  draw();
  return host;
}

import { el, icon, money, num, date, badge, debounce, downloadCsv, emptyState, isoDate } from '../ui.js';
import { store } from '../store.js';
import { entities, tableFields } from '../schema.js';

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

function isStatusField(field) {
  return field.key === 'status' || field.key === 'priority';
}

/**
 * Generic sortable / searchable / filterable table with paging, CSV export
 * and row actions. Used by every list view.
 */
export function dataTable({
  entity,
  rows,
  columns,
  onRowClick,
  actions = [],
  emptyMessage = 'Nothing here yet.',
  filters = [],
  exportName
}) {
  const def = entities[entity];
  const cols = columns || tableFields(entity);
  const state = { q: '', sort: null, dir: 1, page: 1, facets: {} };

  const host = el('div', { class: 'table-wrap' });
  const searchInput = el('input', {
    class: 'input search-input', type: 'search', placeholder: `Search ${def.title.toLowerCase()}…`,
    onInput: debounce(e => { state.q = e.target.value.toLowerCase(); state.page = 1; draw(); }, 200)
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

  const toolbar = el('div', { class: 'table-toolbar' }, [
    el('div', { class: 'search-box' }, [icon('search', 16), searchInput]),
    facetBar,
    el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', title: 'Export visible rows to CSV',
      onClick: () => downloadCsv(
        (exportName || def.title.toLowerCase()) + '-' + isoDate() + '.csv',
        filtered(),
        cols.map(c => ({ label: c.label, value: r => cellValue(c, r) }))
      )
    }, [icon('download', 15), ' CSV'])
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

  function draw() {
    const all = filtered();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const page = all.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

    tableEl.textContent = '';
    const head = el('tr');
    for (const c of cols) {
      const active = state.sort === c.key;
      head.append(el('th', {
        style: c.width ? `width:${c.width}px` : null,
        class: 'sortable' + (active ? ' sorted' : ''),
        onClick: () => {
          if (state.sort === c.key) state.dir *= -1; else { state.sort = c.key; state.dir = 1; }
          draw();
        }
      }, [c.label, active ? (state.dir === 1 ? ' ▲' : ' ▼') : '']));
    }
    if (actions.length) head.append(el('th', { class: 'col-actions', text: '' }));
    tableEl.append(el('thead', {}, [head]));

    emptyHost.textContent = '';
    if (!all.length) {
      // Column headers over nothing are noise, and they are what forced the
      // sideways scrollbar on an empty table.
      scrollEl.hidden = true;
      emptyHost.hidden = false;
      emptyHost.append(emptyState(rows.length ? 'No rows match your filters.' : emptyMessage));
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
          const content = isStatusField(c) ? badge(row[c.key]) : cellValue(c, row);
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

    info.textContent = all.length
      ? `${(state.page - 1) * PAGE_SIZE + 1}–${Math.min(state.page * PAGE_SIZE, all.length)} of ${all.length}`
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

  draw();
  return host;
}

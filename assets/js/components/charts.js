import { el, money } from '../ui.js';

/**
 * Dependency-free SVG charts. Colours come from CSS custom properties so they
 * follow the light/dark theme automatically.
 */

const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/**
 * Grouped income vs expense bars, with a hover band over each month.
 *
 * Drawn at the size it is actually given rather than into a fixed 720-unit
 * viewBox stretched to fit. Stretching squashed the type along with the
 * geometry: on a phone the month labels came out at under half their proper
 * width, which is the one thing you cannot do to a typeface. Working in real
 * pixels also means the axis can thin its labels out when they would collide,
 * instead of relying on the squash to make them fit.
 */
export function barChart(series, { height = 240 } = {}) {
  const svg = svgEl('svg', {
    class: 'chart', role: 'img', 'aria-label': 'Income versus expenses by month'
  });

  const box = el('div', { class: 'chart-box' }, [
    svg,
    el('div', { class: 'legend' }, [
      el('span', { class: 'legend-item' }, [el('i', { class: 'swatch swatch-income' }), 'Collected']),
      el('span', { class: 'legend-item' }, [el('i', { class: 'swatch swatch-expense' }), 'Expenses'])
    ])
  ]);

  function draw(w) {
    const h = height, padL = 56, padR = 16, padT = 12, padB = 34;
    const innerW = Math.max(40, w - padL - padR), innerH = h - padT - padB;
    const max = Math.max(1, ...series.flatMap(d => [d.income, d.expense]));
    const step = innerW / Math.max(1, series.length);
    const barW = Math.min(18, Math.max(6, step / 3.4));
    const baseline = padT + innerH;
    // roughly what a three-letter month needs before its neighbour touches it
    const stride = Math.max(1, Math.ceil(34 / step));

    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.textContent = '';

    // horizontal gridlines with value labels — four is enough to read against
    for (let i = 0; i <= 4; i++) {
      const y = baseline - (innerH * i) / 4;
      if (i > 0) svg.append(svgEl('line', { x1: padL, x2: w - padR, y1: y, y2: y, class: 'grid' }));
      svg.append(svgEl('text', { x: padL - 10, y: y + 3.5, class: 'axis', 'text-anchor': 'end' },
        [money((max * i) / 4, { compact: true })]));
    }
    svg.append(svgEl('line', { x1: padL, x2: w - padR, y1: baseline, y2: baseline, class: 'axis-line' }));

    series.forEach((d, i) => {
      const cx = padL + step * i + step / 2;
      const inH = (d.income / max) * innerH;
      const exH = (d.expense / max) * innerH;
      const col = svgEl('g', { class: 'col' });

      // full-height hit area so hovering anywhere in the month highlights it
      col.append(svgEl('rect', {
        x: cx - step / 2, y: padT, width: step, height: innerH, rx: 4, class: 'col-hit'
      }, [svgEl('title', {}, [
        `${d.label}\nCollected: ${money(d.income)}\nExpenses: ${money(d.expense)}\nNet: ${money(d.net)}`
      ])]));

      if (inH > 0) col.append(svgEl('rect', {
        x: cx - barW - 2, y: baseline - inH, width: barW, height: inH, rx: 3, class: 'bar-income'
      }));
      if (exH > 0) col.append(svgEl('rect', {
        x: cx + 2, y: baseline - exH, width: barW, height: exH, rx: 3, class: 'bar-expense'
      }));

      // every month still has a hover label; only the printed ones are thinned
      if (i % stride === 0) {
        col.append(svgEl('text', { x: cx, y: h - 12, class: 'axis-month', 'text-anchor': 'middle' }, [d.label]));
      }
      svg.append(col);
    });
  }

  // The real width is unknown until this is in the document, so start at the
  // old fixed size and let the observer correct it as soon as it has a box.
  draw(720);
  if (typeof ResizeObserver === 'function') {
    let last = 0;
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0 && w !== last) { last = w; draw(w); }
    }).observe(box);
  }

  return box;
}

/** Donut for occupancy or any part-of-whole split. */
export function donut(parts, { size = 168, centerLabel = '', centerSub = '' } = {}) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const r = 60, c = 2 * Math.PI * r, cx = 84, cy = 84;
  const svg = svgEl('svg', { viewBox: '0 0 168 168', width: size, height: size, class: 'donut', role: 'img',
                             'aria-label': centerLabel + ' ' + centerSub });
  let offset = 0;
  parts.forEach(p => {
    const len = (p.value / total) * c;
    svg.append(svgEl('circle', {
      cx, cy, r, fill: 'none', 'stroke-width': 18, stroke: p.color,
      'stroke-dasharray': `${len} ${c - len}`, 'stroke-dashoffset': -offset,
      transform: `rotate(-90 ${cx} ${cy})`
    }, [svgEl('title', {}, [`${p.label}: ${p.value}`])]));
    offset += len;
  });
  svg.append(svgEl('text', { x: cx, y: cy - 2, class: 'donut-value', 'text-anchor': 'middle' }, [centerLabel]));
  svg.append(svgEl('text', { x: cx, y: cy + 18, class: 'donut-sub', 'text-anchor': 'middle' }, [centerSub]));

  return el('div', { class: 'donut-box' }, [
    svg,
    el('ul', { class: 'donut-legend' }, parts.map(p =>
      el('li', {}, [
        el('i', { class: 'swatch', style: `background:${p.color}` }),
        el('span', { text: p.label }),
        el('b', { text: String(p.value) })
      ])))
  ]);
}

/** Horizontal ranked bars — used for arrears and expense categories. */
export function rankedBars(items, { formatter = money } = {}) {
  const max = Math.max(1, ...items.map(i => i.value));
  return el('ul', { class: 'ranked' }, items.map(i =>
    el('li', {}, [
      el('div', { class: 'ranked-head' }, [
        el('span', { class: 'ranked-label', text: i.label }),
        el('span', { class: 'ranked-value', text: formatter(i.value) })
      ]),
      el('div', { class: 'ranked-track' }, [
        el('div', { class: 'ranked-fill' + (i.tone ? ' tone-' + i.tone : ''),
                    style: `width:${(i.value / max) * 100}%` })
      ])
    ])
  ));
}

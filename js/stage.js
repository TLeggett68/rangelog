/*
 * Stage (range bay) drawing. The bay is 600 x 400 units = 30 yd wide x 20 yd
 * deep (20 units per yard). Downrange is the top of the drawing.
 *
 * Object: { id, type, x, y, rot, label, note, shots?, len? (wall), w?, h? (box),
 *           points?, color?, dashed? (arrow — points are relative to x, y),
 *           boxType? (box — 'stationary' (default, white) or 'moving' (red)) }
 */
(function () {
  'use strict';

  const W = 600, H = 400, PPY = 20, BERM = 22;

  const TYPES = {
    target:  { name: 'Target',       prefix: 'T', shots: 2, note: true, z: 3 },
    steel:   { name: 'Steel',        prefix: 'S', shots: 1, note: true, z: 3 },
    noshoot: { name: 'No-Shoot',     prefix: 'NS', z: 3 },
    barrel:  { name: 'Barrel',       z: 2 },
    box:     { name: 'Shooting Box', prefix: 'letter', note: true, z: 0 },
    wall:    { name: 'Wall',         z: 1 },
    arrow:   { name: 'Route arrow',  note: true, z: 2.5, drawn: true }, // drawn freehand, not added from the toolbar
  };
  const ARROW_COLORS = ['#ffd43b', '#ff6b6b', '#4dabf7', '#ffffff'];

  // Shooting box types: the color tells shooters whether they shoot standing still or moving.
  const BOX_KINDS = {
    stationary: { name: 'Stationary', short: 'Stationary', stroke: '#ffffff', fill: 'rgba(255,255,255,.22)' },
    moving: { name: 'Shooting on the move', short: 'On the move', stroke: '#ff4d4d', fill: 'rgba(255,77,77,.28)' },
  };
  function boxKind(o) { return BOX_KINDS[o.boxType] ? o.boxType : 'stationary'; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function nextLabel(objects, type) {
    const prefix = TYPES[type].prefix;
    if (!prefix) return '';
    if (prefix === 'NS') return 'NS';
    const used = new Set(objects.filter(o => o.type === type).map(o => o.label));
    for (let i = 1; i <= 26; i++) {
      const l = prefix === 'letter' ? String.fromCharCode(64 + i) : prefix + i;
      if (!used.has(l)) return l;
    }
    return '';
  }

  function create(type, objects) {
    const n = objects.length;
    const o = {
      id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      type,
      x: 300 + ((n % 5) - 2) * 25,
      y: 180 + ((n % 3) - 1) * 25,
      rot: 0,
      label: nextLabel(objects, type),
      note: '',
    };
    if (TYPES[type].shots) o.shots = TYPES[type].shots;
    if (type === 'wall') o.len = 60;
    if (type === 'box') { o.w = 40; o.h = 40; o.y = 330; }
    return o;
  }

  /* ---------- route arrows ---------- */

  // Ramer–Douglas–Peucker: drop points that don't change the path's shape much.
  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    let idx = -1, max = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = segDist(pts[i], a, b);
      if (d > max) { max = d; idx = i; }
    }
    if (max <= eps) return [a, b];
    return simplify(pts.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(pts.slice(idx), eps));
  }
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }
  function pathLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return len;
  }

  // Smooth path through the points (quadratic curves between midpoints).
  function smoothPath(pts) {
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      d += ` Q${pts[i].x},${pts[i].y} ${(pts[i].x + pts[i + 1].x) / 2},${(pts[i].y + pts[i + 1].y) / 2}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L${last.x},${last.y}`;
  }

  // Direction at the tip, measured from a point far enough back to be stable.
  function tipAngle(pts, back) {
    const tip = pts[pts.length - 1];
    let base = pts[pts.length - 2];
    for (let i = pts.length - 2; i >= 0; i--) {
      base = pts[i];
      if (Math.hypot(tip.x - base.x, tip.y - base.y) >= back) break;
    }
    return Math.atan2(tip.y - base.y, tip.x - base.x);
  }

  function safeColor(c) { return /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : ARROW_COLORS[0]; }

  function arrowShape(o) {
    const pts = o.points || [];
    if (pts.length < 2) return '';
    const color = safeColor(o.color);
    const size = 13;
    const tip = pts[pts.length - 1];
    const a = tipAngle(pts, size);
    // End the line inside the arrowhead so its thick stroke doesn't poke past the point.
    const trimmed = pts.slice(0, -1).concat({ x: tip.x - Math.cos(a) * size * 0.7, y: tip.y - Math.sin(a) * size * 0.7 });
    const d = smoothPath(trimmed);
    const p1 = `${tip.x - size * Math.cos(a - 0.45)},${tip.y - size * Math.sin(a - 0.45)}`;
    const p2 = `${tip.x - size * Math.cos(a + 0.45)},${tip.y - size * Math.sin(a + 0.45)}`;
    const dash = o.dashed ? ' stroke-dasharray="10 7"' : '';
    const line = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';
    return `<path class="hit-stroke" d="${smoothPath(pts)}" ${line} stroke="transparent" stroke-width="16"/>
      <path d="${d}" ${line} stroke="rgba(0,0,0,.45)" stroke-width="6.5"${dash}/>
      <path d="${d}" ${line} stroke="${color}" stroke-width="3.5"${dash}/>
      <path d="M${tip.x},${tip.y} L${p1} L${p2} Z" fill="${color}" stroke="rgba(0,0,0,.45)" stroke-width="1.5" stroke-linejoin="round"/>`;
  }

  // Raw points from a freehand stroke -> arrow object, or null if the stroke was too short.
  function createArrow(raw, color) {
    if (raw.length < 2 || pathLength(raw) < 20) return null;
    const pts = simplify(raw, 3);
    const x0 = Math.round(pts[0].x), y0 = Math.round(pts[0].y);
    return {
      id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      type: 'arrow', x: x0, y: y0, rot: 0, label: '', note: '',
      color: color || ARROW_COLORS[0], dashed: false,
      points: pts.map(p => ({ x: Math.round(p.x - x0), y: Math.round(p.y - y0) })),
    };
  }

  // Thin preview line shown while a stroke is being drawn (absolute coordinates).
  function draft(raw, color) {
    if (raw.length < 2) return '';
    return `<polyline points="${raw.map(p => p.x + ',' + p.y).join(' ')}" fill="none" stroke="${safeColor(color)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="2 5" opacity=".9"/>`;
  }

  function shape(o) {
    switch (o.type) {
      case 'arrow':
        return arrowShape(o);
      case 'target':
      case 'noshoot': {
        const face = o.type === 'target' ? '#e2c38f' : '#ffffff';
        const edge = o.type === 'target' ? '#6b4f2a' : '#222';
        return `<rect class="hit" x="-15" y="-10" width="30" height="22"/>
          <line x1="-10" y1="0" x2="10" y2="0" stroke="${edge}" stroke-width="7" stroke-linecap="round"/>
          <line x1="-10" y1="0" x2="10" y2="0" stroke="${face}" stroke-width="4.5" stroke-linecap="round"/>
          <path d="M0,4 L-3,9 L3,9 Z" fill="${edge}"/>`;
      }
      case 'steel':
        return `<rect class="hit" x="-11" y="-11" width="22" height="24"/>
          <line x1="0" y1="5" x2="0" y2="11" stroke="#37474f" stroke-width="2.5"/>
          <circle r="6.5" fill="#b0b7bc" stroke="#37474f" stroke-width="2"/>`;
      case 'barrel':
        return `<circle r="12" fill="#2f5d8a" stroke="#183a5a" stroke-width="2"/>
          <circle r="8.5" fill="none" stroke="#6a93bd" stroke-width="1.5"/>
          <circle r="4" fill="none" stroke="#6a93bd" stroke-width="1"/>`;
      case 'box': {
        const w = o.w || 40, h = o.h || 40;
        const k = BOX_KINDS[boxKind(o)];
        return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" fill="${k.fill}" stroke="${k.stroke}" stroke-width="2.5"/>`;
      }
      case 'wall': {
        const len = o.len || 60;
        return `<rect class="hit" x="${-len / 2 - 2}" y="-8" width="${len + 4}" height="16"/>
          <rect x="${-len / 2}" y="-3" width="${len}" height="6" fill="#3e4a52" stroke="#1f272c" stroke-width="1"/>`;
      }
    }
    return '';
  }

  function selBox(o) {
    if (o.type === 'arrow') {
      const xs = (o.points || []).map(p => p.x), ys = (o.points || []).map(p => p.y);
      const x1 = Math.min(...xs) - 9, y1 = Math.min(...ys) - 9;
      return `<rect class="sel" x="${x1}" y="${y1}" width="${Math.max(...xs) + 9 - x1}" height="${Math.max(...ys) + 9 - y1}" rx="4"/>`;
    }
    let w, h;
    switch (o.type) {
      case 'target': case 'noshoot': w = 32; h = 24; break;
      case 'steel': w = 24; h = 26; break;
      case 'barrel': w = 32; h = 32; break;
      case 'box': w = (o.w || 40) + 10; h = (o.h || 40) + 10; break;
      case 'wall': w = (o.len || 60) + 10; h = 16; break;
      default: w = h = 30;
    }
    return `<rect class="sel" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="4"/>`;
  }

  function label(o) {
    if (!o.label) return '';
    const text = esc(o.label);
    if (o.type === 'box') {
      return `<text x="${o.x}" y="${o.y + 6}" pointer-events="none" text-anchor="middle" font-family="Oswald, sans-serif" font-size="17" font-weight="700" fill="#fff" stroke="rgba(0,0,0,.35)" stroke-width="3" paint-order="stroke">${text}</text>`;
    }
    const colors = { target: ['#1b4029', '#fff'], steel: ['#455a64', '#fff'], noshoot: ['#fff', '#b3261e'] }[o.type] || ['#333', '#fff'];
    const w = 10 + o.label.length * 7;
    const dy = o.type === 'steel' ? -19 : -20;
    return `<g transform="translate(${o.x},${o.y + dy})" pointer-events="none">
      <rect x="${-w / 2}" y="-8" width="${w}" height="15" rx="7.5" fill="${colors[0]}" stroke="rgba(0,0,0,.25)"/>
      <text y="3.5" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="700" fill="${colors[1]}">${text}</text>
    </g>`;
  }

  function render(objects, opts) {
    opts = opts || {};
    const sorted = objects.slice().sort((a, b) => (TYPES[a.type] || {}).z - (TYPES[b.type] || {}).z);
    const objs = sorted.map(o => {
      const marked = o.id === opts.selectedId || o.id === opts.highlightId;
      return `<g class="obj obj-${o.type}${marked ? ' marked' : ''}" data-id="${esc(o.id)}" transform="translate(${o.x},${o.y}) rotate(${o.rot || 0})">${shape(o)}${marked ? selBox(o) : ''}</g>`;
    }).join('');
    return objs + sorted.map(label).join('');
  }

  function background() {
    let grid = '';
    for (let x = 100; x < W; x += 100) grid += `<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`;
    for (let y = 100; y < H; y += 100) grid += `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
    return `<rect width="${W}" height="${H}" fill="#c9ad84"/>
      <g stroke="rgba(60,40,10,.12)" stroke-width="1">${grid}</g>
      <rect x="0" y="0" width="${W}" height="${BERM}" fill="#4f7a3a"/>
      <rect x="0" y="0" width="${BERM}" height="${H}" fill="#4f7a3a"/>
      <rect x="${W - BERM}" y="0" width="${BERM}" height="${H}" fill="#4f7a3a"/>
      <text x="${W / 2}" y="15" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="700" letter-spacing="2" fill="#e3f1e5">BERM · DOWNRANGE ▲</text>
      <text x="${W / 2}" y="${H - 8}" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="700" letter-spacing="2" fill="rgba(60,40,10,.55)">UPRANGE ▼</text>
      <g stroke="rgba(60,40,10,.6)" stroke-width="2" fill="none">
        <path d="M${BERM + 12},${H - 18} v6 h${PPY * 5} v-6"/>
      </g>
      <text x="${BERM + 12 + PPY * 2.5}" y="${H - 21}" text-anchor="middle" font-family="sans-serif" font-size="9" font-weight="700" fill="rgba(60,40,10,.7)">5 yd</text>`;
  }

  function svg(objects, opts) {
    opts = opts || {};
    return `<svg class="bay${opts.className ? ' ' + opts.className : ''}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Overhead view of the stage">
      ${background()}<g class="layer">${render(objects || [], opts)}</g></svg>`;
  }

  function icon(type) {
    const sample = { type, x: 0, y: 0, rot: 0, len: 26, w: 22, h: 22, points: [{ x: -11, y: 9 }, { x: -2, y: -8 }, { x: 11, y: -2 }] };
    return `<svg viewBox="-16 -16 32 32" width="30" height="30" aria-hidden="true"><rect x="-16" y="-16" width="32" height="32" rx="6" fill="#c9ad84"/>${shape(sample)}</svg>`;
  }

  function rounds(objects) {
    return (objects || []).filter(o => o.type === 'target' || o.type === 'steel')
      .reduce((sum, o) => sum + (parseInt(o.shots, 10) || 0), 0);
  }

  window.Stage = { W, H, PPY, TYPES, ARROW_COLORS, BOX_KINDS, boxKind, create, createArrow, draft, render, background, svg, icon, rounds };
})();

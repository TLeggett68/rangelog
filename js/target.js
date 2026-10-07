/*
 * Silhouette target (USPSA-style shape). Coordinates are in a 180 x 300 box
 * (roughly 10 units per inch). Shot marks are stored as { x, y } in that space.
 */
(function () {
  'use strict';

  const W = 180, H = 300, PAD = 12;
  const OUTLINE = 'M70,0 L110,0 L120,10 L120,60 L150,60 L180,90 L180,270 L150,300 L30,300 L0,270 L0,90 L30,60 L60,60 L60,10 Z';
  const C_ZONE = 'M50,80 L130,80 L150,100 L150,230 L130,250 L50,250 L30,230 L30,100 Z';
  const INK = '#7a5a30';

  function svg(marks, opts) {
    marks = marks || [];
    opts = opts || {};
    const cls = ['target-svg', opts.editable ? 'editable' : '', opts.mini ? 'mini' : ''].join(' ').trim();
    const markSvg = marks.map((m, i) => `
      <g class="mark" data-i="${i}" transform="translate(${m.x},${m.y})">
        <circle r="11" fill="transparent"/>
        <path d="M-7,-7 L7,7 M7,-7 L-7,7" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/>
        <path d="M-7,-7 L7,7 M7,-7 L-7,7" stroke="#c62828" stroke-width="3.5" stroke-linecap="round"/>
        ${opts.numbers ? `<text x="9" y="-6" class="mark-num">${i + 1}</text>` : ''}
      </g>`).join('');

    return `<svg class="${cls}" viewBox="${-PAD} ${-PAD} ${W + PAD * 2} ${H + PAD * 2}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Silhouette target with ${marks.length} shot marks">
      <path d="${OUTLINE}" fill="#dcbd8e" stroke="${INK}" stroke-width="2"/>
      <path d="${C_ZONE}" fill="none" stroke="${INK}" stroke-width="1.5"/>
      <rect x="60" y="95" width="60" height="110" fill="none" stroke="${INK}" stroke-width="1.5"/>
      <rect x="70" y="15" width="40" height="22" fill="none" stroke="${INK}" stroke-width="1.5"/>
      ${opts.mini ? '' : `<g font-size="10" fill="${INK}" font-family="sans-serif" font-weight="700" opacity=".75">
        <text x="64" y="107">A</text><text x="74" y="30">A</text><text x="64" y="54">B</text>
        <text x="34" y="113">C</text><text x="5" y="104">D</text></g>`}
      ${markSvg}
    </svg>`;
  }

  window.Target = { W, H, PAD, svg };
})();

(function () {
  'use strict';

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const app = $('#app');
  const NAME_KEY = 'rangelog-shooter';

  let pageRefresh = null;  // re-renders the live parts of the current page when data changes
  let pageCleanup = null;  // removes page-specific listeners on navigation
  let editorDirty = false;
  let currentHash = location.hash;
  let ignoreNextHash = false;
  const canHover = window.matchMedia && matchMedia('(hover: hover)').matches; // desktop, not a phone

  /* =========================================================
   * Helpers
   * ======================================================= */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function today() { return iso(new Date()); }
  function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function shiftDate(s, n) { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); }
  function fmtDate(s, long) {
    return parseISO(s).toLocaleDateString(undefined, long
      ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtShort(s) {
    const d = parseISO(s);
    const opts = d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: '2-digit' };
    return d.toLocaleDateString(undefined, opts);
  }
  function fmtTime(t) { return (Math.round(Number(t) * 100) / 100).toFixed(2); }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function vsPar(time, par) {
    if (!par) return '<span class="muted">—</span>';
    const diff = time - par;
    return `<span class="vs ${diff <= 0 ? 'under' : 'over'}">${diff <= 0 ? '−' : '+'}${fmtTime(Math.abs(diff))}</span>`;
  }
  function medal(i) { return ['🥇', '🥈', '🥉'][i] || String(i + 1); }
  function getShooter() { try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; } }
  function setShooter(n) { try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* ignore */ } }
  function shooterKey(n) { return String(n || '').trim().toLowerCase(); }
  function knownShooters() {
    const m = new Map();
    Store.all('times').forEach(t => { const k = shooterKey(t.shooter); if (k && !m.has(k)) m.set(k, t.shooter.trim()); });
    return [...m.values()].sort((a, b) => a.localeCompare(b));
  }
  function members() { return Store.all('members').sort((a, b) => a.name.localeCompare(b.name)); }
  function fmtSec(v) { return String(Math.round(Number(v) * 100) / 100); }
  function penaltyTypes(kind) { return Store.PENALTIES.filter(p => kind === 'stage' || !p.stageOnly); }
  // "1.81 raw + 1C 1M" for runs that had penalties, '' otherwise.
  function penSummary(r) {
    const pen = r.pen || {};
    const parts = Store.PENALTIES.filter(p => pen[p.key] > 0).map(p => pen[p.key] + p.short);
    return parts.length ? `${fmtTime(r.raw)} raw + ${parts.join(' ')}` : '';
  }
  function timeCell(r) {
    const s = penSummary(r);
    return `<span class="strong">${fmtTime(r.time)}</span>${s ? `<span class="pen-note">${esc(s)}</span>` : ''}`;
  }
  function svgPoint(svg, e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2600);
  }
  function emptyState(icon, title, text, actions) {
    return `<div class="card empty"><div class="empty-icon">${icon}</div><h2>${title}</h2><p>${text}</p><div class="actions center">${actions}</div></div>`;
  }
  function notFound(what, back) {
    app.innerHTML = emptyState('🤷', `${what} not found`, 'It may have been deleted.', `<a class="btn" href="${back}">Go back</a>`);
    // If the data shows up a moment later (e.g. still syncing), show the real page.
    pageRefresh = router;
  }
  function itemFor(kind, id) { return Store.get(kind === 'drill' ? 'drills' : 'stages', id); }
  function runsFor(kind, id) { return Store.all('times').filter(t => t.kind === kind && t.itemId === id); }

  // Each shooter's best run, fastest first.
  function rankRuns(runs) {
    const by = new Map();
    runs.forEach(r => {
      const k = shooterKey(r.shooter);
      const cur = by.get(k);
      if (!cur) by.set(k, { shooter: r.shooter.trim(), best: r, attempts: 1 });
      else { cur.attempts++; if (r.time < cur.best.time) cur.best = r; }
    });
    return [...by.values()].sort((a, b) => a.best.time - b.best.time);
  }

  /* =========================================================
   * Shared pieces: record-a-time form and run history
   * ======================================================= */
  function shooterFieldHTML() {
    const list = members();
    const saved = shooterKey(getShooter());
    if (!list.length) {
      return `<label>Shooter <input name="guest" required maxlength="60" value="${esc(getShooter())}" placeholder="Name"></label>
        <p class="hint">Tip: <a href="#/members">add members</a> to pick names from a list.</p>`;
    }
    const match = list.find(m => shooterKey(m.name) === saved);
    return `<label>Shooter <select name="member" required>
        <option value="">Select a member…</option>
        ${list.map(m => `<option value="${esc(m.id)}"${match && match.id === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}
        <option value="__guest">Guest / not listed…</option>
      </select></label>
      <label class="guest-field" hidden>Guest name <input name="guest" maxlength="60" placeholder="Name"></label>`;
  }

  function recordFormHTML(kind) {
    const pens = Store.settings().penalties;
    const types = penaltyTypes(kind).filter(p => pens[p.key] > 0);
    return `<form class="card record-form" id="record-form" autocomplete="off">
      <h3>⏱ Record a time</h3>
      <div class="form-row">
        <div>${shooterFieldHTML()}</div>
        <label>Raw time (seconds) <input name="time" class="big-input" type="number" step="0.01" min="0.01" max="3599" inputmode="decimal" enterkeyhint="done" required placeholder="0.00"></label>
      </div>
      ${types.length ? `<fieldset class="pen-grid"><legend>Penalties <a class="small" href="#/settings">edit values</a></legend>
        ${types.map(p => `<div class="pen">
          <span class="pen-label">${p.label}<small>+${fmtSec(pens[p.key])}s each</small></span>
          <span class="stepper">
            <button type="button" class="step" data-pen-step="-1" aria-label="One fewer">−</button>
            <input name="pen-${p.key}" type="number" min="0" max="99" step="1" value="0" inputmode="numeric" aria-label="${p.label}">
            <button type="button" class="step" data-pen-step="1" aria-label="One more">+</button>
          </span>
        </div>`).join('')}
      </fieldset>` : ''}
      <div class="form-row">
        <label>Date <input name="date" type="date" required value="${today()}"></label>
        <label>Notes <input name="notes" maxlength="200" placeholder="Optional"></label>
      </div>
      <div class="final-line" id="final-line"></div>
      <button class="btn primary block" type="submit">Save time</button>
    </form>`;
  }

  function bindRecordForm(kind, getItem) {
    const form = $('#record-form');
    const f = form.elements;
    const sel = f.member;

    function calc() {
      const pens = Store.settings().penalties;
      const raw = num(f.time.value);
      const pen = {};
      let penTime = 0;
      $$('input[name^="pen-"]', form).forEach(inp => {
        const k = inp.name.slice(4);
        const n = Math.max(0, parseInt(inp.value, 10) || 0);
        if (n) { pen[k] = n; penTime += n * (pens[k] || 0); }
      });
      penTime = round2(penTime);
      return { raw, pen, penTime, final: raw ? round2(raw + penTime) : null };
    }
    function showFinal() {
      const c = calc();
      const el = $('#final-line');
      if (!c.raw) { el.innerHTML = c.penTime ? `Penalties: <strong>+${fmtTime(c.penTime)}s</strong>` : ''; return; }
      el.innerHTML = `Final time: <strong>${fmtTime(c.final)}s</strong>${c.penTime ? ` <span class="muted">(${fmtTime(c.raw)} raw + ${fmtTime(c.penTime)} penalties)</span>` : ''}`;
    }

    form.addEventListener('click', e => {
      const b = e.target.closest('[data-pen-step]');
      if (!b) return;
      const inp = b.parentElement.querySelector('input');
      inp.value = Math.max(0, Math.min(99, (parseInt(inp.value, 10) || 0) + parseInt(b.dataset.penStep, 10)));
      showFinal();
    });
    form.addEventListener('input', showFinal);
    if (sel) sel.addEventListener('change', () => {
      const guest = sel.value === '__guest';
      $('.guest-field', form).hidden = !guest;
      f.guest.required = guest;
      if (guest) f.guest.focus();
    });

    form.addEventListener('submit', e => {
      e.preventDefault();
      const item = getItem();
      let shooter, memberId = null;
      if (sel && sel.value !== '__guest') {
        const m = Store.get('members', sel.value);
        if (!m) return;
        shooter = m.name;
        memberId = m.id;
      } else {
        shooter = f.guest.value.trim();
      }
      const c = calc();
      if (!item || !shooter || !c.raw || c.raw <= 0) return;
      setShooter(shooter);
      const par = kind === 'drill' ? num(item.par) : null;
      Store.add('times', {
        kind, itemId: item.id, itemName: item.name, par, shooter, memberId,
        raw: round2(c.raw), pen: c.pen, penTime: c.penTime, time: c.final,
        date: f.date.value || today(), notes: f.notes.value.trim(),
      });
      f.time.value = '';
      f.notes.value = '';
      $$('input[name^="pen-"]', form).forEach(inp => { inp.value = 0; });
      showFinal();
      const pens = c.penTime ? ` incl. +${fmtTime(c.penTime)} penalties` : '';
      if (par) toast(c.final <= par ? `${fmtTime(c.final)}s${pens} — under par! 🎯` : `${fmtTime(c.final)}s${pens} (+${fmtTime(c.final - par)} over par)`);
      else toast(`${fmtTime(c.final)}s saved${pens}`);
    });
  }

  function historyHTML(kind, id, par) {
    const runs = runsFor(kind, id);
    if (!runs.length) {
      return `<div class="card"><h3>Times</h3><p class="muted">No times recorded yet. Be the first!</p></div>`;
    }
    const ranked = rankRuns(runs).slice(0, 10);
    const recent = runs.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
    const parCol = par ? '<th class="num">vs Par</th>' : '';
    return `<div class="two-col even">
      <div class="card">
        <h3>🏆 All-time leaderboard</h3>
        <p class="muted small">Each shooter's best run</p>
        <table class="table"><thead><tr><th></th><th>Shooter</th><th class="num">Time</th>${parCol}<th>Date</th></tr></thead><tbody>
        ${ranked.map((r, i) => `<tr>
          <td class="rank">${medal(i)}</td><td>${shooterLink(r.shooter, r.best.memberId)}</td>
          <td class="num">${timeCell(r.best)}</td>
          ${par ? `<td class="num">${vsPar(r.best.time, par)}</td>` : ''}
          <td><a href="#/day/${r.best.date}">${fmtShort(r.best.date)}</a></td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card">
        <h3>All runs <span class="count">${runs.length}</span></h3>
        <div class="scroll"><table class="table"><thead><tr><th>Date</th><th>Shooter</th><th class="num">Time</th>${parCol}<th></th></tr></thead><tbody>
        ${recent.map(r => `<tr>
          <td><a href="#/day/${r.date}">${fmtShort(r.date)}</a></td><td>${shooterLink(r.shooter, r.memberId)}${r.notes ? `<span class="sub">${esc(r.notes)}</span>` : ''}</td>
          <td class="num">${timeCell(r)}</td>
          ${par ? `<td class="num">${vsPar(r.time, par)}</td>` : ''}
          <td><button class="icon-btn" data-del-time="${esc(r.id)}" title="Delete this run" aria-label="Delete this run">×</button></td></tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>`;
  }

  /* =========================================================
   * Day view
   * ======================================================= */
  function renderDay(m) {
    const date = (m && m[1]) || today();
    const render = () => {
      const all = Store.all('times');
      const runs = all.filter(t => t.date === date);
      const dates = [...new Set(all.map(t => t.date))].sort().reverse();

      const groups = new Map();
      runs.forEach(r => {
        const k = r.kind + ':' + r.itemId;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      const results = [...groups.values()].map(list => {
        const r0 = list[0];
        const item = itemFor(r0.kind, r0.itemId);
        return {
          kind: r0.kind, id: r0.itemId, exists: !!item,
          name: item ? item.name : r0.itemName,
          par: r0.kind === 'drill' ? num(item ? item.par : r0.par) : null,
          ranked: rankRuns(list), count: list.length,
        };
      }).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'drill' ? -1 : 1) || a.name.localeCompare(b.name));

      const wins = new Map();
      results.forEach(g => {
        const w = g.ranked[0];
        const k = shooterKey(w.shooter);
        const cur = wins.get(k) || { name: w.shooter, wins: 0 };
        cur.wins++;
        wins.set(k, cur);
      });
      const maxWins = Math.max(0, ...[...wins.values()].map(w => w.wins));
      const leaders = [...wins.values()].filter(w => w.wins === maxWins).map(w => w.name);
      const shooters = new Set(runs.map(r => shooterKey(r.shooter)));

      app.innerHTML = `
        <div class="page-head day-head">
          <div><p class="eyebrow">Day View</p><h1>${fmtDate(date, true)}</h1></div>
          <div class="day-nav">
            <a class="btn icon" href="#/day/${shiftDate(date, -1)}" aria-label="Previous day">‹</a>
            <input type="date" id="day-pick" value="${date}" aria-label="Pick a date">
            <a class="btn icon" href="#/day/${shiftDate(date, 1)}" aria-label="Next day">›</a>
            ${date !== today() ? '<a class="btn" href="#/">Today</a>' : ''}
          </div>
        </div>
        ${dates.length ? `<div class="chips"><span class="muted small">Range days:</span>${dates.slice(0, 12).map(d =>
          `<a class="chip${d === date ? ' active' : ''}" href="#/day/${d}">${fmtDate(d)}</a>`).join('')}</div>` : ''}
        ${runs.length ? `
          <div class="stats-row">
            <div class="stat-card"><span class="value">${shooters.size}</span><span class="label">Shooters</span></div>
            <div class="stat-card"><span class="value">${runs.length}</span><span class="label">Runs</span></div>
            <div class="stat-card"><span class="value">${results.length}</span><span class="label">Drills &amp; stages</span></div>
            <div class="stat-card gold"><span class="value">🏆 ${esc(leaders.join(' & '))}</span><span class="label">Most wins today (${maxWins})</span></div>
          </div>
          <h2 class="section-title">Fastest of the day</h2>
          <div class="grid winners">${results.map(winnerCard).join('')}</div>
          <h2 class="section-title">Full results</h2>
          <div class="grid results">${results.map(resultCard).join('')}</div>`
        : emptyState('⏱', `No times recorded ${date === today() ? 'yet today' : 'on this day'}`,
          'Open a drill or stage and record a time — it will show up here.',
          '<a class="btn primary" href="#/drills">Go to drills</a><a class="btn" href="#/stages">Go to stages</a>')}`;

      $('#day-pick').addEventListener('change', e => { if (e.target.value) location.hash = '#/day/' + e.target.value; });
    };
    render();
    pageRefresh = render;
  }

  function winnerCard(g) {
    const w = g.ranked[0];
    const tag = g.exists ? 'a' : 'div';
    const href = g.exists ? ` href="#/${g.kind}s/${esc(g.id)}"` : '';
    return `<${tag} class="card winner-card"${href}>
      <span class="kind ${g.kind}">${g.kind === 'drill' ? 'Drill' : 'Stage'}</span>
      <h3>${esc(g.name)}</h3>
      <div class="winner">
        <span class="trophy">🏆</span>
        <div><div class="who">${esc(w.shooter)}</div><div class="time">${fmtTime(w.best.time)}<small>s</small></div>${w.best.penTime ? `<div class="pen-note">incl. +${fmtTime(w.best.penTime)} penalties</div>` : ''}</div>
      </div>
      ${g.par ? `<div class="par-line">Par ${fmtTime(g.par)}s · ${vsPar(w.best.time, g.par)}</div>` : `<div class="par-line">${g.ranked.length} shooter${g.ranked.length === 1 ? '' : 's'}</div>`}
    </${tag}>`;
  }

  function resultCard(g) {
    return `<div class="card">
      <div class="result-head">
        <h3>${g.exists ? `<a href="#/${g.kind}s/${esc(g.id)}">${esc(g.name)}</a>` : esc(g.name)}</h3>
        <span class="kind ${g.kind}">${g.kind === 'drill' ? 'Drill' : 'Stage'}</span>
      </div>
      ${g.par ? `<p class="muted small">Par ${fmtTime(g.par)}s</p>` : ''}
      <table class="table"><thead><tr><th></th><th>Shooter</th><th class="num">Best</th>${g.par ? '<th class="num">vs Par</th>' : ''}<th class="num">Runs</th></tr></thead><tbody>
      ${g.ranked.map((r, i) => `<tr${i === 0 ? ' class="first"' : ''}>
        <td class="rank">${medal(i)}</td><td>${shooterLink(r.shooter, r.best.memberId)}</td>
        <td class="num">${timeCell(r.best)}</td>
        ${g.par ? `<td class="num">${vsPar(r.best.time, g.par)}</td>` : ''}
        <td class="num muted">${r.attempts}</td></tr>`).join('')}
      </tbody></table>
    </div>`;
  }

  /* =========================================================
   * Drills
   * ======================================================= */
  /*
   * A drill can have several targets (T1, T2, …) for transition drills. Marks are one list in
   * shot order; each mark's `t` is its target (0 = T1). Older drills have no `t` / targetCount
   * and are simply one-target drills.
   */
  const MAX_TARGETS = 6;
  function targetCount(d) {
    return Math.max(1, parseInt(d.targetCount, 10) || 1, ...(d.marks || []).map(mk => (mk.t || 0) + 1));
  }
  function targetsHTML(d, opts) {
    opts = opts || {};
    const n = targetCount(d);
    const marks = (d.marks || []).map((mk, i) => Object.assign({}, mk, { i }));
    let html = '';
    for (let t = 0; t < n; t++) {
      const mine = marks.filter(mk => (mk.t || 0) === t);
      const caption = opts.mini || (n === 1 && !opts.editable) ? '' : `<figcaption>
        <span class="tgt-label">T${t + 1}</span><small>${mine.length} shot${mine.length === 1 ? '' : 's'}</small>
        ${opts.editable && n > 1 ? `<button type="button" class="icon-btn" data-remove-target="${t}" title="Remove T${t + 1}" aria-label="Remove target T${t + 1}">×</button>` : ''}
      </figcaption>`;
      html += `<figure class="tgt" data-t="${t}">${caption}${Target.svg(mine, opts)}</figure>`;
    }
    return `<div class="targets${n > 1 ? ' multi' : ''}" style="--cols:${n};--cols-sm:${Math.min(n, 3)}">${html}</div>`;
  }

  function renderDrillList() {
    const render = () => {
      const drills = Store.all('drills').sort((a, b) => a.name.localeCompare(b.name));
      app.innerHTML = `
        <div class="page-head"><div><p class="eyebrow">Drills</p><h1>Drills &amp; par times</h1></div><a class="btn primary" href="#/drills/new">+ New drill</a></div>
        ${drills.length ? `<div class="grid items">${drills.map(d => {
          const best = rankRuns(runsFor('drill', d.id))[0];
          return `<a class="card item-card" href="#/drills/${esc(d.id)}">
            <div class="thumb target-thumb${targetCount(d) > 1 ? ' multi' : ''}">${targetsHTML(d, { mini: true })}</div>
            <div class="item-body">
              <h3>${esc(d.name)}</h3>
              <div class="meta"><span class="pill">Par ${fmtTime(d.par)}s</span>${d.distance ? `<span>${esc(d.distance)} yd</span>` : ''}<span>${esc(d.rounds || (d.marks || []).length)} rds</span>${targetCount(d) > 1 ? `<span>${targetCount(d)} targets</span>` : ''}</div>
              <div class="best">${best ? `🏆 ${fmtTime(best.best.time)}s — ${esc(best.shooter)}` : '<span class="muted">No times yet</span>'}</div>
            </div>
          </a>`;
        }).join('')}</div>`
        : emptyState('🎯', 'No drills yet', 'Create a drill with a par time, instructions and shot placement.', '<a class="btn primary" href="#/drills/new">Create a drill</a>')}`;
    };
    render();
    pageRefresh = render;
  }

  function renderDrillView(m) {
    const id = m[1];
    const d = Store.get('drills', id);
    if (!d) return notFound('Drill', '#/drills');
    const rounds = d.rounds || (d.marks || []).length;
    const multi = targetCount(d) > 1;
    const details = `
          <div class="stats-row tight">
            <div class="stat-card accent"><span class="value">${fmtTime(d.par)}<small>s</small></span><span class="label">Par time</span></div>
            <div class="stat-card"><span class="value">${rounds || '—'}</span><span class="label">Rounds</span></div>
            <div class="stat-card"><span class="value">${d.distance ? esc(d.distance) + '<small>yd</small>' : '—'}</span><span class="label">Distance</span></div>
          </div>
          <div class="card"><h3>Instructions</h3><div class="instructions">${d.instructions ? nl2br(d.instructions) : '<em class="muted">No instructions.</em>'}</div></div>`;
    app.innerHTML = `
      <a class="back" href="#/drills">← All drills</a>
      <div class="page-head">
        <div><p class="eyebrow">Drill</p><h1>${esc(d.name)}</h1></div>
        <div class="actions"><button class="btn primary mobile-only" type="button" data-jump-record>⏱ Record time</button><a class="btn" href="#/drills/${esc(id)}/edit">Edit</a><button class="btn danger-outline" id="del-item">Delete</button></div>
      </div>
      ${multi ? `
      <div class="card target-card multi">${targetsHTML(d, { numbers: true })}
        <p class="hint center">Numbers show the shot order across targets.</p></div>
      <div class="two-col even">
        <div class="stack">${details}</div>
        ${recordFormHTML('drill')}
      </div>` : `
      <div class="two-col">
        <div class="card target-card">${targetsHTML(d, { numbers: true })}</div>
        <div class="stack">${details}
          ${recordFormHTML('drill')}
        </div>
      </div>`}
      <div id="times-section"></div>`;

    bindRecordForm('drill', () => Store.get('drills', id));
    $('#del-item').addEventListener('click', () => {
      if (confirm(`Delete the drill "${d.name}"? Recorded times will stay in the day view.`)) {
        Store.remove('drills', id);
        location.hash = '#/drills';
      }
    });
    const refresh = () => {
      const cur = Store.get('drills', id);
      if (!cur) { location.hash = '#/drills'; return; }
      $('#times-section').innerHTML = historyHTML('drill', id, num(cur.par));
    };
    refresh();
    pageRefresh = refresh;
  }

  function renderDrillEditor(m) {
    const id = m && m[1];
    const existing = id ? Store.get('drills', id) : null;
    if (id && !existing) return notFound('Drill', '#/drills');
    const d = existing ? JSON.parse(JSON.stringify(existing)) : { name: '', par: '', distance: '', rounds: '', instructions: '', marks: [] };
    d.marks = d.marks || [];
    d.targetCount = targetCount(d);
    let roundsTouched = !!existing && num(existing.rounds) !== null && num(existing.rounds) !== d.marks.length;
    const back = existing ? '#/drills/' + id : '#/drills';

    app.innerHTML = `
      <a class="back" href="${back}">← ${existing ? 'Back to drill' : 'All drills'}</a>
      <div class="page-head"><div><p class="eyebrow">Drill</p><h1>${existing ? 'Edit drill' : 'New drill'}</h1></div></div>
      <form id="drill-form" class="two-col" autocomplete="off">
        <div class="stack">
          <div class="card">
            <label>Drill name <input name="name" required maxlength="80" value="${esc(d.name)}" placeholder="e.g. Bill Drill"></label>
            <div class="form-row three">
              <label>Par time (sec) <input name="par" type="number" step="0.01" min="0.01" required inputmode="decimal" value="${esc(d.par)}" placeholder="2.50"></label>
              <label>Distance (yd) <input name="distance" type="number" step="1" min="0" inputmode="numeric" value="${esc(d.distance == null ? '' : d.distance)}" placeholder="7"></label>
              <label>Rounds <input name="rounds" type="number" step="1" min="0" inputmode="numeric" value="${esc(d.rounds == null ? '' : d.rounds)}"></label>
            </div>
            <label>Instructions <textarea name="instructions" rows="9" placeholder="Start position, string of fire, transitions, reloads, scoring…">${esc(d.instructions)}</textarea></label>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn primary">${existing ? 'Save changes' : 'Create drill'}</button>
            <a class="btn" href="${back}">Cancel</a>
          </div>
        </div>
        <div class="card target-editor">
          <div class="row-between"><h3>Shot placement</h3><span class="pill" id="mark-count"></span></div>
          <p class="hint">Tap a target to place an <b>X</b>; tap an X to remove it. Shots are numbered in the order you place them, so for a transition drill tap them in the order they should be fired.</p>
          <div id="target-area"></div>
          <div class="actions">
            <button type="button" class="btn sm" id="add-target">+ Add target</button>
            <button type="button" class="btn sm" id="undo-mark">↶ Undo</button>
            <button type="button" class="btn sm" id="clear-marks">Clear all</button>
          </div>
        </div>
      </form>`;

    const form = $('#drill-form');
    const f = form.elements;
    const area = $('#target-area');

    function drawTarget() {
      area.innerHTML = targetsHTML(d, { numbers: true, editable: true });
      area.classList.toggle('multi', d.targetCount > 1);
      $('#mark-count').textContent = `${d.marks.length} shot${d.marks.length === 1 ? '' : 's'} marked`;
      $('#add-target').disabled = d.targetCount >= MAX_TARGETS;
      if (!roundsTouched) f.rounds.value = d.marks.length || '';
    }
    area.addEventListener('click', e => {
      const removeBtn = e.target.closest('[data-remove-target]');
      if (removeBtn) {
        const t = +removeBtn.dataset.removeTarget;
        const shots = d.marks.filter(mk => (mk.t || 0) === t).length;
        if (shots && !confirm(`Remove T${t + 1} and its ${shots} shot${shots === 1 ? '' : 's'}?`)) return;
        d.marks = d.marks.filter(mk => (mk.t || 0) !== t).map(mk => ((mk.t || 0) > t ? Object.assign({}, mk, { t: mk.t - 1 }) : mk));
        d.targetCount--;
      } else {
        const fig = e.target.closest('.tgt');
        const svg = fig && e.target.closest('svg');
        if (!svg) return;
        const mark = e.target.closest('.mark');
        if (mark) {
          d.marks.splice(+mark.dataset.i, 1);
        } else {
          const p = svgPoint(svg, e);
          if (p.x < -Target.PAD || p.y < -Target.PAD || p.x > Target.W + Target.PAD || p.y > Target.H + Target.PAD) return;
          const mk = { x: Math.round(p.x), y: Math.round(p.y) };
          if (+fig.dataset.t > 0) mk.t = +fig.dataset.t;
          d.marks.push(mk);
        }
      }
      editorDirty = true;
      drawTarget();
    });
    $('#add-target').addEventListener('click', () => {
      if (d.targetCount >= MAX_TARGETS) return;
      d.targetCount++;
      editorDirty = true;
      drawTarget();
    });
    $('#undo-mark').addEventListener('click', () => { d.marks.pop(); editorDirty = true; drawTarget(); });
    $('#clear-marks').addEventListener('click', () => {
      if (d.marks.length && confirm('Remove all shot marks?')) { d.marks = []; editorDirty = true; drawTarget(); }
    });
    form.addEventListener('input', e => {
      editorDirty = true;
      if (e.target.name === 'rounds') roundsTouched = f.rounds.value !== '';
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const name = f.name.value.trim();
      const par = num(f.par.value);
      if (!name || !par || par <= 0) return;
      const data = {
        name,
        par: round2(par),
        distance: num(f.distance.value),
        rounds: parseInt(f.rounds.value, 10) || d.marks.length,
        instructions: f.instructions.value.trim(),
        marks: d.marks,
        targetCount: d.targetCount,
      };
      let newId = id;
      if (existing) Store.update('drills', id, data);
      else newId = Store.add('drills', data);
      editorDirty = false;
      toast(existing ? 'Drill saved' : 'Drill created');
      location.hash = '#/drills/' + newId;
    });
    drawTarget();
  }

  /* =========================================================
   * Stages
   * ======================================================= */
  function renderStageList() {
    const render = () => {
      const stages = Store.all('stages').sort((a, b) => a.name.localeCompare(b.name));
      app.innerHTML = `
        <div class="page-head"><div><p class="eyebrow">Stages</p><h1>Stages</h1></div><a class="btn primary" href="#/stages/new">+ New stage</a></div>
        ${stages.length ? `<div class="grid items wide">${stages.map(s => {
          const objs = s.objects || [];
          const best = rankRuns(runsFor('stage', s.id))[0];
          const targets = objs.filter(o => o.type === 'target' || o.type === 'steel').length;
          return `<a class="card item-card stage-card" href="#/stages/${esc(s.id)}">
            <div class="thumb">${Stage.svg(objs)}</div>
            <div class="item-body">
              <h3>${esc(s.name)}</h3>
              <div class="meta"><span class="pill">${Stage.rounds(objs)} rds min</span><span>${targets} target${targets === 1 ? '' : 's'}</span></div>
              <div class="best">${best ? `🏆 ${fmtTime(best.best.time)}s — ${esc(best.shooter)}` : '<span class="muted">No times yet</span>'}</div>
            </div>
          </a>`;
        }).join('')}</div>`
        : emptyState('🛢️', 'No stages yet', 'Lay out a course of fire with targets, barrels, walls and shooting boxes.', '<a class="btn primary" href="#/stages/new">Create a stage</a>')}`;
    };
    render();
    pageRefresh = render;
  }

  function renderStageView(m) {
    const id = m[1];
    const s = Store.get('stages', id);
    if (!s) return notFound('Stage', '#/stages');
    const objs = s.objects || [];
    const naturally = (a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true });
    const shootable = objs.filter(o => o.type === 'target' || o.type === 'steel').sort(naturally);
    const boxes = objs.filter(o => o.type === 'box').sort(naturally);
    const noShoots = objs.filter(o => o.type === 'noshoot').length;
    let hi = null;

    app.innerHTML = `
      <a class="back" href="#/stages">← All stages</a>
      <div class="page-head">
        <div><p class="eyebrow">Stage</p><h1>${esc(s.name)}</h1></div>
        <div class="actions"><button class="btn primary mobile-only" type="button" data-jump-record>⏱ Record time</button><a class="btn" href="#/stages/${esc(id)}/edit">Edit</a><button class="btn danger-outline" id="del-item">Delete</button></div>
      </div>
      <div class="stage-layout">
        <div class="stack">
          <div class="card bay-card" id="stage-map">${Stage.svg(objs, { className: 'clickable' })}</div>
          <div class="callout" id="obj-note"><span class="muted">Tap a target or route arrow on the map to see its instructions.</span></div>
        </div>
        <div class="stack">
          <div class="stats-row tight">
            <div class="stat-card accent"><span class="value">${Stage.rounds(objs)}</span><span class="label">Min rounds</span></div>
            <div class="stat-card"><span class="value">${shootable.length}</span><span class="label">Targets</span></div>
            <div class="stat-card"><span class="value">${noShoots}</span><span class="label">No-shoots</span></div>
          </div>
          <div class="card"><h3>Stage procedure</h3><div class="instructions">${s.description ? nl2br(s.description) : '<em class="muted">No procedure written.</em>'}</div></div>
          ${shootable.length ? `<div class="card"><h3>Targets</h3>
            <table class="table target-table" id="target-table"><thead><tr><th>Target</th><th class="num">Shots</th><th>Where to shoot</th></tr></thead><tbody>
            ${shootable.map(o => `<tr data-id="${esc(o.id)}"><td><span class="tag tag-${o.type}">${esc(o.label || Stage.TYPES[o.type].name)}</span></td><td class="num strong">${o.shots || 0}</td><td>${esc(o.note) || '<span class="muted">—</span>'}</td></tr>`).join('')}
            </tbody></table></div>` : ''}
          ${boxes.some(b => b.note) ? `<div class="card"><h3>Shooting positions</h3><ul class="plain">
            ${boxes.filter(b => b.note).map(b => `<li><span class="tag tag-box">Box ${esc(b.label)}</span> ${esc(b.note)}</li>`).join('')}</ul></div>` : ''}
          ${recordFormHTML('stage')}
        </div>
      </div>
      <div id="times-section"></div>`;

    function drawMap() {
      $('#stage-map .layer').innerHTML = Stage.render(objs, { highlightId: hi });
      $$('#target-table tr[data-id]').forEach(tr => tr.classList.toggle('hl', tr.dataset.id === hi));
      const o = objs.find(x => x.id === hi);
      const note = $('#obj-note');
      if (!o) { note.innerHTML = '<span class="muted">Tap a target or route arrow on the map to see its instructions.</span>'; return; }
      const t = Stage.TYPES[o.type];
      note.innerHTML = `<strong>${esc(o.type === 'box' ? 'Box ' + o.label : (o.label || t.name))}</strong>
        ${o.shots ? `<span class="pill">${o.shots} shot${o.shots == 1 ? '' : 's'}</span>` : ''}
        ${o.type === 'noshoot' ? '<span class="pill danger">Do not shoot</span>' : ''}
        <span>${esc(o.note) || (o.type === 'barrel' || o.type === 'wall' ? t.name : '')}</span>`;
    }
    $('#stage-map').addEventListener('click', e => {
      const g = e.target.closest('.obj');
      hi = g && g.dataset.id !== hi ? g.dataset.id : null;
      drawMap();
    });
    const table = $('#target-table');
    if (table) table.addEventListener('click', e => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      hi = tr.dataset.id === hi ? null : tr.dataset.id;
      drawMap();
      $('#stage-map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    bindRecordForm('stage', () => Store.get('stages', id));
    $('#del-item').addEventListener('click', () => {
      if (confirm(`Delete the stage "${s.name}"? Recorded times will stay in the day view.`)) {
        Store.remove('stages', id);
        location.hash = '#/stages';
      }
    });
    const refresh = () => {
      if (!Store.get('stages', id)) { location.hash = '#/stages'; return; }
      $('#times-section').innerHTML = historyHTML('stage', id, null);
    };
    refresh();
    pageRefresh = refresh;
  }

  function renderStageEditor(m) {
    const id = m && m[1];
    const existing = id ? Store.get('stages', id) : null;
    if (id && !existing) return notFound('Stage', '#/stages');
    const s = existing ? JSON.parse(JSON.stringify(existing)) : { name: '', description: '', objects: [] };
    s.objects = s.objects || [];
    const back = existing ? '#/stages/' + id : '#/stages';
    let selId = null;
    let drag = null;
    let drawMode = false;   // "Draw route" tool is on
    let stroke = null;      // points of the arrow currently being drawn
    let arrowColor = Stage.ARROW_COLORS[0];
    const HINT = 'Drag objects to move them · tap one to edit it · on a keyboard, arrows nudge and Delete removes.';
    const DRAW_HINT = 'Press and drag on the map to draw a route arrow, ending where the shooter finishes. Draw as many as you need, then tap “Done drawing”.';

    app.innerHTML = `
      <a class="back" href="${back}">← ${existing ? 'Back to stage' : 'All stages'}</a>
      <div class="page-head"><div><p class="eyebrow">Stage</p><h1>${existing ? 'Edit stage' : 'New stage'}</h1></div></div>
      <form id="stage-form" class="card" autocomplete="off">
        <label>Stage name <input name="name" required maxlength="80" value="${esc(s.name)}" placeholder="e.g. Barrel Run"></label>
        <label>Stage procedure <textarea name="description" rows="4" placeholder="Start position, ready condition, what to engage from where…">${esc(s.description)}</textarea></label>
      </form>
      <div class="palette card">
        <span class="palette-title">Add:</span>
        ${Object.keys(Stage.TYPES).filter(k => !Stage.TYPES[k].drawn).map(k => `<button type="button" class="tool" data-add="${k}">${Stage.icon(k)}<span>${Stage.TYPES[k].name}</span></button>`).join('')}
        <button type="button" class="tool draw-tool" id="draw-route" aria-pressed="false">${Stage.icon('arrow')}<span>Draw route</span></button>
      </div>
      <div class="stage-editor">
        <div class="card bay-card">
          <svg id="bay" class="bay editing" viewBox="0 0 ${Stage.W} ${Stage.H}" xmlns="http://www.w3.org/2000/svg">${Stage.background()}<g id="layer"></g><g id="draft" pointer-events="none"></g></svg>
          <p class="hint" id="bay-hint">${HINT}</p>
        </div>
        <div class="card props" id="props"></div>
      </div>
      <div class="form-actions">
        <button type="submit" form="stage-form" class="btn primary">${existing ? 'Save changes' : 'Create stage'}</button>
        <a class="btn" href="${back}">Cancel</a>
        <span class="muted" id="round-count"></span>
      </div>`;

    const form = $('#stage-form');
    const svg = $('#bay');
    const find = oid => s.objects.find(o => o.id === oid);

    function drawLayer() {
      $('#layer').innerHTML = Stage.render(s.objects, { selectedId: selId });
      const r = Stage.rounds(s.objects);
      $('#round-count').textContent = `${r} round${r === 1 ? '' : 's'} minimum`;
    }
    function select(oid) {
      selId = oid;
      drawLayer();
      drawProps();
    }
    function changed() { editorDirty = true; drawLayer(); }

    function drawProps() {
      const p = $('#props');
      const o = find(selId);
      if (!o) {
        p.innerHTML = `<h3>Properties</h3><p class="muted">Add an object from the toolbar, then tap it on the map to edit it. Use <b>Draw route</b> to sketch movement arrows.</p>
          <ul class="legend">${Object.keys(Stage.TYPES).map(k => `<li>${Stage.icon(k)} ${Stage.TYPES[k].name}</li>`).join('')}</ul>`;
        return;
      }
      const t = Stage.TYPES[o.type];
      const yd = v => (v / Stage.PPY).toFixed(1) + ' yd';
      p.innerHTML = `
        <div class="row-between"><h3>${t.name}</h3><button type="button" class="icon-btn" id="desel" aria-label="Close">×</button></div>
        ${t.prefix && o.type !== 'noshoot' ? `<label>Label <input data-prop="label" maxlength="6" value="${esc(o.label)}"></label>` : ''}
        ${t.shots ? `<label>Shots <input data-prop="shots" type="number" min="0" max="50" inputmode="numeric" value="${o.shots == null ? '' : o.shots}"></label>` : ''}
        ${o.type === 'arrow' ? `<div class="field"><span class="field-label">Color</span>
          <span class="swatches">${Stage.ARROW_COLORS.map(c => `<button type="button" class="swatch${(o.color || Stage.ARROW_COLORS[0]) === c ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}</span></div>
          <label class="check"><input type="checkbox" id="arrow-dashed"${o.dashed ? ' checked' : ''}> Dashed line</label>
          <p><button type="button" class="btn sm" id="reverse-arrow">⇄ Reverse direction</button></p>` : ''}
        ${t.note ? `<label>${o.type === 'box' || o.type === 'arrow' ? 'Notes' : 'Where to shoot'} <textarea data-prop="note" rows="3" placeholder="${{ box: 'e.g. Start here, hands on head', arrow: 'e.g. Reload while moving to Box B' }[o.type] || 'e.g. 2 to the body, 1 to the head'}">${esc(o.note)}</textarea></label>` : ''}
        ${o.type === 'wall' ? `<label>Length <span class="range-row"><input data-prop="len" type="range" min="20" max="300" step="10" value="${o.len}"><span class="val">${yd(o.len)}</span></span></label>` : ''}
        ${o.type === 'box' ? `
          <label>Width <span class="range-row"><input data-prop="w" type="range" min="20" max="160" step="5" value="${o.w}"><span class="val">${yd(o.w)}</span></span></label>
          <label>Depth <span class="range-row"><input data-prop="h" type="range" min="20" max="160" step="5" value="${o.h}"><span class="val">${yd(o.h)}</span></span></label>` : ''}
        ${o.type !== 'barrel' && o.type !== 'arrow' ? `<label>Rotation
          <span class="range-row"><input data-prop="rot" type="range" min="0" max="359" step="1" value="${o.rot || 0}" aria-label="Rotation"></span>
          <span class="range-row">
            <button type="button" class="btn sm" data-rot="-15" aria-label="Rotate left 15 degrees">−15°</button>
            <input data-prop="rot" class="deg" type="number" min="0" max="359" step="1" inputmode="numeric" value="${o.rot || 0}" aria-label="Degrees">°
            <button type="button" class="btn sm" data-rot="15" aria-label="Rotate right 15 degrees">+15°</button>
          </span></label>` : ''}
        <div class="actions"><button type="button" class="btn sm" id="dup-obj">Duplicate</button><button type="button" class="btn sm danger-outline" id="del-obj">Delete</button></div>`;

      $$('[data-prop]', p).forEach(inp => inp.addEventListener('input', () => {
        const k = inp.dataset.prop;
        o[k] = inp.type === 'range' || inp.type === 'number' ? (parseInt(inp.value, 10) || 0) : inp.value;
        if (k === 'rot') o.rot = ((o.rot % 360) + 360) % 360;
        // keep the slider and the degree box in sync
        $$(`[data-prop="${k}"]`, p).forEach(other => { if (other !== inp) other.value = o[k]; });
        const val = inp.parentElement.querySelector('.val');
        if (val) val.textContent = yd(o[k]);
        changed();
      }));
      $$('[data-rot]', p).forEach(b => b.addEventListener('click', () => {
        o.rot = ((o.rot || 0) + parseInt(b.dataset.rot, 10) + 360) % 360;
        $$('[data-prop="rot"]', p).forEach(inp => { inp.value = o.rot; });
        changed();
      }));
      $$('[data-color]', p).forEach(b => b.addEventListener('click', () => {
        o.color = arrowColor = b.dataset.color;
        $$('[data-color]', p).forEach(x => x.classList.toggle('on', x === b));
        changed();
      }));
      if (o.type === 'arrow') {
        $('#arrow-dashed').addEventListener('change', e => { o.dashed = e.target.checked; changed(); });
        $('#reverse-arrow').addEventListener('click', () => { o.points.reverse(); changed(); });
      }
      $('#desel').addEventListener('click', () => select(null));
      $('#del-obj').addEventListener('click', removeSelected);
      $('#dup-obj').addEventListener('click', () => {
        const copy = Object.assign({}, o, Stage.create(o.type, s.objects), { rot: o.rot, note: o.note, shots: o.shots, len: o.len, w: o.w, h: o.h, points: o.points && o.points.map(pt => Object.assign({}, pt)) });
        copy.x = Math.min(Stage.W - 10, o.x + 25);
        copy.y = Math.min(Stage.H - 10, o.y + 10);
        s.objects.push(copy);
        editorDirty = true;
        select(copy.id);
      });
    }

    function removeSelected() {
      s.objects = s.objects.filter(o => o.id !== selId);
      editorDirty = true;
      select(null);
    }

    $$('[data-add]').forEach(b => b.addEventListener('click', () => {
      const o = Stage.create(b.dataset.add, s.objects);
      s.objects.push(o);
      editorDirty = true;
      select(o.id);
    }));

    function setDrawMode(on) {
      drawMode = on;
      stroke = null;
      $('#draft').innerHTML = '';
      svg.classList.toggle('drawing', on);
      const btn = $('#draw-route');
      btn.setAttribute('aria-pressed', String(on));
      $('span', btn).textContent = on ? 'Done drawing' : 'Draw route';
      $('#bay-hint').textContent = on ? DRAW_HINT : HINT;
    }
    $('#draw-route').addEventListener('click', () => setDrawMode(!drawMode));

    function finishStroke() {
      const arrow = stroke && Stage.createArrow(stroke, arrowColor);
      stroke = null;
      $('#draft').innerHTML = '';
      if (!arrow) return;
      s.objects.push(arrow);
      editorDirty = true;
      select(arrow.id);
    }

    const snap = v => Math.round(v / 5) * 5;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    svg.addEventListener('pointerdown', e => {
      if (drawMode) {
        const p = svgPoint(svg, e);
        stroke = [{ x: clamp(p.x, 0, Stage.W), y: clamp(p.y, 0, Stage.H) }];
        svg.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      const g = e.target.closest('.obj');
      if (!g) { if (selId) select(null); return; }
      const o = find(g.dataset.id);
      if (!o) return;
      if (selId !== o.id) select(o.id);
      const p = svgPoint(svg, e);
      drag = { o, dx: o.x - p.x, dy: o.y - p.y };
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    svg.addEventListener('pointermove', e => {
      if (stroke) {
        const p = svgPoint(svg, e);
        const pt = { x: clamp(p.x, 0, Stage.W), y: clamp(p.y, 0, Stage.H) };
        const last = stroke[stroke.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < 3) return;
        stroke.push(pt);
        $('#draft').innerHTML = Stage.draft(stroke, arrowColor);
        return;
      }
      if (!drag) return;
      const p = svgPoint(svg, e);
      const x = clamp(snap(p.x + drag.dx), 0, Stage.W);
      const y = clamp(snap(p.y + drag.dy), 0, Stage.H);
      if (x === drag.o.x && y === drag.o.y) return;
      drag.o.x = x;
      drag.o.y = y;
      changed();
    });
    const endDrag = () => { drag = null; if (stroke) finishStroke(); };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    const onKey = e => {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (e.key === 'Escape' && drawMode) { setDrawMode(false); return; }
      if (!selId) return;
      const o = find(selId);
      if (!o) return;
      const step = e.shiftKey ? 20 : 5;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
      else if (e.key === 'Escape') select(null);
      else if (moves[e.key]) {
        e.preventDefault();
        o.x = clamp(o.x + moves[e.key][0], 0, Stage.W);
        o.y = clamp(o.y + moves[e.key][1], 0, Stage.H);
        changed();
      }
    };
    document.addEventListener('keydown', onKey);
    pageCleanup = () => document.removeEventListener('keydown', onKey);

    form.addEventListener('input', () => { editorDirty = true; });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      if (!name) return;
      const data = { name, description: form.elements.description.value.trim(), objects: s.objects };
      let newId = id;
      if (existing) Store.update('stages', id, data);
      else newId = Store.add('stages', data);
      editorDirty = false;
      toast(existing ? 'Stage saved' : 'Stage created');
      location.hash = '#/stages/' + newId;
    });

    drawLayer();
    drawProps();
  }

  /* =========================================================
   * Record — quick time entry for the range (built for phones)
   * ======================================================= */
  const ITEM_KEY = 'rangelog-last-item';

  function renderRecord(m) {
    const byName = (a, b) => a.name.localeCompare(b.name);
    const drills = Store.all('drills').sort(byName);
    const stages = Store.all('stages').sort(byName);
    if (!drills.length && !stages.length) {
      app.innerHTML = emptyState('⏱', 'Nothing to record yet', 'Create a drill or stage first, then record times here.',
        '<a class="btn primary" href="#/drills/new">Create a drill</a><a class="btn" href="#/stages/new">Create a stage</a>');
      pageRefresh = () => renderRecord(m);
      return;
    }

    const itemOf = v => {
      const i = String(v || '').indexOf(':');
      const kind = String(v).slice(0, i), id = String(v).slice(i + 1);
      return { kind, id, item: i > 0 ? itemFor(kind, id) : null };
    };
    let saved = '';
    try { saved = localStorage.getItem(ITEM_KEY) || ''; } catch (e) { /* ignore */ }
    let current = [m && m[1], saved].find(v => v && itemOf(v).item)
      || (drills.length ? 'drill:' + drills[0].id : 'stage:' + stages[0].id);

    app.innerHTML = `
      <div class="page-head"><div><p class="eyebrow">Record</p><h1>Record times</h1></div></div>
      <div class="record-page">
        <div class="card pick-card">
          <label>Drill or stage
            <select id="item-pick">
              ${drills.length ? `<optgroup label="Drills">${drills.map(d => `<option value="drill:${esc(d.id)}">${esc(d.name)}</option>`).join('')}</optgroup>` : ''}
              ${stages.length ? `<optgroup label="Stages">${stages.map(st => `<option value="stage:${esc(st.id)}">${esc(st.name)}</option>`).join('')}</optgroup>` : ''}
            </select>
          </label>
          <div class="item-info" id="item-info"></div>
        </div>
        <div id="record-slot"></div>
        <div id="today-slot"></div>
      </div>`;

    function mountForm() {
      const { kind, id, item } = itemOf(current);
      $('#item-info').innerHTML = kind === 'drill'
        ? `<span class="pill">Par ${fmtTime(item.par)}s</span>${item.rounds ? `<span>${esc(item.rounds)} rds</span>` : ''}${item.distance ? `<span>${esc(item.distance)} yd</span>` : ''}<a href="#/drills/${esc(id)}">View drill →</a>`
        : `<span class="pill">${Stage.rounds(item.objects)} rds min</span><a href="#/stages/${esc(id)}">View stage →</a>`;
      $('#record-slot').innerHTML = recordFormHTML(kind);
      bindRecordForm(kind, () => itemFor(kind, id));
      drawToday();
    }

    // Today's results for the picked item, plus the latest entries so mistakes are easy to spot and delete.
    function drawToday() {
      const { kind, id, item } = itemOf(current);
      if (!item) return;
      const runs = runsFor(kind, id).filter(r => r.date === today());
      const ranked = rankRuns(runs);
      const par = kind === 'drill' ? num(item.par) : null;
      const latest = runs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);
      $('#today-slot').innerHTML = `<div class="card">
        <h3>Today · ${esc(item.name)} <span class="count">${runs.length}</span></h3>
        ${ranked.length ? `
          <table class="table"><thead><tr><th></th><th>Shooter</th><th class="num">Best</th>${par ? '<th class="num">vs Par</th>' : ''}<th class="num">Runs</th></tr></thead><tbody>
          ${ranked.map((r, i) => `<tr${i === 0 ? ' class="first"' : ''}><td class="rank">${medal(i)}</td><td>${shooterLink(r.shooter, r.best.memberId)}</td>
            <td class="num">${timeCell(r.best)}</td>${par ? `<td class="num">${vsPar(r.best.time, par)}</td>` : ''}<td class="num muted">${r.attempts}</td></tr>`).join('')}
          </tbody></table>
          <h4 class="mini-title">Latest entries</h4>
          <ul class="entry-list">${latest.map(r => `<li>
            <span class="who">${esc(r.shooter)}</span>
            <span class="t">${timeCell(r)}</span>
            <button class="icon-btn" data-del-time="${esc(r.id)}" title="Delete this run" aria-label="Delete ${esc(r.shooter)}'s ${fmtTime(r.time)} run">×</button>
          </li>`).join('')}</ul>`
        : '<p class="muted">No times recorded today yet.</p>'}
      </div>`;
    }

    const pick = $('#item-pick');
    pick.value = current;
    pick.addEventListener('change', () => {
      current = pick.value;
      try { localStorage.setItem(ITEM_KEY, current); } catch (e) { /* ignore */ }
      mountForm();
    });
    mountForm();
    pageRefresh = () => { if (itemOf(current).item) drawToday(); else renderRecord(); };
  }

  /* =========================================================
   * Shooter history & progress
   * ======================================================= */
  function historyHref(name, memberId) {
    const m = (memberId && Store.get('members', memberId))
      || Store.all('members').find(x => shooterKey(x.name) === shooterKey(name));
    return m ? `#/history/${encodeURIComponent(m.id)}` : `#/history/guest/${encodeURIComponent(String(name || '').trim())}`;
  }
  function shooterLink(name, memberId) {
    return `<a class="shooter-link" href="${historyHref(name, memberId)}">${esc(name)}</a>`;
  }
  function niceStep(raw) {
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
  }

  // Line chart of a shooter's best time per range day, with an optional par line.
  // Single series, so no legend; hover/tap shows the day's details.
  function drawTrend(el, sessions, par) {
    const W = Math.max(260, el.clientWidth), H = 180;
    const pad = { l: 40, r: 16, t: 22, b: 26 };
    const xs = sessions.map(s => parseISO(s.date).getTime());
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (x0 === x1) { x0 -= 864e5; x1 += 864e5; }
    const vals = sessions.map(s => s.best).concat(par ? [par] : []);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const span = (hi - lo) || hi * 0.2 || 1;
    lo = Math.max(0, lo - span * 0.2);
    hi += span * 0.2;
    const step = niceStep((hi - lo) / 3);
    const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
    const X = t => pad.l + (t - x0) / (x1 - x0) * (W - pad.l - pad.r);
    const Y = v => pad.t + (hi - v) / (hi - lo) * (H - pad.t - pad.b);
    const pts = sessions.map((s, i) => ({ x: X(xs[i]), y: Y(s.best), s }));
    const pb = pts.reduce((a, b) => (b.s.best < a.s.best ? b : a));
    const pbAnchor = pb.x > W - 60 ? 'end' : pb.x < pad.l + 30 ? 'start' : 'middle';
    // The PB is the lowest point, so the space under it is always clear of the line.
    const pbY = pb.y + 18;
    const dateLabel = d => parseISO(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const first = sessions[0], last = sessions[sessions.length - 1];

    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Best time per range day, ${sessions.length} days, personal best ${fmtTime(pb.s.best)} seconds">
      <g class="grid">${ticks.map(v => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('')}</g>
      <g class="axis">${ticks.map(v => `<text x="${pad.l - 8}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(dec)}</text>`).join('')}
        <text x="${pts[0].x}" y="${H - 6}" text-anchor="${sessions.length > 1 ? 'start' : 'middle'}">${dateLabel(first.date)}</text>
        ${sessions.length > 1 ? `<text x="${pts[pts.length - 1].x}" y="${H - 6}" text-anchor="end">${dateLabel(last.date)}</text>` : ''}
      </g>
      ${par ? `<line class="par-line" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(par)}" y2="${Y(par)}"/>
        <text class="par-label" x="${W - pad.r}" y="${Y(par) - 5}" text-anchor="end">Par ${fmtTime(par)}</text>` : ''}
      <path class="trend-line" d="${pts.map((p, i) => (i ? 'L' : 'M') + p.x + ',' + p.y).join(' ')}"/>
      <line class="crosshair" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
      ${pts.map((p, i) => `<circle class="trend-dot${p === pb ? ' pb' : ''}" data-i="${i}" cx="${p.x}" cy="${p.y}" r="${p === pb ? 5.5 : 4}"/>`).join('')}
      <text class="pb-label" x="${pb.x}" y="${pbY}" text-anchor="${pbAnchor}">PB ${fmtTime(pb.s.best)}</text>
      <rect class="hover-zone" x="${pad.l - 10}" y="0" width="${W - pad.l - pad.r + 20}" height="${H}"/>
    </svg><div class="chart-tip" hidden></div>`;

    const svg = $('svg', el), tip = $('.chart-tip', el), cross = $('.crosshair', el);

    // If the par label lands on the PB label, move it to the left end of the par line.
    const parLabel = $('.par-label', el), pbLabel = $('.pb-label', el);
    if (parLabel) {
      const a = parLabel.getBBox(), b = pbLabel.getBBox();
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        parLabel.setAttribute('x', pad.l + 4);
        parLabel.setAttribute('text-anchor', 'start');
      }
    }
    function show(e) {
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      let best = 0;
      pts.forEach((p, i) => { if (Math.abs(p.x - px) < Math.abs(pts[best].x - px)) best = i; });
      const p = pts[best];
      cross.setAttribute('x1', p.x); cross.setAttribute('x2', p.x); cross.setAttribute('visibility', 'visible');
      $$('.trend-dot', el).forEach(d => d.classList.toggle('on', +d.dataset.i === best));
      tip.innerHTML = `<strong>${fmtDate(p.s.date)}</strong><span>Best ${fmtTime(p.s.best)}s${par ? ' · ' + vsPar(p.s.best, par) : ''}</span>
        <span class="muted">${p.s.count} run${p.s.count === 1 ? '' : 's'} that day</span>`;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = Math.max(0, Math.min(W - tw, p.x - tw / 2)) + 'px';
      tip.style.top = Math.max(0, p.y - tip.offsetHeight - 14) + 'px';
    }
    function hide() {
      tip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
      $$('.trend-dot', el).forEach(d => d.classList.remove('on'));
    }
    const zone = $('.hover-zone', el);
    zone.addEventListener('pointermove', show);
    zone.addEventListener('pointerdown', show);
    zone.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
  }

  function renderHistory(m) {
    const isGuest = !!(m && /\/guest\//.test(m[0]));
    const param = m && m[1] ? decodeURIComponent(m[1]) : null;

    const render = () => {
      const list = members();
      let who = null;
      if (isGuest) who = { name: param, memberId: null };
      else if (param) {
        const mm = Store.get('members', param);
        if (mm) who = { name: mm.name, memberId: mm.id };
      } else {
        // No one picked yet: start with whoever last recorded on this phone, else the first member.
        const mm = list.find(x => shooterKey(x.name) === shooterKey(getShooter())) || list[0];
        if (mm) who = { name: mm.name, memberId: mm.id };
      }
      const guests = knownShooters().filter(n => !list.some(x => shooterKey(x.name) === shooterKey(n)));
      const picker = `<select id="who-pick" aria-label="Choose a shooter">
        ${who ? '' : '<option value="">Choose a shooter…</option>'}
        ${list.length ? `<optgroup label="Members">${list.map(x => `<option value="${historyHref(x.name, x.id)}"${who && who.memberId === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : ''}
        ${guests.length ? `<optgroup label="Guests">${guests.map(n => `<option value="${historyHref(n)}"${who && !who.memberId && shooterKey(who.name) === shooterKey(n) ? ' selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>` : ''}
      </select>`;
      const head = `<a class="back" href="#/members">← Members</a>
        <div class="page-head history-head"><div><p class="eyebrow">Shooter history</p><h1>${who ? esc(who.name) : 'History'}</h1></div>
        <label class="who-label">Shooter ${picker}</label></div>`;

      if (!who) {
        app.innerHTML = head + emptyState('📈', 'No shooters yet', 'Add members and record some times to see their progress here.', '<a class="btn primary" href="#/members">Go to members</a>');
        bindPicker();
        return;
      }

      const key = shooterKey(who.name);
      const runs = Store.all('times').filter(r => {
        if (who.memberId && r.memberId === who.memberId) return true;
        // Runs saved by name (before the member existed, or for guests).
        return shooterKey(r.shooter) === key && (!r.memberId || !Store.get('members', r.memberId));
      });

      if (!runs.length) {
        app.innerHTML = head + emptyState('⏱', `No times for ${esc(who.name)} yet`, 'Once they record a drill or stage, their progress shows up here.', '<a class="btn primary" href="#/record">Record a time</a>');
        bindPicker();
        return;
      }

      // ---- per drill / stage ----
      const groups = new Map();
      runs.forEach(r => {
        const k = r.kind + ':' + r.itemId;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      let recordsHeld = 0;
      const items = [...groups.values()].map(list2 => {
        const r0 = list2[0];
        const item = itemFor(r0.kind, r0.itemId);
        const par = r0.kind === 'drill' ? num(item ? item.par : r0.par) : null;
        const byDay = new Map();
        list2.forEach(r => {
          const d = byDay.get(r.date) || { date: r.date, best: Infinity, count: 0 };
          d.best = Math.min(d.best, r.time);
          d.count++;
          byDay.set(r.date, d);
        });
        const sessions = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
        const sorted = list2.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
        const times = sorted.map(r => r.time);
        const groupRank = rankRuns(runsFor(r0.kind, r0.itemId));
        const rank = groupRank.findIndex(g => shooterKey(g.shooter) === key) + 1;
        if (rank === 1) recordsHeld++;
        return {
          kind: r0.kind, id: r0.itemId, exists: !!item, name: item ? item.name : r0.itemName, par, sessions,
          count: list2.length, best: Math.min(...times),
          avg: times.reduce((a, b) => a + b, 0) / times.length,
          latest: sorted[sorted.length - 1],
          underPar: par ? list2.filter(r => r.time <= par).length : null,
          rank, of: groupRank.length,
          change: sessions.length > 1 ? sessions[sessions.length - 1].best - sessions[0].best : null,
          lastDate: sessions[sessions.length - 1].date,
        };
      }).sort((a, b) => b.lastDate.localeCompare(a.lastDate) || a.name.localeCompare(b.name));

      // ---- overall ----
      const days = new Set(runs.map(r => r.date));
      const drillRuns = runs.filter(r => r.kind === 'drill');
      const parFor = r => { const it = itemFor('drill', r.itemId); return num(it ? it.par : r.par); };
      const parRuns = drillRuns.filter(r => parFor(r));
      const underParPct = parRuns.length ? Math.round(parRuns.filter(r => r.time <= parFor(r)).length / parRuns.length * 100) : null;
      const clean = runs.filter(r => !(r.penTime > 0)).length;
      const penTotals = Store.PENALTIES.map(p => ({ p, n: runs.reduce((sum, r) => sum + ((r.pen || {})[p.key] || 0), 0) })).filter(x => x.n > 0);
      const penSeconds = runs.reduce((sum, r) => sum + (r.penTime || 0), 0);
      const recent = runs.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 30);

      const trend = it => {
        if (it.change === null) return '<span class="trend flat">Shoot it on another day to see a trend</span>';
        if (Math.abs(it.change) < 0.005) return '<span class="trend flat">→ Same best as the first day</span>';
        const faster = it.change < 0;
        return `<span class="trend ${faster ? 'up' : 'down'}">${faster ? '▼' : '▲'} ${fmtTime(Math.abs(it.change))}s ${faster ? 'faster' : 'slower'} since ${fmtShort(it.sessions[0].date)}</span>`;
      };

      app.innerHTML = head + `
        <div class="stats-row history-stats">
          <div class="stat-card"><span class="value">${runs.length}</span><span class="label">Runs</span></div>
          <div class="stat-card"><span class="value">${days.size}</span><span class="label">Range days</span></div>
          <div class="stat-card"><span class="value">${underParPct === null ? '—' : underParPct + '%'}</span><span class="label">Drills under par</span></div>
          <div class="stat-card"><span class="value">${Math.round(clean / runs.length * 100)}%</span><span class="label">Clean runs</span></div>
          ${recordsHeld ? `<div class="stat-card gold"><span class="value">🏆 ${recordsHeld}</span><span class="label">Group record${recordsHeld === 1 ? '' : 's'} held</span></div>` : ''}
        </div>

        <h2 class="section-title">Progress by drill &amp; stage</h2>
        <div class="grid progress-grid">
          ${items.map((it, i) => `<div class="card progress-card">
            <div class="result-head">
              <h3>${it.exists ? `<a href="#/${it.kind}s/${esc(it.id)}">${esc(it.name)}</a>` : esc(it.name)}</h3>
              <span class="kind ${it.kind}">${it.kind === 'drill' ? 'Drill' : 'Stage'}</span>
            </div>
            ${trend(it)}
            <div class="mini-stats">
              <div><span class="label">Best</span><span class="value">${fmtTime(it.best)}</span></div>
              <div><span class="label">Average</span><span class="value">${fmtTime(it.avg)}</span></div>
              <div><span class="label">Latest</span><span class="value">${fmtTime(it.latest.time)}</span></div>
              <div><span class="label">Rank</span><span class="value">${it.rank ? `${it.rank === 1 ? '🏆 ' : ''}#${it.rank}<small> of ${it.of}</small>` : '—'}</span></div>
            </div>
            ${it.sessions.length > 1 ? `<div class="chart-caption">Best time each range day${it.par ? ' · lower is faster' : ' (seconds, lower is faster)'}</div><div class="trend-chart" data-chart="${i}"></div>` : ''}
            <p class="muted small">${it.count} run${it.count === 1 ? '' : 's'} over ${it.sessions.length} day${it.sessions.length === 1 ? '' : 's'}${it.par ? ` · ${it.underPar} under par (${Math.round(it.underPar / it.count * 100)}%)` : ''}</p>
          </div>`).join('')}
        </div>

        <div class="two-col even">
          <div class="card">
            <h3>Penalties</h3>
            ${penTotals.length ? `
              <p class="muted small">${fmtTime(penSeconds)}s of penalties over ${runs.length} runs, an average of ${fmtTime(penSeconds / runs.length)}s per run.</p>
              <table class="table"><thead><tr><th>Type</th><th class="num">Count</th><th class="num">Per run</th></tr></thead><tbody>
              ${penTotals.sort((a, b) => b.n - a.n).map(x => `<tr><td>${x.p.label}</td><td class="num strong">${x.n}</td><td class="num">${(x.n / runs.length).toFixed(2)}</td></tr>`).join('')}
              </tbody></table>`
            : '<p class="muted">No penalties recorded. 🎯</p>'}
          </div>
          <div class="card">
            <h3>Recent runs <span class="count">${runs.length}</span></h3>
            <div class="scroll"><table class="table"><thead><tr><th>Date</th><th>Drill / stage</th><th class="num">Time</th></tr></thead><tbody>
            ${recent.map(r => {
              const it = itemFor(r.kind, r.itemId);
              const par = r.kind === 'drill' ? num(it ? it.par : r.par) : null;
              return `<tr><td><a href="#/day/${r.date}">${fmtShort(r.date)}</a></td>
                <td>${esc(it ? it.name : r.itemName)}${par ? `<span class="sub">${vsPar(r.time, par)} vs par</span>` : ''}</td>
                <td class="num">${timeCell(r)}</td></tr>`;
            }).join('')}
            </tbody></table></div>
            ${runs.length > recent.length ? `<p class="muted small">Showing the latest ${recent.length}.</p>` : ''}
          </div>
        </div>`;

      bindPicker();
      drawCharts();
      function drawCharts() {
        $$('.trend-chart').forEach(el => { const it = items[+el.dataset.chart]; drawTrend(el, it.sessions, it.par); });
      }
      redraw = drawCharts;
    };

    function bindPicker() {
      $('#who-pick').addEventListener('change', e => { if (e.target.value) location.hash = e.target.value; });
    }

    let redraw = null;
    let resizeTimer = null;
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => redraw && redraw(), 150); };
    window.addEventListener('resize', onResize);
    pageCleanup = () => window.removeEventListener('resize', onResize);
    render();
    pageRefresh = render;
  }

  /* =========================================================
   * Members
   * ======================================================= */
  function addMember(name) {
    name = String(name || '').trim().replace(/\s+/g, ' ');
    if (!name) return false;
    if (Store.all('members').some(m => shooterKey(m.name) === shooterKey(name))) {
      toast(`${name} is already a member`);
      return false;
    }
    Store.add('members', { name });
    return true;
  }

  function renderMembers() {
    const render = () => {
      const list = members();
      const times = Store.all('times');
      const memberKeys = new Set(list.map(m => shooterKey(m.name)));
      const unlisted = knownShooters().filter(n => !memberKeys.has(shooterKey(n)));
      const statsFor = name => {
        const runs = times.filter(t => shooterKey(t.shooter) === shooterKey(name));
        return { runs: runs.length, last: runs.map(r => r.date).sort().pop() };
      };

      app.innerHTML = `
        <div class="page-head"><div><p class="eyebrow">Members</p><h1>Members</h1></div>${list.length ? '<a class="btn primary" href="#/history">📈 View history</a>' : ''}</div>
        <div class="two-col">
          <div class="stack">
            <form class="card" id="member-form" autocomplete="off">
              <h3>Add a member</h3>
              <label>Name <input name="name" required maxlength="60" placeholder="First and last name" autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="done"></label>
              <button class="btn primary block" type="submit">Add member</button>
            </form>
            ${unlisted.length ? `<div class="card">
              <h3>Shooters not on the list</h3>
              <p class="muted small">These names have recorded times but aren't members yet.</p>
              <div class="chips">${unlisted.map(n => `<button class="chip" type="button" data-add-name="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>
              <button class="btn sm" type="button" id="add-all">Add all ${unlisted.length}</button>
            </div>` : ''}
          </div>
          <div class="card">
            <h3>Roster <span class="count">${list.length}</span></h3>
            ${list.length ? `<table class="table"><thead><tr><th>Name</th><th class="num">Runs</th><th>Last shot</th><th></th></tr></thead><tbody>
              ${list.map(m => {
                const st = statsFor(m.name);
                return `<tr><td class="strong"><a class="shooter-link" href="${historyHref(m.name, m.id)}">${esc(m.name)}</a></td><td class="num">${st.runs}</td>
                  <td>${st.last ? `<a href="#/day/${st.last}">${fmtShort(st.last)}</a>` : '<span class="muted">—</span>'}</td>
                  <td class="num"><button class="icon-btn" data-del-member="${esc(m.id)}" title="Remove ${esc(m.name)}" aria-label="Remove ${esc(m.name)}">×</button></td></tr>`;
              }).join('')}
            </tbody></table>` : '<p class="muted">No members yet. Add your group so their names show up in a dropdown when recording times.</p>'}
            ${list.length ? '<p class="muted small">Tap a name to see their history and progress.</p>' : ''}
          </div>
        </div>`;

      const form = $('#member-form');
      form.addEventListener('submit', e => {
        e.preventDefault();
        const name = form.elements.name.value;
        refocus = true;
        if (addMember(name)) toast(`Added ${name.trim()}`);
        else refocus = false;
      });
      $$('[data-add-name]').forEach(b => b.addEventListener('click', () => addMember(b.dataset.addName)));
      const all = $('#add-all');
      if (all) all.addEventListener('click', () => { unlisted.forEach(addMember); toast(`Added ${unlisted.length} members`); });
      $$('[data-del-member]').forEach(b => b.addEventListener('click', () => {
        const m = Store.get('members', b.dataset.delMember);
        if (m && confirm(`Remove ${m.name} from the member list? Their recorded times will stay.`)) Store.remove('members', m.id);
      }));
      // Keep the keyboard open after adding someone so several names can be entered in a row.
      if (refocus || canHover) $('input', form).focus();
      refocus = false;
    };
    let refocus = false;
    render();
    pageRefresh = render;
  }

  /* =========================================================
   * Settings
   * ======================================================= */
  function renderSettings() {
    const pens = Store.settings().penalties;
    app.innerHTML = `
      <div class="page-head"><div><p class="eyebrow">Settings</p><h1>Settings</h1></div></div>
      <form class="card settings-card" id="settings-form" autocomplete="off">
        <h3>Penalties</h3>
        <p class="muted">Seconds added to the raw time for each one. Set a penalty to 0 to turn it off; it won't appear on the record form.</p>
        <div class="settings-grid">
          ${Store.PENALTIES.map(p => `<label>${p.label}${p.stageOnly ? ' <span class="muted small">(stages only)</span>' : ''}
            <span class="input-suffix"><input name="${p.key}" type="number" min="0" max="60" step="0.05" inputmode="decimal" required value="${fmtSec(pens[p.key])}"><span>sec</span></span>
          </label>`).join('')}
        </div>
        <p class="hint">Changes apply to times recorded from now on. Times already saved keep the penalties they were scored with.</p>
        <div class="actions">
          <button class="btn primary" type="submit">Save settings</button>
          <button class="btn" type="button" id="defaults">Restore defaults</button>
        </div>
      </form>`;

    const form = $('#settings-form');
    form.addEventListener('input', () => { editorDirty = true; });
    $('#defaults').addEventListener('click', () => {
      Store.PENALTIES.forEach(p => { form.elements[p.key].value = p.def; });
      editorDirty = true;
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const penalties = {};
      Store.PENALTIES.forEach(p => { penalties[p.key] = Math.max(0, round2(num(form.elements[p.key].value) || 0)); });
      Store.saveSettings({ penalties });
      editorDirty = false;
      toast('Settings saved');
    });
  }

  /* =========================================================
   * Router, footer, startup
   * ======================================================= */
  const routes = [
    [/^#?\/?$/, renderDay],
    [/^#\/day\/(\d{4}-\d{2}-\d{2})$/, renderDay],
    [/^#\/drills\/?$/, renderDrillList],
    [/^#\/drills\/new$/, () => renderDrillEditor(null)],
    [/^#\/drills\/([^/]+)\/edit$/, renderDrillEditor],
    [/^#\/drills\/([^/]+)$/, renderDrillView],
    [/^#\/stages\/?$/, renderStageList],
    [/^#\/stages\/new$/, () => renderStageEditor(null)],
    [/^#\/stages\/([^/]+)\/edit$/, renderStageEditor],
    [/^#\/stages\/([^/]+)$/, renderStageView],
    [/^#\/record\/?$/, renderRecord],
    [/^#\/record\/((?:drill|stage):[^/]+)$/, renderRecord],
    [/^#\/members\/?$/, renderMembers],
    [/^#\/history\/?$/, renderHistory],
    [/^#\/history\/guest\/(.+)$/, renderHistory],
    [/^#\/history\/([^/]+)$/, renderHistory],
    [/^#\/settings\/?$/, renderSettings],
  ];

  function router() {
    if (pageCleanup) pageCleanup();
    pageCleanup = null;
    pageRefresh = null;
    const hash = location.hash || '#/';
    const section = hash.startsWith('#/history') ? 'members'
      : ['drills', 'stages', 'record', 'members', 'settings'].find(s => hash.startsWith('#/' + s)) || 'day';
    $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === section));
    window.scrollTo(0, 0);
    for (const [re, fn] of routes) {
      const m = hash.match(re);
      if (m) { fn(m); return; }
    }
    notFound('Page', '#/');
  }

  function onHashChange() {
    if (ignoreNextHash) { ignoreNextHash = false; return; }
    if (editorDirty && location.hash !== currentHash && !confirm('You have unsaved changes. Leave without saving?')) {
      ignoreNextHash = true;
      location.hash = currentHash;
      return;
    }
    editorDirty = false;
    currentHash = location.hash;
    router();
  }

  function renderFooter() {
    const footer = $('#footer');
    if (Store.mode === 'local') {
      footer.innerHTML = `<div class="mode-banner"><span>💾 <b>Demo mode</b> — data is saved only in this browser. Connect Firebase (see README) so the whole group shares the same data.</span>
        <button class="btn sm" id="reset-demo">Reset demo data</button></div>`;
      $('#reset-demo').addEventListener('click', () => {
        if (confirm('Replace everything in this browser with the demo data?')) { Store.resetDemo(); toast('Demo data restored'); }
      });
    } else {
      footer.innerHTML = Store.error
        ? `<div class="mode-banner error">⚠️ Could not reach the database: ${esc(Store.error)}</div>`
        : '<p class="muted small center">☁️ Synced with the group</p>';
    }
  }

  window.addEventListener('beforeunload', e => { if (editorDirty) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('store-error', e => toast('Could not save: ' + e.detail));

  app.addEventListener('click', e => {
    const btn = e.target.closest('[data-del-time]');
    if (!btn) return;
    const t = Store.get('times', btn.dataset.delTime);
    if (t && confirm(`Delete ${t.shooter}'s ${fmtTime(t.time)}s run on ${fmtDate(t.date)}?`)) {
      Store.remove('times', t.id);
      toast('Run deleted');
    }
  });

  app.addEventListener('click', e => {
    if (!e.target.closest('[data-jump-record]')) return;
    const form = $('#record-form');
    if (!form) return;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const first = form.elements.member && !form.elements.member.value ? form.elements.member : form.elements.time;
    setTimeout(() => first.focus({ preventScroll: true }), 350);
  });

  // Offline support: lets the site open at the range with no signal once it has been visited.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  if (window.GROUP_NAME) { $('#brand-name').textContent = window.GROUP_NAME; document.title = window.GROUP_NAME; }
  if (window.GROUP_TAGLINE) $('#brand-sub').textContent = window.GROUP_TAGLINE;

  Store.onChange(() => { if (pageRefresh) pageRefresh(); renderFooter(); });
  Store.ready.then(() => {
    renderFooter();
    window.addEventListener('hashchange', onHashChange);
    router();
  });
})();

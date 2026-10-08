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
  /*
   * Scoring. Drills and most stages are "time plus": lower final time wins. A stage can instead
   * use USPSA hit factor (points ÷ time): higher wins. Each run records how it was scored
   * (r.scoring === 'hf' with r.hf, r.points, r.hits), so it always displays correctly.
   */
  const HF_HITS = [
    { key: 'a', label: 'A hits', pts: [5, 5] },
    { key: 'c', label: 'C hits', pts: [3, 4] },   // [minor, major]
    { key: 'd', label: 'D hits', pts: [1, 2] },
    { key: 'm', label: 'Misses', pts: [-10, -10] },
    { key: 'ns', label: 'No-shoots', pts: [-10, -10] },
    { key: 'p', label: 'Procedurals', pts: [-10, -10] },
  ];
  function modeOf(kind, item) { return kind === 'stage' && item && item.scoring === 'hf' ? 'hf' : 'time'; }
  function isHF(r) { return r.scoring === 'hf' && typeof r.hf === 'number'; }
  function scoreOf(r, mode) { return mode === 'hf' ? r.hf : r.time; }
  function fmtHF(v) { return Number(v).toFixed(4); }
  function fmtScore(v, mode) { return mode === 'hf' ? fmtHF(v) : fmtTime(v); }
  function unitOf(mode) { return mode === 'hf' ? ' HF' : 's'; }

  // "1.81 raw + 1C 1M" (time plus) or "48 pts · 11.64s · 12A 2C 1M" (hit factor); '' if nothing to add.
  function penSummary(r) {
    if (isHF(r)) {
      const h = r.hits || {};
      const parts = HF_HITS.filter(x => h[x.key] > 0).map(x => h[x.key] + x.key.toUpperCase());
      return `${r.points} pts · ${fmtTime(r.time)}s${parts.length ? ' · ' + parts.join(' ') : ''}`;
    }
    const pen = r.pen || {};
    const parts = Store.PENALTIES.filter(p => pen[p.key] > 0).map(p => pen[p.key] + p.short);
    return parts.length ? `${fmtTime(r.raw)} raw + ${parts.join(' ')}` : '';
  }
  function timeCell(r) {
    const s = penSummary(r);
    if (isHF(r)) return `<span class="strong">${fmtHF(r.hf)}</span><span class="pen-note hf-note">${esc(s)}</span>`;
    return `<span class="strong">${fmtTime(r.time)}</span>${s ? `<span class="pen-note">${esc(s)}</span>` : ''}`;
  }

  /* Gun type ("division") filter shared by the leaderboards. Runs saved before gun types existed
     have no division and only show under "All". */
  const DIV_FILTER_KEY = 'rangelog-div-filter';
  let divFilter = 'all';
  try { divFilter = localStorage.getItem(DIV_FILTER_KEY) || 'all'; } catch (e) { /* ignore */ }
  function byDivision(runs) {
    if (divFilter === 'all') return runs;
    return runs.filter(r => (r.division || '') === divFilter);
  }
  // Chip row to pick a gun type; hidden until some run has one.
  function divChipsHTML() {
    const used = [...new Set(Store.all('times').map(r => r.division).filter(Boolean))];
    if (!used.length) return '';
    const order = Store.settings().divisions;
    used.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
    if (divFilter !== 'all' && !used.includes(divFilter)) used.push(divFilter);
    return `<div class="chips div-chips"><span class="muted small">Gun:</span>
      ${['all'].concat(used).map(d => `<button type="button" class="chip${divFilter === d ? ' active' : ''}" data-div-filter="${esc(d)}">${d === 'all' ? 'All' : esc(d)}</button>`).join('')}
    </div>`;
  }
  // Small gun label under a name when the leaderboard mixes gun types.
  function divNote(r) { return divFilter === 'all' && r.division ? `<span class="sub">${esc(r.division)}</span>` : ''; }
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

  // Each shooter's best run, best first. Only runs scored the way the item is scored now count
  // (if a stage switches between time plus and hit factor, the other kind of run isn't comparable).
  function rankRuns(runs, mode) {
    mode = mode || 'time';
    const hf = mode === 'hf';
    const by = new Map();
    runs.filter(r => isHF(r) === hf).forEach(r => {
      const k = shooterKey(r.shooter);
      const cur = by.get(k);
      if (!cur) by.set(k, { shooter: r.shooter.trim(), best: r, attempts: 1 });
      else {
        cur.attempts++;
        if (hf ? r.hf > cur.best.hf : r.time < cur.best.time) cur.best = r;
      }
    });
    return [...by.values()].sort((a, b) => (hf ? b.best.hf - a.best.hf : a.best.time - b.best.time));
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

  const GUN_KEY = 'rangelog-division';
  const PF_KEY = 'rangelog-pf';
  function getPref(k, def) { try { return localStorage.getItem(k) || def; } catch (e) { return def; } }
  function setPref(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  function stepperHTML(name, label, sub) {
    return `<div class="pen">
      <span class="pen-label">${label}${sub ? `<small>${sub}</small>` : ''}</span>
      <span class="stepper">
        <button type="button" class="step" data-pen-step="-1" aria-label="One fewer ${label}">−</button>
        <input name="${name}" type="number" min="0" max="99" step="1" value="0" inputmode="numeric" aria-label="${label}">
        <button type="button" class="step" data-pen-step="1" aria-label="One more ${label}">+</button>
      </span>
    </div>`;
  }

  function recordFormHTML(kind, item) {
    const st = Store.settings();
    const mode = modeOf(kind, item);
    const divs = st.divisions;
    const gun = getPref(GUN_KEY, divs[0] || '');
    const gunField = divs.length ? `<label>Gun <select name="division">
        ${divs.map(d => `<option${d === gun ? ' selected' : ''}>${esc(d)}</option>`).join('')}
      </select></label>` : '';

    let scoring;
    if (mode === 'hf') {
      const pf = getPref(PF_KEY, 'minor');
      const maxPts = item && item.objects ? Stage.rounds(item.objects) * 5 : 0;
      scoring = `<fieldset class="pen-grid hf-grid"><legend>Hits <span class="muted small">— count steel hits as A</span></legend>
        ${HF_HITS.map(h => stepperHTML('hit-' + h.key, h.label, h.key === 'a' ? '5 pts' : h.pts[0] < 0 ? '−10 pts' : `${h.pts[0]} pts minor / ${h.pts[1]} major`)).join('')}
        <div class="pen pf-row"><span class="pen-label">Power factor${maxPts ? `<small>${maxPts} pts possible</small>` : ''}</span>
          <select name="pf" aria-label="Power factor"><option value="minor"${pf === 'minor' ? ' selected' : ''}>Minor</option><option value="major"${pf === 'major' ? ' selected' : ''}>Major</option></select>
        </div>
      </fieldset>`;
    } else {
      const types = penaltyTypes(kind).filter(p => st.penalties[p.key] > 0);
      scoring = types.length ? `<fieldset class="pen-grid"><legend>Penalties <a class="small" href="#/settings">edit values</a></legend>
        ${types.map(p => stepperHTML('pen-' + p.key, p.label, `+${fmtSec(st.penalties[p.key])}s each`)).join('')}
      </fieldset>` : '';
    }

    return `<form class="card record-form" id="record-form" autocomplete="off">
      <h3>⏱ Record a ${mode === 'hf' ? 'run' : 'time'}${mode === 'hf' ? ' <span class="kind stage">Hit factor</span>' : ''}</h3>
      <div class="form-row">
        <div>${shooterFieldHTML()}</div>
        <label>${mode === 'hf' ? 'Time' : 'Raw time'} (seconds) <input name="time" class="big-input" type="number" step="0.01" min="0.01" max="3599" inputmode="decimal" enterkeyhint="done" required placeholder="0.00"></label>
      </div>
      ${gunField ? `<div class="form-row">${gunField}<div></div></div>` : ''}
      ${scoring}
      <div class="form-row">
        <label>Date <input name="date" type="date" required value="${today()}"></label>
        <label>Notes <input name="notes" maxlength="200" placeholder="Optional"></label>
      </div>
      <div class="final-line" id="final-line"></div>
      <button class="btn primary block" type="submit">Save ${mode === 'hf' ? 'run' : 'time'}</button>
    </form>`;
  }

  // onSaved(run) lets a page react after a save (the Record screen moves to the next shooter).
  function bindRecordForm(kind, getItem, onSaved) {
    const form = $('#record-form');
    const f = form.elements;
    const sel = f.member;
    const hfMode = () => modeOf(kind, getItem()) === 'hf';

    function counts(prefix) {
      const out = {};
      $$(`input[name^="${prefix}"]`, form).forEach(inp => {
        const n = Math.max(0, parseInt(inp.value, 10) || 0);
        if (n) out[inp.name.slice(prefix.length)] = n;
      });
      return out;
    }
    function calc() {
      const raw = num(f.time.value);
      if (hfMode()) {
        const hits = counts('hit-');
        const major = f.pf && f.pf.value === 'major';
        const points = Math.max(0, HF_HITS.reduce((sum, h) => sum + (hits[h.key] || 0) * h.pts[major ? 1 : 0], 0));
        return { raw, hits, pf: major ? 'major' : 'minor', points, hf: raw ? Math.round(points / raw * 10000) / 10000 : null };
      }
      const pens = Store.settings().penalties;
      const pen = counts('pen-');
      const penTime = round2(Object.keys(pen).reduce((sum, k) => sum + pen[k] * (pens[k] || 0), 0));
      return { raw, pen, penTime, final: raw ? round2(raw + penTime) : null };
    }
    function showFinal() {
      const c = calc();
      const el = $('#final-line');
      if (hfMode()) {
        el.innerHTML = `Points: <strong>${c.points}</strong>${c.hf !== null ? ` · Hit factor: <strong>${fmtHF(c.hf)}</strong>` : ''}`;
        return;
      }
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
    form.addEventListener('change', showFinal);
    if (sel) sel.addEventListener('change', () => {
      const guest = sel.value === '__guest';
      $('.guest-field', form).hidden = !guest;
      f.guest.required = guest;
      if (guest) f.guest.focus();
    });
    showFinal();

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
      const division = f.division ? f.division.value : '';
      if (division) setPref(GUN_KEY, division);
      const base = {
        kind, itemId: item.id, itemName: item.name, shooter, memberId, division: division || null,
        date: f.date.value || today(), notes: f.notes.value.trim(),
      };
      let run;
      if (hfMode()) {
        setPref(PF_KEY, c.pf);
        run = Object.assign(base, { scoring: 'hf', par: null, raw: round2(c.raw), time: round2(c.raw), hits: c.hits, pf: c.pf, points: c.points, hf: c.hf });
      } else {
        run = Object.assign(base, { par: kind === 'drill' ? num(item.par) : null, raw: round2(c.raw), pen: c.pen, penTime: c.penTime, time: c.final });
      }
      Store.add('times', run);
      f.time.value = '';
      f.notes.value = '';
      $$('input[name^="pen-"], input[name^="hit-"]', form).forEach(inp => { inp.value = 0; });
      showFinal();
      if (run.scoring === 'hf') toast(`${shooter}: HF ${fmtHF(run.hf)} (${run.points} pts / ${fmtTime(run.time)}s)`);
      else {
        const par = run.par;
        const pens = run.penTime ? ` incl. +${fmtTime(run.penTime)} penalties` : '';
        if (par) toast(run.time <= par ? `${fmtTime(run.time)}s${pens} — under par! 🎯` : `${fmtTime(run.time)}s${pens} (+${fmtTime(run.time - par)} over par)`);
        else toast(`${fmtTime(run.time)}s saved${pens}`);
      }
      if (onSaved) onSaved(run);
    });
  }

  function historyHTML(kind, id, par) {
    const mode = modeOf(kind, itemFor(kind, id));
    const runs = byDivision(runsFor(kind, id));
    const chips = divChipsHTML();
    if (!runs.length) {
      return `${chips}<div class="card"><h3>Times</h3><p class="muted">No times recorded yet${divFilter !== 'all' ? ' for this gun' : ''}. Be the first!</p></div>`;
    }
    const ranked = rankRuns(runs, mode).slice(0, 10);
    const recent = runs.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
    const parCol = par ? '<th class="num">vs Par</th>' : '';
    return `${chips}<div class="two-col even">
      <div class="card">
        <h3>🏆 All-time leaderboard</h3>
        <p class="muted small">Each shooter's best run${mode === 'hf' ? ' (by hit factor, higher is better)' : ''}</p>
        ${ranked.length ? '' : '<p class="muted">No runs scored this way yet.</p>'}
        <table class="table"><thead><tr><th></th><th>Shooter</th><th class="num">${mode === 'hf' ? 'HF' : 'Time'}</th>${parCol}<th>Date</th></tr></thead><tbody>
        ${ranked.map((r, i) => `<tr>
          <td class="rank">${medal(i)}</td><td>${shooterLink(r.shooter, r.best.memberId)}${divNote(r.best)}</td>
          <td class="num">${timeCell(r.best)}</td>
          ${par ? `<td class="num">${vsPar(r.best.time, par)}</td>` : ''}
          <td><a href="#/day/${r.best.date}">${fmtShort(r.best.date)}</a></td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card">
        <h3>All runs <span class="count">${runs.length}</span></h3>
        <div class="scroll"><table class="table"><thead><tr><th>Date</th><th>Shooter</th><th class="num">Time</th>${parCol}<th></th></tr></thead><tbody>
        ${recent.map(r => `<tr>
          <td><a href="#/day/${r.date}">${fmtShort(r.date)}</a></td><td>${shooterLink(r.shooter, r.memberId)}${divNote(r)}${r.notes ? `<span class="sub">${esc(r.notes)}</span>` : ''}</td>
          <td class="num">${timeCell(r)}</td>
          ${par ? `<td class="num">${isHF(r) ? '' : vsPar(r.time, par)}</td>` : ''}
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
      const runs = byDivision(all.filter(t => t.date === date));
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
        const mode = modeOf(r0.kind, item);
        return {
          kind: r0.kind, id: r0.itemId, exists: !!item, mode,
          name: item ? item.name : r0.itemName,
          par: r0.kind === 'drill' ? num(item ? item.par : r0.par) : null,
          ranked: rankRuns(list, mode), count: list.length,
        };
      }).filter(g => g.ranked.length).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'drill' ? -1 : 1) || a.name.localeCompare(b.name));

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
        ${date === today() ? rangeDayCardHTML() : ''}
        <div class="day-links"><a class="btn sm" href="#/standings">🏆 Season standings</a><a class="btn sm" href="#/plan">📋 Range day plan</a></div>
        ${dates.length ? `<div class="chips"><span class="muted small">Range days:</span>${dates.slice(0, 12).map(d =>
          `<a class="chip${d === date ? ' active' : ''}" href="#/day/${d}">${fmtDate(d)}</a>`).join('')}</div>` : ''}
        ${divChipsHTML()}
        ${runs.length ? `
          <div class="stats-row">
            <div class="stat-card"><span class="value">${shooters.size}</span><span class="label">Shooters</span></div>
            <div class="stat-card"><span class="value">${runs.length}</span><span class="label">Runs</span></div>
            <div class="stat-card"><span class="value">${results.length}</span><span class="label">Drills &amp; stages</span></div>
            <div class="stat-card gold"><span class="value">🏆 ${esc(leaders.join(' & '))}</span><span class="label">Most wins today (${maxWins})</span></div>
          </div>
          <h2 class="section-title">Best of the day</h2>
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
        <div><div class="who">${esc(w.shooter)}</div><div class="time">${fmtScore(scoreOf(w.best, g.mode), g.mode)}<small>${unitOf(g.mode)}</small></div>${g.mode === 'hf' ? `<div class="pen-note hf-note">${esc(penSummary(w.best))}</div>` : w.best.penTime ? `<div class="pen-note">incl. +${fmtTime(w.best.penTime)} penalties</div>` : ''}${divNote(w.best)}</div>
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
      ${g.mode === 'hf' ? '<p class="muted small">Hit factor · higher is better</p>' : ''}
      <table class="table"><thead><tr><th></th><th>Shooter</th><th class="num">${g.mode === 'hf' ? 'Best HF' : 'Best'}</th>${g.par ? '<th class="num">vs Par</th>' : ''}<th class="num">Runs</th></tr></thead><tbody>
      ${g.ranked.map((r, i) => `<tr${i === 0 ? ' class="first"' : ''}>
        <td class="rank">${medal(i)}</td><td>${shooterLink(r.shooter, r.best.memberId)}${divNote(r.best)}</td>
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
   * and are simply one-target drills. `targetDistances[t]` optionally sets a target's own
   * distance; blank falls back to the drill's `distance`.
   */
  const MAX_TARGETS = 6;
  function targetDistance(d, t) {
    if (targetCount(d) > 1) {
      const own = num((d.targetDistances || [])[t]);
      if (own !== null) return own;
    }
    return num(d.distance);
  }
  // "7 yd", or "7–15 yd" when targets are at different distances.
  function distanceText(d) {
    const n = targetCount(d);
    const ds = [];
    for (let t = 0; t < n; t++) { const v = targetDistance(d, t); if (v !== null) ds.push(v); }
    if (!ds.length) return '';
    const lo = Math.min(...ds), hi = Math.max(...ds);
    return lo === hi ? `${lo} yd` : `${lo}–${hi} yd`;
  }
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
        <span class="tgt-label">T${t + 1}</span>${!opts.editable && targetDistance(d, t) !== null ? `<span class="tgt-dist">${targetDistance(d, t)} yd</span>` : ''}<small>${mine.length} shot${mine.length === 1 ? '' : 's'}</small>
        ${opts.editable && n > 1 ? `<button type="button" class="icon-btn" data-remove-target="${t}" title="Remove T${t + 1}" aria-label="Remove target T${t + 1}">×</button>` : ''}
      </figcaption>`;
      const own = (d.targetDistances || [])[t];
      const distInput = opts.editable && n > 1 ? `<label class="tgt-dist-input">
          <input type="number" min="0" max="999" step="1" inputmode="numeric" data-dist="${t}" value="${esc(own == null ? '' : own)}"
            placeholder="${esc(num(d.distance) == null ? '–' : d.distance)}" aria-label="T${t + 1} distance in yards"> yd
        </label>` : '';
      html += `<figure class="tgt" data-t="${t}">${caption}${Target.svg(mine, opts)}${distInput}</figure>`;
    }
    return `<div class="targets${n > 1 ? ' multi' : ''}" style="--cols:${n};--cols-sm:${Math.min(n, 3)}">${html}</div>`;
  }

  function renderDrillList() {
    const render = () => {
      const drills = Store.all('drills').sort((a, b) => a.name.localeCompare(b.name));
      app.innerHTML = `
        <div class="page-head"><div><p class="eyebrow">Drills</p><h1>Drills &amp; par times</h1></div><div class="actions"><a class="btn" href="#/timer">⏲ Dry fire timer</a><a class="btn primary" href="#/drills/new">+ New drill</a></div></div>
        ${drills.length ? `<div class="grid items">${drills.map(d => {
          const best = rankRuns(runsFor('drill', d.id))[0];
          return `<a class="card item-card" href="#/drills/${esc(d.id)}">
            <div class="thumb target-thumb${targetCount(d) > 1 ? ' multi' : ''}">${targetsHTML(d, { mini: true })}</div>
            <div class="item-body">
              <h3>${esc(d.name)}</h3>
              <div class="meta"><span class="pill">Par ${fmtTime(d.par)}s</span>${distanceText(d) ? `<span>${distanceText(d)}</span>` : ''}<span>${esc(d.rounds || (d.marks || []).length)} rds</span>${targetCount(d) > 1 ? `<span>${targetCount(d)} targets</span>` : ''}</div>
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
            <div class="stat-card"><span class="value">${distanceText(d) ? distanceText(d).replace(' yd', '<small>yd</small>') : '—'}</span><span class="label">Distance</span></div>
          </div>
          <div class="card"><h3>Instructions</h3><div class="instructions">${d.instructions ? nl2br(d.instructions) : '<em class="muted">No instructions.</em>'}</div></div>`;
    app.innerHTML = `
      <a class="back" href="#/drills">← All drills</a>
      <div class="page-head">
        <div><p class="eyebrow">Drill</p><h1>${esc(d.name)}</h1></div>
        <div class="actions"><button class="btn primary mobile-only" type="button" data-jump-record>⏱ Record time</button><a class="btn" href="#/timer/drill:${esc(id)}">⏲ Dry fire timer</a><a class="btn" href="#/drills/${esc(id)}/edit">Edit</a><button class="btn danger-outline" id="del-item">Delete</button></div>
      </div>
      ${multi ? `
      <div class="card target-card multi">${targetsHTML(d, { numbers: true })}
        <p class="hint center">Numbers show the shot order across targets.</p></div>
      <div class="two-col even">
        <div class="stack">${details}</div>
        ${recordFormHTML('drill', d)}
      </div>` : `
      <div class="two-col">
        <div class="card target-card">${targetsHTML(d, { numbers: true })}</div>
        <div class="stack">${details}
          ${recordFormHTML('drill', d)}
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
    d.targetDistances = (d.targetDistances || []).slice(0, d.targetCount);
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
          <p class="hint">Tap a target to place an <b>X</b>; tap an X to remove it. Shots are numbered in the order you place them, so for a transition drill tap them in the order they should be fired. With more than one target, set each target's distance under it (blank uses the drill distance).</p>
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
        d.targetDistances.splice(t, 1);
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
      if (e.target.dataset.dist != null) {
        // Per-target distance; don't redraw (that would close the phone keyboard).
        const v = num(e.target.value);
        d.targetDistances[+e.target.dataset.dist] = v === null ? null : Math.round(v);
      }
      if (e.target.name === 'distance') {
        // Blank target distances show the drill distance as their placeholder.
        $$('[data-dist]', area).forEach(inp => { inp.placeholder = f.distance.value || '–'; });
      }
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
        targetDistances: d.targetCount > 1
          ? Array.from({ length: d.targetCount }, (_, t) => (d.targetDistances[t] == null ? null : d.targetDistances[t]))
          : null,
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
          const best = rankRuns(runsFor('stage', s.id), modeOf('stage', s))[0];
          const targets = objs.filter(o => o.type === 'target' || o.type === 'steel').length;
          return `<a class="card item-card stage-card" href="#/stages/${esc(s.id)}">
            <div class="thumb">${Stage.svg(objs)}</div>
            <div class="item-body">
              <h3>${esc(s.name)}</h3>
              <div class="meta"><span class="pill">${Stage.rounds(objs)} rds min</span><span>${targets} target${targets === 1 ? '' : 's'}</span></div>
              <div class="best">${best ? `🏆 ${fmtScore(scoreOf(best.best, modeOf('stage', s)), modeOf('stage', s))}${unitOf(modeOf('stage', s))} — ${esc(best.shooter)}` : '<span class="muted">No times yet</span>'}</div>
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
    const hasMoving = boxes.some(b => Stage.boxKind(b) === 'moving');
    const boxTag = b => `<span class="tag tag-box${Stage.boxKind(b) === 'moving' ? ' moving' : ''}">Box ${esc(b.label)}</span>`;
    const boxKey = hasMoving ? `<div class="map-key">${Object.keys(Stage.BOX_KINDS).map(k => {
      const kind = Stage.BOX_KINDS[k];
      return `<span><span class="box-swatch" style="border-color:${kind.stroke};background:linear-gradient(${kind.fill},${kind.fill}),#c9ad84"></span>${kind.name}</span>`;
    }).join('')}</div>` : '';
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
          <div class="card bay-card" id="stage-map">${Stage.svg(objs, { className: 'clickable' })}${boxKey}</div>
          <div class="callout" id="obj-note"><span class="muted">Tap a target or route arrow on the map to see its instructions.</span></div>
        </div>
        <div class="stack">
          <div class="stats-row tight">
            <div class="stat-card accent"><span class="value">${Stage.rounds(objs)}</span><span class="label">Min rounds</span></div>
            <div class="stat-card"><span class="value">${shootable.length}</span><span class="label">Targets</span></div>
            <div class="stat-card"><span class="value">${noShoots}</span><span class="label">No-shoots</span></div>
          </div>
          <div class="scoring-note">${s.scoring === 'hf' ? '🎯 Scored by <b>hit factor</b> (USPSA): points ÷ time, highest wins.' : '⏱ Scored by <b>time plus</b>: raw time + penalties, fastest wins.'}
          </div>
          <div class="card"><h3>Stage procedure</h3><div class="instructions">${s.description ? nl2br(s.description) : '<em class="muted">No procedure written.</em>'}</div></div>
          ${shootable.length ? `<div class="card"><h3>Targets</h3>
            <table class="table target-table" id="target-table"><thead><tr><th>Target</th><th class="num">Shots</th><th>Where to shoot</th></tr></thead><tbody>
            ${shootable.map(o => `<tr data-id="${esc(o.id)}"><td><span class="tag tag-${o.type}">${esc(o.label || Stage.TYPES[o.type].name)}</span></td><td class="num strong">${o.shots || 0}</td><td>${esc(o.note) || '<span class="muted">—</span>'}</td></tr>`).join('')}
            </tbody></table></div>` : ''}
          ${boxes.some(b => b.note) || hasMoving ? `<div class="card"><h3>Shooting positions</h3><ul class="plain">
            ${boxes.filter(b => b.note || Stage.boxKind(b) === 'moving').map(b => `<li>${boxTag(b)} ${Stage.boxKind(b) === 'moving' ? '<strong>Shooting on the move.</strong> ' : ''}${esc(b.note)}</li>`).join('')}</ul></div>` : ''}
          ${recordFormHTML('stage', s)}
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
        ${o.type === 'box' ? `<span class="pill${Stage.boxKind(o) === 'moving' ? ' danger' : ''}">${Stage.BOX_KINDS[Stage.boxKind(o)].name}</span>` : ''}
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
        <label>Scoring <select name="scoring">
          <option value="time"${s.scoring === 'hf' ? '' : ' selected'}>Time plus (fastest final time wins)</option>
          <option value="hf"${s.scoring === 'hf' ? ' selected' : ''}>Hit factor, USPSA (points ÷ time, highest wins)</option>
        </select></label>
        <p class="hint">Changing scoring later only changes how runs are ranked: runs scored the other way stay in the history but aren't compared.</p>
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
          <div class="field"><span class="field-label">Box type</span>
            <span class="seg">${Object.keys(Stage.BOX_KINDS).map(k => {
              const kind = Stage.BOX_KINDS[k];
              return `<button type="button" class="seg-btn${Stage.boxKind(o) === k ? ' on' : ''}" data-box-kind="${k}" aria-pressed="${Stage.boxKind(o) === k}">
                <span class="box-swatch" style="border-color:${kind.stroke};background:linear-gradient(${kind.fill},${kind.fill}),#c9ad84"></span>${kind.short}</button>`;
            }).join('')}</span>
          </div>
          <label>Width <span class="range-row"><input data-prop="w" type="range" min="20" max="300" step="5" value="${o.w}"><span class="val">${yd(o.w)}</span></span></label>
          <label>Depth <span class="range-row"><input data-prop="h" type="range" min="20" max="300" step="5" value="${o.h}"><span class="val">${yd(o.h)}</span></span></label>` : ''}
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
      $$('[data-box-kind]', p).forEach(b => b.addEventListener('click', () => {
        o.boxType = b.dataset.boxKind;
        $$('[data-box-kind]', p).forEach(x => {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-pressed', String(x === b));
        });
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
      const data = { name, description: form.elements.description.value.trim(), objects: s.objects, scoring: form.elements.scoring.value === 'hf' ? 'hf' : 'time' };
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

  function itemOfValue(v) {
    const i = String(v || '').indexOf(':');
    const kind = String(v).slice(0, i), id = String(v).slice(i + 1);
    return { kind, id, item: i > 0 ? itemFor(kind, id) : null };
  }
  // Today's range-day plan, if one is set for today and has items that still exist.
  function todaysPlan() {
    const rd = Store.settings().rangeDay;
    if (!rd || rd.date !== today()) return null;
    const items = (rd.items || []).filter(v => itemOfValue(v).item);
    const shooters = (rd.shooters || []).filter(id => Store.get('members', id));
    return items.length || shooters.length ? Object.assign({}, rd, { items, shooters }) : null;
  }

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

    const plan = todaysPlan();
    const planItems = plan ? plan.items : [];
    let saved = '';
    try { saved = localStorage.getItem(ITEM_KEY) || ''; } catch (e) { /* ignore */ }
    let current = [m && m[1], planItems.length && !planItems.includes(saved) ? planItems[0] : saved].find(v => v && itemOfValue(v).item)
      || planItems[0] || (drills.length ? 'drill:' + drills[0].id : 'stage:' + stages[0].id);

    const opt = (v, name) => `<option value="${esc(v)}">${esc(name)}</option>`;
    app.innerHTML = `
      <div class="page-head"><div><p class="eyebrow">Record</p><h1>Record times</h1></div>
        <a class="btn sm" href="#/plan">📋 ${plan ? "Today's plan" : 'Plan a range day'}</a></div>
      <div class="record-page">
        <div class="card pick-card">
          <label>Drill or stage
            <select id="item-pick">
              ${planItems.length ? `<optgroup label="Today's plan">${planItems.map((v, i) => opt(v, `${i + 1}. ${itemOfValue(v).item.name}`)).join('')}</optgroup>` : ''}
              ${drills.filter(d => !planItems.includes('drill:' + d.id)).length ? `<optgroup label="Drills">${drills.filter(d => !planItems.includes('drill:' + d.id)).map(d => opt('drill:' + d.id, d.name)).join('')}</optgroup>` : ''}
              ${stages.filter(st => !planItems.includes('stage:' + st.id)).length ? `<optgroup label="Stages">${stages.filter(st => !planItems.includes('stage:' + st.id)).map(st => opt('stage:' + st.id, st.name)).join('')}</optgroup>` : ''}
            </select>
          </label>
          <div class="item-info" id="item-info"></div>
          <div id="plan-slot"></div>
        </div>
        <div id="record-slot"></div>
        <div id="today-slot"></div>
      </div>`;

    // Has this member shot the current item today?
    function shotToday(memberId) {
      const { kind, id } = itemOfValue(current);
      const mem = Store.get('members', memberId);
      return runsFor(kind, id).some(r => r.date === today() && (r.memberId === memberId || (!r.memberId && mem && shooterKey(r.shooter) === shooterKey(mem.name))));
    }
    function selectShooter(memberId) {
      const sel = $('#record-form select[name="member"]');
      if (!sel || !memberId) return;
      sel.value = memberId;
      sel.dispatchEvent(new Event('change'));
      drawPlan();
    }

    // Plan progress and the shooting order (tap a name to pick them).
    function drawPlan() {
      const slot = $('#plan-slot');
      if (!plan) { slot.innerHTML = ''; return; }
      const idx = planItems.indexOf(current);
      const nextItem = idx >= 0 && idx < planItems.length - 1 ? planItems[idx + 1] : null;
      const sel = $('#record-form select[name="member"]');
      const doneCount = plan.shooters.filter(shotToday).length;
      slot.innerHTML = `<div class="plan-box">
        ${idx >= 0 ? `<div class="plan-nav"><span>📋 Plan: ${idx + 1} of ${planItems.length}</span>
          ${nextItem ? `<button type="button" class="btn sm${plan.shooters.length && doneCount === plan.shooters.length ? ' primary' : ''}" id="plan-next">Next: ${esc(itemOfValue(nextItem).item.name)} ›</button>` : '<span class="muted small">Last item in the plan</span>'}</div>` : ''}
        ${plan.shooters.length ? `<div class="order"><span class="muted small">Shooting order · ${doneCount} of ${plan.shooters.length} done</span>
          <div class="order-chips">${plan.shooters.map((mid, i) => {
            const mem = Store.get('members', mid);
            const done = shotToday(mid);
            return `<button type="button" class="chip order-chip${done ? ' done' : ''}${sel && sel.value === mid ? ' active' : ''}" data-order="${esc(mid)}">${done ? '✓' : i + 1 + '.'} ${esc(mem.name)}</button>`;
          }).join('')}</div></div>` : ''}
      </div>`;
      const nb = $('#plan-next');
      if (nb) nb.addEventListener('click', () => { pick.value = nextItem; pick.dispatchEvent(new Event('change')); });
      $$('[data-order]', slot).forEach(b => b.addEventListener('click', () => selectShooter(b.dataset.order)));
    }

    // After a save, move on to the next shooter in the order who hasn't shot this item yet.
    function afterSave(run) {
      if (!plan || !plan.shooters.length) return;
      const order = plan.shooters;
      const from = order.indexOf(run.memberId);
      for (let k = 1; k <= order.length; k++) {
        const mid = order[(from + k + order.length) % order.length];
        if (!shotToday(mid)) { selectShooter(mid); return; }
      }
      const idx = planItems.indexOf(current);
      const nextItem = idx >= 0 && idx < planItems.length - 1 ? planItems[idx + 1] : null;
      toast(nextItem ? `Everyone has shot this one. Next up: ${itemOfValue(nextItem).item.name}` : 'Everyone has shot this one. 🎉');
      drawPlan();
    }

    function mountForm() {
      const { kind, id, item } = itemOfValue(current);
      $('#item-info').innerHTML = kind === 'drill'
        ? `<span class="pill">Par ${fmtTime(item.par)}s</span>${item.rounds ? `<span>${esc(item.rounds)} rds</span>` : ''}${distanceText(item) ? `<span>${distanceText(item)}</span>` : ''}<a href="#/drills/${esc(id)}">View drill →</a>`
        : `<span class="pill">${Stage.rounds(item.objects)} rds min</span>${item.scoring === 'hf' ? '<span class="pill">Hit factor</span>' : ''}<a href="#/stages/${esc(id)}">View stage →</a>`;
      $('#record-slot').innerHTML = recordFormHTML(kind, item);
      bindRecordForm(kind, () => itemFor(kind, id), afterSave);
      const sel = $('#record-form select[name="member"]');
      if (sel) sel.addEventListener('change', drawPlan);
      if (plan && plan.shooters.length) {
        const first = plan.shooters.find(mid => !shotToday(mid));
        if (first) selectShooter(first);
      }
      drawPlan();
      drawToday();
    }

    // Today's results for the picked item, plus the latest entries so mistakes are easy to spot and delete.
    function drawToday() {
      const { kind, id, item } = itemOfValue(current);
      if (!item) return;
      const runs = runsFor(kind, id).filter(r => r.date === today());
      const mode = modeOf(kind, item);
      const ranked = rankRuns(runs, mode);
      const par = kind === 'drill' ? num(item.par) : null;
      const latest = runs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);
      $('#today-slot').innerHTML = `<div class="card">
        <h3>Today · ${esc(item.name)} <span class="count">${runs.length}</span></h3>
        ${ranked.length ? `
          <table class="table"><thead><tr><th></th><th>Shooter</th><th class="num">${mode === 'hf' ? 'Best HF' : 'Best'}</th>${par ? '<th class="num">vs Par</th>' : ''}<th class="num">Runs</th></tr></thead><tbody>
          ${ranked.map((r, i) => `<tr${i === 0 ? ' class="first"' : ''}><td class="rank">${medal(i)}</td><td>${shooterLink(r.shooter, r.best.memberId)}${divNote(r.best)}</td>
            <td class="num">${timeCell(r.best)}</td>${par ? `<td class="num">${vsPar(r.best.time, par)}</td>` : ''}<td class="num muted">${r.attempts}</td></tr>`).join('')}
          </tbody></table>` : ''}
        ${latest.length ? `
          <h4 class="mini-title">Latest entries</h4>
          <ul class="entry-list">${latest.map(r => `<li>
            <span class="who">${esc(r.shooter)}</span>
            <span class="t">${timeCell(r)}</span>
            <button class="icon-btn" data-del-time="${esc(r.id)}" title="Delete this run" aria-label="Delete ${esc(r.shooter)}'s run">×</button>
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
    pageRefresh = () => { if (itemOfValue(current).item) { drawToday(); drawPlan(); } else renderRecord(); };
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
  // Line chart of a shooter's best score per range day, with optional par and goal lines.
  // mode 'time': lower is better, the PB is the lowest point. mode 'hf': higher is better.
  // Single series, so no legend; hover/tap shows the day's details.
  function drawTrend(el, sessions, par, mode, goal) {
    const hf = mode === 'hf';
    const W = Math.max(260, el.clientWidth), H = 180;
    const pad = { l: 44, r: 16, t: 22, b: 26 };
    const xs = sessions.map(s => parseISO(s.date).getTime());
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (x0 === x1) { x0 -= 864e5; x1 += 864e5; }
    const vals = sessions.map(s => s.best).concat(par ? [par] : [], goal ? [goal] : []);
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
    const pb = pts.reduce((a, b) => ((hf ? b.s.best > a.s.best : b.s.best < a.s.best) ? b : a));
    const pbAnchor = pb.x > W - 60 ? 'end' : pb.x < pad.l + 30 ? 'start' : 'middle';
    // The PB is the lowest point (time) or highest (HF), so the space beyond it is clear of the line.
    const pbY = hf ? pb.y - 10 : pb.y + 18;
    const fmt = v => fmtScore(v, mode);
    const dateLabel = d => parseISO(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const first = sessions[0], last = sessions[sessions.length - 1];

    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Best ${hf ? 'hit factor' : 'time'} per range day, ${sessions.length} days, personal best ${fmt(pb.s.best)}">
      <g class="grid">${ticks.map(v => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('')}</g>
      <g class="axis">${ticks.map(v => `<text x="${pad.l - 8}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(dec)}</text>`).join('')}
        <text x="${pts[0].x}" y="${H - 6}" text-anchor="${sessions.length > 1 ? 'start' : 'middle'}">${dateLabel(first.date)}</text>
        ${sessions.length > 1 ? `<text x="${pts[pts.length - 1].x}" y="${H - 6}" text-anchor="end">${dateLabel(last.date)}</text>` : ''}
      </g>
      ${par ? `<line class="par-line" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(par)}" y2="${Y(par)}"/>
        <text class="par-label" x="${W - pad.r}" y="${Y(par) - 5}" text-anchor="end">Par ${fmtTime(par)}</text>` : ''}
      ${goal ? `<line class="goal-line" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(goal)}" y2="${Y(goal)}"/>
        <text class="goal-label" x="${pad.l + 4}" y="${Y(goal) - 5}" text-anchor="start">Goal ${fmt(goal)}</text>` : ''}
      <path class="trend-line" d="${pts.map((p, i) => (i ? 'L' : 'M') + p.x + ',' + p.y).join(' ')}"/>
      <line class="crosshair" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
      ${pts.map((p, i) => `<circle class="trend-dot${p === pb ? ' pb' : ''}" data-i="${i}" cx="${p.x}" cy="${p.y}" r="${p === pb ? 5.5 : 4}"/>`).join('')}
      <text class="pb-label" x="${pb.x}" y="${pbY}" text-anchor="${pbAnchor}">PB ${fmt(pb.s.best)}</text>
      <rect class="hover-zone" x="${pad.l - 10}" y="0" width="${W - pad.l - pad.r + 20}" height="${H}"/>
    </svg><div class="chart-tip" hidden></div>`;

    const svg = $('svg', el), tip = $('.chart-tip', el), cross = $('.crosshair', el);

    // Keep reference-line labels off the PB label: move a colliding label to the other end of its line.
    const pbBox = $('.pb-label', el).getBBox();
    const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    [['.par-label', pad.l + 4, 'start'], ['.goal-label', W - pad.r, 'end']].forEach(([sel, x, anchor]) => {
      const lbl = $(sel, el);
      if (lbl && overlaps(lbl.getBBox(), pbBox)) { lbl.setAttribute('x', x); lbl.setAttribute('text-anchor', anchor); }
    });
    function show(e) {
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      let best = 0;
      pts.forEach((p, i) => { if (Math.abs(p.x - px) < Math.abs(pts[best].x - px)) best = i; });
      const p = pts[best];
      cross.setAttribute('x1', p.x); cross.setAttribute('x2', p.x); cross.setAttribute('visibility', 'visible');
      $$('.trend-dot', el).forEach(d => d.classList.toggle('on', +d.dataset.i === best));
      tip.innerHTML = `<strong>${fmtDate(p.s.date)}</strong><span>Best ${hf ? 'HF ' + fmtHF(p.s.best) : fmtTime(p.s.best) + 's'}${par ? ' · ' + vsPar(p.s.best, par) : ''}</span>
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

  // Goal progress for one drill/stage on a member's history card.
  function goalHTML(it, goal, canEdit) {
    const hf = it.mode === 'hf';
    const unit = hf ? ' HF' : 's';
    let view;
    if (goal == null) {
      view = canEdit ? '<button type="button" class="link-btn" data-goal-edit>🎯 Set a goal</button>' : '';
    } else {
      const met = hf ? it.best >= goal : it.best <= goal;
      const start = it.sessions[0].best;
      const total = hf ? goal - start : start - goal;
      const done = hf ? it.best - start : start - it.best;
      const pct = met ? 100 : total > 0 ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
      const left = Math.abs(goal - it.best);
      view = `<div class="goal-line-text"><span>🎯 Goal <b>${fmtScore(goal, it.mode)}${unit}</b></span>
          <span class="${met ? 'goal-met' : 'muted'}">${met ? 'Goal met! ✅' : `${fmtScore(left, it.mode)}${unit} to go`}</span>
          ${canEdit ? '<button type="button" class="link-btn" data-goal-edit>Edit</button>' : ''}</div>
        <div class="goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>`;
    }
    if (!view) return '';
    return `<div class="goal" data-goal="${esc(it.kind + ':' + it.id)}">
      <div class="goal-view">${view}</div>
      ${canEdit ? `<form class="goal-form" hidden>
        <input type="number" min="0" step="${hf ? '0.0001' : '0.01'}" inputmode="decimal" value="${goal == null ? '' : goal}" placeholder="${hf ? 'e.g. 5.0000' : 'e.g. ' + fmtTime(it.best * 0.95)}" aria-label="Goal">
        <span class="muted">${hf ? 'HF' : 'sec'}</span>
        <button class="btn sm primary" type="submit">Save</button>
        ${goal != null ? '<button class="btn sm" type="button" data-goal-clear>Clear</button>' : ''}
        <button class="btn sm" type="button" data-goal-cancel>Cancel</button>
      </form>` : ''}
    </div>`;
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
        <label class="who-label">Shooter ${picker}</label></div>${divChipsHTML()}`;

      if (!who) {
        app.innerHTML = head + emptyState('📈', 'No shooters yet', 'Add members and record some times to see their progress here.', '<a class="btn primary" href="#/members">Go to members</a>');
        bindPicker();
        return;
      }

      const key = shooterKey(who.name);
      const member = who.memberId ? Store.get('members', who.memberId) : null;
      const goals = (member && member.goals) || {};
      const runs = byDivision(Store.all('times').filter(r => {
        if (who.memberId && r.memberId === who.memberId) return true;
        // Runs saved by name (before the member existed, or for guests).
        return shooterKey(r.shooter) === key && (!r.memberId || !Store.get('members', r.memberId));
      }));

      if (!runs.length) {
        app.innerHTML = head + emptyState('⏱', `No times for ${esc(who.name)} yet${divFilter !== 'all' ? ' with this gun' : ''}`, 'Once they record a drill or stage, their progress shows up here.', '<a class="btn primary" href="#/record">Record a time</a>');
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
        const mode = modeOf(r0.kind, item);
        const hf = mode === 'hf';
        const scored = list2.filter(r => isHF(r) === hf);
        if (!scored.length) return null;
        const par = r0.kind === 'drill' ? num(item ? item.par : r0.par) : null;
        const byDay = new Map();
        scored.forEach(r => {
          const v = scoreOf(r, mode);
          const d = byDay.get(r.date) || { date: r.date, best: v, count: 0 };
          if (hf ? v > d.best : v < d.best) d.best = v;
          d.count++;
          byDay.set(r.date, d);
        });
        const sessions = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
        const sorted = scored.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
        const vals = sorted.map(r => scoreOf(r, mode));
        const groupRank = rankRuns(byDivision(runsFor(r0.kind, r0.itemId)), mode);
        const rank = groupRank.findIndex(g => shooterKey(g.shooter) === key) + 1;
        if (rank === 1) recordsHeld++;
        return {
          kind: r0.kind, id: r0.itemId, exists: !!item, name: item ? item.name : r0.itemName, par, mode, sessions,
          count: scored.length, best: hf ? Math.max(...vals) : Math.min(...vals),
          avg: vals.reduce((a, b) => a + b, 0) / vals.length,
          latest: scoreOf(sorted[sorted.length - 1], mode),
          underPar: par ? scored.filter(r => r.time <= par).length : null,
          rank, of: groupRank.length,
          change: sessions.length > 1 ? sessions[sessions.length - 1].best - sessions[0].best : null,
          lastDate: sessions[sessions.length - 1].date,
        };
      }).filter(Boolean).sort((a, b) => b.lastDate.localeCompare(a.lastDate) || a.name.localeCompare(b.name));

      // ---- overall ----
      const days = new Set(runs.map(r => r.date));
      const drillRuns = runs.filter(r => r.kind === 'drill');
      const parFor = r => { const it = itemFor('drill', r.itemId); return num(it ? it.par : r.par); };
      const parRuns = drillRuns.filter(r => parFor(r));
      const underParPct = parRuns.length ? Math.round(parRuns.filter(r => r.time <= parFor(r)).length / parRuns.length * 100) : null;
      const hfPen = { miss: 'm', ns: 'ns', proc: 'p' }; // hit-factor runs record these as hits
      const penCount = (r, key) => ((r.pen || {})[key] || 0) + (isHF(r) && hfPen[key] ? ((r.hits || {})[hfPen[key]] || 0) : 0);
      const clean = runs.filter(r => !(r.penTime > 0) && !Object.keys(hfPen).some(k => penCount(r, k) > 0)).length;
      const penTotals = Store.PENALTIES.map(p => ({ p, n: runs.reduce((sum, r) => sum + penCount(r, p.key), 0) })).filter(x => x.n > 0);
      const penSeconds = runs.reduce((sum, r) => sum + (r.penTime || 0), 0);
      const recent = runs.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 30);

      const trend = it => {
        if (it.change === null) return '<span class="trend flat">Shoot it on another day to see a trend</span>';
        const tiny = it.mode === 'hf' ? 0.00005 : 0.005;
        if (Math.abs(it.change) < tiny) return '<span class="trend flat">→ Same best as the first day</span>';
        const better = it.mode === 'hf' ? it.change > 0 : it.change < 0;
        const amount = it.mode === 'hf' ? `${fmtHF(Math.abs(it.change))} HF ${better ? 'higher' : 'lower'}` : `${fmtTime(Math.abs(it.change))}s ${better ? 'faster' : 'slower'}`;
        return `<span class="trend ${better ? 'up' : 'down'}">${better ? '▲ ' : '▼ '}${amount} since ${fmtShort(it.sessions[0].date)}</span>`;
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
              <span class="kind ${it.kind}">${it.kind === 'drill' ? 'Drill' : it.mode === 'hf' ? 'Stage · HF' : 'Stage'}</span>
            </div>
            ${trend(it)}
            <div class="mini-stats">
              <div><span class="label">Best</span><span class="value">${fmtScore(it.best, it.mode)}</span></div>
              <div><span class="label">Average</span><span class="value">${fmtScore(it.avg, it.mode)}</span></div>
              <div><span class="label">Latest</span><span class="value">${fmtScore(it.latest, it.mode)}</span></div>
              <div><span class="label">Rank</span><span class="value">${it.rank ? `${it.rank === 1 ? '🏆 ' : ''}#${it.rank}<small> of ${it.of}</small>` : '—'}</span></div>
            </div>
            ${goalHTML(it, num(goals[it.kind + ':' + it.id]), !!member)}
            ${it.sessions.length > 1 ? `<div class="chart-caption">${it.mode === 'hf' ? 'Best hit factor each range day · higher is better' : `Best time each range day${it.par ? ' · lower is faster' : ' (seconds, lower is faster)'}`}</div><div class="trend-chart" data-chart="${i}"></div>` : ''}
            <p class="muted small">${it.count} run${it.count === 1 ? '' : 's'} over ${it.sessions.length} day${it.sessions.length === 1 ? '' : 's'}${it.par ? ` · ${it.underPar} under par (${Math.round(it.underPar / it.count * 100)}%)` : ''}</p>
          </div>`).join('')}
        </div>

        <div class="two-col even">
          <div class="card">
            <h3>Penalties</h3>
            ${penTotals.length ? `
              ${penSeconds > 0 ? `<p class="muted small">${fmtTime(penSeconds)}s of time penalties over ${runs.length} runs, an average of ${fmtTime(penSeconds / runs.length)}s per run.</p>` : ''}
              <table class="table"><thead><tr><th>Type</th><th class="num">Count</th><th class="num">Per run</th></tr></thead><tbody>
              ${penTotals.sort((a, b) => b.n - a.n).map(x => `<tr><td>${x.p.label}</td><td class="num strong">${x.n}</td><td class="num">${(x.n / runs.length).toFixed(2)}</td></tr>`).join('')}
              </tbody></table>`
            : '<p class="muted">No penalties recorded. 🎯</p>'}
          </div>
          <div class="card">
            <h3>Recent runs <span class="count">${runs.length}</span></h3>
            <div class="scroll"><table class="table"><thead><tr><th>Date</th><th>Drill / stage</th><th class="num">Score</th></tr></thead><tbody>
            ${recent.map(r => {
              const it = itemFor(r.kind, r.itemId);
              const par = r.kind === 'drill' ? num(it ? it.par : r.par) : null;
              return `<tr><td><a href="#/day/${r.date}">${fmtShort(r.date)}</a></td>
                <td>${esc(it ? it.name : r.itemName)}${par && !isHF(r) ? `<span class="sub">${vsPar(r.time, par)} vs par</span>` : ''}${divNote(r)}</td>
                <td class="num">${timeCell(r)}</td></tr>`;
            }).join('')}
            </tbody></table></div>
            ${runs.length > recent.length ? `<p class="muted small">Showing the latest ${recent.length}.</p>` : ''}
          </div>
        </div>`;

      bindPicker();
      if (member) bindGoals(member);
      drawCharts();
      function drawCharts() {
        $$('.trend-chart').forEach(el => {
          const it = items[+el.dataset.chart];
          drawTrend(el, it.sessions, it.par, it.mode, num(goals[it.kind + ':' + it.id]));
        });
      }
      redraw = drawCharts;
    };

    function bindPicker() {
      $('#who-pick').addEventListener('change', e => { if (e.target.value) location.hash = e.target.value; });
    }

    // Goals are stored on the member: goals['drill:<id>'] = target (null when cleared).
    function bindGoals(member) {
      const save = (key, value) => {
        const cur = Store.get('members', member.id) || member;
        const goals = Object.assign({}, cur.goals || {}, { [key]: value });
        Store.update('members', member.id, { name: cur.name, goals });
      };
      $$('.goal').forEach(box => {
        const key = box.dataset.goal;
        const form = $('.goal-form', box);
        const view = $('.goal-view', box);
        const editBtn = $('[data-goal-edit]', box);
        if (!form || !editBtn) return;
        editBtn.addEventListener('click', () => { view.hidden = true; form.hidden = false; $('input', form).focus(); });
        $('[data-goal-cancel]', form).addEventListener('click', () => { form.hidden = true; view.hidden = false; });
        const clear = $('[data-goal-clear]', form);
        if (clear) clear.addEventListener('click', () => { save(key, null); toast('Goal cleared'); });
        form.addEventListener('submit', e => {
          e.preventDefault();
          const v = num($('input', form).value);
          if (v === null || v <= 0) return;
          save(key, v);
          toast('Goal saved 🎯');
        });
      });
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
    const st = Store.settings();
    const pens = st.penalties;
    let divs = st.divisions.slice();
    app.innerHTML = `
      <div class="page-head"><div><p class="eyebrow">Settings</p><h1>Settings</h1></div></div>
      <div class="stack settings-page">
        <form class="card settings-card" id="settings-form" autocomplete="off">
          <h3>Penalties</h3>
          <p class="muted">Seconds added to the raw time for each one (time-plus scoring). Set a penalty to 0 to turn it off; it won't appear on the record form.</p>
          <div class="settings-grid">
            ${Store.PENALTIES.map(p => `<label>${p.label}${p.stageOnly ? ' <span class="muted small">(stages only)</span>' : ''}
              <span class="input-suffix"><input name="${p.key}" type="number" min="0" max="60" step="0.05" inputmode="decimal" required value="${fmtSec(pens[p.key])}"><span>sec</span></span>
            </label>`).join('')}
          </div>
          <p class="hint">Changes apply to times recorded from now on. Times already saved keep the penalties they were scored with.</p>
          <div class="actions">
            <button class="btn primary" type="submit">Save penalties</button>
            <button class="btn" type="button" id="defaults">Restore defaults</button>
          </div>
        </form>

        <div class="card settings-card">
          <h3>Gun types</h3>
          <p class="muted">Shooters pick one when recording a time, and leaderboards can be filtered by it.</p>
          <ul class="gun-list" id="gun-list"></ul>
          <form class="gun-add" id="gun-add" autocomplete="off">
            <input name="gun" maxlength="30" placeholder="Add a gun type, e.g. Revolver" aria-label="New gun type">
            <button class="btn" type="submit">Add</button>
          </form>
          <p class="hint">Removing a gun type here doesn't change runs already recorded with it.</p>
        </div>

        <div class="card settings-card">
          <h3>Export</h3>
          <p class="muted">Download your group's data, for a spreadsheet, a year-end recap or a backup.</p>
          <div class="actions">
            <button class="btn" type="button" id="export-csv">⬇ All times (spreadsheet .csv)</button>
            <button class="btn" type="button" id="export-json">⬇ Full backup (.json)</button>
          </div>
        </div>

        <div class="card settings-card">
          <h3>Range day</h3>
          <p class="muted">Set the next range day, what you'll shoot and the shooting order.</p>
          <a class="btn" href="#/plan">📋 Open range day plan</a>
        </div>

        <div class="admin-foot">
          ${Store.adminState().isAdmin
            ? `<span class="muted small">Admin: ${esc(Store.adminState().email)}</span>
               <a class="btn sm" href="#/admin">Waivers &amp; RSVPs</a>
               <button class="btn sm" type="button" id="settings-sign-out">Sign out</button>`
            : '<a class="admin-link" href="#/admin">Admin sign in</a>'}
        </div>
      </div>`;

    const so = $('#settings-sign-out');
    if (so) so.addEventListener('click', () => Store.signOut().then(() => { toast('Signed out'); renderSettings(); }));

    // ---- penalties ----
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
      toast('Penalties saved');
    });

    // ---- gun types (saved right away) ----
    function drawGuns() {
      $('#gun-list').innerHTML = divs.length ? divs.map((d, i) => `<li><span>${esc(d)}</span>
        <span class="plan-btns">
          <button type="button" class="icon-btn" data-gun-move="${i}" data-dir="-1" aria-label="Move ${esc(d)} up"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="icon-btn" data-gun-move="${i}" data-dir="1" aria-label="Move ${esc(d)} down"${i === divs.length - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" class="icon-btn" data-gun-remove="${i}" aria-label="Remove ${esc(d)}">×</button>
        </span></li>`).join('') : '<li class="muted">No gun types. The Gun choice is hidden on the record form.</li>';
    }
    const saveGuns = () => { Store.saveSettings({ divisions: divs }); drawGuns(); };
    $('#gun-list').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.gunMove != null) {
        const i = +b.dataset.gunMove, j = i + +b.dataset.dir;
        [divs[i], divs[j]] = [divs[j], divs[i]];
      } else if (b.dataset.gunRemove != null) {
        if (!confirm(`Remove "${divs[+b.dataset.gunRemove]}"?`)) return;
        divs.splice(+b.dataset.gunRemove, 1);
      } else return;
      saveGuns();
    });
    $('#gun-add').addEventListener('submit', e => {
      e.preventDefault();
      const inp = e.target.elements.gun;
      const v = inp.value.trim().replace(/\s+/g, ' ');
      if (!v) return;
      if (divs.some(d => d.toLowerCase() === v.toLowerCase())) { toast(`${v} is already listed`); return; }
      divs.push(v);
      inp.value = '';
      saveGuns();
      toast(`Added ${v}`);
    });
    drawGuns();

    // ---- export ----
    function download(name, text, type) {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    $('#export-csv').addEventListener('click', () => {
      const cell = v => {
        const t = v == null ? '' : String(v);
        return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      };
      const head = ['Date', 'Shooter', 'Gun', 'Type', 'Drill / stage', 'Scoring', 'Final time', 'Raw time', 'Penalty seconds',
        'A', 'C', 'D', 'Misses', 'No-shoots', 'Procedurals', 'Points', 'Hit factor', 'Power factor', 'Par', 'Notes'];
      const rows = Store.all('times').sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0)).map(r => {
        const it = itemFor(r.kind, r.itemId);
        const hf = isHF(r);
        const h = r.hits || {}, pen = r.pen || {};
        return [r.date, r.shooter, r.division || '', r.kind === 'drill' ? 'Drill' : 'Stage', it ? it.name : r.itemName,
          hf ? 'Hit factor' : 'Time plus', fmtTime(r.time), r.raw != null ? fmtTime(r.raw) : '', hf ? '' : fmtTime(r.penTime || 0),
          hf ? h.a || 0 : '', hf ? h.c || 0 : pen.c || 0, hf ? h.d || 0 : pen.d || 0, hf ? h.m || 0 : pen.miss || 0,
          hf ? h.ns || 0 : pen.ns || 0, hf ? h.p || 0 : pen.proc || 0, hf ? r.points : '', hf ? fmtHF(r.hf) : '', hf ? r.pf || '' : '',
          r.par != null ? fmtTime(r.par) : '', r.notes || ''].map(cell).join(',');
      });
      download(`range-log-times-${today()}.csv`, '﻿' + [head.join(',')].concat(rows).join('\r\n'), 'text/csv;charset=utf-8');
      toast(`Exported ${rows.length} runs`);
    });
    $('#export-json').addEventListener('click', () => {
      const data = { exported: new Date().toISOString(), settings: Store.settings() };
      ['drills', 'stages', 'members', 'times'].forEach(c => { data[c] = Store.all(c); });
      if (Store.adminState().isAdmin) data.adminRoster = Store.admin();
      download(`range-log-backup-${today()}.json`, JSON.stringify(data, null, 2), 'application/json');
      toast('Backup downloaded');
    });
  }

  /* =========================================================
   * Range day: next date, note, plan (drills/stages in order) and shooting order
   * ======================================================= */
  function rangeDayCardHTML() {
    const rd = Store.settings().rangeDay;
    if (!rd || !rd.date || rd.date < today()) return '';
    const isToday = rd.date === today();
    const items = (rd.items || []).map(itemOfValue).filter(x => x.item);
    const names = (rd.shooters || []).map(id => Store.get('members', id)).filter(Boolean).map(x => x.name);
    return `<div class="card range-day-card${isToday ? ' today' : ''}">
      <div class="rd-head">
        <span class="rd-icon" aria-hidden="true">📅</span>
        <div class="rd-title"><p class="eyebrow">${isToday ? 'Range day today' : 'Next range day'}</p><h3>${fmtDate(rd.date, true)}</h3></div>
        <a class="btn sm" href="#/plan">Edit</a>
      </div>
      ${rd.note ? `<p class="rd-note">${nl2br(rd.note)}</p>` : ''}
      ${items.length ? `<div class="rd-items">${items.map((x, i) => `<a class="chip" href="#/${x.kind}s/${esc(x.id)}">${i + 1}. ${esc(x.item.name)}</a>`).join('')}</div>` : ''}
      ${names.length ? `<p class="muted small">Shooting order: ${names.map(esc).join(', ')}</p>` : ''}
      ${(() => {
        if (!Store.adminState().isAdmin) return '';
        const a = Store.admin();
        const going = members().filter(x => (a.rsvps[rd.date] || {})[x.id]);
        const missing = going.filter(x => !a.waivers[x.id]).length;
        return `<a class="admin-line" href="#/admin/${rd.date}">🔒 Admin: ${going.length} coming${missing ? ` · <b>⚠️ ${missing} need${missing === 1 ? 's' : ''} a waiver</b>` : ' · all have waivers'} ›</a>`;
      })()}
      ${isToday && (items.length || names.length) ? '<a class="btn primary" href="#/record">⏱ Start recording</a>' : ''}
    </div>`;
  }

  function renderPlan() {
    const rd = Store.settings().rangeDay || {};
    const st = {
      date: rd.date && rd.date >= today() ? rd.date : today(),
      note: rd.note || '',
      items: (rd.items || []).filter(v => itemOfValue(v).item),
      shooters: (rd.shooters || []).filter(id => Store.get('members', id)),
    };
    const byName = (a, b) => a.name.localeCompare(b.name);

    app.innerHTML = `
      <a class="back" href="#/">← Today</a>
      <div class="page-head"><div><p class="eyebrow">Range day</p><h1>Range day plan</h1></div></div>
      <p class="muted plan-intro">Set the next range day, what you'll shoot, and the shooting order. It shows on the home page, and on the day the Record screen steps through it.</p>
      <form id="plan-form" class="stack plan-page" autocomplete="off">
        <div class="card">
          <div class="form-row">
            <label>Date <input name="date" type="date" required value="${st.date}"></label>
            <div></div>
          </div>
          <label>Note <textarea name="note" rows="3" maxlength="500" placeholder="e.g. 9 AM at Bay 3. Bring 150 rounds, eye and ear protection.">${esc(st.note)}</textarea></label>
        </div>
        <div class="card"><h3>Drills &amp; stages <span class="muted small">in the order you'll shoot them</span></h3><div id="plan-items"></div></div>
        <div class="card"><h3>Shooting order</h3><div id="plan-shooters"></div></div>
        <div class="form-actions">
          <button class="btn primary" type="submit">Save plan</button>
          ${rd.date ? '<button class="btn danger-outline" type="button" id="plan-clear">Clear plan</button>' : ''}
          <a class="btn" href="#/">Cancel</a>
        </div>
      </form>`;

    // An ordered list with ↑ ↓ ✕, plus buttons to add whatever isn't in it yet.
    function listEditor(el, key, all, label) {
      const chosen = st[key];
      const rest = all.filter(x => !chosen.includes(x.value));
      el.innerHTML = `
        ${chosen.length ? `<ol class="plan-list">${chosen.map((v, i) => `<li>
          <span class="plan-name">${esc(label(v))}</span>
          <span class="plan-btns">
            <button type="button" class="icon-btn" data-move="${i}" data-dir="-1" aria-label="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-move="${i}" data-dir="1" aria-label="Move down"${i === chosen.length - 1 ? ' disabled' : ''}>↓</button>
            <button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove">×</button>
          </span></li>`).join('')}</ol>` : '<p class="muted small">Nothing added yet.</p>'}
        ${rest.length ? `<div class="plan-add"><span class="muted small">Add:</span>${rest.map(x => `<button type="button" class="chip" data-add="${esc(x.value)}">+ ${esc(x.name)}</button>`).join('')}
          ${key === 'shooters' && rest.length > 1 ? '<button type="button" class="chip" data-add-all>+ Everyone</button>' : ''}</div>` : ''}
        ${key === 'shooters' && chosen.length > 1 ? '<p><button type="button" class="btn sm" data-shuffle>🔀 Shuffle order</button></p>' : ''}`;
      el.onclick = e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.move != null) {
          const i = +b.dataset.move, j = i + +b.dataset.dir;
          [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
        } else if (b.dataset.remove != null) chosen.splice(+b.dataset.remove, 1);
        else if (b.dataset.add != null) chosen.push(b.dataset.add);
        else if (b.hasAttribute('data-add-all')) rest.forEach(x => chosen.push(x.value));
        else if (b.hasAttribute('data-shuffle')) {
          for (let i = chosen.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [chosen[i], chosen[j]] = [chosen[j], chosen[i]]; }
        } else return;
        editorDirty = true;
        draw();
      };
    }
    function draw() {
      const allItems = Store.all('drills').sort(byName).map(d => ({ value: 'drill:' + d.id, name: d.name }))
        .concat(Store.all('stages').sort(byName).map(x => ({ value: 'stage:' + x.id, name: x.name + ' (stage)' })));
      listEditor($('#plan-items'), 'items', allItems, v => { const x = itemOfValue(v); return x.item.name + (x.kind === 'stage' ? ' (stage)' : ''); });
      const allPeople = members().map(x => ({ value: x.id, name: x.name }));
      listEditor($('#plan-shooters'), 'shooters', allPeople, id => (Store.get('members', id) || {}).name || '?');
      if (!allPeople.length) $('#plan-shooters').innerHTML = '<p class="muted small">Add members on the <a href="#/members">Members</a> page to set a shooting order.</p>';
    }
    draw();

    const form = $('#plan-form');
    form.addEventListener('input', () => { editorDirty = true; });
    form.addEventListener('submit', e => {
      e.preventDefault();
      Store.saveSettings({ rangeDay: { date: form.elements.date.value || today(), note: form.elements.note.value.trim(), items: st.items, shooters: st.shooters } });
      editorDirty = false;
      toast('Range day saved');
      location.hash = '#/';
    });
    const clear = $('#plan-clear');
    if (clear) clear.addEventListener('click', () => {
      if (!confirm('Clear the range day plan?')) return;
      Store.saveSettings({ rangeDay: null });
      editorDirty = false;
      toast('Plan cleared');
      location.hash = '#/';
    });
  }

  /* =========================================================
   * Season standings
   * ======================================================= */
  // Points for places on each drill/stage each range day; everyone who shoots it gets at least 1.
  const PLACE_POINTS = [10, 8, 6, 5, 4, 3, 2];

  function renderStandings(m) {
    const param = (m && m[1]) || 'm-' + today().slice(0, 7);
    const pad2 = n => String(n).padStart(2, '0');
    let from = '0000-00-00', to = '9999-12-31', label = 'All time', prev = null, next = null, kind = 'all';
    if (/^y-\d{4}$/.test(param)) {
      const y = +param.slice(2);
      kind = 'year'; from = `${y}-01-01`; to = `${y}-12-31`; label = String(y); prev = `y-${y - 1}`; next = `y-${y + 1}`;
    } else if (/^m-\d{4}-\d{2}$/.test(param)) {
      const [y, mo] = param.slice(2).split('-').map(Number);
      kind = 'month'; from = `${y}-${pad2(mo)}-01`; to = iso(new Date(y, mo, 0));
      label = new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      const p = new Date(y, mo - 2, 1), n = new Date(y, mo, 1);
      prev = `m-${p.getFullYear()}-${pad2(p.getMonth() + 1)}`; next = `m-${n.getFullYear()}-${pad2(n.getMonth() + 1)}`;
    }
    const thisMonth = 'm-' + today().slice(0, 7), thisYear = 'y-' + today().slice(0, 4);

    const render = () => {
      const runs = byDivision(Store.all('times').filter(r => r.date >= from && r.date <= to));
      const table = new Map();
      const entry = r => {
        const k = shooterKey(r.shooter);
        if (!table.has(k)) table.set(k, { name: r.shooter.trim(), memberId: r.memberId, points: 0, wins: 0, podiums: 0, days: new Set(), runs: 0 });
        return table.get(k);
      };
      runs.forEach(r => { const e = entry(r); e.days.add(r.date); e.runs++; });

      // Group runs by range day + drill/stage, rank each group, hand out points.
      const groups = new Map();
      runs.forEach(r => {
        const k = r.date + '|' + r.kind + ':' + r.itemId;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      groups.forEach(list => {
        const r0 = list[0];
        rankRuns(list, modeOf(r0.kind, itemFor(r0.kind, r0.itemId))).forEach((g, i) => {
          const e = entry(g.best);
          e.points += PLACE_POINTS[i] || 1;
          if (i === 0) e.wins++;
          if (i < 3) e.podiums++;
        });
      });
      const standings = [...table.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name));
      // Same points and wins = same place.
      standings.forEach((x, i) => {
        const p = standings[i - 1];
        x.place = p && p.points === x.points && p.wins === x.wins ? p.place : i;
      });

      // Most improved: average % change from first to last range day on each drill/stage shot on 2+ days.
      const improved = [];
      const perShooter = new Map();
      runs.forEach(r => {
        const k = shooterKey(r.shooter);
        if (!perShooter.has(k)) perShooter.set(k, { name: r.shooter.trim(), memberId: r.memberId, items: new Map() });
        const ps = perShooter.get(k);
        const ik = r.kind + ':' + r.itemId;
        if (!ps.items.has(ik)) ps.items.set(ik, []);
        ps.items.get(ik).push(r);
      });
      perShooter.forEach(ps => {
        const changes = [];
        ps.items.forEach(list => {
          const r0 = list[0];
          const mode = modeOf(r0.kind, itemFor(r0.kind, r0.itemId));
          const hf = mode === 'hf';
          const byDay = new Map();
          list.filter(r => isHF(r) === hf).forEach(r => {
            const v = scoreOf(r, mode);
            const cur = byDay.get(r.date);
            if (cur === undefined || (hf ? v > cur : v < cur)) byDay.set(r.date, v);
          });
          const daysSorted = [...byDay.keys()].sort();
          if (daysSorted.length < 2) return;
          const a = byDay.get(daysSorted[0]), b = byDay.get(daysSorted[daysSorted.length - 1]);
          if (!a) return;
          changes.push(hf ? (b - a) / a * 100 : (a - b) / a * 100);
        });
        if (changes.length) {
          const avg = changes.reduce((x, y) => x + y, 0) / changes.length;
          if (avg > 0) improved.push({ name: ps.name, memberId: ps.memberId, pct: avg, items: changes.length });
        }
      });
      improved.sort((a, b) => b.pct - a.pct);

      app.innerHTML = `
        <div class="page-head"><div><p class="eyebrow">Season standings</p><h1>${esc(label)}</h1></div>
          <div class="day-nav">
            ${prev ? `<a class="btn icon" href="#/standings/${prev}" aria-label="Previous">‹</a>` : ''}
            ${next ? `<a class="btn icon" href="#/standings/${next}" aria-label="Next">›</a>` : ''}
          </div>
        </div>
        <div class="chips">
          <a class="chip${param === thisMonth ? ' active' : ''}" href="#/standings/${thisMonth}">This month</a>
          <a class="chip${param === thisYear ? ' active' : ''}" href="#/standings/${thisYear}">This year</a>
          <a class="chip${kind === 'all' ? ' active' : ''}" href="#/standings/all">All time</a>
        </div>
        ${divChipsHTML()}
        ${standings.length ? `
          <div class="two-col">
            <div class="stack">
              <div class="card">
                <h3>🏆 Points</h3>
                <table class="table"><thead><tr><th></th><th>Shooter</th><th class="num">Points</th><th class="num">Wins</th><th class="num">Days</th></tr></thead><tbody>
                ${standings.map(x => `<tr${x.place === 0 ? ' class="first"' : ''}><td class="rank">${medal(x.place)}</td><td>${shooterLink(x.name, x.memberId)}</td>
                  <td class="num strong">${x.points}</td><td class="num">${x.wins}</td><td class="num muted">${x.days.size}</td></tr>`).join('')}
                </tbody></table>
                <p class="muted small">Each range day, every drill and stage awards ${PLACE_POINTS.join(' / ')} points for 1st–${PLACE_POINTS.length}th place, and 1 point for everyone else who shoots it.</p>
              </div>
            </div>
            <div class="stack">
              <div class="card">
                <h3>📈 Most improved</h3>
                ${improved.length ? `<ol class="improved">${improved.slice(0, 5).map(x => `<li>${shooterLink(x.name, x.memberId)}
                  <span class="trend up">▲ ${x.pct.toFixed(1)}%</span><span class="muted small">over ${x.items} drill${x.items === 1 ? '' : 's'}/stage${x.items === 1 ? '' : 's'}</span></li>`).join('')}</ol>
                  <p class="muted small">Average improvement from each shooter's first to last range day on every drill or stage they shot on at least two days in this period.</p>`
                : '<p class="muted">Shoot the same drill or stage on two different range days in this period to show up here.</p>'}
              </div>
            </div>
          </div>`
        : emptyState('🏆', 'No results in this period', 'Record some times and the standings fill in automatically.', '<a class="btn primary" href="#/record">Record times</a>')}`;
    };
    render();
    pageRefresh = render;
  }

  /* =========================================================
   * Dry fire timer — start beep after a random delay, par beep at the par time.
   * Deliberately labeled for dry fire only; live fire uses a real shot timer.
   * ======================================================= */
  const TIMER_KEY = 'rangelog-timer';
  function renderTimer(m) {
    const drill = m && m[1] && m[1].startsWith('drill:') ? Store.get('drills', m[1].slice(6)) : null;
    let prefs = { min: 1.5, max: 4, repeat: false };
    try { prefs = Object.assign(prefs, JSON.parse(localStorage.getItem(TIMER_KEY) || '{}')); } catch (e) { /* ignore */ }
    const par = drill ? num(drill.par) : num(prefs.par);

    app.innerHTML = `
      <a class="back" href="${drill ? '#/drills/' + esc(drill.id) : '#/drills'}">← ${drill ? esc(drill.name) : 'Drills'}</a>
      <div class="dry-banner" role="note"><strong>DRY FIRE ONLY.</strong> Unloaded gun, no ammunition in the room. For live fire, use a real shot timer.</div>
      <div class="timer-page">
        <div class="card timer-card" id="timer-card">
          <p class="eyebrow">Dry fire timer${drill ? ' · ' + esc(drill.name) : ''}</p>
          <div class="timer-display" id="t-display" aria-live="off">0.00</div>
          <div class="timer-status" id="t-status">Press Start, then wait for the beep</div>
          <button type="button" class="btn primary timer-start" id="t-start">Start</button>
          <p class="muted small" id="t-reps"></p>
        </div>
        <div class="card timer-settings">
          <h3>Settings</h3>
          <label>Par time (seconds) <input id="t-par" type="number" min="0.1" max="120" step="0.01" inputmode="decimal" value="${par ? fmtTime(par) : ''}" placeholder="No par beep"></label>
          <div class="form-row">
            <label>Random delay from (s) <input id="t-min" type="number" min="0" max="20" step="0.5" inputmode="decimal" value="${prefs.min}"></label>
            <label>to (s) <input id="t-max" type="number" min="0" max="20" step="0.5" inputmode="decimal" value="${prefs.max}"></label>
          </div>
          <label class="check"><input type="checkbox" id="t-repeat"${prefs.repeat ? ' checked' : ''}> Keep repeating (new rep a few seconds after each par)</label>
          <p class="hint">The start beep is high, the par beep is lower. On an iPhone, turn off silent mode to hear them. The screen also flashes for each beep.</p>
        </div>
      </div>`;

    const display = $('#t-display'), status = $('#t-status'), startBtn = $('#t-start'), card = $('#timer-card');
    let ctx = null, startAt = 0, repPar = null, raf = 0, nodes = [], timers = [], running = false, reps = 0, wakeLock = null;

    function audio() {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function beep(at, freq, dur) {
      const c = audio();
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.35, at + 0.01);
      g.gain.setValueAtTime(0.35, at + dur - 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(c.destination);
      o.start(at);
      o.stop(at + dur + 0.05);
      nodes.push(o);
    }
    function flash(cls, delayMs) {
      timers.push(setTimeout(() => {
        card.classList.add(cls);
        if (navigator.vibrate) navigator.vibrate(cls === 'flash-start' ? 120 : [60, 40, 60]);
        timers.push(setTimeout(() => card.classList.remove(cls), 250));
      }, delayMs));
    }
    function settings() {
      const p = num($('#t-par').value);
      let lo = Math.max(0, num($('#t-min').value) || 0), hi = Math.max(0, num($('#t-max').value) || 0);
      if (hi < lo) [lo, hi] = [hi, lo];
      const out = { par: p && p > 0 ? p : null, min: lo, max: hi, repeat: $('#t-repeat').checked };
      try { localStorage.setItem(TIMER_KEY, JSON.stringify(drill ? Object.assign({}, out, { par: prefs.par }) : out)); } catch (e) { /* ignore */ }
      return out;
    }
    function tick() {
      if (!running) return;
      const t = ctx.currentTime - startAt;
      if (t < 0) { display.textContent = '0.00'; status.textContent = 'Standby…'; }
      else {
        display.textContent = t.toFixed(2);
        status.textContent = repPar && t >= repPar ? 'Par' : 'Go!';
      }
      raf = requestAnimationFrame(tick);
    }
    function clearScheduled() {
      nodes.forEach(o => { try { o.stop(); } catch (e) { /* already stopped */ } });
      nodes = [];
      timers.forEach(clearTimeout);
      timers = [];
      cancelAnimationFrame(raf);
    }
    function startRep() {
      const cfg = settings();
      const c = audio();
      const delay = cfg.min + Math.random() * (cfg.max - cfg.min);
      startAt = c.currentTime + delay;
      repPar = cfg.par;
      beep(startAt, 2600, 0.35);
      flash('flash-start', delay * 1000);
      let end = delay + 2; // without a par, the clock runs until Stop
      if (cfg.par) {
        beep(startAt + cfg.par, 1500, 0.3);
        flash('flash-par', (delay + cfg.par) * 1000);
        end = delay + cfg.par + 0.6;
      }
      reps++;
      $('#t-reps').textContent = `Rep ${reps}`;
      if (cfg.par) {
        timers.push(setTimeout(() => {
          if (!running) return;
          if (cfg.repeat) { status.textContent = 'Reset… next rep coming'; timers.push(setTimeout(() => { if (running) startRep(); }, 3000)); }
          else stop(true);
        }, end * 1000));
      }
    }
    async function start() {
      running = true;
      startBtn.textContent = 'Stop';
      startBtn.classList.remove('primary');
      startBtn.classList.add('danger-outline');
      try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not supported */ }
      startRep();
      raf = requestAnimationFrame(tick);
    }
    function stop(finished) {
      running = false;
      clearScheduled();
      startBtn.textContent = 'Start';
      startBtn.classList.add('primary');
      startBtn.classList.remove('danger-outline');
      status.textContent = finished ? 'Done. Press Start for another rep' : 'Stopped';
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    }
    startBtn.addEventListener('click', () => (running ? stop(false) : start()));
    ['#t-par', '#t-min', '#t-max', '#t-repeat'].forEach(sel => $(sel).addEventListener('change', settings));
    pageCleanup = () => {
      if (running) stop(false);
      if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    };
  }

  /* =========================================================
   * Admin: waivers (signed with the range) and RSVPs for range days.
   * Only the signed-in admin can read or change this; Firestore rules enforce it.
   * ======================================================= */
  function authMessage(err) {
    const code = (err && err.code) || '';
    if (/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(code)) return 'Email or password is incorrect.';
    if (/too-many-requests/.test(code)) return 'Too many tries. Wait a few minutes and try again.';
    if (/network/.test(code)) return 'No connection. Check your signal and try again.';
    return (err && err.message) || 'Could not sign in.';
  }

  function adminSignInHTML(st) {
    if (st.signedIn && !st.isAdmin) {
      return `<div class="card admin-signin">
        <h3>Admin</h3>
        <div class="mode-banner error">${esc(st.error || 'Checking admin access…')}</div>
        <p class="muted small">Signed in as ${esc(st.email)}.${st.uid ? ` This account's User UID is <code class="uid">${esc(st.uid)}</code>` : ''}</p>
        <button class="btn" type="button" id="sign-out">Sign out</button>
      </div>`;
    }
    const demo = Store.mode === 'local';
    return `<form class="card admin-signin" id="sign-in-form" autocomplete="on">
      <h3>Admin sign in</h3>
      <p class="muted">For tracking waivers and RSVPs. Group members don't need to sign in.</p>
      ${demo ? '<p class="hint">Demo mode: no password needed.</p>' : `
        <label>Email <input name="email" type="email" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>`}
      <p class="form-error" id="sign-in-error" hidden></p>
      <button class="btn primary block" type="submit">Sign in${demo ? ' (demo)' : ''}</button>
    </form>`;
  }

  function bindAdminAuth() {
    const out = $('#sign-out');
    if (out) out.addEventListener('click', () => Store.signOut().then(() => toast('Signed out')));
    const form = $('#sign-in-form');
    if (!form) return;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('button[type="submit"]', form);
      const errEl = $('#sign-in-error');
      btn.disabled = true;
      errEl.hidden = true;
      try {
        await Store.signIn(form.elements.email ? form.elements.email.value.trim() : '', form.elements.password ? form.elements.password.value : '');
      } catch (err) {
        errEl.textContent = authMessage(err);
        errEl.hidden = false;
        btn.disabled = false;
      }
    });
  }

  function renderAdmin(m) {
    const render = () => {
      const st = Store.adminState();
      if (!st.isAdmin) {
        app.innerHTML = `<div class="page-head"><div><p class="eyebrow">Admin</p><h1>Waivers &amp; RSVPs</h1></div></div>${adminSignInHTML(st)}`;
        bindAdminAuth();
        return;
      }
      const rd = Store.settings().rangeDay;
      const date = (m && m[1]) || (rd && rd.date && rd.date >= today() ? rd.date : today());
      const a = Store.admin();
      const list = members();
      const going = a.rsvps[date] || {};
      const coming = list.filter(x => going[x.id]);
      const noWaiver = coming.filter(x => !a.waivers[x.id]);
      const isPlanDay = rd && rd.date === date;

      app.innerHTML = `
        <div class="page-head"><div><p class="eyebrow">Admin</p><h1>Waivers &amp; RSVPs</h1></div>
          <div class="actions"><span class="muted small">${esc(st.email)}</span><button class="btn sm" type="button" id="sign-out">Sign out</button></div></div>
        <div class="card admin-event">
          <div class="form-row">
            <label>Range day <input type="date" id="admin-date" value="${date}"></label>
            <div class="admin-day-note">${isPlanDay ? '📅 This is the planned range day.' : rd && rd.date && rd.date >= today() ? `Planned range day: <a href="#/admin/${rd.date}">${fmtDate(rd.date)}</a>` : ''}</div>
          </div>
          <div class="admin-summary">
            <span class="pill">${coming.length} coming</span>
            ${noWaiver.length ? `<span class="pill danger">⚠️ ${noWaiver.length} without a waiver: ${noWaiver.map(x => esc(x.name)).join(', ')}</span>`
              : coming.length ? '<span class="pill">✓ Everyone coming has a waiver</span>' : ''}
          </div>
        </div>
        ${list.length ? `<div class="card">
          <table class="table admin-table"><thead><tr><th>Member</th><th class="center">Waiver signed</th><th class="center">Coming ${fmtShort(date)}</th></tr></thead><tbody>
          ${list.map(x => {
            const w = a.waivers[x.id];
            const g = !!going[x.id];
            return `<tr${g && !w ? ' class="warn"' : ''}>
              <td class="strong">${esc(x.name)}${g && !w ? '<span class="sub warn-text">⚠️ Needs a waiver</span>' : ''}</td>
              <td class="center"><label class="check-cell"><input type="checkbox" data-waiver="${esc(x.id)}"${w ? ' checked' : ''} aria-label="${esc(x.name)} has signed the waiver">${w ? `<span class="sub">${fmtShort(w)}</span>` : ''}</label></td>
              <td class="center"><label class="check-cell"><input type="checkbox" data-rsvp="${esc(x.id)}"${g ? ' checked' : ''} aria-label="${esc(x.name)} is coming"></label></td>
            </tr>`;
          }).join('')}
          </tbody></table>
          <div class="actions admin-actions">
            <button class="btn sm" type="button" id="to-order"${coming.length ? '' : ' disabled'}>Set shooting order to everyone coming</button>
            <a class="btn sm" href="#/plan">📋 Range day plan</a>
          </div>
        </div>` : emptyState('👥', 'No members yet', 'Add your group on the Members page first.', '<a class="btn primary" href="#/members">Go to members</a>')}`;

      bindAdminAuth();
      $('#admin-date').addEventListener('change', e => { if (e.target.value) location.hash = '#/admin/' + e.target.value; });
      $$('[data-waiver]').forEach(cb => cb.addEventListener('change', () => {
        const mem = Store.get('members', cb.dataset.waiver);
        if (!cb.checked && !confirm(`Mark ${mem ? mem.name : 'this member'} as NOT having a waiver?`)) { cb.checked = true; return; }
        Store.setWaiver(cb.dataset.waiver, cb.checked ? today() : null);
      }));
      $$('[data-rsvp]').forEach(cb => cb.addEventListener('change', () => Store.setRsvp(date, cb.dataset.rsvp, cb.checked)));
      const order = $('#to-order');
      if (order) order.addEventListener('click', () => {
        const base = isPlanDay ? rd : { date, note: '', items: [] };
        // Keep the current order for people already in it, then add anyone else who's coming.
        const ids = coming.map(x => x.id);
        const shooters = (base.shooters || []).filter(id => ids.includes(id)).concat(ids.filter(id => !(base.shooters || []).includes(id)));
        Store.saveSettings({ rangeDay: Object.assign({}, base, { shooters }) });
        toast(isPlanDay ? 'Shooting order updated' : `Range day set for ${fmtShort(date)} with ${shooters.length} shooters`);
      });
    };
    render();
    pageRefresh = render;
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
    [/^#\/plan\/?$/, renderPlan],
    [/^#\/admin\/?$/, renderAdmin],
    [/^#\/admin\/(\d{4}-\d{2}-\d{2})$/, renderAdmin],
    [/^#\/standings\/?$/, renderStandings],
    [/^#\/standings\/(m-\d{4}-\d{2}|y-\d{4}|all)$/, renderStandings],
    [/^#\/timer\/?$/, renderTimer],
    [/^#\/timer\/(drill:[^/]+)$/, renderTimer],
  ];

  function router() {
    if (pageCleanup) pageCleanup();
    pageCleanup = null;
    pageRefresh = null;
    const hash = location.hash || '#/';
    const alias = { history: 'members', plan: 'record', timer: 'drills', admin: 'settings' };
    const first = (hash.match(/^#\/([a-z]+)/) || [])[1];
    const section = alias[first] || ['drills', 'stages', 'record', 'members', 'settings', 'standings'].find(x => x === first) || 'day';
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
    if (t && confirm(`Delete ${t.shooter}'s ${isHF(t) ? 'HF ' + fmtHF(t.hf) : fmtTime(t.time) + 's'} run on ${fmtDate(t.date)}?`)) {
      Store.remove('times', t.id);
      toast('Run deleted');
    }
  });

  // Gun type filter chips (Day view, drill/stage leaderboards, history, standings).
  app.addEventListener('click', e => {
    const chip = e.target.closest('[data-div-filter]');
    if (!chip) return;
    divFilter = chip.dataset.divFilter;
    setPref(DIV_FILTER_KEY, divFilter);
    if (pageRefresh) pageRefresh();
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
    // When updated offline code takes over, reload so the page uses the new files right away.
    const hadController = !!navigator.serviceWorker.controller;
    let reloadingForSw = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloadingForSw || editorDirty) return;
      reloadingForSw = true;
      location.reload();
    });
  }

  /*
   * Update check. js/version.js is re-stamped on every commit; compare the copy this page loaded
   * with the live one (cache: 'no-store' skips every saved copy). Phones — especially home-screen
   * apps resumed from memory — can otherwise keep showing an old version.
   */
  const UPDATE_KEY = 'rangelog-reloaded-for';
  async function checkForUpdate(atStartup) {
    if (!location.protocol.startsWith('http') || !window.APP_VERSION) return;
    let latest;
    try {
      const text = await (await fetch('js/version.js', { cache: 'no-store' })).text();
      latest = (text.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
    } catch (e) { return; } // offline: keep using what we have
    if (!latest || latest === window.APP_VERSION) return;

    let alreadyTried = false;
    try { alreadyTried = sessionStorage.getItem(UPDATE_KEY) === latest; } catch (e) { /* ignore */ }
    const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
    if (atStartup && !alreadyTried && !editorDirty && !typing) {
      // Nothing typed yet: just load the new version (once, so a stubborn cache can't loop).
      try { sessionStorage.setItem(UPDATE_KEY, latest); } catch (e) { /* ignore */ }
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) { try { await reg.update(); } catch (e) { /* ignore */ } }
      location.reload();
      return;
    }
    // Mid-use: let them finish, then tap Refresh. (An older saved page may not have the bar.)
    const bar = $('#update-bar');
    if (bar) bar.hidden = false;
  }
  // Optional lookups are guarded: a stale saved index.html can pair with a newer app.js, and an
  // error here would stop the whole site from starting.
  const updateNow = $('#update-now');
  if (updateNow) updateNow.addEventListener('click', async () => {
    if (editorDirty && !confirm('You have unsaved changes. Refresh anyway?')) return;
    editorDirty = false;
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) { try { await reg.update(); } catch (e) { /* ignore */ } }
    location.reload();
  });
  // Check again when someone comes back to the site: switching back to the tab or app, clicking
  // back into the window, or returning with the Back button. At most once a minute.
  let lastCheck = Date.now();
  const recheck = () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    checkForUpdate(false);
  };
  document.addEventListener('visibilitychange', recheck);
  window.addEventListener('focus', recheck);
  window.addEventListener('pageshow', e => { if (e.persisted) { lastCheck = 0; recheck(); } });

  if (window.GROUP_NAME) { $('#brand-name').textContent = window.GROUP_NAME; document.title = window.GROUP_NAME; }
  if (window.GROUP_TAGLINE) $('#brand-sub').textContent = window.GROUP_TAGLINE;

  Store.onChange(() => { if (pageRefresh) pageRefresh(); renderFooter(); });
  Store.ready.then(() => {
    renderFooter();
    window.addEventListener('hashchange', onHashChange);
    router();
    checkForUpdate(true);
  });
})();

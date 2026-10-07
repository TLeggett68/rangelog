/*
 * Data layer.
 *
 * Cloud mode (FIREBASE_CONFIG set): data lives in Firestore and syncs live to
 * everyone. Drills and stages are one document each. Times are grouped into
 * one document per day ("days/2026-10-06") so loading the whole history costs
 * one read per range day instead of one per run — this keeps the site well
 * inside Firestore's free daily read limit.
 *
 * Local mode: everything is kept in this browser's localStorage.
 */
(function () {
  'use strict';

  const LS_KEY = 'rangelog-data-v1';
  const FB_VERSION = '10.12.2';
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const cfg = window.FIREBASE_CONFIG;
  const mode = cfg && cfg.apiKey ? 'cloud' : 'local';

  const COLLECTIONS = ['drills', 'stages', 'times', 'members'];

  // Penalty types added to a shooter's raw time. `def` is the default seconds per occurrence
  // (IDPA-style "points down = seconds"); the group can change them on the Settings page.
  const PENALTIES = [
    { key: 'c', label: 'C-zone hits', short: 'C', def: 1 },
    { key: 'd', label: 'D-zone hits', short: 'D', def: 3 },
    { key: 'miss', label: 'Misses', short: 'M', def: 5 },
    { key: 'ns', label: 'No-shoot hits', short: 'NS', def: 5, stageOnly: true },
    { key: 'proc', label: 'Procedurals', short: 'P', def: 3, stageOnly: true },
  ];
  const DEFAULT_SETTINGS = { penalties: PENALTIES.reduce((o, p) => (o[p.key] = p.def, o), {}) };

  const cache = { drills: [], stages: [], times: [], members: [], settings: {} };
  const listeners = [];
  let db = null;
  let rawRuns = new Map(); // cloud: run id -> { date, raw } (raw is needed for arrayRemove)

  function emit() {
    listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function plain(obj) {
    return JSON.parse(JSON.stringify(obj)); // drops undefined values
  }
  function isoToday() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function writeFailed(err) {
    console.error(err);
    window.dispatchEvent(new CustomEvent('store-error', { detail: err.message || String(err) }));
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  /* ---------- local mode ---------- */
  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { return null; }
  }
  function writeLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); } catch (e) { console.warn(e); }
  }
  function fillCache(data) {
    COLLECTIONS.forEach(c => { cache[c] = data && Array.isArray(data[c]) ? data[c] : []; });
    cache.settings = (data && data.settings) || {};
  }
  function initLocal() {
    fillCache(readLocal() || sampleData());
    writeLocal();
    window.addEventListener('storage', e => {
      if (e.key === LS_KEY) { fillCache(readLocal()); emit(); }
    });
  }

  /* ---------- cloud mode ---------- */
  async function initCloud() {
    const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
    await loadScript(base + 'firebase-app-compat.js');
    await loadScript(base + 'firebase-firestore-compat.js');
    firebase.initializeApp(cfg);
    db = firebase.firestore();
    // Offline cache: lets people record times at the range with poor signal; they sync later.
    try { await db.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* unsupported – fine */ }

    const subs = [
      ['drills', snap => { cache.drills = snap.docs.map(d => Object.assign({ id: d.id }, d.data())); }],
      ['stages', snap => { cache.stages = snap.docs.map(d => Object.assign({ id: d.id }, d.data())); }],
      ['members', snap => { cache.members = snap.docs.map(d => Object.assign({ id: d.id }, d.data())); }],
      ['settings', snap => {
        const doc = snap.docs.find(d => d.id === 'config');
        cache.settings = doc ? doc.data() : {};
      }],
      ['days', snap => {
        rawRuns = new Map();
        const list = [];
        snap.docs.forEach(doc => {
          (doc.data().runs || []).forEach(r => {
            rawRuns.set(r.id, { date: doc.id, raw: r });
            list.push(Object.assign({}, r, { date: doc.id }));
          });
        });
        cache.times = list;
      }],
    ];
    await Promise.all(subs.map(([coll, apply]) => new Promise(resolve => {
      let first = true;
      db.collection(coll).onSnapshot(snap => {
        apply(snap);
        if (first) { first = false; resolve(); } else emit();
      }, err => {
        console.error(err);
        Store.error = err.message;
        if (first) { first = false; resolve(); } else emit();
      });
    })));
  }

  /* ---------- public API ---------- */
  const Store = {
    mode,
    error: null,
    ready: null,

    PENALTIES,
    DEFAULT_SETTINGS,

    all(c) { return cache[c].slice(); },

    // Settings merged over defaults, so new keys always have a value.
    settings() {
      const s = cache.settings || {};
      return { penalties: Object.assign({}, DEFAULT_SETTINGS.penalties, s.penalties || {}) };
    },
    saveSettings(obj) {
      const data = plain(Object.assign({}, obj, { updatedAt: Date.now() }));
      if (mode === 'local') {
        cache.settings = data;
        writeLocal();
        emit();
      } else {
        db.collection('settings').doc('config').set(data).catch(writeFailed);
      }
    },
    get(c, id) { return cache[c].find(x => x.id === id) || null; },
    onChange(fn) { listeners.push(fn); },

    // Writes are fire-and-forget so they work offline; returns the new id immediately.
    add(c, obj) {
      const id = uid();
      const data = plain(Object.assign({}, obj, { id, createdAt: Date.now() }));
      if (c === 'times' && !DATE_RE.test(data.date || '')) data.date = isoToday();

      if (mode === 'local') {
        cache[c].push(data);
        writeLocal();
        emit();
      } else if (c === 'times') {
        const date = data.date;
        delete data.date;
        const FV = firebase.firestore.FieldValue;
        db.collection('days').doc(date).set({ date, runs: FV.arrayUnion(data) }, { merge: true }).catch(writeFailed);
      } else {
        delete data.id;
        db.collection(c).doc(id).set(data).catch(writeFailed);
      }
      return id;
    },

    update(c, id, obj) {
      const data = plain(Object.assign({}, obj, { updatedAt: Date.now() }));
      delete data.id;
      if (mode === 'local') {
        const i = cache[c].findIndex(x => x.id === id);
        if (i >= 0) cache[c][i] = Object.assign({}, cache[c][i], data, { id });
        writeLocal();
        emit();
      } else {
        db.collection(c).doc(id).set(data, { merge: true }).catch(writeFailed);
      }
    },

    remove(c, id) {
      if (mode === 'local') {
        cache[c] = cache[c].filter(x => x.id !== id);
        writeLocal();
        emit();
      } else if (c === 'times') {
        const ref = rawRuns.get(id);
        if (!ref) return;
        const FV = firebase.firestore.FieldValue;
        db.collection('days').doc(ref.date).update({ runs: FV.arrayRemove(ref.raw) }).catch(writeFailed);
      } else {
        db.collection(c).doc(id).delete().catch(writeFailed);
      }
    },

    resetDemo() {
      if (mode !== 'local') return;
      fillCache(sampleData());
      writeLocal();
      emit();
    },
  };

  /* ---------- demo data for local mode ---------- */
  function sampleData() {
    const d0 = isoToday();
    const y = new Date(); y.setDate(y.getDate() - 7);
    const d1 = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
    let now = Date.now();
    const pens = DEFAULT_SETTINGS.penalties;
    // `time` is the raw time; any penalties are added on top, like a real entry.
    const run = (itemId, itemName, kind, shooter, time, date, notes, pen) => {
      const penTime = Object.keys(pen || {}).reduce((sum, k) => sum + pen[k] * pens[k], 0);
      return {
        id: uid(), kind, itemId, itemName, shooter, raw: time, pen: pen || {}, penTime,
        time: Math.round((time + penTime) * 100) / 100, date, notes: notes || '', createdAt: now++,
      };
    };
    return {
      drills: [
        {
          id: 'demo-bill', name: 'Bill Drill', par: 2.5, distance: 7, rounds: 6, createdAt: now,
          instructions: 'Start facing the target, hands relaxed at sides, gun loaded and holstered.\n\nOn the beep, draw and fire 6 rounds into the A-zone.\n\nGoal: all hits in the A-zone under par.',
          marks: [{ x: 76, y: 125 }, { x: 104, y: 125 }, { x: 76, y: 152 }, { x: 104, y: 152 }, { x: 76, y: 180 }, { x: 104, y: 180 }],
        },
        {
          id: 'demo-moz', name: 'Failure to Stop', par: 2.0, distance: 5, rounds: 3, createdAt: now,
          instructions: 'Start in the ready position (gun out, muzzle low).\n\nOn the beep, fire 2 rounds to the body A-zone, then 1 round to the head A-zone.',
          marks: [{ x: 86, y: 145 }, { x: 95, y: 152 }, { x: 90, y: 26 }],
        },
      ],
      members: ['John', 'Mike', 'Sarah'].map((name, i) => ({ id: 'demo-m' + i, name, createdAt: now })),
      stages: [
        {
          id: 'demo-stage', name: 'Barrel Run', createdAt: now,
          description: 'Start in Box A, hands relaxed at sides, gun loaded and holstered.\n\nOn the beep, engage T1, T2 and S1–S2 from Box A. Move to Box B and engage T3 and T4.\n\nSteel must fall. Do not hit the no-shoot.',
          objects: [
            { id: 'o1', type: 'box', x: 180, y: 330, rot: 0, label: 'A', note: 'Start here, hands relaxed at sides', w: 40, h: 40 },
            { id: 'o2', type: 'box', x: 420, y: 330, rot: 0, label: 'B', note: '', w: 40, h: 40 },
            { id: 'o3', type: 'wall', x: 300, y: 285, rot: 90, len: 80, label: '', note: '' },
            { id: 'o4', type: 'barrel', x: 290, y: 200, rot: 0, label: '', note: '' },
            { id: 'o5', type: 'barrel', x: 315, y: 205, rot: 0, label: '', note: '' },
            { id: 'o6', type: 'target', x: 110, y: 120, rot: 15, label: 'T1', shots: 2, note: '2 to the body from Box A' },
            { id: 'o7', type: 'target', x: 210, y: 90, rot: 0, label: 'T2', shots: 2, note: '2 to the body from Box A' },
            { id: 'o8', type: 'noshoot', x: 235, y: 95, rot: 0, label: 'NS', note: '' },
            { id: 'o9', type: 'target', x: 400, y: 90, rot: 0, label: 'T3', shots: 2, note: '2 to the body from Box B' },
            { id: 'o10', type: 'target', x: 490, y: 130, rot: 345, label: 'T4', shots: 3, note: '2 to the body + 1 to the head from Box B' },
            { id: 'o11', type: 'steel', x: 290, y: 60, rot: 0, label: 'S1', shots: 1, note: 'Must fall' },
            { id: 'o12', type: 'steel', x: 320, y: 60, rot: 0, label: 'S2', shots: 1, note: 'Must fall' },
            { id: 'o13', type: 'arrow', x: 205, y: 345, rot: 0, label: '', note: 'Move to Box B around the uprange end of the wall', color: '#ffd43b', dashed: false,
              points: [{ x: 0, y: 0 }, { x: 55, y: 22 }, { x: 135, y: 22 }, { x: 188, y: -5 }] },
          ],
        },
      ],
      times: [
        run('demo-bill', 'Bill Drill', 'drill', 'John', 2.31, d0),
        run('demo-bill', 'Bill Drill', 'drill', 'Mike', 1.92, d0, '', { c: 1 }),
        run('demo-bill', 'Bill Drill', 'drill', 'Sarah', 2.18, d0),
        run('demo-bill', 'Bill Drill', 'drill', 'John', 2.24, d0),
        run('demo-moz', 'Failure to Stop', 'drill', 'Mike', 1.88, d0),
        run('demo-moz', 'Failure to Stop', 'drill', 'Sarah', 2.05, d0),
        run('demo-moz', 'Failure to Stop', 'drill', 'John', 1.97, d0),
        run('demo-stage', 'Barrel Run', 'stage', 'John', 14.62, d0),
        run('demo-stage', 'Barrel Run', 'stage', 'Sarah', 13.9, d0),
        run('demo-stage', 'Barrel Run', 'stage', 'Mike', 13.04, d0, 'Steel make-up shot', { d: 1 }),
        run('demo-bill', 'Bill Drill', 'drill', 'John', 2.55, d1),
        run('demo-bill', 'Bill Drill', 'drill', 'Mike', 2.71, d1),
      ],
    };
  }

  Store.ready = mode === 'cloud'
    ? initCloud().catch(err => { console.error(err); Store.error = err.message; })
    : Promise.resolve(initLocal());

  window.Store = Store;
})();

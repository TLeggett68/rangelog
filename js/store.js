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
  // Add ?demo to the address to try things on sample data kept only in this browser.
  const forceDemo = /[?&]demo\b/.test(location.search);
  const mode = cfg && cfg.apiKey && !forceDemo ? 'cloud' : 'local';

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
  const DEFAULT_SETTINGS = {
    penalties: PENALTIES.reduce((o, p) => (o[p.key] = p.def, o), {}),
    // Gun types ("divisions") a run can be tagged with; editable on the Settings page.
    divisions: ['Pistol', 'Pistol (optic)', 'PCC', 'Rifle', 'Shotgun'],
    // Next range day and its plan: { date, note, items: ['drill:id', 'stage:id'], shooters: [memberId | 'guest:Name'] }
    rangeDay: null,
  };

  const cache = { drills: [], stages: [], times: [], members: [], settings: {}, admin: {} };

  /*
   * Admin: one signed-in account (Firebase email/password) can read and change admin/roster,
   * which holds { waivers: { memberId: 'YYYY-MM-DD' | null }, rsvps: { 'YYYY-MM-DD': { memberId: bool } } }.
   * Firestore rules allow only the admin's UID. In demo mode "signing in" just flips a flag.
   */
  const DEMO_ADMIN_KEY = 'rangelog-demo-admin';
  const adminState = { signedIn: false, email: null, isAdmin: false, error: null };
  let auth = null;
  let adminUnsub = null;
  let authLoaded = null; // promise, cloud mode
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
    cache.admin = (data && data.admin) || {};
  }
  function initLocal() {
    fillCache(readLocal() || sampleData());
    writeLocal();
    let demoAdmin = false;
    try { demoAdmin = localStorage.getItem(DEMO_ADMIN_KEY) === '1'; } catch (e) { /* ignore */ }
    Object.assign(adminState, { signedIn: demoAdmin, email: demoAdmin ? 'demo admin' : null, isAdmin: demoAdmin });
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
    // Sign-in is only needed for the admin page, so load it after the site is up.
    authLoaded = loadScript(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-auth-compat.js`)
      .then(watchAuth)
      .catch(err => { console.error(err); adminState.error = 'Sign-in could not load. Check your connection.'; emit(); });
  }

  function watchAuth() {
    auth = firebase.auth();
    auth.onAuthStateChanged(user => {
      if (adminUnsub) { adminUnsub(); adminUnsub = null; }
      cache.admin = {};
      Object.assign(adminState, { signedIn: !!user, email: user ? user.email : null, isAdmin: false, error: null });
      if (user) {
        adminUnsub = db.collection('admin').doc('roster').onSnapshot(doc => {
          cache.admin = doc.exists ? doc.data() : {};
          adminState.isAdmin = true;
          adminState.error = null;
          emit();
        }, err => {
          adminState.isAdmin = false;
          adminState.error = err.code === 'permission-denied'
            ? 'This account is not set up as the admin yet (the Firestore rules need its User UID).'
            : err.message;
          emit();
        });
      }
      emit();
    });
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
      return {
        penalties: Object.assign({}, DEFAULT_SETTINGS.penalties, s.penalties || {}),
        divisions: Array.isArray(s.divisions) ? s.divisions.slice() : DEFAULT_SETTINGS.divisions.slice(),
        rangeDay: s.rangeDay || null,
      };
    },
    // Saves only the given keys; everything else in settings is kept.
    saveSettings(partial) {
      const data = plain(Object.assign({}, this.settings(), partial, { updatedAt: Date.now() }));
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

    // Every write updates this browser's copy right away (so the page that opens next can see it),
    // then goes to Firestore in the background so it also works offline. In cloud mode Firestore's
    // next snapshot replaces the copy with the real data, and rolls it back if a write is rejected.
    add(c, obj) {
      const id = uid();
      const data = plain(Object.assign({}, obj, { id, createdAt: Date.now() }));
      if (c === 'times' && !DATE_RE.test(data.date || '')) data.date = isoToday();
      cache[c].push(data);

      if (mode === 'local') {
        writeLocal();
      } else if (c === 'times') {
        const run = Object.assign({}, data);
        delete run.date;
        rawRuns.set(id, { date: data.date, raw: run });
        const FV = firebase.firestore.FieldValue;
        db.collection('days').doc(data.date).set({ date: data.date, runs: FV.arrayUnion(run) }, { merge: true }).catch(writeFailed);
      } else {
        const doc = Object.assign({}, data);
        delete doc.id;
        db.collection(c).doc(id).set(doc).catch(writeFailed);
      }
      emit();
      return id;
    },

    update(c, id, obj) {
      const data = plain(Object.assign({}, obj, { updatedAt: Date.now() }));
      delete data.id;
      const i = cache[c].findIndex(x => x.id === id);
      if (i >= 0) cache[c][i] = Object.assign({}, cache[c][i], data, { id });

      if (mode === 'local') writeLocal();
      else db.collection(c).doc(id).set(data, { merge: true }).catch(writeFailed);
      emit();
    },

    remove(c, id) {
      const ref = c === 'times' ? rawRuns.get(id) : null;
      cache[c] = cache[c].filter(x => x.id !== id);

      if (mode === 'local') {
        writeLocal();
      } else if (c === 'times') {
        if (ref) {
          const FV = firebase.firestore.FieldValue;
          db.collection('days').doc(ref.date).update({ runs: FV.arrayRemove(ref.raw) }).catch(writeFailed);
        }
      } else {
        db.collection(c).doc(id).delete().catch(writeFailed);
      }
      emit();
    },

    /*
     * Renames a member everywhere: the member record and every past run recorded under them —
     * runs saved with their member id, plus older runs saved under the old name with no id
     * (those get linked to the member too). Cloud: each affected range day is rewritten in a
     * transaction so a time recorded at the same moment isn't lost. Past runs are updated first,
     * so if this fails partway the member keeps the old name and retrying finishes the job.
     * Resolves to the number of runs renamed.
     */
    async renameMember(id, newName) {
      const m = cache.members.find(x => x.id === id);
      if (!m) throw new Error('Member not found.');
      const oldKey = String(m.name || '').trim().toLowerCase();
      const matches = r => r.memberId === id || (!r.memberId && String(r.shooter || '').trim().toLowerCase() === oldKey);
      const renamed = r => (matches(r) ? Object.assign({}, r, { shooter: newName, memberId: id }) : r);
      const affected = cache.times.filter(matches);

      if (mode === 'cloud') {
        for (const date of [...new Set(affected.map(r => r.date))]) {
          const ref = db.collection('days').doc(date);
          await db.runTransaction(async t => {
            const snap = await t.get(ref);
            if (!snap.exists) return;
            t.update(ref, { runs: (snap.data().runs || []).map(renamed) });
          });
        }
      }
      cache.times = cache.times.map(renamed);
      this.update('members', id, { name: newName }); // saves (local) and emits
      return affected.length;
    },

    /* ---------- admin ---------- */
    adminState() { return Object.assign({}, adminState, { uid: auth && auth.currentUser ? auth.currentUser.uid : null }); },
    admin() {
      const a = cache.admin || {};
      return { waivers: Object.assign({}, a.waivers || {}), rsvps: JSON.parse(JSON.stringify(a.rsvps || {})) };
    },
    async signIn(email, password) {
      if (mode === 'local') {
        try { localStorage.setItem(DEMO_ADMIN_KEY, '1'); } catch (e) { /* ignore */ }
        Object.assign(adminState, { signedIn: true, email: 'demo admin', isAdmin: true, error: null });
        emit();
        return;
      }
      if (!authLoaded) throw new Error('Sign-in is still loading. Try again in a moment.');
      await authLoaded;
      await auth.signInWithEmailAndPassword(email, password);
    },
    async signOut() {
      if (mode === 'local') {
        try { localStorage.removeItem(DEMO_ADMIN_KEY); } catch (e) { /* ignore */ }
        Object.assign(adminState, { signedIn: false, email: null, isAdmin: false, error: null });
        emit();
        return;
      }
      if (auth) await auth.signOut();
    },
    // value: 'YYYY-MM-DD' when signed, null when not.
    setWaiver(memberId, value) { this.saveAdmin({ waivers: { [memberId]: value } }); },
    setRsvp(date, memberId, going) { this.saveAdmin({ rsvps: { [date]: { [memberId]: !!going } } }); },
    // Deep-merges a partial { waivers, rsvps } into admin/roster.
    saveAdmin(partial) {
      const a = cache.admin || {};
      if (partial.waivers) a.waivers = Object.assign({}, a.waivers || {}, partial.waivers);
      if (partial.rsvps) {
        a.rsvps = Object.assign({}, a.rsvps || {});
        Object.keys(partial.rsvps).forEach(d => { a.rsvps[d] = Object.assign({}, a.rsvps[d] || {}, partial.rsvps[d]); });
      }
      cache.admin = a;
      if (mode === 'local') writeLocal();
      else db.collection('admin').doc('roster').set(plain(Object.assign({}, partial, { updatedAt: Date.now() })), { merge: true }).catch(writeFailed);
      emit();
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
    const daysAgo = n => {
      const d = new Date(); d.setDate(d.getDate() - n);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };
    const d1 = daysAgo(7), d2 = daysAgo(14), d3 = daysAgo(28);
    let now = Date.now();
    const pens = DEFAULT_SETTINGS.penalties;
    // `time` is the raw time; any penalties are added on top, like a real entry.
    const memberIds = { John: 'demo-m0', Mike: 'demo-m1', Sarah: 'demo-m2' };
    const run = (itemId, itemName, kind, shooter, time, date, notes, pen, division) => {
      const penTime = Object.keys(pen || {}).reduce((sum, k) => sum + pen[k] * pens[k], 0);
      return {
        id: uid(), kind, itemId, itemName, shooter, memberId: memberIds[shooter] || null, division: division || 'Pistol',
        raw: time, pen: pen || {}, penTime,
        time: Math.round((time + penTime) * 100) / 100, date, notes: notes || '', createdAt: now++,
      };
    };
    // Hit-factor run (USPSA minor): hits = { a, c, d, m, ns, p }.
    const hfRun = (shooter, time, hits, date) => {
      const points = Math.max(0, (hits.a || 0) * 5 + (hits.c || 0) * 3 + (hits.d || 0) - 10 * ((hits.m || 0) + (hits.ns || 0) + (hits.p || 0)));
      return {
        id: uid(), kind: 'stage', itemId: 'demo-hf', itemName: 'Steel & Paper', shooter, memberId: memberIds[shooter] || null,
        division: 'Pistol', scoring: 'hf', par: null, raw: time, time, hits, pf: 'minor', points,
        hf: Math.round(points / time * 10000) / 10000, date, notes: '', createdAt: now++,
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
      members: ['John', 'Mike', 'Sarah'].map((name, i) => ({ id: 'demo-m' + i, name, createdAt: now,
        goals: name === 'John' ? { 'drill:demo-bill': 2.1 } : undefined })),
      admin: {
        waivers: { 'demo-m0': d1, 'demo-m2': d1 },
        rsvps: { [d0]: { 'demo-m0': true, 'demo-m1': true, 'demo-m2': true } },
      },
      settings: {
        rangeDay: {
          date: d0, note: '9 AM at Bay 3. Bring 150 rounds, eye and ear protection.',
          items: ['drill:demo-bill', 'drill:demo-moz', 'stage:demo-hf'], shooters: ['demo-m2', 'demo-m0', 'demo-m1'],
        },
      },
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
        {
          id: 'demo-hf', name: 'Steel & Paper', scoring: 'hf', createdAt: now,
          description: 'Scored by hit factor (USPSA, minor). Start in Box A, wrists above shoulders.\n\nOn the beep, engage T1–T3 with 2 rounds each and S1–S2 until down.',
          objects: [
            { id: 'h1', type: 'box', x: 300, y: 330, rot: 0, label: 'A', note: 'Start, wrists above shoulders', w: 40, h: 40 },
            { id: 'h2', type: 'target', x: 180, y: 110, rot: 20, label: 'T1', shots: 2, note: '2 to the body' },
            { id: 'h3', type: 'target', x: 300, y: 90, rot: 0, label: 'T2', shots: 2, note: '2 to the body' },
            { id: 'h4', type: 'target', x: 420, y: 110, rot: 340, label: 'T3', shots: 2, note: '2 to the body' },
            { id: 'h5', type: 'steel', x: 250, y: 60, rot: 0, label: 'S1', shots: 1, note: 'Must fall' },
            { id: 'h6', type: 'steel', x: 350, y: 60, rot: 0, label: 'S2', shots: 1, note: 'Must fall' },
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
        run('demo-bill', 'Bill Drill', 'drill', 'John', 2.78, d2, '', { c: 1 }),
        run('demo-bill', 'Bill Drill', 'drill', 'John', 2.69, d2),
        run('demo-bill', 'Bill Drill', 'drill', 'John', 3.12, d3, '', { miss: 1 }),
        run('demo-bill', 'Bill Drill', 'drill', 'John', 2.94, d3),
        run('demo-bill', 'Bill Drill', 'drill', 'Sarah', 2.41, d2),
        run('demo-moz', 'Failure to Stop', 'drill', 'John', 2.31, d2),
        run('demo-moz', 'Failure to Stop', 'drill', 'John', 2.48, d3, '', { c: 1 }),
        run('demo-stage', 'Barrel Run', 'stage', 'John', 15.88, d2, '', { c: 2 }),
        run('demo-bill', 'Bill Drill', 'drill', 'Mike', 2.95, d0, 'AR, red dot', {}, 'Rifle'),
        hfRun('Sarah', 6.12, { a: 6, c: 2 }, d1),
        hfRun('John', 5.48, { a: 5, c: 2, d: 1 }, d1),
        hfRun('John', 5.02, { a: 7, c: 1 }, d0),
        hfRun('Mike', 7.40, { a: 6, c: 1, m: 1 }, d0),
      ],
    };
  }

  Store.ready = mode === 'cloud'
    ? initCloud().catch(err => { console.error(err); Store.error = err.message; })
    : Promise.resolve(initLocal());

  window.Store = Store;
})();

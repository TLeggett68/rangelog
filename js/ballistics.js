/*
 * Point-mass external ballistics, the same model most free calculators use.
 *
 * - Drag: standard G1 / G7 drag tables (Cd vs Mach), scaled by the bullet's ballistic
 *   coefficient. Deceleration (ft/s²) = ρ · v² · Cd(M) · π / (8 · 144 · BC).
 * - Air: density and speed of sound from temperature and altitude (standard atmosphere).
 * - Integration: RK4 in time, small fixed step, gravity 32.174 ft/s².
 * - Zero: the launch angle is solved so the bullet crosses the line of sight at the zero range.
 * - Wind: lag-time method — drift = crosswind × (time of flight − range / muzzle velocity).
 * Not modeled: spin drift, Coriolis, shooting uphill/downhill.
 *
 * Units in: fps, grains, inches, yards, °F, feet, mph. "path" is inches relative to the line of
 * sight (+ = impact above point of aim).
 */
(function () {
  'use strict';

  // [Mach, Cd] — standard G1 (flat-base) and G7 (boat-tail, long-range) drag functions.
  const G1 = [
    [0, .2629], [.05, .2558], [.1, .2487], [.15, .2413], [.2, .2344], [.25, .2278], [.3, .2214], [.35, .2155],
    [.4, .2104], [.45, .2061], [.5, .2032], [.55, .2020], [.6, .2034], [.7, .2165], [.725, .2230], [.75, .2313],
    [.775, .2417], [.8, .2546], [.825, .2706], [.85, .2901], [.875, .3136], [.9, .3415], [.925, .3734], [.95, .4084],
    [.975, .4448], [1, .4805], [1.025, .5136], [1.05, .5427], [1.075, .5677], [1.1, .5883], [1.125, .6053], [1.15, .6191],
    [1.2, .6393], [1.25, .6518], [1.3, .6589], [1.35, .6621], [1.4, .6625], [1.45, .6607], [1.5, .6573], [1.55, .6528],
    [1.6, .6474], [1.65, .6413], [1.7, .6347], [1.75, .6280], [1.8, .6210], [1.85, .6141], [1.9, .6072], [1.95, .6003],
    [2, .5934], [2.05, .5867], [2.1, .5804], [2.15, .5743], [2.2, .5685], [2.25, .5630], [2.3, .5577], [2.35, .5527],
    [2.4, .5481], [2.45, .5438], [2.5, .5397], [2.6, .5325], [2.7, .5264], [2.8, .5211], [2.9, .5168], [3, .5133],
    [3.1, .5105], [3.2, .5084], [3.3, .5067], [3.4, .5054], [3.5, .5040], [3.6, .5030], [3.7, .5022], [3.8, .5016],
    [3.9, .5010], [4, .5006], [4.2, .4998], [4.4, .4995], [4.6, .4992], [4.8, .4990], [5, .4988],
  ];
  const G7 = [
    [0, .1198], [.05, .1197], [.1, .1196], [.15, .1194], [.2, .1193], [.25, .1194], [.3, .1194], [.35, .1194],
    [.4, .1193], [.45, .1193], [.5, .1194], [.55, .1193], [.6, .1194], [.65, .1197], [.7, .1202], [.725, .1207],
    [.75, .1215], [.775, .1226], [.8, .1242], [.825, .1266], [.85, .1306], [.875, .1368], [.9, .1464], [.925, .1660],
    [.95, .2054], [.975, .2993], [1, .3803], [1.025, .4015], [1.05, .4043], [1.075, .4034], [1.1, .4014], [1.125, .3987],
    [1.15, .3955], [1.2, .3884], [1.25, .3810], [1.3, .3732], [1.35, .3657], [1.4, .3580], [1.5, .3440], [1.55, .3376],
    [1.6, .3315], [1.65, .3260], [1.7, .3209], [1.75, .3160], [1.8, .3117], [1.85, .3078], [1.9, .3042], [1.95, .3010],
    [2, .2980], [2.05, .2951], [2.1, .2922], [2.15, .2892], [2.2, .2864], [2.25, .2835], [2.3, .2807], [2.35, .2779],
    [2.4, .2752], [2.45, .2725], [2.5, .2697], [2.55, .2670], [2.6, .2643], [2.65, .2615], [2.7, .2588], [2.75, .2561],
    [2.8, .2533], [2.85, .2506], [2.9, .2479], [2.95, .2451], [3, .2424], [3.1, .2368], [3.2, .2313], [3.3, .2258],
    [3.4, .2205], [3.5, .2154], [3.6, .2106], [3.7, .2060], [3.8, .2017], [3.9, .1975], [4, .1935], [4.2, .1861],
    [4.4, .1793], [4.6, .1730], [4.8, .1672], [5, .1618],
  ];
  const TABLES = { G1, G7 };

  function cd(table, mach) {
    if (mach <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
      if (mach <= table[i][0]) {
        const [m0, c0] = table[i - 1], [m1, c1] = table[i];
        return c0 + (c1 - c0) * (mach - m0) / (m1 - m0);
      }
    }
    return table[table.length - 1][1];
  }

  // Standard atmosphere: station pressure from altitude, then density and speed of sound.
  function air(tempF, altitudeFt) {
    const t = tempF == null ? 59 : tempF;
    const alt = altitudeFt || 0;
    const pressure = 29.92 * Math.pow(1 - 6.8753e-6 * alt, 5.2559); // inHg
    const rankine = t + 459.67;
    return {
      density: 0.0764742 * (pressure / 29.92) * (518.67 / rankine), // lb/ft³
      sound: 49.0223 * Math.sqrt(rankine), // ft/s
    };
  }

  const G = 32.174;

  // Integrates the shot. sample(xFt, state) is called once per crossing of each requested x.
  function fly(p, angle, maxFt, onYard) {
    const table = TABLES[p.model] || G1;
    const k = p.air.density * Math.PI / (8 * 144 * p.bc);
    const sound = p.air.sound;
    const accel = (vx, vy) => {
      const v = Math.hypot(vx, vy);
      const a = k * v * v * cd(table, v / sound);
      return [-a * vx / v, -a * vy / v - G];
    };
    let x = 0, y = -p.sightHeight / 12, vx = p.mv * Math.cos(angle), vy = p.mv * Math.sin(angle), t = 0;
    const dt = 0.0005;
    let nextYard = 0;
    while (x < maxFt && t < 10) {
      // RK4 step
      const [ax1, ay1] = accel(vx, vy);
      const [ax2, ay2] = accel(vx + ax1 * dt / 2, vy + ay1 * dt / 2);
      const [ax3, ay3] = accel(vx + ax2 * dt / 2, vy + ay2 * dt / 2);
      const [ax4, ay4] = accel(vx + ax3 * dt, vy + ay3 * dt);
      const nvx = vx + dt / 6 * (ax1 + 2 * ax2 + 2 * ax3 + ax4);
      const nvy = vy + dt / 6 * (ay1 + 2 * ay2 + 2 * ay3 + ay4);
      const nx = x + dt / 6 * (vx + 2 * (vx + ax1 * dt / 2) + 2 * (vx + ax2 * dt / 2) + (vx + ax3 * dt));
      const ny = y + dt / 6 * (vy + 2 * (vy + ay1 * dt / 2) + 2 * (vy + ay2 * dt / 2) + (vy + ay3 * dt));
      // Report every whole yard crossed during this step (linear interpolation inside the step).
      while (onYard && nextYard * 3 <= nx && nextYard * 3 <= maxFt) {
        const f = nx === x ? 0 : (nextYard * 3 - x) / (nx - x);
        onYard(nextYard, {
          y: y + (ny - y) * f,
          v: Math.hypot(vx + (nvx - vx) * f, vy + (nvy - vy) * f),
          t: t + dt * f,
        });
        nextYard++;
      }
      x = nx; y = ny; vx = nvx; vy = nvy; t += dt;
      if (vx <= 0) break;
    }
    return { x, y };
  }

  // Height (ft, relative to line of sight) at a given range for a launch angle.
  function heightAt(p, angle, yards) {
    let h = null;
    fly(p, angle, yards * 3, (yd, s) => { if (yd === yards) h = s.y; });
    return h;
  }

  function zeroAngle(p, zeroYards) {
    let lo = -0.02, hi = 0.06; // radians
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      const h = heightAt(p, mid, zeroYards);
      if (h === null || h < 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /*
   * opts: { mv, bc, model ('G1'|'G7'), weight (gr), sightHeight (in), zero (yd), maxRange (yd),
   *         tempF?, altitudeFt?, windMph?, windClock? (1–12; 3 = full value from the right) }
   * Returns { path (inches per yard), row(yd), nearZero, farZero, apex, subsonicAt, sound }.
   */
  function solve(opts) {
    const p = {
      mv: +opts.mv, bc: +opts.bc, model: opts.model === 'G7' ? 'G7' : 'G1',
      sightHeight: +opts.sightHeight || 0, air: air(opts.tempF, opts.altitudeFt),
    };
    const maxRange = Math.max(10, Math.min(2000, Math.round(+opts.maxRange || 500)));
    const zero = Math.max(1, +opts.zero || 100);
    const angle = zeroAngle(p, Math.round(zero));
    const clock = ((Math.round(+opts.windClock || 3) % 12) + 12) % 12;
    const cross = (+opts.windMph || 0) * 5280 / 3600 * Math.sin(clock / 12 * 2 * Math.PI); // ft/s, + = from the right

    const n = maxRange + 1;
    const path = new Float64Array(n).fill(NaN), vel = new Float64Array(n).fill(NaN), tof = new Float64Array(n).fill(NaN);
    fly(p, angle, maxRange * 3, (yd, s) => { if (yd < n) { path[yd] = s.y * 12; vel[yd] = s.v; tof[yd] = s.t; } });

    // Zero crossings and highest point above the line of sight.
    let nearZero = null, farZero = null, apex = { yd: 0, path: -Infinity };
    for (let yd = 1; yd < n; yd++) {
      if (Number.isNaN(path[yd])) break;
      if (path[yd - 1] < 0 && path[yd] >= 0 && nearZero === null) nearZero = interpZero(path, yd);
      else if (path[yd - 1] > 0 && path[yd] <= 0 && farZero === null) farZero = interpZero(path, yd);
      if (path[yd] > apex.path) apex = { yd, path: path[yd] };
    }

    const row = yd => {
      if (yd >= n || Number.isNaN(path[yd])) return null;
      const drift = yd ? -cross * (tof[yd] - (yd * 3) / p.mv) * 12 : 0; // in, + = right
      return {
        yd, path: path[yd], v: vel[yd], tof: tof[yd],
        energy: (+opts.weight || 0) * vel[yd] * vel[yd] / 450240,
        moa: yd ? -path[yd] / (1.04720 * yd / 100) : 0, // hold/correction, + = up
        mil: yd ? -path[yd] / (3.6 * yd / 100) : 0,
        drift,
        driftMoa: yd ? drift / (1.04720 * yd / 100) : 0,
        driftMil: yd ? drift / (3.6 * yd / 100) : 0,
      };
    };
    return {
      angle, path, nearZero, farZero, apex: apex.path > -Infinity ? apex : null, maxRange, row,
      sound: p.air.sound,
      // First yard where the bullet drops below the speed of sound (accuracy often suffers past it).
      subsonicAt: (() => { for (let yd = 0; yd < n; yd++) { if (vel[yd] < p.air.sound) return yd; } return null; })(),
    };
  }

  function interpZero(path, yd) {
    const a = path[yd - 1], b = path[yd];
    return yd - 1 + (b === a ? 0 : -a / (b - a));
  }

  window.Ballistics = { solve, air, cd, TABLES };
})();

// Interactive banner: a quadruped trotting through mud.
// Drag across the mud to lead it; grab the robot to pick it up and toss it.
(() => {
  const canvas = document.getElementById('mud-banner');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const root = canvas.closest('.banner');
  const hintEl = root.querySelector('.banner-hint');
  const terrainEl = root.querySelector('.banner-terrain');
  const motionMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const STORE_KEY = 'portfolio.mudBanner.terrain';

  // All lengths are in "base" px and get multiplied by the scale s.
  // sinkMax: how deep a planted foot settles. recover/diffuse: how fast the mud flows back.
  const TERRAINS = {
    firm: {
      sinkMax: 5, sinkRate: 9, recover: 0.35, diffuse: 1.5, speed: 1.0, splash: 0.35, lift: 13, printFade: 0.07,
      plane: ['#2c2419', '#44382b'], face: ['#3b2f23', '#140f0a'], edge: 'rgba(235,210,175,.16)',
      drop: ['#5b4b39', '#6e5c47'], sheen: 0.04,
    },
    wet: {
      sinkMax: 11, sinkRate: 5, recover: 0.18, diffuse: 3, speed: 0.72, splash: 1, lift: 19, printFade: 0.12,
      plane: ['#241a10', '#3a2a1b'], face: ['#33251a', '#110b07'], edge: 'rgba(240,200,160,.24)',
      drop: ['#4a3421', '#604630'], sheen: 0.1,
    },
    slurry: {
      sinkMax: 19, sinkRate: 3, recover: 0.9, diffuse: 7, speed: 0.48, splash: 1.8, lift: 27, printFade: 0.6,
      plane: ['#1e150d', '#302216'], face: ['#2a1d13', '#0d0805'], edge: 'rgba(255,215,170,.32)',
      drop: ['#3d2a19', '#58412a'], sheen: 0.2,
    },
    // hard ground with a tangle of vines mid-field: feet snag, then the robot high-steps out
    vines: {
      sinkMax: 0, sinkRate: 10, recover: 0.4, diffuse: 1.5, speed: 1.0, splash: 0, lift: 13, printFade: 1,
      plane: ['#222320', '#35362f'], face: ['#2c2b26', '#11100e'], edge: 'rgba(225,220,205,.14)',
      drop: ['#3f5a2c', '#5b8a3a'], sheen: 0, vines: true, hard: true,
    },
  };
  const VINE_GREENS = ['#2f4a22', '#3b5a29', '#4a6e32', '#355026'];
  const VINE_STEP = 40; // swing height (base px) when clearing vines

  const BODY_L = 104, HIP_X = 40, HIP_Y = 7, L1 = 33, L2 = 35, STAND = 52;
  const NEAR_ROW = 5, FAR_ROW = 15, PLANE = 30, DUTY = 0.62, VMAX = 85, GRAVITY = 1500;

  const LEGS = [
    { name: 'FL', front: true,  near: true,  off: 0 },
    { name: 'RL', front: false, near: true,  off: 0.5 },
    { name: 'FR', front: true,  near: false, off: 0.5 },
    { name: 'RR', front: false, near: false, off: 0 },
  ].map(l => ({ ...l, high: false, snag: null, catch: null, catchCool: 0, sw0: 0, snagCool: 0, state: 'stance', fx: 0, fy: 0, x0: 0, y0: 0, fvx: 0, fvy: 0, sink: 0, dirt: 0, print: null }));

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);

  let T = TERRAINS.wet;
  let W = 0, H = 0, s = 1, groundY = 0;
  let field = new Float32Array(0); // front-edge deformation, + = depression
  const COL = 3;
  let texture = [];
  let vines = []; // vine strands, rebuilt on resize / terrain change
  const prints = [], drops = [], ripples = [];

  const R = {
    x: 0, y: 0, vx: 0, vy: 0, pitch: 0, pv: 0, dir: 1, sx: 1, turnT: -1,
    mode: 'walk', phase: 0.05, target: null, time: 0, highStep: false, hurry: null, // hurry: leg finishing a snap-out step at speed
    grabDX: 0, grabDY: 0, px: 0, py: 0, samples: [],
  };

  let running = false, inView = true, lastTime = 0, rafId = 0;
  let reduced = motionMQ.matches;
  let dragging = null; // 'robot' | 'lead'
  let pauseFor = 0.6, userActed = false;

  // ---------- geometry helpers ----------
  const rowY = leg => groundY - (leg.near ? NEAR_ROW : FAR_ROW) * s;
  function toWorld(lx, ly) {
    const c = Math.cos(R.pitch), sn = Math.sin(R.pitch);
    const X = lx * R.sx * s, Y = ly * s;
    return [R.x + X * c - Y * sn, R.y + X * sn + Y * c];
  }
  const hipOf = leg => toWorld(leg.front ? HIP_X : -HIP_X, HIP_Y);
  const restY = () => groundY - 10 * s + T.sinkMax * s * 0.6 - (STAND + HIP_Y) * s;
  const margin = () => BODY_L * 0.7 * s;
  const fieldAt = x => field[clamp(Math.round(x / COL), 0, field.length - 1)] || 0;
  const vinePatch = () => { const w = clamp(W * 0.26, 170 * s, 360 * s); return [W / 2 - w / 2, W / 2 + w / 2]; };
  function inVines(x) {
    if (!T.vines) return false;
    const [a, b] = vinePatch(), m = 26 * s;
    return x > a - m && x < b + m;
  }

  function solveKnee(hx, hy, fx, fy, facing) {
    const l1 = L1 * s, l2 = L2 * s;
    let dx = fx - hx, dy = fy - hy, d = Math.hypot(dx, dy);
    if (d < 1e-3) { dx = 0; dy = 1; d = 1; }
    const max = (l1 + l2) * 0.999, min = Math.abs(l1 - l2) + 2;
    const dc = clamp(d, min, max);
    fx = hx + dx / d * dc; fy = hy + dy / d * dc;
    const a = Math.acos(clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1));
    const base = Math.atan2(fy - hy, fx - hx);
    const ka = [hx + l1 * Math.cos(base + a), hy + l1 * Math.sin(base + a)];
    const kb = [hx + l1 * Math.cos(base - a), hy + l1 * Math.sin(base - a)];
    // Knees point backward, like Spot's
    const k = (ka[0] * facing < kb[0] * facing) ? ka : kb;
    return { kx: k[0], ky: k[1], fx, fy };
  }

  // ---------- mud ----------
  function deform(x, depth, width) {
    const i0 = Math.floor((x - width * 3) / COL), i1 = Math.ceil((x + width * 3) / COL);
    for (let i = Math.max(0, i0); i <= Math.min(field.length - 1, i1); i++) {
      const u = (i * COL - x) / width;
      const v = depth * (Math.exp(-u * u) - 0.35 * Math.exp(-(((Math.abs(u) - 1.7) / 0.6) ** 2)));
      if (v > 0) field[i] = Math.max(field[i], v);
      else if (field[i] < 0.5) field[i] = Math.min(field[i], v);
    }
  }

  function relaxField(dt) {
    const k = Math.min(0.45, T.diffuse * dt), decay = Math.exp(-T.recover * dt);
    let prev = field[0];
    for (let i = 1; i < field.length - 1; i++) {
      const cur = field[i];
      field[i] = (cur + (prev + field[i + 1] - 2 * cur) * k) * decay;
      prev = cur;
    }
  }

  function addPrint(x, y, r) {
    const p = { x, y, r, depth: 0 };
    prints.push(p);
    if (prints.length > 90) prints.shift();
    return p;
  }

  function splash(x, y, n, power, bias = 0) {
    if (reduced) return;
    n = Math.round(n * T.splash);
    for (let i = 0; i < n && drops.length < 320; i++) {
      const ang = -Math.PI / 2 + rand(-0.85, 0.85);
      const sp = power * rand(0.35, 1.1) * s;
      drops.push({
        x, y, vx: Math.cos(ang) * sp + bias, vy: Math.sin(ang) * sp,
        r: rand(1, 2.6) * s, floor: groundY - rand(0, PLANE * 0.95) * s,
        c: Math.random() < 0.5 ? 0 : 1,
      });
    }
  }

  function buildTexture() {
    texture = [];
    const n = Math.round(W / 9);
    for (let i = 0; i < n; i++) {
      texture.push({ x: Math.random() * W, t: Math.random(), r: rand(0.6, 2.4), light: Math.random() < 0.35 });
    }
  }

  function buildVines() {
    vines = [];
    for (const leg of LEGS) { leg.snag = null; leg.catch = null; }
    if (!T.vines) return;
    const [a, b] = vinePatch();
    for (let i = 0; i < 18; i++) {
      const x0 = rand(a - 12 * s, b - 50 * s), x1 = Math.min(b + 12 * s, x0 + rand(70, 170) * s);
      const row = rand(2, PLANE - 3);                    // base px behind the front edge
      const leaves = [];
      for (let u = rand(0, 14) * s; u < x1 - x0; u += rand(12, 22) * s) leaves.push({ u, side: Math.random() < 0.5 ? -1 : 1, r: rand(2.2, 3.8) });
      vines.push({
        x0, x1, row, front: row < NEAR_ROW + 1.5,
        h: rand(6, 17) * s, k: rand(0.03, 0.065) / s, ph: rand(0, Math.PI * 2),
        w: rand(1.3, 2.6) * s, c: VINE_GREENS[i % VINE_GREENS.length], leaves,
      });
    }
  }

  // Resting height of a strand above its base at x; planted feet press it flat
  function vineArch(v, x) {
    const span = v.x1 - v.x0, u = (x - v.x0) / span;
    const taper = Math.min(1, u * 5, (1 - u) * 5);
    let press = 0;
    if (R.mode === 'walk') {
      const base = groundY - v.row * s;
      for (const leg of LEGS) {
        if (leg.state !== 'stance' || Math.abs(rowY(leg) - base) > 9 * s) continue;
        press = Math.max(press, 1 - Math.abs(leg.fx - x) / (16 * s));
      }
    }
    const sway = reduced ? 0 : Math.sin(R.time * 1.3 + v.ph + x * 0.02) * 0.8 * s;
    return (v.h * Math.abs(Math.sin(v.k * (x - v.x0) + v.ph)) + sway) * taper * (1 - Math.max(0, press) * 0.85);
  }
  const vineY = (v, x) => groundY - v.row * s - vineArch(v, x);

  // Where a strand actually is at x: its resting shape, plus any foot hooked on it pulling
  // it like a string pinned at both ends, plus the spring-back after a foot slips off
  function vinePoint(v, x) {
    let px = x, py = vineY(v, x);
    const pull = (cx, dx, dy) => {
      const w = x <= cx ? (x - v.x0) / Math.max(1, cx - v.x0) : (v.x1 - x) / Math.max(1, v.x1 - cx);
      const k = Math.pow(clamp(w, 0, 1), 1.25);
      px += dx * k; py += dy * k;
    };
    for (const leg of LEGS) if (leg.snag && leg.snag.v === v) pull(leg.snag.cx, leg.fx - leg.snag.cx, leg.fy - leg.snag.cy);
    if (v.recoil) pull(v.recoil.cx, v.recoil.dx * v.recoil.a, v.recoil.dy * v.recoil.a);
    return [px, py];
  }

  // The existing strand a foot at (x, rowY) is tangled in, if any (one foot per strand)
  function strandNear(x, row, footY = null) {
    let best = null, bd = Infinity;
    for (const v of vines) {
      if (x < v.x0 + 5 * s || x > v.x1 - 5 * s) continue;
      if (LEGS.some(l => l.snag && l.snag.v === v)) continue;
      const base = groundY - v.row * s, dRow = Math.abs(base - row);
      if (dRow > 10 * s) continue;
      if (footY !== null && footY < vineY(v, x) - 4 * s) continue; // foot passing above it
      if (dRow < bd) { bd = dRow; best = v; }
    }
    return best;
  }
  function hook(leg, v) { leg.snag = { v, cx: leg.fx, cy: vineY(v, leg.fx) }; }
  // Foot slips free: the strand springs back and sheds a couple of leaves
  function unhook(leg, leaves) {
    const { v, cx, cy } = leg.snag;
    v.recoil = { cx, dx: leg.fx - cx, dy: leg.fy - cy, a: 1, t: 0 };
    leafBurst(leg.fx, leg.fy, leaves);
    leg.snag = null;
  }

  function leafBurst(x, y, n) {
    if (reduced) return;
    for (let i = 0; i < n && drops.length < 320; i++) {
      const ang = -Math.PI / 2 + rand(-1.2, 1.2), sp = rand(50, 160) * s;
      drops.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: rand(1.2, 2.2) * s, floor: groundY - rand(0, PLANE * 0.95) * s, c: i % 2 });
    }
  }

  function clearSnags() {
    for (const leg of LEGS) { leg.snag = null; leg.catch = null; }
    R.highStep = false;
  }

  function drawVines(front) {
    for (const v of vines) {
      if (v.front !== front) continue;
      ctx.strokeStyle = v.c; ctx.lineWidth = v.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let x = v.x0; x <= v.x1 + 0.1; x += 3) {
        const [px, py] = vinePoint(v, Math.min(x, v.x1));
        ctx[x === v.x0 ? 'moveTo' : 'lineTo'](px, py);
      }
      ctx.stroke();
      ctx.fillStyle = v.c;
      for (const lf of v.leaves) {
        const x = v.x0 + lf.u;
        const [px, py] = vinePoint(v, x), [ax, ay] = vinePoint(v, x - 2), [bx, by] = vinePoint(v, x + 2);
        ctx.beginPath();
        ctx.ellipse(px, py + lf.side * 2.5 * s, lf.r * s * 1.6, lf.r * s * 0.7, Math.atan2(by - ay, bx - ax) + lf.side * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---------- robot ----------
  function plantAll() {
    for (const leg of LEGS) {
      const [hx] = hipOf(leg);
      leg.state = 'stance';
      leg.fx = hx; leg.fy = rowY(leg) + T.sinkMax * s * 0.6;
      leg.sink = T.sinkMax * s * 0.6; leg.fvx = leg.fvy = 0; leg.print = null;
    }
    R.phase = 0.05;
  }

  function initRobot() {
    R.x = W * 0.2; R.vx = R.vy = 0; R.pitch = R.pv = 0; R.dir = 1; R.sx = 1; R.turnT = -1;
    R.mode = 'walk'; R.target = null; R.y = restY();
    plantAll();
    for (const leg of LEGS) leg.dirt = 0;
    field.fill(0); prints.length = 0; drops.length = 0; ripples.length = 0;
  }

  function hitRobot(px, py) {
    const dx = px - R.x, dy = py - R.y, c = Math.cos(R.pitch), sn = Math.sin(R.pitch);
    const lx = (dx * c + dy * sn) / s, ly = (-dx * sn + dy * c) / s;
    return Math.abs(lx) < (BODY_L / 2 + 14) * Math.max(0.45, Math.abs(R.sx)) && ly > -30 && ly < HIP_Y + 30;
  }

  function stepWalk(dt) {
    if (R.highStep && !inVines(R.x) && LEGS.every(l => !inVines(l.fx))) R.highStep = false;
    const pulling = LEGS.some(l => l.catch);
    for (const leg of LEGS) leg.catchCool = Math.max(0, leg.catchCool - dt);
    const vmax = VMAX * s * T.speed * (R.highStep ? 0.7 : 1);
    let desired = 0;

    if (R.turnT >= 0) {
      R.turnT += dt / 0.55;
      if (R.turnT >= 1) { R.dir = -R.dir; R.turnT = -1; }
    } else if (R.target !== null) {
      const dx = R.target - R.x;
      if (Math.sign(dx) !== R.dir && Math.abs(dx) > 40 * s) {
        if (Math.abs(R.vx) < 10) { R.turnT = 0; R.vx = 0; }
      } else {
        desired = clamp(dx * 2.4, -vmax, vmax);
        if (Math.sign(desired) !== R.dir) desired *= 0.45; // shuffling backward
        if (Math.abs(dx) < 2 && Math.abs(R.vx) < 6) { R.target = null; pauseFor = 1.2; }
      }
    }
    const acc = 240 * s * T.speed * dt;
    if (pulling) { desired = 0; R.vx *= Math.exp(-7 * dt); } // a foot is caught: the body stops
    R.vx += clamp(desired - R.vx, -acc, acc);
    R.x += R.vx * dt;
    if (R.x < margin() || R.x > W - margin()) { R.x = clamp(R.x, margin(), W - margin()); R.vx = 0; }

    // facing scale: squash through a front-on view while turning
    if (R.turnT >= 0) {
      const c = Math.cos(Math.PI * R.turnT);
      R.sx = R.dir * Math.sign(c || 1) * Math.max(0.38, Math.abs(c));
    } else R.sx = R.dir;

    const speed = Math.abs(R.vx);
    const freq = (1.45 + 1.3 * speed / (VMAX * s)) * (R.highStep ? 0.8 : 1);
    let allStance = true, farOff = 0;
    for (const leg of LEGS) {
      if (leg.state !== 'stance') allStance = false;
      farOff = Math.max(farOff, Math.abs(leg.fx - hipOf(leg)[0]));
    }
    const moving = speed > 3 || pulling || (R.target !== null && R.turnT < 0);
    // the gait holds still while a foot works itself free of a vine
    if (R.turnT < 0 && !pulling && (moving || !allStance || farOff > 16 * s)) R.phase = (R.phase + dt * freq * (R.hurry ? 2.6 : 1)) % 1;

    const stanceTime = DUTY / freq;
    for (const leg of LEGS) {
      const [hx] = hipOf(leg);
      const cb = rowY(leg);
      if (R.turnT >= 0) { // shuffle feet under the hips
        leg.state = 'stance';
        if (leg.catch) { if (leg.snag) unhook(leg, 1); leg.catch = null; }
        R.hurry = null;
        leg.fx += (hx - leg.fx) * Math.min(1, dt * 10);
        const hop = Math.max(0, Math.sin(R.turnT * Math.PI * 4 + (leg.off ? Math.PI : 0)));
        leg.fy = cb + leg.sink * (1 - hop) - 5 * s * hop;
        continue;
      }
      const p = (R.phase + leg.off) % 1;
      const wantSwing = p >= DUTY;
      if (wantSwing && leg.state === 'stance') {
        leg.state = 'swing'; leg.x0 = leg.fx; leg.y0 = leg.fy; leg.sw0 = 0; leg.print = null;
        leg.high = R.highStep && (inVines(leg.x0) || inVines(hx + R.vx * (1 - DUTY + DUTY * 0.5) / freq));
        if (leg.sink > 2 * s) splash(leg.fx, cb, 3 + leg.sink / s * 0.3, 160 + leg.sink * 6, R.vx * 0.3);
        leg.dirt = Math.min(1, leg.dirt + 0.05 * T.splash);
      } else if (!wantSwing && leg.state === 'swing') {
        leg.state = 'stance'; leg.sink = 0; leg.fy = cb;
        if (R.hurry === leg) R.hurry = null;
        if (!T.hard) {
          leg.print = addPrint(leg.fx, cb, 1);
          splash(leg.fx, cb, 2 + speed / (VMAX * s) * 4, 130, R.vx * 0.2);
        }
      }

      if (leg.state === 'stance') {
        leg.sink = Math.max(leg.sink, leg.sink + (T.sinkMax * s - leg.sink) * (1 - Math.exp(-T.sinkRate * dt)));
        leg.fy = cb + leg.sink;
        if (leg.print) leg.print.depth = Math.max(leg.print.depth, leg.sink);
        if (leg.near) deform(leg.fx, leg.sink * 0.6, 7 * s);
        continue;
      }

      const sw = (p - DUTY) / (1 - DUTY);
      if (leg.catch) {
        // The swinging foot ran into a vine. It keeps pushing forward into it (the vine
        // stretches and holds), then flicks back out of the loop and up over the tangle.
        const PUSH = 0.6, FLICK = 0.12;
        const c = leg.catch, fwd = R.dir;
        c.t += dt;
        if (c.t < PUSH) {
          const push = Math.abs(Math.sin((c.t / PUSH) * Math.PI * 2)); // two shoves into the vine
          leg.fx = c.x + fwd * 13 * s * push;
          leg.fy = c.y - 2 * s * push;
          continue;
        }
        if (leg.snag) unhook(leg, 2); // drawing the foot back: the strand slips off
        const u = clamp((c.t - PUSH) / FLICK, 0, 1);
        const top = Math.min(c.y, cb - 28 * s);  // just clear of the tallest strands
        leg.fx = c.x - fwd * 18 * s * (1 - Math.pow(1 - u, 3));
        leg.fy = lerp(c.y, top, 1 - Math.pow(1 - u, 2));
        if (u < 1) continue;
        leg.catch = null; leg.catchCool = 0.8;
        R.hurry = leg; // snap straight on over the tangle
        R.highStep = true;
        // restart this leg pair's swing from where the feet are now, so the freed foot
        // gets a full (fast) high step over the vines instead of dropping straight down
        R.phase = ((DUTY - leg.off) % 1 + 1) % 1 + 0.001;
        for (const o of LEGS) if (o.off === leg.off && o.state === 'swing') { o.x0 = o.fx; o.y0 = o.fy; o.sw0 = 0; }
        leg.high = true;
        continue;
      }

      const su = clamp((sw - leg.sw0) / Math.max(0.05, 1 - leg.sw0), 0, 1); // progress through the rest of the swing
      const remain = (1 - p) / freq;
      const reach = 0.5 * (L1 + L2) * s;
      const tx = hx + clamp(R.vx * remain + R.vx * stanceTime * 0.5, -reach, reach);
      if (!leg.high && R.highStep && su < 0.35 && inVines(tx)) leg.high = true;
      // a foot that starts the swing already raised only needs a little more lift
      const lift = leg.high ? Math.max(8 * s, VINE_STEP * s - (cb - leg.y0) * 0.8)
        : T.lift * s * (0.45 + 0.55 * Math.min(1, speed / (VMAX * s * T.speed)));
      // high steps use a boxier arc: up fast, across, then down
      const arc = leg.high ? Math.pow(Math.sin(Math.PI * su), 0.55) : Math.sin(Math.PI * su);
      const prevX = leg.fx;
      leg.fx = leg.x0 + (tx - leg.x0) * (leg.high ? ease(clamp((su - 0.15) / 0.7, 0, 1)) : ease(su));
      leg.fy = leg.y0 + (cb - leg.y0) * su - lift * arc;

      // does the foot, moving forward, run into a strand that is actually in its way?
      if (T.vines && !leg.snag && leg.catchCool <= 0 && inVines(leg.fx) && (leg.fx - prevX) * R.dir > 0) {
        const v = strandNear(leg.fx, cb, leg.fy);
        if (v) { hook(leg, v); leg.catch = { t: 0, x: leg.fx, y: leg.fy }; }
      }
    }

    // body height and pitch follow the support feet
    let sum = 0, left = 0, right = 0, nl = 0, nr = 0;
    for (const leg of LEGS) {
      const sup = (leg.state === 'stance' ? leg.fy : rowY(leg) + T.sinkMax * s * 0.6) + (leg.near ? -5 : 5) * s;
      sum += sup;
      if (hipOf(leg)[0] > R.x) { right += sup; nr++; } else { left += sup; nl++; }
    }
    const bob = reduced ? 0 : -1.4 * s * Math.cos(4 * Math.PI * R.phase) * Math.min(1, speed / (VMAX * s * 0.5));
    const ty = sum / 4 - (STAND + HIP_Y) * s + bob + (pulling ? 4 * s : 0);
    const k = 150, c = 2 * 0.5 * Math.sqrt(k);
    R.vy += (k * (ty - R.y) - c * R.vy) * dt;
    R.y += R.vy * dt;
    const tp = nl && nr ? clamp(Math.atan2(right / nr - left / nl, 2 * HIP_X * s), -0.25, 0.25) : 0;
    R.pv += (70 * (tp - R.pitch) - 2 * 0.7 * Math.sqrt(70) * R.pv) * dt;
    R.pitch += R.pv * dt;
  }

  function dangleLegs(dt) {
    const reach = (L1 + L2) * s * 0.92;
    const fast = Math.hypot(R.vx, R.vy) > 650;
    LEGS.forEach((leg, i) => {
      const [hx, hy] = hipOf(leg);
      const kick = Math.sin(R.time * 11 + i * 1.7) * 4 * s;
      const rx = hx + kick, ry = hy + reach;
      leg.fvx += (180 * (rx - leg.fx) - 2 * 0.3 * Math.sqrt(180) * leg.fvx) * dt;
      leg.fvy += (180 * (ry - leg.fy) - 2 * 0.3 * Math.sqrt(180) * leg.fvy) * dt;
      leg.fx += leg.fvx * dt; leg.fy += leg.fvy * dt;
      const d = Math.hypot(leg.fx - hx, leg.fy - hy);
      if (d > reach) { leg.fx = hx + (leg.fx - hx) / d * reach; leg.fy = hy + (leg.fy - hy) / d * reach; }
      leg.state = 'swing'; leg.print = null; leg.catch = null;
      if (T.vines) {
        const cb = rowY(leg), SNAP = 72 * s;
        leg.snagCool = Math.max(0, leg.snagCool - dt);
        if (!leg.snag && !leg.snagCool && inVines(leg.fx)) {
          const v = strandNear(leg.fx, cb, leg.fy);
          if (v) hook(leg, v);
        }
        if (leg.snag) {
          const dx = leg.snag.cx - leg.fx, dy = leg.snag.cy - leg.fy, dd = Math.hypot(dx, dy);
          if (dd > SNAP) { unhook(leg, 3); leg.snagCool = 0.45; }
          else {
            leg.fvx += dx * 260 * dt; leg.fvy += dy * 260 * dt;   // vine drags the foot back
            R.vx += dx * 120 * dt; R.vy += dy * 120 * dt;         // and the whole robot with it
          }
        }
      }
      if (fast && leg.dirt > 0.02 && !reduced) { // shaking mud off
        leg.dirt = Math.max(0, leg.dirt - dt * 0.9);
        if (Math.random() < 0.5) drops.push({ x: leg.fx, y: leg.fy, vx: R.vx * 0.6 + rand(-80, 80), vy: R.vy * 0.6 + rand(-80, 40), r: rand(1, 2.4) * s, floor: groundY - rand(0, PLANE * 0.95) * s, c: 1 });
      }
    });
  }

  function land() {
    const impact = Math.max(0, R.vy);
    R.mode = 'walk'; R.target = null; R.vx *= 0.25; R.vy *= 0.55;
    const extra = Math.min(T.sinkMax * s * 1.7, T.sinkMax * s * (0.5 + impact / 900));
    R.highStep = false;
    for (const leg of LEGS) {
      const [hx] = hipOf(leg);
      const cb = rowY(leg);
      leg.state = 'stance'; leg.fx = clamp(leg.fx, hx - 20 * s, hx + 20 * s);
      leg.sink = extra; leg.fy = cb + extra; leg.fvx = leg.fvy = 0;
      leg.snag = null; leg.catch = null; leg.sw0 = 0;
      if (T.hard) continue;
      leg.print = addPrint(leg.fx, cb, 1.25); leg.print.depth = extra;
      if (leg.near) deform(leg.fx, extra * 0.7, 9 * s);
      splash(leg.fx, cb, 4 + impact / 70, 120 + impact * 0.45, rand(-60, 60));
      leg.dirt = Math.min(1, leg.dirt + 0.25 * T.splash);
    }
    R.phase = 0.05; pauseFor = 1;
  }

  function stepAir(dt) {
    R.hurry = null;
    if (R.mode === 'held') {
      const tx = R.px - R.grabDX, ty = Math.min(R.py - R.grabDY, restY() + 6 * s);
      const k = 320, c = 2 * 0.75 * Math.sqrt(k);
      R.vx += (k * (tx - R.x) - c * R.vx) * dt;
      R.vy += (k * (ty - R.y) - c * R.vy) * dt;
    } else {
      R.vy += GRAVITY * dt;
    }
    R.x += R.vx * dt; R.y += R.vy * dt;
    if (R.x < margin() * 0.6) { R.x = margin() * 0.6; R.vx = Math.abs(R.vx) * 0.45; }
    if (R.x > W - margin() * 0.6) { R.x = W - margin() * 0.6; R.vx = -Math.abs(R.vx) * 0.45; }
    if (R.turnT >= 0) { R.turnT = -1; R.sx = R.dir; }
    const tp = clamp(R.vx * 0.0007, -0.5, 0.5);
    R.pv += (90 * (tp - R.pitch) - 2 * 0.5 * Math.sqrt(90) * R.pv) * dt;
    R.pitch += R.pv * dt;
    dangleLegs(dt);
    if (R.mode === 'air' && R.vy > 0 && LEGS.some(l => l.fy >= rowY(l))) land();
  }

  function update(dt) {
    R.time += dt;
    if (R.mode === 'walk') stepWalk(dt); else stepAir(dt);
    relaxField(dt);

    for (let i = prints.length - 1; i >= 0; i--) {
      const p = prints[i];
      if (LEGS.some(l => l.print === p)) continue;
      p.depth *= Math.exp(-T.printFade * dt);
      if (p.depth < 0.35) prints.splice(i, 1);
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.vy += GRAVITY * 0.8 * dt; d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.vy > 0 && d.y >= d.floor) {
        if (!T.hard && d.r > 1.8 * s && prints.length < 90) { const p = addPrint(d.x, d.floor, 0.35); p.depth = 3 * s; }
        drops.splice(i, 1);
      } else if (d.x < -20 || d.x > W + 20) drops.splice(i, 1);
    }
    for (const v of vines) {
      if (!v.recoil) continue;
      const r = v.recoil;
      r.t += dt; r.a = Math.exp(-5 * r.t) * Math.cos(22 * r.t);
      if (r.t > 1.2) v.recoil = null;
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      ripples[i].age += dt;
      if (ripples[i].age > 0.9) ripples.splice(i, 1);
    }

    // patrol: walk to the far edge, pause, head back
    if (!reduced && R.mode === 'walk' && R.target === null && dragging !== 'lead') {
      pauseFor -= dt;
      if (pauseFor <= 0) R.target = R.x < W / 2 ? W - margin() : margin();
    }
  }

  // ---------- drawing ----------
  function rr(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  }

  function drawScene() {
    const top = groundY - PLANE * s;
    // backdrop with a faint sim grid
    const bg = ctx.createLinearGradient(0, 0, 0, top);
    bg.addColorStop(0, '#0b0c0d'); bg.addColorStop(1, '#16171a');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,.035)'; ctx.lineWidth = 1;
    ctx.beginPath();
    const g = 48 * s;
    for (let x = (W / 2) % g; x < W; x += g) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, top); }
    for (let y = top - g; y > 0; y -= g) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();

    // name as a backdrop wordmark, centred in the sky above the robot's back
    const size = Math.min(top * 0.62, W / 6.4);
    const midY = top * 0.42, base = midY + size * 0.34; // alphabetic baseline for caps centred on midY
    ctx.font = `700 ${size}px "Anek Devanagari", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const ng = ctx.createLinearGradient(0, base - size * 0.75, 0, base);
    ng.addColorStop(0, 'rgba(240,242,244,.42)'); ng.addColorStop(1, 'rgba(240,242,244,.2)');
    ctx.fillStyle = ng;
    ctx.fillText('George Ortiz', W / 2, base);

    // mud plane (top surface seen at a shallow angle)
    const pg = ctx.createLinearGradient(0, top, 0, groundY);
    pg.addColorStop(0, T.plane[0]); pg.addColorStop(1, T.plane[1]);
    ctx.fillStyle = pg; ctx.fillRect(0, top, W, groundY - top + 1);
    ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(0, top, W, 1);
    for (const t of texture) {
      const y = top + t.t * PLANE * s;
      ctx.fillStyle = t.light ? `rgba(255,225,190,${T.sheen * 0.8})` : 'rgba(0,0,0,.22)';
      ctx.beginPath(); ctx.ellipse(t.x, y, t.r * s * (1 + t.t) * 1.6, t.r * s * 0.45, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (T.sheen > 0.05) {
      ctx.fillStyle = `rgba(255,230,200,${T.sheen * 0.35})`;
      for (let i = 0; i < 6; i++) {
        const x = ((i * 0.173 + 0.07) % 1) * W + Math.sin(R.time * 0.3 + i) * 20;
        ctx.beginPath(); ctx.ellipse(x, top + (0.3 + (i % 3) * 0.2) * PLANE * s, 40 * s, 1.2 * s, 0, 0, Math.PI * 2); ctx.fill();
      }
    }

    // footprints
    for (const p of prints) {
      const a = Math.min(0.62, p.depth / (10 * s) * 0.5 + 0.08);
      const rx = 7 * s * p.r, ry = 2.3 * s * p.r;
      ctx.fillStyle = `rgba(8,5,2,${a})`;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(255,220,180,${a * 0.35})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 0.6 * s, rx * 1.05, ry * 1.05, 0, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    }
    for (const r of ripples) {
      const k = r.age / 0.9, rx = (4 + k * 34) * s;
      ctx.strokeStyle = `rgba(255,220,180,${(1 - k) * 0.4})`; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(r.x, r.y, rx, rx * 0.26, 0, 0, Math.PI * 2); ctx.stroke();
    }

    // route + target flag
    if (R.target !== null) {
      const y = groundY - 10 * s;
      ctx.setLineDash([4 * s, 6 * s]); ctx.strokeStyle = 'rgba(240,242,244,.22)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(R.x, y); ctx.lineTo(R.target, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(240,242,244,.7)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(R.target, y); ctx.lineTo(R.target, y - 26 * s); ctx.stroke();
      ctx.fillStyle = '#9c1414';
      ctx.beginPath(); ctx.moveTo(R.target, y - 26 * s); ctx.lineTo(R.target + 13 * s, y - 21.5 * s); ctx.lineTo(R.target, y - 17 * s); ctx.fill();
      ctx.fillStyle = 'rgba(8,5,2,.5)';
      ctx.beginPath(); ctx.ellipse(R.target, y, 4 * s, 1.3 * s, 0, 0, Math.PI * 2); ctx.fill();
    }

    // shadow under the robot, shrinks with height
    const lift = clamp((restY() - R.y) / (140 * s), 0, 1);
    ctx.fillStyle = `rgba(0,0,0,${0.32 * (1 - lift * 0.7)})`;
    ctx.beginPath(); ctx.ellipse(R.x, groundY - 10 * s, 58 * s * (1 - lift * 0.4) * Math.max(0.5, Math.abs(R.sx)), 5 * s, 0, 0, Math.PI * 2); ctx.fill();

    drawVines(false);

    // front cross-section of the mud
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let i = 0; i < field.length; i++) ctx.lineTo(i * COL, groundY + field[i]);
    ctx.lineTo(W, H); ctx.closePath();
    const fg = ctx.createLinearGradient(0, groundY, 0, H);
    fg.addColorStop(0, T.face[0]); fg.addColorStop(1, T.face[1]);
    ctx.fillStyle = fg; ctx.fill();
    ctx.save(); ctx.clip();
    for (const t of texture) {
      ctx.fillStyle = t.light ? 'rgba(255,220,180,.05)' : 'rgba(0,0,0,.28)';
      ctx.beginPath(); ctx.arc(t.x, groundY + 6 * s + t.t * (H - groundY), t.r * s * 0.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = T.edge; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < field.length; i++) ctx[i ? 'lineTo' : 'moveTo'](i * COL, groundY + field[i] + 0.75);
    ctx.stroke();
  }

  function drawLeg(leg, far) {
    const [hx, hy] = hipOf(leg);
    const facing = Math.sign(R.sx) || 1;
    const { kx, ky, fx, fy } = solveKnee(hx, hy, leg.fx, leg.fy, facing);
    const cb = rowY(leg);
    ctx.save();
    ctx.beginPath(); ctx.rect(-50, -H * 4, W + 100, cb + H * 4); ctx.clip();
    ctx.lineCap = 'round';
    ctx.strokeStyle = far ? '#2a2f34' : '#3a4046'; ctx.lineWidth = 7.5 * s;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(kx, ky); ctx.stroke();
    ctx.strokeStyle = far ? '#30353a' : '#474e55'; ctx.lineWidth = 5.5 * s;
    ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
    // mud caked on the lower leg
    const coat = Math.min(1, (T.sinkMax * 0.9 + leg.dirt * 16) * s / Math.hypot(kx - fx, ky - fy));
    if (coat > 0.05) {
      ctx.strokeStyle = far ? '#1d140c' : T.drop[0]; ctx.lineWidth = 6.3 * s;
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + (kx - fx) * coat, fy + (ky - fy) * coat); ctx.stroke();
    }
    ctx.fillStyle = far ? '#23272b' : '#5a626a';
    ctx.beginPath(); ctx.arc(kx, ky, 3.8 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = far ? '#0a0a0a' : (leg.dirt > 0.3 ? T.drop[0] : '#111');
    ctx.beginPath(); ctx.arc(fx, fy, 4.3 * s, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // mud collar where the leg enters the surface
    if (!T.hard && fy > cb - 1) {
      const d = Math.min(fy - cb, T.sinkMax * s * 1.7);
      ctx.fillStyle = far ? T.plane[0] : T.plane[1];
      ctx.beginPath(); ctx.ellipse(fx, cb, 5.5 * s + d * 0.3, 1.8 * s + d * 0.06, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(255,220,180,${0.12 + T.sheen})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(fx, cb, 5.5 * s + d * 0.3, 1.8 * s + d * 0.06, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    }
  }

  function drawBody() {
    ctx.save();
    ctx.translate(R.x, R.y); ctx.rotate(R.pitch); ctx.scale(R.sx * s, s);
    rr(-52, -12, 104, 24, 10); ctx.fillStyle = '#c4c9ce'; ctx.fill();      // body
    rr(38, -9, 18, 18, 7); ctx.fillStyle = '#1f2327'; ctx.fill();          // sensor head
    ctx.restore();
  }

  function drawRobot() {
    for (const leg of LEGS) if (!leg.near) drawLeg(leg, true);
    drawBody();
    for (const leg of LEGS) if (leg.near) drawLeg(leg, false);
    for (const leg of LEGS) {
      if (!leg.near) continue;
      const [hx, hy] = hipOf(leg);
      ctx.fillStyle = '#2a2f34'; ctx.beginPath(); ctx.arc(hx, hy, 6 * s, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawDrops() {
    for (const d of drops) {
      ctx.fillStyle = T.drop[d.c];
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    drawScene();
    drawRobot();
    drawVines(true);
    drawDrops();
  }

  // ---------- loop ----------
  function frame(t) {
    if (!running) return;
    const dt = Math.min(1 / 30, (t - lastTime) / 1000 || 0);
    lastTime = t;
    update(dt);
    render();
    rafId = requestAnimationFrame(frame);
  }
  function start() {
    if (running || !inView || !W) return;
    running = true; lastTime = performance.now();
    rafId = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(rafId); }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const first = !W, oldW = W;
    W = r.width; H = r.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    s = clamp(H / 225, 0.9, 1.55);
    groundY = H - clamp(H * 0.2, 40, 72);
    field = new Float32Array(Math.ceil(W / COL) + 2);
    prints.length = 0; drops.length = 0;
    buildTexture();
    buildVines();
    if (first) initRobot();
    else {
      R.x = clamp(R.x * W / oldW, margin(), W - margin());
      if (R.target !== null) R.target = clamp(R.target * W / oldW, margin(), W - margin());
      R.mode = 'walk'; R.vx = R.vy = 0; R.turnT = -1; R.sx = R.dir; R.y = restY();
      plantAll();
    }
    render();
    start();
  }

  // ---------- input ----------
  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function interacted() {
    if (!userActed) { userActed = true; hintEl.classList.add('dismissed'); }
    pauseFor = 1.5;
  }

  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const [px, py] = localPoint(e);
    interacted();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    R.px = px; R.py = py; R.samples = [{ x: px, y: py, t: performance.now() }];
    if (hitRobot(px, py)) {
      dragging = 'robot'; R.mode = 'held'; R.target = null;
      R.grabDX = px - R.x; R.grabDY = py - R.y;
      canvas.style.cursor = 'grabbing';
    } else {
      dragging = 'lead';
      R.target = clamp(px, margin(), W - margin());
      if (py > groundY - PLANE * s) {
        ripples.push({ x: px, y: clamp(py, groundY - PLANE * s, groundY), age: 0 });
        splash(px, clamp(py, groundY - PLANE * s, groundY), 3, 140);
      }
    }
  });
  canvas.addEventListener('pointermove', e => {
    const [px, py] = localPoint(e);
    if (!dragging) { canvas.style.cursor = hitRobot(px, py) ? 'grab' : 'crosshair'; return; }
    R.px = px; R.py = py;
    const now = performance.now();
    R.samples.push({ x: px, y: py, t: now });
    while (R.samples.length > 2 && now - R.samples[0].t > 90) R.samples.shift();
    if (dragging === 'lead') R.target = clamp(px, margin(), W - margin());
  });
  function endDrag(e) {
    if (!dragging) return;
    if (dragging === 'robot') {
      const a = R.samples[0], b = R.samples[R.samples.length - 1];
      const dt = Math.max(16, b.t - a.t) / 1000;
      const lim = 1400 * s;
      R.vx = clamp((b.x - a.x) / dt, -lim, lim);
      R.vy = clamp((b.y - a.y) / dt, -lim, lim);
      if (Math.sign(R.vx) && Math.abs(R.vx) > 60) R.dir = Math.sign(R.vx);
      R.sx = R.dir;
      R.mode = 'air';
      canvas.style.cursor = 'grab';
    }
    dragging = null;
    if (e && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', () => endDrag());

  canvas.addEventListener('keydown', e => {
    if (R.mode !== 'walk') return;
    const base = R.target ?? R.x;
    if (e.key === 'Enter' || e.key === ' ') R.target = rand(margin(), W - margin());
    else if (e.key === 'ArrowLeft') R.target = clamp(base - 80 * s, margin(), W - margin());
    else if (e.key === 'ArrowRight') R.target = clamp(base + 80 * s, margin(), W - margin());
    else if (e.key === 'Escape') R.target = null;
    else return;
    e.preventDefault(); interacted();
  });

  function setTerrain(name) {
    if (!TERRAINS[name]) name = 'wet';
    T = TERRAINS[name];
    clearSnags();
    field.fill(0); prints.length = 0; drops.length = 0;
    for (const leg of LEGS) { leg.sink = Math.min(leg.sink, T.sinkMax * s * 0.6); leg.print = null; }
    buildVines();
    terrainEl.value = name;
    try { localStorage.setItem(STORE_KEY, name); } catch {}
  }
  terrainEl.addEventListener('change', () => { setTerrain(terrainEl.value); interacted(); });
  try { setTerrain(localStorage.getItem(STORE_KEY) || 'wet'); } catch { setTerrain('wet'); }

  motionMQ.addEventListener?.('change', e => { reduced = e.matches; if (reduced) drops.length = 0; });
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (inView) start(); else stop();
  }).observe(canvas);
})();

/*
 * game.js — the runtime: fixed-timestep physics, player, movable bodies,
 * tether, quests, camera, rendering, UI glue and the save system.
 *
 * Design notes
 * ------------
 * - Physics runs at a FIXED 120 Hz step with an accumulator, so behaviour is
 *   identical regardless of display refresh rate (frame-rate independence).
 * - All bodies (player, crates, orb) use CENTER coordinates with half-extents
 *   and are resolved against solid AABBs one axis at a time.
 * - The tether is an elastic (bungee) constraint: it only pulls when stretched
 *   past its rest length, with velocity damping — a rope you can reel in/out.
 */
(function (G) {
  'use strict';

  const { clamp, lerp, dist, aabb, pointInRect, easeOut } = G.util;
  const WORLD = G.WORLD;
  const Input = G.Input;
  const Audio = G.Audio;

  // ----- tuning constants -------------------------------------------------
  const STEP = 1 / 120;              // fixed physics timestep (s)
  const MAX_FRAME = 0.25;            // clamp huge frame gaps (tab switch)
  const PLAYER = {
    hw: 15, hh: 22,                  // half width / height
    runAccelGround: 5200,
    runAccelAir: 2600,
    maxRun: 540,
    jumpVel: 880,
    coyote: 0.10,                    // grace after leaving ground
    buffer: 0.10,                    // jump pressed slightly early
    mass: 25,                        // contribution to the counterweight plate
  };
  const TETHER = {
    range: 560,                      // max attach distance to an anchor
    cone: 0.75,                      // how forgiving aim is (dot threshold)
    k: 62,                           // spring stiffness (accel per px stretch)
    damp: 5.2,                       // along-rope velocity damping
    minLen: 46,
    reelSpeed: 360,                  // px/s rest-length change while reeling
    bodyK: 48,
    bodyDamp: 4.0,
  };
  const GROUND_FRICTION = 0.0016;    // exp damping base (per second)
  const AIR_DRAG = 0.22;
  const ICE_FRICTION = 0.4;

  // ----- live state -------------------------------------------------------
  const State = {
    mode: 'title',       // title | playing | paused | dialogue | ending
    canvas: null, ctx: null,
    acc: 0, last: 0, raf: 0, timeScale: 1,
    cam: { x: 0, y: 0, scale: 0.78, tx: 0, ty: 0 },
    player: null,
    bodies: [],
    shards: [],
    quests: {},          // id -> {def, state:'active'|'done'}
    fragments: 0,
    checkpoint: WORLD.spawn,
    activeCheckpointId: 'cp-start',
    plateMass: 0,
    plateLoaded: false,
    lift: null,
    bellRung: false,
    orbCaptured: false,
    coreAwake: false,
    gameWon: false,
    fragment1Taken: false,
    toast: [],           // {text, t, life}
    dialogue: null,      // {name, lines, i}
    event: { active: false, timer: 18, dur: 0, name: '' },
    debug: false,
    introSeen: false,
    settings: {
      volume: 0.6, muted: false,
      reducedMotion: false, highContrast: false, textScale: 1,
    },
    dt: STEP,
    shake: 0,
    bellFeedback: 0,
    missFlash: 0, missAnchor: null,
  };
  G.State = State;

  // ====================================================================
  //  SAVE / LOAD
  // ====================================================================
  const SAVE_KEY = 'eotw-save-v1';

  function serialise() {
    return {
      v: 1,
      shards: State.shards.filter((s) => s.collected).map((s) => s.id),
      quests: Object.fromEntries(
        Object.values(State.quests).map((q) => [q.def.id, q.state === 'done'])
      ),
      fragment1Taken: State.fragment1Taken,
      bellRung: State.bellRung,
      orbCaptured: State.orbCaptured,
      coreAwake: State.coreAwake,
      gameWon: State.gameWon,
      checkpoint: State.activeCheckpointId,
      introSeen: State.introSeen,
      settings: Object.assign({}, State.settings, { bindings: Input.bindings }),
    };
  }

  function saveGame() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(serialise()));
    } catch (e) { /* storage may be unavailable; game still runs */ }
  }

  function loadRaw() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.v !== 1 || typeof data !== 'object') return null;
      return data;
    } catch (e) { return null; }
  }

  function hasSave() {
    const d = loadRaw();
    return !!d && (d.introSeen || (Array.isArray(d.shards) && d.shards.length) ||
      (d.quests && Object.values(d.quests).some(Boolean)));
  }

  function applySettings(s) {
    if (!s || typeof s !== 'object') return;
    const t = State.settings;
    if (typeof s.volume === 'number') t.volume = clamp(s.volume, 0, 1);
    if (typeof s.muted === 'boolean') t.muted = s.muted;
    if (typeof s.reducedMotion === 'boolean') t.reducedMotion = s.reducedMotion;
    if (typeof s.highContrast === 'boolean') t.highContrast = s.highContrast;
    if (typeof s.textScale === 'number') t.textScale = clamp(s.textScale, 0.8, 1.6);
    Audio.setVolume(t.volume); Audio.setMuted(t.muted);
    document.body.classList.toggle('reduced-motion', t.reducedMotion);
    document.body.classList.toggle('high-contrast', t.highContrast);
    document.documentElement.style.setProperty('--ui-scale', String(t.textScale));
  }

  // ====================================================================
  //  WORLD BUILD (fresh runtime objects from the blueprint)
  // ====================================================================
  function buildWorld() {
    // Player
    State.player = {
      x: WORLD.spawn.x, y: WORLD.spawn.y, vx: 0, vy: 0,
      hw: PLAYER.hw, hh: PLAYER.hh, mass: PLAYER.mass,
      onGround: false, coyote: 0, jumpBuf: 0, jumpHeld: false,
      facing: 1, onPlate: false, carrying: null, grabCooldown: 0,
      tether: null, // {type:'anchor'|'body', ax,ay, restLen, target}
    };

    // Movable bodies
    State.bodies = WORLD.crates.map((c) => ({
      id: c.id, x: c.x, y: c.y, vx: 0, vy: 0,
      hw: c.w / 2, hh: c.h / 2, mass: c.mass, color: c.color,
      round: !!c.round, glow: !!c.glow,
      spawn: { x: c.x, y: c.y }, onGround: false, carried: false,
      captured: false,
    }));

    // Collectibles
    State.shards = WORLD.collectibles.map((s) => ({ ...s, collected: false, bob: Math.random() * 6 }));

    // Quests
    State.quests = {};
    for (const q of WORLD.quests) State.quests[q.id] = { def: q, state: 'active' };

    // counterweight lift runtime state
    State.lift = { x: WORLD.lift.x, w: WORLD.lift.w, h: WORLD.lift.h, y: WORLD.lift.yLowered };

    State.fragments = 0;
    State.checkpoint = { x: WORLD.spawn.x, y: WORLD.spawn.y };
    State.activeCheckpointId = 'cp-start';
    State.plateMass = 0; State.plateLoaded = false;
    State.bellRung = false; State.orbCaptured = false;
    State.coreAwake = false; State.gameWon = false; State.fragment1Taken = false;
    State.toast = []; State.dialogue = null;
    State.event = { active: false, timer: 18, dur: 0, name: '' };
    State.shake = 0;
  }

  // Restore from save over a freshly built world.
  function restoreFrom(data) {
    buildWorld();
    const done = data.quests || {};
    for (const id of Object.keys(State.quests)) {
      if (done[id]) State.quests[id].state = 'done';
    }
    State.fragments = Object.values(State.quests).filter((q) => q.state === 'done').length;
    if (Array.isArray(data.shards)) {
      for (const s of State.shards) if (data.shards.includes(s.id)) s.collected = true;
    }
    State.fragment1Taken = !!data.fragment1Taken;
    State.bellRung = !!data.bellRung;
    State.orbCaptured = !!data.orbCaptured;
    State.coreAwake = State.fragments >= 3;
    State.gameWon = !!data.gameWon;
    State.introSeen = !!data.introSeen;

    // reflect captured orb in the world
    if (State.orbCaptured) {
      const orb = bodyById('orb');
      if (orb) { orb.captured = true; orb.x = WORLD.receptacle.x + WORLD.receptacle.w / 2; orb.y = WORLD.receptacle.y + WORLD.receptacle.h - 40; orb.vx = orb.vy = 0; }
    }
    // checkpoint
    const cp = WORLD.checkpoints.find((c) => c.id === data.checkpoint);
    if (cp) { State.checkpoint = { x: cp.x, y: cp.y }; State.activeCheckpointId = cp.id; }
    // snap player to checkpoint
    State.player.x = State.checkpoint.x; State.player.y = State.checkpoint.y;
  }

  function bodyById(id) { return State.bodies.find((b) => b.id === id); }

  // ====================================================================
  //  SOLIDS — what a given mover collides with
  // ====================================================================
  function platformSolids() {
    // platforms + plate + the current lift position (all solid)
    const solids = [];
    for (const p of WORLD.platforms) {
      solids.push({ x: p.x, y: p.y, w: p.w, h: p.h, slippery: !!p.slippery, kind: 'plat' });
    }
    const pl = WORLD.plate;
    solids.push({ x: pl.x, y: pl.y, w: pl.w, h: pl.h, kind: 'plate' });
    // the counterweight lift platform (at its current height)
    const lf = State.lift;
    solids.push({ x: lf.x, y: lf.y, w: lf.w, h: lf.h, kind: 'lift' });
    return solids;
  }

  // AABB helpers using center coords
  function overlapCC(a, s) {
    return aabb(a.x - a.hw, a.y - a.hh, a.hw * 2, a.hh * 2, s.x, s.y, s.w, s.h);
  }

  function moveAxis(e, axis, solids, onLand) {
    if (axis === 'x') {
      e.x += e.vx * State.dt;
      for (const s of solids) {
        if (!overlapCC(e, s)) continue;
        if (e.vx > 0) e.x = s.x - e.hw;
        else if (e.vx < 0) e.x = s.x + s.w + e.hw;
        e.vx = 0;
      }
    } else {
      e.y += e.vy * State.dt;
      e.onGround = false; e.groundSolid = null;
      for (const s of solids) {
        if (!overlapCC(e, s)) continue;
        if (e.vy > 0) {
          e.y = s.y - e.hh; e.onGround = true; e.groundSolid = s;
          if (onLand) onLand(e.vy, s);
          e.vy = 0;
        } else if (e.vy < 0) {
          e.y = s.y + s.h + e.hh; e.vy = 0;
        }
      }
    }
  }

  // ====================================================================
  //  TETHER
  // ====================================================================
  function aimVector(p) {
    // Prefer the mouse when it is meaningfully away from the player; else aim
    // using movement/up so the game is fully playable on keyboard alone.
    const m = Input.mouse;
    const sx = (p.x - State.cam.x) * State.cam.scale;
    const sy = (p.y - State.cam.y) * State.cam.scale;
    const mdx = m.x - sx, mdy = m.y - sy;
    if (Math.hypot(mdx, mdy) > 24 && (m.x || m.y)) {
      const d = Math.hypot(mdx, mdy);
      return { x: mdx / d, y: mdy / d };
    }
    // keyboard aim: diagonal up toward facing, biased upward
    let ax = 0, ay = -1;
    if (Input.isDown('left')) ax -= 1;
    if (Input.isDown('right')) ax += 1;
    if (Input.isDown('up')) ay -= 1;
    if (Input.isDown('down')) ay += 1;
    if (ax === 0 && ay === 0) { ax = p.facing * 0.6; ay = -1; }
    const d = Math.hypot(ax, ay) || 1;
    return { x: ax / d, y: ay / d };
  }

  function tryTether(p) {
    const aim = aimVector(p);
    let best = null, bestScore = -Infinity;
    // world anchors
    for (const a of WORLD.anchors) {
      const dx = a.x - p.x, dy = a.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > TETHER.range || d < 20) continue;
      const dot = (dx / d) * aim.x + (dy / d) * aim.y;
      if (dot < TETHER.cone) continue;
      const score = dot - d / TETHER.range * 0.5;
      if (score > bestScore) { bestScore = score; best = { type: 'anchor', ax: a.x, ay: a.y, d, ref: a }; }
    }
    // dynamic bodies (tether-fling)
    for (const b of State.bodies) {
      if (b.captured) continue;
      const dx = b.x - p.x, dy = b.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > TETHER.range || d < 20) continue;
      const dot = (dx / d) * aim.x + (dy / d) * aim.y;
      if (dot < TETHER.cone) continue;
      const score = dot - d / TETHER.range * 0.5 + 0.08; // slight bias to grab bodies
      if (score > bestScore) { bestScore = score; best = { type: 'body', target: b, d }; }
    }

    if (!best) {
      // miss: flash the nearest in-range-but-off-aim anchor, or just feedback
      Audio.tetherMiss();
      State.missFlash = 0.35;
      pushToast('Tether missed — aim at a glowing anchor', 1.2, '#ff6b6b');
      return;
    }
    if (best.type === 'anchor') {
      p.tether = { type: 'anchor', ax: best.ax, ay: best.ay, restLen: clamp(best.d, TETHER.minLen, TETHER.range) };
    } else {
      const b = best.target;
      p.tether = { type: 'body', target: b, restLen: clamp(best.d, TETHER.minLen, TETHER.range) };
    }
    Audio.tetherHit();
  }

  function tetherForces(p) {
    const t = p.tether; if (!t) return;
    // reel in / out adjusts the rest length (skill expression)
    if (Input.isDown('reelIn')) t.restLen = clamp(t.restLen - TETHER.reelSpeed * State.dt, TETHER.minLen, TETHER.range);
    if (Input.isDown('reelOut')) t.restLen = clamp(t.restLen + TETHER.reelSpeed * State.dt, TETHER.minLen, TETHER.range);

    if (t.type === 'anchor') {
      const dx = t.ax - p.x, dy = t.ay - p.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      if (d > t.restLen) {
        const nx = dx / d, ny = dy / d;
        const stretch = d - t.restLen;
        const vAlong = p.vx * nx + p.vy * ny;
        const a = TETHER.k * stretch - TETHER.damp * vAlong;
        p.vx += nx * a * State.dt;
        p.vy += ny * a * State.dt;
      }
    } else if (t.type === 'body') {
      const b = t.target;
      if (b.captured) { p.tether = null; return; }
      const dx = p.x - b.x, dy = p.y - b.y;         // pull BODY toward player
      const d = Math.hypot(dx, dy) || 0.0001;
      if (d > t.restLen) {
        const nx = dx / d, ny = dy / d;
        const stretch = d - t.restLen;
        const vAlong = b.vx * nx + b.vy * ny;
        const a = TETHER.bodyK * stretch - TETHER.bodyDamp * vAlong;
        b.vx += nx * a * State.dt;
        b.vy += ny * a * State.dt;
        // small reaction on the player so heavy things tug back
        const react = clamp(b.mass / 120, 0, 0.5);
        p.vx -= nx * a * State.dt * react;
        p.vy -= ny * a * State.dt * react;
      }
    }
  }

  function releaseTether(p) { if (p.tether) p.tether = null; }

  // ====================================================================
  //  PLAYER STEP
  // ====================================================================
  function stepPlayer(p) {
    if (p.grabCooldown > 0) p.grabCooldown -= State.dt;

    const left = Input.isDown('left'), right = Input.isDown('right');
    const dir = (right ? 1 : 0) - (left ? 1 : 0);
    if (dir !== 0) p.facing = dir;

    const accel = p.onGround ? PLAYER.runAccelGround : PLAYER.runAccelAir;
    // carrying something heavy slows you down a touch
    const carryPenalty = p.carrying ? clamp(1 - p.carrying.mass / 160, 0.55, 1) : 1;
    p.vx += dir * accel * carryPenalty * State.dt;

    // friction / drag (frame-rate independent exponential damping)
    const slippery = p.groundSolid && p.groundSolid.slippery;
    if (p.onGround) {
      if (dir === 0) {
        const base = slippery ? ICE_FRICTION : GROUND_FRICTION;
        p.vx *= Math.pow(base, State.dt);
      } else if (slippery) {
        p.vx *= Math.pow(0.5, State.dt);
      }
    } else {
      p.vx *= Math.pow(AIR_DRAG, State.dt);
    }
    p.vx = clamp(p.vx, -PLAYER.maxRun * 2.4, PLAYER.maxRun * 2.4); // cap but allow tether overspeed
    if (p.onGround && Math.abs(p.vx) > PLAYER.maxRun && dir !== 0) {
      p.vx = clamp(p.vx, -PLAYER.maxRun, PLAYER.maxRun);
    }

    // gravity (reduced during a surge event)
    const g = WORLD.gravity * (State.event.active ? 0.45 : 1);
    p.vy += g * State.dt;
    p.vy = clamp(p.vy, -3000, 2600);

    // tether forces
    tetherForces(p);

    // jump: coyote + buffer + variable height, single jump (no mid-air repeat)
    if (p.onGround) p.coyote = PLAYER.coyote; else p.coyote = Math.max(0, p.coyote - State.dt);
    if (Input.wasPressed('jump')) p.jumpBuf = PLAYER.buffer;
    else p.jumpBuf = Math.max(0, p.jumpBuf - State.dt);
    if (p.jumpBuf > 0 && p.coyote > 0) {
      p.vy = -PLAYER.jumpVel; p.coyote = 0; p.jumpBuf = 0; p.onGround = false;
      Audio.jump();
    }
    // variable jump height: release early -> cut the rise
    if (!Input.isDown('jump') && p.vy < -200) p.vy *= Math.pow(0.02, State.dt);

    // integrate + collide
    const solids = platformSolids();
    // bodies act as solids for the player too (stand on / bump into)
    const bodySolids = State.bodies
      .filter((b) => !b.carried)
      .map((b) => ({ x: b.x - b.hw, y: b.y - b.hh, w: b.hw * 2, h: b.hh * 2, kind: 'body', ref: b }));

    const wasAir = !p.onGround;
    moveAxis(p, 'x', solids);
    // push bodies when walking into them on the ground
    pushBodies(p);
    moveAxis(p, 'x', bodySolids);
    moveAxis(p, 'y', solids.concat(bodySolids), (vy) => {
      if (wasAir && vy > 500) Audio.land();
    });

    // world bounds
    p.x = clamp(p.x, p.hw, WORLD.width - p.hw);
    if (p.x <= p.hw || p.x >= WORLD.width - p.hw) p.vx = 0;

    // standing on the plate?
    const pl = WORLD.plate;
    p.onPlate = p.onGround && p.groundSolid && p.groundSolid.kind === 'plate';

    // carried body follows overhead
    if (p.carrying) {
      const b = p.carrying;
      // rigid overhead carry — snappy and predictable for puzzle placement
      b.x = p.x; b.y = p.y - p.hh - b.hh - 6;
      b.vx = p.vx; b.vy = 0;
    }

    // grab / drop
    if (Input.wasPressed('grab') && p.grabCooldown <= 0) {
      Input.consume('grab'); // fire once per press, not once per substep
      if (p.carrying) {
        const b = p.carrying; p.carrying = null; b.carried = false;
        // drop roughly in place so plate-loading is precise; a gentle forward
        // nudge only if the player is actually running
        b.vx = p.vx * 0.5; b.vy = 40;
        p.grabCooldown = 0.12;
      } else {
        // pick up nearest body in reach
        let pick = null, pd = 1e9;
        for (const b of State.bodies) {
          if (b.carried || b.captured) continue;
          const d = dist(p.x, p.y, b.x, b.y);
          if (d < 72 && d < pd) { pd = d; pick = b; }
        }
        if (pick) { p.carrying = pick; pick.carried = true; p.grabCooldown = 0.12; Audio.thud(); }
      }
    }

    // fell off the world -> respawn (never requires reload)
    if (p.y - p.hh > WORLD.killY) respawn();
  }

  // Drive crates the player walks into. The push speed is set from the input
  // direction (not the player's velocity, which the contact just zeroed) and
  // scaled by the crate's mass, so heavy things move slowly but steadily.
  function pushBodies(p) {
    const dir = (Input.isDown('right') ? 1 : 0) - (Input.isDown('left') ? 1 : 0);
    if (dir === 0) return;
    for (const b of State.bodies) {
      if (b.carried || b.captured) continue;
      const horiz = Math.abs(p.y - b.y) < (p.hh + b.hh - 6);
      const close = Math.abs(p.x - b.x) < (p.hw + b.hw + 6);
      if (!horiz || !close) continue;
      if (dir > 0 && b.x > p.x) {
        const s = PLAYER.maxRun * clamp(PLAYER.mass / b.mass, 0.35, 1);
        if (s > b.vx) b.vx = s;
      } else if (dir < 0 && b.x < p.x) {
        const s = -PLAYER.maxRun * clamp(PLAYER.mass / b.mass, 0.35, 1);
        if (s < b.vx) b.vx = s;
      }
    }
  }

  // Let a pushed body shove the body in front of it (chain pushing), so the
  // player can herd several crates onto the plate at once.
  function cascadePush() {
    const bs = State.bodies.filter((b) => !b.carried && !b.captured);
    for (let iter = 0; iter < 4; iter++) {
      for (const a of bs) {
        if (Math.abs(a.vx) < 5) continue;
        for (const b of bs) {
          if (a === b) continue;
          const vOverlap = Math.abs(a.y - b.y) < (a.hh + b.hh - 4);
          const gap = Math.abs(a.x - b.x) - (a.hw + b.hw);
          if (!vOverlap || gap > 4) continue;
          const v = a.vx * 0.92 * clamp(a.mass / b.mass, 0.3, 1);
          if (a.vx > 0 && b.x > a.x && v > b.vx) b.vx = v;
          else if (a.vx < 0 && b.x < a.x && v < b.vx) b.vx = v;
        }
      }
    }
  }

  // Hard anti-overlap pass: guarantees bodies never sink into or tunnel
  // through each other, keeping stacks and chains predictable.
  function separateBodies() {
    const bs = State.bodies.filter((b) => !b.carried && !b.captured);
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < bs.length; i++) {
        for (let j = i + 1; j < bs.length; j++) {
          const a = bs[i], b = bs[j];
          const ox = (a.hw + b.hw) - Math.abs(a.x - b.x);
          const oy = (a.hh + b.hh) - Math.abs(a.y - b.y);
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) {
            const push = (ox / 2 + 0.1) * (a.x < b.x ? 1 : -1);
            a.x -= push; b.x += push;
            if ((a.x < b.x && a.vx > b.vx) || (a.x > b.x && a.vx < b.vx)) { const m = (a.vx + b.vx) / 2; a.vx = b.vx = m; }
          } else {
            const push = (oy / 2 + 0.1) * (a.y < b.y ? 1 : -1);
            a.y -= push; b.y += push;
            const lower = a.y < b.y ? b : a, upper = a.y < b.y ? a : b;
            if (lower.vy < 0) lower.vy = 0;
            if (upper.vy > 0) upper.vy = 0;
          }
        }
      }
    }
  }

  function respawn() {
    const p = State.player;
    if (p.carrying) { p.carrying.carried = false; p.carrying = null; }
    p.tether = null;
    p.x = State.checkpoint.x; p.y = State.checkpoint.y; p.vx = 0; p.vy = 0;
    State.shake = State.settings.reducedMotion ? 0 : 6;
    pushToast('Recovered at checkpoint', 1.0, '#7fd1ff');
  }

  // ====================================================================
  //  BODY STEP (crates & orb)
  // ====================================================================
  function stepBody(b, idx) {
    if (b.carried || b.captured) return;

    const g = WORLD.gravity * (State.event.active ? 0.45 : 1);
    b.vy += g * State.dt;
    b.vy = clamp(b.vy, -3000, 2600);

    // ground friction
    const slip = b.groundSolid && b.groundSolid.slippery;
    if (b.onGround) b.vx *= Math.pow(slip ? ICE_FRICTION : 0.02, State.dt);
    b.vx = clamp(b.vx, -560, 560); // keep speeds low enough to resolve cleanly

    const solids = platformSolids();
    // other bodies + player as solids (stacking / resting)
    const others = State.bodies
      .filter((o, i) => i !== idx && !o.carried && !o.captured)
      .map((o) => ({ x: o.x - o.hw, y: o.y - o.hh, w: o.hw * 2, h: o.hh * 2, kind: 'body', ref: o }));
    const pl = State.player;
    const playerSolid = { x: pl.x - pl.hw, y: pl.y - pl.hh, w: pl.hw * 2, h: pl.hh * 2, kind: 'player' };

    moveAxis(b, 'x', solids.concat(others));
    moveAxis(b, 'y', solids.concat(others, [playerSolid]));

    // world bounds for bodies
    b.x = clamp(b.x, b.hw, WORLD.width - b.hw);

    // lost into a pit -> respawn the object so quests can't soft-lock
    if (b.y - b.hh > WORLD.killY) {
      b.x = b.spawn.x; b.y = b.spawn.y; b.vx = 0; b.vy = 0;
      if (b.id === 'orb') pushToast('The orb returned to the dock', 1.4, '#ff9ad6');
    }
  }

  // ====================================================================
  //  QUEST / FIXTURE LOGIC
  // ====================================================================
  function updatePlate() {
    const pl = WORLD.plate;
    let mass = 0;
    // bodies resting on the plate
    for (const b of State.bodies) {
      if (b.carried || b.captured) continue;
      const onTop = Math.abs((b.y + b.hh) - pl.y) < 12 &&
        b.x + b.hw > pl.x && b.x - b.hw < pl.x + pl.w && Math.abs(b.vy) < 120;
      if (onTop) mass += b.mass;
    }
    // player on the plate
    if (State.player.onPlate) mass += PLAYER.mass;
    State.plateMass = mass;
    const loaded = mass >= pl.threshold;
    if (loaded && !State.plateLoaded) {
      pushToast('Counterweight engaged — the lift rises!', 1.6, '#7CFFB2');
      Audio.quest();
    }
    State.plateLoaded = loaded;
  }

  // The counterweight lift tracks toward raised/lowered and carries riders.
  function updateLift() {
    const lf = State.lift, def = WORLD.lift;
    const target = State.plateLoaded ? def.yRaised : def.yLowered;
    const old = lf.y;
    if (lf.y < target) lf.y = Math.min(target, lf.y + def.speed * State.dt);
    else if (lf.y > target) lf.y = Math.max(target, lf.y - def.speed * State.dt);
    const delta = lf.y - old;
    if (delta === 0) return;
    // carry anything resting on the lift top
    const onLift = (e) =>
      Math.abs((e.y + e.hh) - lf.y) < 8 && e.x + e.hw > lf.x && e.x - e.hw < lf.x + lf.w;
    const p = State.player;
    if (onLift(p)) { p.y += delta; }
    for (const b of State.bodies) {
      if (b.carried || b.captured) continue;
      if (onLift(b)) b.y += delta;
    }
  }

  function updateSpringPad() {
    const pad = WORLD.springPad;
    const p = State.player;
    // Press interact while near the pad to fire it (reliable, keyboard-only).
    const near = p.x > pad.x - 70 && p.x < pad.x + pad.w + 70 && Math.abs(p.y - pad.y) < 160;
    if (near && Input.wasPressed('interact')) fireSpring();
  }

  function fireSpring() {
    const pad = WORLD.springPad;
    let launchedAny = false;
    for (const b of State.bodies) {
      if (b.carried || b.captured) continue;
      const onPad = Math.abs((b.y + b.hh) - pad.y) < 12 && b.x > pad.x - 8 && b.x < pad.x + pad.w + 8;
      if (onPad) { launchBody(b); launchedAny = true; }
    }
    // launch the player if standing on it
    const p = State.player;
    const playerStanding = Math.abs((p.y + p.hh) - pad.y) < 12 && p.x > pad.x - 6 && p.x < pad.x + pad.w + 6;
    if (playerStanding) { p.vy = -pad.impulse * 0.95; p.onGround = false; launchedAny = true; }
    if (launchedAny) { Audio.tetherHit(); State.shake = State.settings.reducedMotion ? 0 : 5; }
    else pushToast('Place the orb on the spring first', 1.2, '#ffb0b0');
  }

  function launchBody(b) {
    const pad = WORLD.springPad;
    b.vy = -pad.impulse;
    b.vx *= 1.25;
    Audio.thud();
  }

  function updateBell() {
    if (State.bellRung) return;
    const bell = WORLD.bell;
    const p = State.player;
    const d = dist(p.x, p.y, bell.x, bell.y);
    const speed = Math.hypot(p.vx, p.vy);
    if (d < bell.r + p.hw + 6) {
      if (speed >= bell.ringSpeed) {
        State.bellRung = true;
        completeQuest('q-signal-bell');
        State.shake = State.settings.reducedMotion ? 0 : 10;
      } else {
        State.bellFeedback = 0.6;
      }
    }
  }

  function updateReceptacle() {
    if (State.orbCaptured) return;
    const r = WORLD.receptacle;
    const orb = bodyById('orb');
    if (!orb || orb.carried) return;
    if (orb.x > r.x && orb.x < r.x + r.w && orb.y > r.y && orb.y < r.y + r.h) {
      State.orbCaptured = true;
      orb.captured = true; orb.vx = 0; orb.vy = 0;
      orb.x = r.x + r.w / 2; orb.y = r.y + r.h - 40;
      completeQuest('q-resonator');
    }
  }

  function updateFragment1() {
    if (State.fragment1Taken) return;
    const f = WORLD.fragment1;
    const p = State.player;
    if (dist(p.x, p.y, f.x, f.y) < 46) {
      State.fragment1Taken = true;
      completeQuest('q-counterweight');
    }
  }

  function completeQuest(id) {
    const q = State.quests[id];
    if (!q || q.state === 'done') return;
    q.state = 'done';
    State.fragments = Object.values(State.quests).filter((x) => x.state === 'done').length;
    Audio.quest();
    pushToast('Fragment recovered! (' + State.fragments + '/3)', 2.2, '#9af');
    if (State.fragments >= 3 && !State.coreAwake) {
      State.coreAwake = true;
      pushToast('The Aether Core stirs in The Fracture…', 3, '#ffd36b');
    }
    saveGame();
  }

  function updateCore() {
    if (State.gameWon) return;
    const c = WORLD.core;
    const p = State.player;
    const near = dist(p.x, p.y, c.x, c.y) < 120;
    if (near && Input.wasPressed('interact')) {
      if (State.coreAwake) {
        State.gameWon = true; State.mode = 'ending';
        Audio.win(); saveGame(); UI.showEnding();
      } else {
        pushToast('The Core needs all three fragments.', 1.8, '#ffb0b0');
        Audio.error();
      }
    }
  }

  function updateShards() {
    const p = State.player;
    for (const s of State.shards) {
      if (s.collected) continue;
      if (dist(p.x, p.y, s.x, s.y) < 40) {
        s.collected = true;
        Audio.collect();
        const n = State.shards.filter((x) => x.collected).length;
        pushToast('Echo Shard ' + n + '/6', 1.6, '#8CF0FF');
        saveGame();
      }
    }
  }

  function updateCheckpoints() {
    const p = State.player;
    for (const c of WORLD.checkpoints) {
      if (c.id === State.activeCheckpointId) continue;
      if (dist(p.x, p.y, c.x, c.y) < 90 && p.onGround) {
        State.checkpoint = { x: c.x, y: c.y };
        State.activeCheckpointId = c.id;
        pushToast('Checkpoint reached', 1.2, '#7fd1ff');
        saveGame();
      }
    }
  }

  function updateNPCs() {
    const p = State.player;
    for (const n of WORLD.npcs) {
      if (dist(p.x, p.y, n.x, n.y) < 70) {
        n._near = true;
        if (Input.wasPressed('interact') && State.mode === 'playing') {
          State.dialogue = { name: n.name, lines: n.lines, i: 0 };
          State.mode = 'dialogue';
          UI.showDialogue();
        }
      } else n._near = false;
    }
  }

  // ====================================================================
  //  DYNAMIC WORLD EVENT — "Gravity Surge" (bonus)
  // ====================================================================
  function updateEvent() {
    const e = State.event;
    if (e.active) {
      e.dur -= State.dt;
      if (e.dur <= 0) { e.active = false; e.timer = 26 + Math.random() * 10; pushToast('Gravity stabilising…', 1.6, '#cbd5ff'); }
    } else {
      e.timer -= State.dt;
      if (e.timer <= 0) {
        e.active = true; e.dur = 8.5; e.name = 'GRAVITY SURGE';
        pushToast('⚠ GRAVITY SURGE — the city floats light!', 2.4, '#ffd36b');
        if (!State.settings.reducedMotion) State.shake = 6;
      }
    }
  }

  // ====================================================================
  //  MAIN STEP
  // ====================================================================
  function fixedStep() {
    State.dt = STEP;
    stepPlayer(State.player);
    cascadePush();
    for (let i = 0; i < State.bodies.length; i++) stepBody(State.bodies[i], i);
    separateBodies();
    updatePlate();
    updateLift();
    updateSpringPad();
    updateBell();
    updateReceptacle();
    updateFragment1();
    updateShards();
    updateCheckpoints();
    updateNPCs();
    updateCore();
    updateEvent();

    if (State.bellFeedback > 0) State.bellFeedback -= State.dt;
    if (State.missFlash > 0) State.missFlash -= State.dt;
    if (State.shake > 0) State.shake = Math.max(0, State.shake - 40 * State.dt);
  }

  // ====================================================================
  //  TETHER INPUT (edge-triggered, outside fixed step so it is never missed)
  // ====================================================================
  function handleTetherInput() {
    const p = State.player;
    if (Input.mouse.pressedLeft) Input.mouseSeen = true;
    const firePressed = Input.wasPressed('tether') || Input.mouse.pressedLeft;
    const held = Input.isDown('tether') || Input.mouse.downLeft;
    if (firePressed && !p.tether) { Audio.resume(); tryTether(p); }
    if (!held && p.tether) releaseTether(p);
  }

  // Mode-independent keys (pause, journal, debug, dialogue advance).
  function handleGlobalKeys() {
    if (Input.wasPressed('debug')) Game.toggleDebug();

    if (State.mode === 'dialogue') {
      if (Input.wasPressed('interact') || Input.wasPressed('jump')) Game.advanceDialogue();
      return;
    }
    if (Input.wasPressed('pause')) {
      if (State.mode === 'playing') Game.pause();
      else if (State.mode === 'paused') Game.resume();
    }
    if (Input.wasPressed('journal')) {
      if (State.mode === 'playing') { State.mode = 'journal'; UI.showJournal(); }
      else if (State.mode === 'journal') { State.mode = 'playing'; UI.hideOverlays(); }
    }
  }

  // ====================================================================
  //  CAMERA
  // ====================================================================
  function updateCamera(rdt) {
    const p = State.player;
    const vw = State.canvas.width / State.cam.scale;
    const vh = State.canvas.height / State.cam.scale;
    let tx = p.x - vw / 2;
    let ty = p.y - vh / 2 - 40;
    tx = clamp(tx, 0, Math.max(0, WORLD.width - vw));
    ty = clamp(ty, 0, Math.max(0, WORLD.height - vh));
    const s = 1 - Math.pow(0.0009, rdt);
    State.cam.x = lerp(State.cam.x, tx, s);
    State.cam.y = lerp(State.cam.y, ty, s);
  }

  // ====================================================================
  //  RENDER
  // ====================================================================
  function currentZone(x) {
    for (const z of WORLD.zones) if (x >= z.x0 && x < z.x1) return z;
    return WORLD.zones[WORLD.zones.length - 1];
  }

  function render(rdt) {
    const ctx = State.ctx, cv = State.canvas;
    const cam = State.cam;
    const hc = State.settings.highContrast;

    // backdrop (zone-tinted gradient)
    const zone = currentZone(State.player.x);
    const g = ctx.createLinearGradient(0, 0, 0, cv.height);
    if (hc) { g.addColorStop(0, '#05050c'); g.addColorStop(1, '#000'); }
    else {
      g.addColorStop(0, zone.sky);
      g.addColorStop(1, '#05060d');
    }
    ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);

    // surge tint
    if (State.event.active && !hc) {
      ctx.fillStyle = 'rgba(255,211,107,0.06)';
      ctx.fillRect(0, 0, cv.width, cv.height);
    }

    ctx.save();
    let shX = 0, shY = 0;
    if (State.shake > 0.1 && !State.settings.reducedMotion) {
      shX = (Math.random() - 0.5) * State.shake;
      shY = (Math.random() - 0.5) * State.shake;
    }
    ctx.scale(cam.scale, cam.scale);
    ctx.translate(-cam.x + shX / cam.scale, -cam.y + shY / cam.scale);

    if (!hc) drawParallax(ctx, cam);
    drawLandmarks(ctx);
    drawPlatforms(ctx, hc);
    drawFixtures(ctx, hc);
    drawAnchors(ctx);
    drawShards(ctx);
    drawNPCs(ctx);
    drawBodies(ctx);
    drawTether(ctx);
    drawPlayer(ctx, hc);
    if (State.debug) drawDebug(ctx);

    ctx.restore();

    drawVignette(ctx, cv);
  }

  function drawParallax(ctx, cam) {
    if (State.settings.reducedMotion) return;
    // Soft distant nebulae and drifting motes — clearly background, never
    // mistakable for solid platforms. Parallax: depth<1 moves slower than cam.
    ctx.save();
    for (let layer = 0; layer < 2; layer++) {
      const depth = layer === 0 ? 0.45 : 0.68;
      const col = layer === 0 ? '120,150,255' : '180,120,255';
      for (let i = 0; i < 10; i++) {
        const wx = ((i * 787 + layer * 300) % WORLD.width) + cam.x * (1 - depth);
        const wy = 200 + ((i * 523) % 1500) + cam.y * (1 - depth) * 0.3;
        const r = 160 + (i % 4) * 70;
        const g = ctx.createRadialGradient(wx, wy, 0, wx, wy, r);
        g.addColorStop(0, 'rgba(' + col + ',0.05)');
        g.addColorStop(1, 'rgba(' + col + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawLandmarks(ctx) {
    for (const lm of WORLD.landmarks) {
      if (lm.kind === 'lighthouse') {
        ctx.fillStyle = '#24344f';
        ctx.beginPath();
        ctx.moveTo(lm.x - 60, lm.y);
        ctx.lineTo(lm.x - 34, lm.y - lm.h);
        ctx.lineTo(lm.x + 34, lm.y - lm.h);
        ctx.lineTo(lm.x + 60, lm.y);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ffd36b';
        ctx.beginPath(); ctx.arc(lm.x, lm.y - lm.h - 6, 22, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,211,107,0.25)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(lm.x, lm.y - lm.h - 6, 40, 0, Math.PI * 2); ctx.stroke();
        label(ctx, 'Lighthouse', lm.x, lm.y - lm.h - 60);
      } else if (lm.kind === 'crane') {
        ctx.strokeStyle = '#3a2f5c'; ctx.lineWidth = 18;
        ctx.beginPath(); ctx.moveTo(lm.x, lm.y); ctx.lineTo(lm.x, lm.y - lm.h); ctx.stroke();
        ctx.lineWidth = 12;
        ctx.beginPath(); ctx.moveTo(lm.x - 260, lm.y - lm.h + 70); ctx.lineTo(lm.x + 120, lm.y - lm.h + 70); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(lm.x, lm.y - lm.h); ctx.lineTo(lm.x - 260, lm.y - lm.h + 70); ctx.stroke();
        label(ctx, 'The Great Crane', lm.x, lm.y - lm.h - 24);
      } else if (lm.kind === 'core') {
        const awake = State.coreAwake;
        const t = performance.now() / 600;
        ctx.save();
        ctx.translate(lm.x, lm.y - lm.h / 2);
        ctx.fillStyle = awake ? '#1a3a2e' : '#201a2e';
        ctx.fillRect(-70, lm.h / 2 - 40, 140, 40);
        label(ctx, 'Aether Core', 0, -lm.h / 2 - 20, true);
        ctx.restore();
      }
    }
  }

  function drawPlatforms(ctx, hc) {
    for (const p of WORLD.platforms) {
      if (p.slippery) ctx.fillStyle = hc ? '#223' : '#2a5578';
      else if (p.type === 'ground') ctx.fillStyle = hc ? '#1a1a1a' : '#182338';
      else ctx.fillStyle = hc ? '#222' : '#243a5e';
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.fillStyle = p.slippery ? (hc ? '#88f' : '#8fd0ff') : (hc ? '#fff' : '#3e62a0');
      ctx.fillRect(p.x, p.y, p.w, 5);
      if (p.slippery) {
        ctx.fillStyle = 'rgba(180,230,255,0.15)';
        ctx.fillRect(p.x, p.y, p.w, 16);
      }
    }
  }

  function drawFixtures(ctx, hc) {
    // plate
    const pl = WORLD.plate;
    const loaded = State.plateMass >= pl.threshold;
    ctx.fillStyle = loaded ? '#7CFFB2' : '#b9803a';
    ctx.fillRect(pl.x, pl.y, pl.w, pl.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 2;
    ctx.strokeRect(pl.x, pl.y - 2, pl.w, pl.h + 2);
    label(ctx, 'PLATE ' + Math.round(State.plateMass) + '/' + pl.threshold, pl.x + pl.w / 2, pl.y - 16);

    // counterweight lift + guide rails
    const lf = State.lift, ld = WORLD.lift;
    ctx.strokeStyle = 'rgba(140,160,200,0.3)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(lf.x - 6, ld.yLowered + 30); ctx.lineTo(lf.x - 6, ld.yRaised - 20); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(lf.x + lf.w + 6, ld.yLowered + 30); ctx.lineTo(lf.x + lf.w + 6, ld.yRaised - 20); ctx.stroke();
    ctx.fillStyle = loaded ? '#7CFFB2' : '#6d7a94';
    ctx.fillRect(lf.x, lf.y, lf.w, lf.h);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(lf.x, lf.y, lf.w, 5);
    label(ctx, 'LIFT', lf.x + lf.w / 2, lf.y - 8, true);

    // fragment 1 pickup
    if (!State.fragment1Taken) drawFragment(ctx, WORLD.fragment1.x, WORLD.fragment1.y);

    // spring pad
    const pad = WORLD.springPad;
    ctx.fillStyle = '#d14f8f';
    ctx.fillRect(pad.x, pad.y, pad.w, pad.h);
    ctx.strokeStyle = '#ff9ad6'; ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(pad.x + 14 + i * 40, pad.y + pad.h);
      ctx.lineTo(pad.x + 24 + i * 40, pad.y + pad.h + 26);
      ctx.lineTo(pad.x + 14 + i * 40, pad.y + pad.h + 10);
      ctx.stroke();
    }
    label(ctx, 'SPRING ▲ (F to launch)', pad.x + pad.w / 2, pad.y - 14);

    // receptacle
    const r = WORLD.receptacle;
    ctx.strokeStyle = State.orbCaptured ? '#7CFFB2' : '#ff9ad6';
    ctx.lineWidth = 4;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = State.orbCaptured ? 'rgba(124,255,178,0.14)' : 'rgba(255,154,214,0.10)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    label(ctx, State.orbCaptured ? 'RESONATOR ✓' : 'RESONATOR', r.x + r.w / 2, r.y - 12);

    // bell
    const bl = WORLD.bell;
    ctx.fillStyle = State.bellRung ? '#7CFFB2' : (State.bellFeedback > 0 ? '#ff9a6b' : '#f0c75a');
    ctx.beginPath(); ctx.arc(bl.x, bl.y, bl.r, Math.PI, 0); ctx.lineTo(bl.x + bl.r, bl.y + bl.r * 0.5);
    ctx.lineTo(bl.x - bl.r, bl.y + bl.r * 0.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#333'; ctx.beginPath(); ctx.arc(bl.x, bl.y + bl.r * 0.5, 5, 0, Math.PI * 2); ctx.fill();
    label(ctx, State.bellRung ? 'BELL ✓' : (State.bellFeedback > 0 ? 'FASTER!' : 'SIGNAL BELL'), bl.x, bl.y - bl.r - 12);

    // core
    const c = WORLD.core;
    const t = performance.now() / 500;
    const pulse = State.coreAwake ? (1 + Math.sin(t) * 0.12) : 1;
    ctx.save();
    ctx.translate(c.x, c.y);
    const grad = ctx.createRadialGradient(0, 0, 10, 0, 0, c.r * 2.2);
    if (State.coreAwake) { grad.addColorStop(0, '#fff2c0'); grad.addColorStop(0.5, '#ffd36b'); grad.addColorStop(1, 'rgba(255,211,107,0)'); }
    else { grad.addColorStop(0, '#4a4160'); grad.addColorStop(1, 'rgba(60,50,80,0)'); }
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, c.r * 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = State.coreAwake ? '#fff6d8' : '#2b2440';
    ctx.beginPath(); ctx.arc(0, 0, c.r * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    label(ctx, State.coreAwake ? 'AETHER CORE — press F' : 'Aether Core (dormant)', c.x, c.y - c.r - 16);
  }

  function drawFragment(ctx, x, y) {
    const t = performance.now() / 400;
    ctx.save(); ctx.translate(x, y + Math.sin(t) * 5); ctx.rotate(t * 0.5);
    ctx.fillStyle = '#9af';
    ctx.shadowColor = '#9af'; ctx.shadowBlur = 20;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; const r = i % 2 ? 10 : 20; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawAnchors(ctx) {
    const p = State.player;
    for (const a of WORLD.anchors) {
      const d = dist(p.x, p.y, a.x, a.y);
      const inRange = d <= TETHER.range;
      ctx.beginPath();
      if (inRange) {
        ctx.fillStyle = '#7CFFB2';
        ctx.strokeStyle = 'rgba(124,255,178,0.35)';
      } else {
        ctx.fillStyle = 'rgba(160,170,200,0.5)';
        ctx.strokeStyle = 'rgba(160,170,200,0.15)';
      }
      ctx.lineWidth = 3;
      ctx.arc(a.x, a.y, 9, 0, Math.PI * 2); ctx.fill();
      if (inRange) { ctx.beginPath(); ctx.arc(a.x, a.y, 16 + Math.sin(performance.now() / 300) * 3, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (State.missFlash > 0 && !State.settings.reducedMotion) {
      ctx.strokeStyle = 'rgba(255,80,80,' + (State.missFlash / 0.35) + ')';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(p.x, p.y, 40, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawShards(ctx) {
    for (const s of State.shards) {
      if (s.collected) continue;
      const t = performance.now() / 500 + s.bob;
      ctx.save(); ctx.translate(s.x, s.y + Math.sin(t) * 6);
      ctx.rotate(t * 0.8);
      ctx.fillStyle = '#8CF0FF'; ctx.shadowColor = '#8CF0FF'; ctx.shadowBlur = 16;
      ctx.fillRect(-9, -9, 18, 18);
      ctx.restore();
    }
  }

  function drawNPCs(ctx) {
    for (const n of WORLD.npcs) {
      ctx.fillStyle = '#d8c28a';
      ctx.fillRect(n.x - 10, n.y - 44, 20, 44);
      ctx.fillStyle = '#2a2436';
      ctx.fillRect(n.x - 10, n.y - 48, 20, 8);
      if (n._near) label(ctx, n.name + '  [F]', n.x, n.y - 64, true);
    }
  }

  function drawBodies(ctx) {
    for (const b of State.bodies) {
      if (b.captured && b.id === 'orb') { /* still draw in receptacle */ }
      ctx.save();
      if (b.glow) { ctx.shadowColor = b.color; ctx.shadowBlur = 18; }
      ctx.fillStyle = b.color;
      if (b.round) { ctx.beginPath(); ctx.arc(b.x, b.y, b.hw, 0, Math.PI * 2); ctx.fill(); }
      else {
        ctx.fillRect(b.x - b.hw, b.y - b.hh, b.hw * 2, b.hh * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 3;
        ctx.strokeRect(b.x - b.hw, b.y - b.hh, b.hw * 2, b.hh * 2);
      }
      ctx.restore();
    }
  }

  function drawTether(ctx) {
    const p = State.player, t = p.tether;
    if (!t) return;
    let ax, ay;
    if (t.type === 'anchor') { ax = t.ax; ay = t.ay; }
    else { ax = t.target.x; ay = t.target.y; }
    const d = dist(p.x, p.y, ax, ay);
    const taut = d > t.restLen;
    ctx.strokeStyle = t.type === 'body' ? '#ff9ad6' : (taut ? '#9effc0' : 'rgba(158,255,192,0.5)');
    ctx.lineWidth = taut ? 3 : 2;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(ax, ay); ctx.stroke();
    ctx.fillStyle = '#9effc0'; ctx.beginPath(); ctx.arc(ax, ay, 6, 0, Math.PI * 2); ctx.fill();
  }

  function drawPlayer(ctx, hc) {
    const p = State.player;
    ctx.save();
    ctx.translate(p.x, p.y);
    // body
    ctx.fillStyle = hc ? '#ffffff' : '#ff4b5c';
    ctx.fillRect(-p.hw, -p.hh, p.hw * 2, p.hh * 2);
    // visor
    ctx.fillStyle = hc ? '#000' : '#17263f';
    ctx.fillRect(-p.hw + 4 + (p.facing > 0 ? 6 : 0), -p.hh + 6, p.hw, 10);
    // web emblem
    ctx.strokeStyle = hc ? '#000' : 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, 10); ctx.moveTo(-6, 2); ctx.lineTo(6, 2); ctx.stroke();
    ctx.restore();
  }

  function drawDebug(ctx) {
    const p = State.player;
    // velocity vectors
    const vec = (e, col) => {
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(e.x + e.vx * 0.12, e.y + e.vy * 0.12); ctx.stroke();
    };
    // AABBs
    ctx.strokeStyle = '#0f0'; ctx.lineWidth = 1;
    ctx.strokeRect(p.x - p.hw, p.y - p.hh, p.hw * 2, p.hh * 2);
    for (const b of State.bodies) ctx.strokeRect(b.x - b.hw, b.y - b.hh, b.hw * 2, b.hh * 2);
    for (const pf of WORLD.platforms) { ctx.strokeStyle = 'rgba(255,0,255,0.4)'; ctx.strokeRect(pf.x, pf.y, pf.w, pf.h); }
    vec(p, '#ff0');
    for (const b of State.bodies) vec(b, '#0ff');
    for (const a of WORLD.anchors) {
      ctx.strokeStyle = 'rgba(0,255,0,0.12)';
      ctx.beginPath(); ctx.arc(a.x, a.y, TETHER.range, 0, Math.PI * 2); ctx.stroke();
    }
    if (p.tether) {
      const ax = p.tether.type === 'anchor' ? p.tether.ax : p.tether.target.x;
      const ay = p.tether.type === 'anchor' ? p.tether.ay : p.tether.target.y;
      label(ctx, 'len ' + Math.round(dist(p.x, p.y, ax, ay)) + ' / rest ' + Math.round(p.tether.restLen), p.x, p.y - 40, true);
    }
    label(ctx, 'v(' + Math.round(p.vx) + ',' + Math.round(p.vy) + ') spd ' + Math.round(Math.hypot(p.vx, p.vy)), p.x, p.y - 56, true);
  }

  function label(ctx, text, x, y, small) {
    ctx.font = (small ? 12 : 14) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#eef'; ctx.fillText(text, x, y);
  }

  function drawVignette(ctx, cv) {
    if (State.settings.reducedMotion) return;
    const g = ctx.createRadialGradient(cv.width / 2, cv.height / 2, cv.height * 0.4, cv.width / 2, cv.height / 2, cv.height * 0.8);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
  }

  // ====================================================================
  //  TOASTS
  // ====================================================================
  function pushToast(text, life, color) {
    State.toast.push({ text, t: 0, life: life || 1.5, color: color || '#fff' });
    if (State.toast.length > 4) State.toast.shift();
  }

  // ====================================================================
  //  MAIN LOOP
  // ====================================================================
  function frame(now) {
    State.raf = requestAnimationFrame(frame);
    if (!State.last) State.last = now;
    let rdt = (now - State.last) / 1000;
    State.last = now;
    if (rdt > MAX_FRAME) rdt = MAX_FRAME;

    handleGlobalKeys();

    if (State.mode === 'playing') {
      handleTetherInput();
      State.acc += rdt;
      let steps = 0;
      while (State.acc >= STEP && steps < 240) { fixedStep(); State.acc -= STEP; steps++; }
      updateCamera(rdt);
    }

    // toasts advance regardless
    for (const t of State.toast) t.t += rdt;
    State.toast = State.toast.filter((t) => t.t < t.life);

    if (State.mode !== 'title') render(rdt);
    UI.updateHUD(rdt);

    Input.endFrame();
  }

  // ====================================================================
  //  PUBLIC API
  // ====================================================================
  const Game = {
    init() {
      State.canvas = document.getElementById('game');
      State.ctx = State.canvas.getContext('2d');
      resize();
      window.addEventListener('resize', resize);
      Input.attach(State.canvas);

      // load settings always (even on the title screen)
      const data = loadRaw();
      if (data && data.settings) {
        Input.loadBindings(data.settings.bindings);
        applySettings(data.settings);
      } else {
        applySettings(State.settings);
      }

      buildWorld();
      State.raf = requestAnimationFrame(frame);
      UI.init(this);
    },

    newGame() {
      try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
      buildWorld();
      State.introSeen = false;
      State.cam.x = State.player.x - 400; State.cam.y = State.player.y - 300;
      Audio.init(); Audio.resume();
      UI.showIntro();
    },

    continueGame() {
      const data = loadRaw();
      if (!data) { this.newGame(); return; }
      restoreFrom(data);
      if (data.settings) applySettings(data.settings);
      State.cam.x = State.player.x - 400; State.cam.y = State.player.y - 300;
      Audio.init(); Audio.resume();
      this.startPlaying();
    },

    startPlaying() {
      State.introSeen = true;
      State.mode = 'playing';
      saveGame();
      UI.hideOverlays();
    },

    resetProgress() {
      try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
      buildWorld();
      State.introSeen = false;
      State.mode = 'title';
      UI.showTitle();
    },

    pause() { if (State.mode === 'playing') { State.mode = 'paused'; UI.showPause(); } },
    resume() { if (State.mode === 'paused') { State.mode = 'playing'; UI.hideOverlays(); } },

    advanceDialogue() {
      const d = State.dialogue; if (!d) return;
      d.i++;
      if (d.i >= d.lines.length) { State.dialogue = null; State.mode = 'playing'; UI.hideOverlays(); }
      else UI.showDialogue();
    },

    toggleDebug() { State.debug = !State.debug; },
    saveGame, hasSave, applySettings,
    get state() { return State; },
  };

  // expose for UI module
  G.Game = Game;

  function resize() {
    const cv = State.canvas; if (!cv) return;
    // fixed internal resolution for crisp, consistent physics-to-pixel mapping
    cv.width = 1280; cv.height = 720;
  }

  // The UI object is defined in ui.js; declare a stub so this file loads
  // even if ui.js has not run yet (it will replace it).
  const UI = G.UI || {
    init() {}, updateHUD() {}, showTitle() {}, showIntro() {}, showPause() {},
    hideOverlays() {}, showDialogue() {}, showEnding() {},
  };
  G._bindUI = (ui) => { Object.assign(UI, ui); };

})(window.EOTW);

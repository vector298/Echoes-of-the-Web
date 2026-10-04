/*
 * world.js — static design data for the whole game world.
 *
 * One connected world, 7200 x 2600 px, divided into three themed zones.
 * Nothing here holds mutable runtime state; game.js builds live objects from
 * this blueprint so that "New Game / Reset" is a clean rebuild.
 *
 * Coordinate system: +x right, +y DOWN. Platforms are given by their
 * top-left corner (x,y) and size (w,h); (x,y) of a platform is its top surface.
 */
(function (G) {
  'use strict';

  const WORLD = {
    width: 7200,
    height: 2600,
    killY: 2480, // fall below this -> respawn at last checkpoint (no reload)
    gravity: 2100, // px/s^2
    spawn: { x: 140, y: 2120 },

    // Three connected zones. Boundaries are used only for the HUD label and
    // the subtle background tint; the world itself is continuous.
    zones: [
      { id: 'docks', name: 'Harbor Docks', x0: 0, x1: 2400, sky: '#10233f', glow: '#2e6ad1' },
      { id: 'cranes', name: 'Crane Heights', x0: 2400, x1: 4800, sky: '#15123a', glow: '#8b5cf6' },
      { id: 'fracture', name: 'The Fracture', x0: 4800, x1: 7200, sky: '#2a1030', glow: '#f0569b' },
    ],

    // Solid terrain. type is cosmetic; `slippery` reduces friction (ice).
    platforms: [
      // --- Zone 1: Harbor Docks ---
      { x: 0, y: 2200, w: 1150, h: 400, type: 'ground' },
      { x: 300, y: 2060, w: 180, h: 28, type: 'platform' },
      { x: 700, y: 1900, w: 150, h: 28, type: 'platform' },
      { x: 1500, y: 2200, w: 900, h: 400, type: 'ground' }, // east dock (gap 1150-1500)
      { x: 1640, y: 2000, w: 240, h: 28, type: 'platform' },
      // quest-1 reward ledge, only reachable by riding the counterweight lift
      { x: 2120, y: 1920, w: 280, h: 20, type: 'platform' },

      // --- Zone 2: Crane Heights --- (lots of vertical air -> swing)
      { x: 2400, y: 2200, w: 520, h: 400, type: 'ground' }, // landing
      { x: 3560, y: 2040, w: 360, h: 560, type: 'ground' }, // mid pillar (gap 2920-3560)
      { x: 3540, y: 1640, w: 180, h: 26, type: 'platform' },
      { x: 3820, y: 1500, w: 240, h: 26, type: 'platform' }, // signal-tower ledge
      { x: 4360, y: 2200, w: 440, h: 400, type: 'ground' }, // east landing

      // --- Zone 3: The Fracture ---
      { x: 4800, y: 2100, w: 420, h: 500, type: 'ground', slippery: true }, // icy entry ramp area
      { x: 5040, y: 2100, w: 160, h: 500, type: 'spring-base' },
      { x: 5820, y: 1880, w: 360, h: 720, type: 'ground' }, // resonator pillar (gap 5220-5820)
      { x: 6040, y: 1560, w: 200, h: 26, type: 'platform' },
      { x: 6420, y: 1960, w: 780, h: 640, type: 'ground' }, // core plaza
    ],

    // Tether anchor points. r is the visual node radius; attachment is allowed
    // when the aim line is within tether range (checked in game.js).
    anchors: [
      { x: 180, y: 1560, label: 'Lighthouse Lamp' },
      { x: 1000, y: 1700, label: 'Dock Crane' },
      { x: 1330, y: 1740 }, // over the harbor gap
      { x: 1760, y: 1620 },
      { x: 2200, y: 1640 },
      { x: 2760, y: 1560 }, // crane heights spans
      { x: 3080, y: 1360 },
      { x: 3300, y: 1120 }, // Great Crane top (near the bell)
      { x: 3680, y: 1300 },
      { x: 4040, y: 1480 },
      { x: 4360, y: 1700 },
      { x: 5180, y: 1500 }, // the fracture
      { x: 5520, y: 1360 },
      { x: 5980, y: 1360 },
      { x: 6320, y: 1500 },
    ],

    // Big recognisable structures for navigation.
    landmarks: [
      { kind: 'lighthouse', x: 180, y: 2200, h: 640 },
      { kind: 'crane', x: 3300, y: 2040, h: 1000 },
      { kind: 'core', x: 6760, y: 1960, h: 360 },
    ],

    // 6 Echo Shards. `physics:true` ones demand deliberate movement/tether use.
    collectibles: [
      { id: 'shard-1', x: 620, y: 2150, physics: false, hint: 'On the dock boards.' },
      { id: 'shard-2', x: 388, y: 2020, physics: false, hint: 'Hop the crates.' },
      { id: 'shard-3', x: 180, y: 1500, physics: true, hint: 'Atop the lighthouse — swing for it.' },
      { id: 'shard-4', x: 3150, y: 1280, physics: true, hint: 'Floating over the chasm.' },
      { id: 'shard-5', x: 3930, y: 1440, physics: true, hint: 'Above the signal ledge.' },
      { id: 'shard-6', x: 6120, y: 1500, physics: true, hint: 'Across the fracture.' },
    ],

    // Movable rigid bodies (boxes). mass drives the counterweight puzzle and
    // how hard they are to push / how they respond to the tether.
    crates: [
      { id: 'crate-a', x: 1600, y: 2160, w: 72, h: 72, mass: 35, color: '#caa06a' },
      { id: 'crate-b', x: 1680, y: 2160, w: 72, h: 72, mass: 35, color: '#caa06a' },
      { id: 'boulder', x: 1540, y: 2150, w: 86, h: 86, mass: 55, color: '#8a94a6', round: true },
      // the launchable fragment orb for quest 3 (also a movable body)
      { id: 'orb', x: 4990, y: 2040, w: 58, h: 58, mass: 18, color: '#ff7ac0', round: true, glow: true },
    ],

    // --- Quest fixtures ---
    plate: { x: 1700, y: 2200, w: 150, h: 14, threshold: 60 }, // counterweight plate (flush with ground)
    // Counterweight lift: loading the plate with enough mass raises this
    // platform from the dock up to the reward ledge. Ride it up.
    lift: { x: 1960, w: 130, h: 34, yLowered: 2200, yRaised: 1952, speed: 230 },
    bell: { x: 3300, y: 1030, r: 34, ringSpeed: 760 }, // momentum target
    springPad: { x: 5060, y: 2100, w: 120, h: 16, impulse: 1950 }, // launches bodies up
    receptacle: { x: 5790, y: 1690, w: 220, h: 190 }, // orb goal: catch basin atop the pillar
    core: { x: 6760, y: 1620, r: 70 }, // final objective

    // Fragment reward pickup for quest 1 (sits on the lift's upper ledge).
    fragment1: { x: 2280, y: 1884 },

    // Respawn checkpoints, activated by proximity. First is the start.
    checkpoints: [
      { id: 'cp-start', x: 140, y: 2120 },
      { id: 'cp-dock-e', x: 1560, y: 2120 },
      { id: 'cp-cranes', x: 2520, y: 2120 },
      { id: 'cp-crane-mid', x: 3640, y: 1960 },
      { id: 'cp-fracture', x: 4860, y: 2020 },
      { id: 'cp-core', x: 6480, y: 1880 },
    ],

    // Story signs / residents. Interact (F) when close.
    npcs: [
      {
        id: 'npc-elder', x: 460, y: 2120,
        name: 'Archivist Mira',
        lines: [
          'The surge shattered the Aether Core into three fragments.',
          'Momentum, weight, launching things across gaps — the city will answer to physics now.',
          'Restore the three fragments in any order, then wake the Core in the Fracture.',
        ],
      },
      {
        id: 'npc-sign-dock', x: 1860, y: 2150,
        name: 'Dockside Notice',
        lines: [
          'COUNTERWEIGHT LIFT: load the plate with enough MASS to raise the lift.',
          'One crate is not enough. Push, carry or tether heavy things onto it, then ride up.',
        ],
      },
      {
        id: 'npc-sign-crane', x: 2560, y: 2150,
        name: 'Crane Foreman',
        lines: [
          'The Signal Bell sits high on the Great Crane.',
          'Walking will not reach it. Swing, build speed, and strike it hard.',
        ],
      },
      {
        id: 'npc-sign-fracture', x: 4900, y: 2020,
        name: 'Fracture Warning',
        lines: [
          'The Resonator across the gap needs the Pink Orb.',
          'Spring-launch it, carry it while swinging, or tether-fling it — your call.',
        ],
      },
    ],

    // Quests. order-independent; each grants one Core fragment.
    quests: [
      {
        id: 'q-counterweight',
        title: 'The Counterweight Lift',
        zone: 'Harbor Docks',
        objective: 'Load the dock plate with enough mass, ride the lift, take the fragment.',
        physics: ['weight / balance / counterweight'],
        multiSolution: true,
      },
      {
        id: 'q-signal-bell',
        title: 'Strike the Signal Bell',
        zone: 'Crane Heights',
        objective: 'Swing up the Great Crane and strike the bell at speed.',
        physics: ['pendulum / swinging', 'momentum / impulse'],
        combinesTwo: true,
      },
      {
        id: 'q-resonator',
        title: 'Charge the Resonator',
        zone: 'The Fracture',
        objective: 'Get the Pink Orb across the gap into the Resonator.',
        physics: ['projectile motion', 'springs / elastic forces'],
        combinesTwo: true,
        multiSolution: true,
      },
    ],

    intro: [
      'SILICON MAZE — ECHOES OF THE WEB',
      'A surge fractured the Aether Core. Bridges fell. The city went quiet.',
      "You're a young web-slinger. Swing, build momentum, move the world,",
      'recover three Core fragments in any order — then wake the Core.',
    ],
  };

  G.WORLD = WORLD;
})(window.EOTW);

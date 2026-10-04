# Silicon Maze: Echoes of the Web

A physics-driven, open-world **web-slinger** that runs entirely in the browser.
A city-wide energy surge shattered the **Aether Core** into three fragments and
collapsed the bridges between districts. You play a young web-slinger who must
swing, build momentum, and move the world itself to recover the fragments **in
any order** and wake the Core.

> Make the city feel fun to move through before making it big — so this is a
> small, stable world with carefully tuned physics rather than a huge map.

---

## ▶ Play it

- **Deployed build:** https://vector298.github.io/Echoes-of-the-Web/
  *(served by GitHub Pages from `main` via the included workflow — see
  [Deployment](#deployment). If the repo is still private, the link goes live
  the moment the repo is made public and Pages is enabled.)*
- **Run locally:** it is pure static HTML/JS/CSS with **no build step**.
  - Simplest: just open `index.html` in a modern desktop browser (works from
    `file://` because it uses classic scripts, not ES modules).
  - Or serve it (recommended, avoids any browser file:// quirks):
    ```bash
    cd Echoes-of-the-Web
    python3 -m http.server 8000
    # then open http://localhost:8000
    ```

---

## Premise & goal

Three connected zones make up one continuous world:

1. **Harbor Docks** — the calm starting hub, home of the counterweight puzzle.
2. **Crane Heights** — a vertical forest of cranes; pure swinging territory.
3. **The Fracture** — a torn district of chasms, springs and the dormant Core.

Recover **3 Core fragments** (one per quest, completable in any order), optionally
collect **6 Echo Shards**, then **wake the Aether Core** in The Fracture to finish.

---

## Controls

| Action | Keys |
|---|---|
| Move | `A` / `D` or `←` / `→` |
| Jump (hold for higher) | `Space` |
| Tether / swing | `J` or `Shift`, **or Left-click** — aim at a glowing anchor |
| Reel tether in / out | `W` / `S` (or `↑` / `↓`) while tethered |
| Grab / carry / drop | `E` |
| Interact / launch spring / talk | `F` |
| Journal | `Q` |
| Pause | `Esc` |
| Physics debug view | `` ` `` (backtick / tilde) |

All controls are **remappable** in Settings, and the game is fully playable on
keyboard alone (mouse aiming for the tether is optional).

---

## The three quests (physics)

Each grants one Core fragment and can be done in any order.

1. **The Counterweight Lift** *(Harbor Docks)* — **weight / balance / counterweight**,
   **multiple solutions.** The reward ledge is only reachable by a lift that
   rises when a pressure plate carries enough **mass**. One crate isn't enough;
   combine two crates, the boulder + a crate, etc. — by **pushing, carrying, or
   tethering** them onto the plate.
2. **Strike the Signal Bell** *(Crane Heights)* — **pendulum/swinging + momentum
   (combines two ideas).** The bell high on the Great Crane only rings if you
   hit it fast enough, so you must swing to build the speed to reach and strike it.
3. **Charge the Resonator** *(The Fracture)* — **projectile motion + springs/elastic
   (combines two ideas), multiple solutions.** Get the Pink Orb across the gap
   into the Resonator basin by **spring-launching** it as a projectile, **carrying
   it while swinging**, or **tether-flinging** it.

Physics ideas used across the quests: *weight/balance, pendulum/swinging,
momentum/impulse, projectile motion, springs/elastic forces* — plus a **slippery
(low-friction) ramp** at the entry to The Fracture.

---

## Technology stack

- **Vanilla JavaScript + HTML5 Canvas 2D** — no frameworks, no build tooling.
- **Custom 2D physics** written for this game (it directly supports the tether
  and counterweight mechanics, which is exactly when a hand-rolled solver is
  worth it).
- **Web Audio API** for fully procedural sound effects (no asset files).
- **localStorage** for saving.

Everything is static, so it deploys to any static host (GitHub Pages included).

### Project layout
```
index.html         # shell: canvas + HUD + overlay containers
css/style.css      # UI styling, tokens, high-contrast + reduced-motion rules
js/utils.js        # vector/AABB math helpers
js/input.js        # remappable keyboard/mouse input, robust edge detection
js/audio.js        # procedural Web Audio sound engine
js/world.js        # static blueprint: zones, terrain, anchors, quests, NPCs
js/game.js         # engine: fixed-step physics, player, bodies, tether, quests,
                   #         camera, rendering, save/load, dynamic events
js/ui.js           # HUD + all menus/journal/dialogue/settings/ending
.github/workflows/deploy.yml  # GitHub Pages deployment
```

---

## How the physics works

- **Fixed timestep (120 Hz) with an accumulator.** The render loop can run at
  any refresh rate; physics always advances in constant `1/120 s` steps, so
  behaviour is identical on 60 Hz, 144 Hz, or a throttled tab. All damping uses
  `pow(base, dt)` so friction/drag are frame-rate independent too.
- **Movement** integrates velocity from acceleration, gravity and drag. Ground
  vs. air acceleration differ; there's **coyote time** and **jump buffering**,
  and **variable jump height** (release early to hop lower). Jumping is strictly
  single — no mid-air double jumps or flight.
- **Elastic tether (bungee).** When attached, a rope constraint applies a spring
  force only when stretched beyond its rest length, with velocity damping along
  the rope: `a = k·stretch − c·v∥`. This produces real **pendulum swinging** and
  lets you store/convert momentum. You can **reel in/out** to change the rope
  length mid-swing, and release cleanly while keeping all momentum. Anchors glow
  when in range; failed attachments give a red-flash + sound.
- **Rigid bodies (crates, boulder, orb)** fall under gravity, collide with
  terrain and each other via **axis-separated AABB resolution**, rest and stack,
  and are driven by the player through **pushing** (mass-scaled), **carrying**
  (rigid overhead), or the **tether** (fling). A per-frame **separation pass**
  guarantees they never sink into or tunnel through one another, keeping puzzles
  predictable.
- **Fixtures:** the **pressure plate** sums the resting mass on it (bodies +
  player) and drives the **counterweight lift**; the **spring pad** applies an
  upward impulse (amplifying horizontal speed for projectile arcs); the **bell**
  checks impact speed; the **Resonator** is a catch volume for the orb.
- **Dynamic event — Gravity Surge:** every ~30 s gravity drops to ~45 % for a
  few seconds, changing how high you jump and how far you swing. (A bonus
  feature; visuals soften under Reduced Motion.)

Toggle the **debug view** (`` ` ``) to see velocity vectors, collision boxes,
anchor ranges, and live tether length / rest length.

---

## Story & progression

- An **opening intro** and an in-world **Archivist** (and signs) set up the goal.
- The three quests are **order-independent**; the final objective (the Core)
  only unlocks once all three fragments are recovered.
- A **HUD quest tracker** and a full **Journal** (`Q`) show active/completed
  quests, objectives, physics tags, and fragment/shard counts. Non-blocking
  **toasts** announce discoveries; the world reacts (lift rises, bell rings,
  Resonator and Core light up) to show consequences.

### Save / resume / reset
- Progress (collected shards, completed quests, unlocked state, last checkpoint
  and all settings) is saved to **localStorage** automatically on every
  meaningful event.
- **Continue** restores a valid save after a refresh/restart.
- **Reset Progress** (in Pause) wipes the save and starts fresh.
- Missing or corrupt save data is detected and the game starts safely from the
  beginning.

### No soft-locks / safe failure
- Falling into any pit **respawns you at the last checkpoint** — never a reload.
- Quest objects (crates, orb) that fall into a pit **respawn at their origin**,
  so a puzzle can't be made unsolvable.
- Zones connect without needing any quest done, so quests stay doable in any order.

---

## Accessibility & game feel

- Readable controls, objective text, high-contrast-friendly palette and a
  **High-Contrast mode**.
- **Audio volume slider + mute.**
- **Reduced-Motion** option (disables screen shake, flashes, parallax and the
  surge flash while keeping gameplay intact).
- **Scalable UI text** and **fully remappable controls**.
- Keyboard-only play fully supported (mouse optional).

### Bonus challenges implemented
- **Physics debug view** — velocity vectors, collision shapes, tether length,
  anchor ranges.
- **Dynamic world event** — the recurring Gravity Surge changes traversal.
- **Advanced accessibility** — remappable controls + scalable text + high-contrast mode.
- **Original mechanic** — **tether reel in/out**, letting you shorten/lengthen
  the rope mid-swing to climb, tighten arcs and control momentum.

---

## Known limitations

- Tuned for **desktop browsers + keyboard/mouse**; there are no touch/gamepad
  controls.
- Physics is a compact custom solver, not a general engine: very fast,
  high-energy collisions are velocity-capped for stability rather than modelled
  exactly, and stacking is kept simple (a few crates, not large towers).
- The world favours tight, readable traversal over size.
- Audio is synthesised (no music track).

---

## Explanation video

A short walkthrough showing the three connected zones, movement + swinging, all
three physics quests, save/resume, and the relevant code:

- **Video link:** _TODO — add the public link (YouTube / Loom / Google Drive) here before submitting._

---

## Credits

- Code, design, physics, art (all canvas-drawn) and sound (procedural Web Audio):
  original work for this challenge.
- No external libraries or third-party assets are used.

## License

MIT — see [`LICENSE`](LICENSE).

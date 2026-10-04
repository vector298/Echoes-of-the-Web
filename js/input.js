/*
 * input.js — keyboard input with remappable bindings (accessibility bonus).
 * Exposes logical "actions" (left/right/jump/...) decoupled from physical keys.
 */
(function (G) {
  'use strict';

  const DEFAULTS = {
    left: ['ArrowLeft', 'KeyA'],
    right: ['ArrowRight', 'KeyD'],
    up: ['ArrowUp', 'KeyW'],
    down: ['ArrowDown', 'KeyS'],
    jump: ['Space'],
    tether: ['KeyJ', 'ShiftLeft'],
    reelIn: ['KeyW', 'ArrowUp'],
    reelOut: ['KeyS', 'ArrowDown'],
    grab: ['KeyE'],
    interact: ['KeyF'],
    journal: ['KeyQ'],
    debug: ['Backquote'],
    pause: ['Escape'],
  };

  const Input = {
    bindings: JSON.parse(JSON.stringify(DEFAULTS)),
    down: Object.create(null), // physical code -> bool
    pressed: Object.create(null), // edge, held until observed then cleared
    seen: Object.create(null), // codes observed via wasPressed this frame
    mouseSeen: false,
    // Mouse is a secondary way to aim/fire the tether.
    mouse: { x: 0, y: 0, downLeft: false, pressedLeft: false },
    enabled: true,

    loadBindings(saved) {
      if (saved && typeof saved === 'object') {
        for (const a of Object.keys(DEFAULTS)) {
          if (Array.isArray(saved[a]) && saved[a].length) {
            this.bindings[a] = saved[a].slice(0, 3);
          }
        }
      }
    },
    resetBindings() {
      this.bindings = JSON.parse(JSON.stringify(DEFAULTS));
    },
    defaults() {
      return JSON.parse(JSON.stringify(DEFAULTS));
    },

    isDown(action) {
      if (!this.enabled) return false;
      const keys = this.bindings[action] || [];
      for (const k of keys) if (this.down[k]) return true;
      return false;
    },
    // True on the frame(s) until the press is observed. Observing marks the
    // code "seen"; endFrame only clears seen edges, so a press that lands on a
    // frame which runs no physics step survives to the next frame (no drops).
    wasPressed(action) {
      if (!this.enabled) return false;
      const keys = this.bindings[action] || [];
      let hit = false;
      for (const k of keys) if (this.pressed[k]) { this.seen[k] = true; hit = true; }
      return hit;
    },

    // Immediately clear an action's edge so it fires at most once per press,
    // even across multiple physics substeps in the same frame.
    consume(action) {
      const keys = this.bindings[action] || [];
      for (const k of keys) delete this.pressed[k];
    },

    // Clear only edges that were actually observed this frame.
    endFrame() {
      for (const k of Object.keys(this.seen)) delete this.pressed[k];
      this.seen = Object.create(null);
      if (this.mouseSeen) { this.mouse.pressedLeft = false; this.mouseSeen = false; }
    },

    attach(canvas) {
      window.addEventListener('keydown', (e) => {
        // Avoid hijacking keys while typing into a remap field or text input.
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (!e.repeat) this.pressed[e.code] = true;
        this.down[e.code] = true;
        // Prevent page scroll on the keys we actually use.
        if (this._usesCode(e.code)) e.preventDefault();
      });
      window.addEventListener('keyup', (e) => {
        this.down[e.code] = false;
      });
      window.addEventListener('blur', () => {
        this.down = Object.create(null);
      });

      const toWorldPointer = (e) => {
        const r = canvas.getBoundingClientRect();
        this.mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
        this.mouse.y = (e.clientY - r.top) * (canvas.height / r.height);
      };
      canvas.addEventListener('mousemove', toWorldPointer);
      canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0) {
          this.mouse.downLeft = true;
          this.mouse.pressedLeft = true;
          toWorldPointer(e);
        }
      });
      window.addEventListener('mouseup', (e) => {
        if (e.button === 0) this.mouse.downLeft = false;
      });
    },

    _usesCode(code) {
      for (const a of Object.keys(this.bindings)) {
        if (this.bindings[a].includes(code)) return true;
      }
      return false;
    },
  };

  G.Input = Input;
})(window.EOTW);

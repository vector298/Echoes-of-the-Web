/*
 * ui.js — all DOM overlays and the in-game HUD.
 * Rendering of the world is on the canvas (game.js); everything here is HTML
 * so screen-reader text, buttons and sliders stay accessible and crisp.
 */
(function (G) {
  'use strict';

  const WORLD = G.WORLD;
  const Input = G.Input;
  const Audio = G.Audio;

  let Game = null;
  let el = {}; // cached DOM nodes
  let capturing = null; // action name while rebinding a key

  const KEY_LABEL = (code) => code
    .replace('Arrow', '')
    .replace('Key', '')
    .replace('Digit', '')
    .replace('Left', ' L').replace('Right', ' R')
    .replace('Space', 'Space').replace('Backquote', '` (tilde)')
    .replace('ShiftL', 'Shift').replace('Escape', 'Esc');

  const UI = {
    init(game) {
      Game = game;
      el.hud = document.getElementById('hud');
      el.overlay = document.getElementById('overlay');
      el.dialogue = document.getElementById('dialogue');
      el.zone = document.getElementById('hud-zone');
      el.frag = document.getElementById('hud-frag');
      el.shard = document.getElementById('hud-shard');
      el.quests = document.getElementById('hud-quests');
      el.banner = document.getElementById('hud-banner');
      el.toasts = document.getElementById('toasts');
      el.hint = document.getElementById('hud-hint');

      // Rebind capture: grab the next key when a slot is armed.
      window.addEventListener('keydown', (e) => {
        if (!capturing) return;
        e.preventDefault();
        if (e.code === 'Escape') { capturing = null; this.renderSettings(); return; }
        Input.bindings[capturing] = [e.code];
        Game.saveGame();
        capturing = null;
        this.renderSettings();
      }, true);

      this.showTitle();
    },

    // ---- screen helpers ----
    _panel(html) { el.overlay.innerHTML = html; el.overlay.classList.add('show'); },
    hideOverlays() { el.overlay.classList.remove('show'); el.overlay.innerHTML = ''; el.dialogue.classList.remove('show'); },

    showTitle() {
      const resume = Game.hasSave();
      this._panel(`
        <div class="panel title-panel">
          <h1>SILICON MAZE</h1>
          <h2>Echoes of the Web</h2>
          <p class="tagline">Swing. Build momentum. Move the world. Wake the Core.</p>
          <div class="btnrow">
            <button id="b-new" class="primary">New Game</button>
            ${resume ? '<button id="b-cont">Continue</button>' : ''}
            <button id="b-how">How to Play</button>
            <button id="b-set">Settings</button>
          </div>
          <p class="fineprint">A physics-driven open-world web-slinger. Keyboard + mouse.</p>
        </div>`);
      bind('b-new', () => { Audio.init(); Audio.resume(); Game.newGame(); });
      if (resume) bind('b-cont', () => { Audio.init(); Audio.resume(); Game.continueGame(); });
      bind('b-how', () => this.showHowTo('title'));
      bind('b-set', () => this.showSettings('title'));
    },

    showHowTo(back) {
      this._panel(`
        <div class="panel">
          <h2>How to Play</h2>
          <div class="howto">
            <p><b>The city's Aether Core shattered into three fragments.</b> Explore three connected
            zones — Harbor Docks, Crane Heights and The Fracture — recover all three fragments in
            any order, then wake the Core.</p>
            <ul>
              <li><b>Move:</b> ${keys('left')}/${keys('right')} &nbsp; <b>Jump:</b> ${keys('jump')} (hold higher)</li>
              <li><b>Tether / swing:</b> ${keys('tether')} or <b>Left-click</b> — aim at a glowing anchor</li>
              <li><b>Reel in / out:</b> ${keys('reelIn')} / ${keys('reelOut')} while tethered</li>
              <li><b>Grab / carry / toss:</b> ${keys('grab')} &nbsp; <b>Interact / launch / talk:</b> ${keys('interact')}</li>
              <li><b>Journal:</b> ${keys('journal')} &nbsp; <b>Pause:</b> ${keys('pause')} &nbsp; <b>Physics debug:</b> ${keys('debug')}</li>
            </ul>
            <p class="tip">Tip: you can also <b>tether crates and the orb</b> to fling them. Fall in a
            pit and you simply respawn at the last checkpoint — no reloading.</p>
          </div>
          <div class="btnrow"><button id="b-back" class="primary">Back</button></div>
        </div>`);
      bind('b-back', () => back === 'pause' ? this.showPause() : this.showTitle());
    },

    showIntro() {
      const lines = WORLD.intro;
      this._panel(`
        <div class="panel intro">
          ${lines.map((l, i) => `<p class="intro-line ${i === 0 ? 'big' : ''}">${l}</p>`).join('')}
          <div class="btnrow"><button id="b-begin" class="primary">Begin the Rescue</button></div>
        </div>`);
      bind('b-begin', () => { Audio.resume(); Game.startPlaying(); });
    },

    showPause() {
      this._panel(`
        <div class="panel">
          <h2>Paused</h2>
          <div class="btnrow col">
            <button id="b-resume" class="primary">Resume</button>
            <button id="b-set">Settings</button>
            <button id="b-how">How to Play</button>
            <button id="b-reset" class="danger">Reset Progress</button>
            <button id="b-title">Return to Title</button>
          </div>
        </div>`);
      bind('b-resume', () => Game.resume());
      bind('b-set', () => this.showSettings('pause'));
      bind('b-how', () => this.showHowTo('pause'));
      bind('b-reset', () => this.confirmReset());
      bind('b-title', () => { Game.saveGame(); G.State.mode = 'title'; this.showTitle(); });
    },

    confirmReset() {
      this._panel(`
        <div class="panel">
          <h2>Reset Progress?</h2>
          <p>This erases your saved fragments, shards and checkpoints.</p>
          <div class="btnrow">
            <button id="b-yes" class="danger">Yes, start over</button>
            <button id="b-no" class="primary">Cancel</button>
          </div>
        </div>`);
      bind('b-yes', () => Game.resetProgress());
      bind('b-no', () => this.showPause());
    },

    showJournal() {
      const S = G.State;
      const qs = Object.values(S.quests).map((q) => {
        const done = q.state === 'done';
        return `<div class="q ${done ? 'done' : ''}">
          <span class="tick">${done ? '✓' : '○'}</span>
          <div><div class="qt">${q.def.title} <em>· ${q.def.zone}</em></div>
          <div class="qo">${done ? 'Fragment recovered.' : q.def.objective}</div>
          <div class="qp">Physics: ${q.def.physics.join(', ')}</div></div>
        </div>`;
      }).join('');
      const shardN = S.shards.filter((s) => s.collected).length;
      const finalLine = S.fragments >= 3
        ? '<b>Final objective:</b> Wake the Aether Core in The Fracture (press Interact beside it).'
        : `Recover ${3 - S.fragments} more fragment(s) to wake the Core.`;
      this._panel(`
        <div class="panel wide">
          <h2>Journal</h2>
          <div class="stat">Fragments <b>${S.fragments}/3</b> &nbsp;·&nbsp; Echo Shards <b>${shardN}/6</b></div>
          <div class="final">${finalLine}</div>
          <div class="quests">${qs}</div>
          <div class="btnrow"><button id="b-close" class="primary">Close (${keys('journal')})</button></div>
        </div>`);
      bind('b-close', () => { G.State.mode = 'playing'; this.hideOverlays(); });
    },

    showSettings(back) {
      this._back = back;
      this.renderSettings();
    },
    renderSettings() {
      const s = G.State.settings;
      const row = (a) => `<tr><td>${labelFor(a)}</td><td>
        <button class="rebind" data-a="${a}">${capturing === a ? 'press a key…' : keys(a)}</button></td></tr>`;
      this._panel(`
        <div class="panel wide">
          <h2>Settings</h2>
          <div class="settings">
            <label class="srow"><span>Volume</span>
              <input id="s-vol" type="range" min="0" max="1" step="0.05" value="${s.volume}"></label>
            <label class="srow"><span>Mute audio</span>
              <input id="s-mute" type="checkbox" ${s.muted ? 'checked' : ''}></label>
            <label class="srow"><span>Reduced motion (no shake / flashes)</span>
              <input id="s-rm" type="checkbox" ${s.reducedMotion ? 'checked' : ''}></label>
            <label class="srow"><span>High contrast mode</span>
              <input id="s-hc" type="checkbox" ${s.highContrast ? 'checked' : ''}></label>
            <label class="srow"><span>Text size</span>
              <input id="s-ts" type="range" min="0.8" max="1.6" step="0.1" value="${s.textScale}"></label>
          </div>
          <h3>Controls (click to rebind)</h3>
          <table class="binds">${['left','right','up','down','jump','tether','reelIn','reelOut','grab','interact','journal','pause','debug'].map(row).join('')}</table>
          <div class="btnrow">
            <button id="s-defaults">Reset Controls</button>
            <button id="s-back" class="primary">Back</button>
          </div>
        </div>`);

      const sync = () => { Game.applySettings(s); Game.saveGame(); };
      el.overlay.querySelector('#s-vol').oninput = (e) => { s.volume = parseFloat(e.target.value); sync(); };
      el.overlay.querySelector('#s-mute').onchange = (e) => { s.muted = e.target.checked; sync(); };
      el.overlay.querySelector('#s-rm').onchange = (e) => { s.reducedMotion = e.target.checked; sync(); };
      el.overlay.querySelector('#s-hc').onchange = (e) => { s.highContrast = e.target.checked; sync(); };
      el.overlay.querySelector('#s-ts').oninput = (e) => { s.textScale = parseFloat(e.target.value); sync(); };
      el.overlay.querySelectorAll('.rebind').forEach((b) => {
        b.onclick = () => { capturing = b.getAttribute('data-a'); this.renderSettings(); };
      });
      bind('s-defaults', () => { Input.resetBindings(); Game.saveGame(); this.renderSettings(); });
      bind('s-back', () => { capturing = null; this._back === 'pause' ? this.showPause() : this.showTitle(); });
    },

    showDialogue() {
      const d = G.State.dialogue; if (!d) return;
      el.overlay.classList.remove('show');
      el.dialogue.classList.add('show');
      el.dialogue.innerHTML = `
        <div class="dname">${d.name}</div>
        <div class="dline">${d.lines[d.i]}</div>
        <button id="d-next">${d.i < d.lines.length - 1 ? 'Next ▸' : 'Close'}</button>
        <div class="dhint">(${keys('interact')} / ${keys('jump')})</div>`;
      bind('d-next', () => Game.advanceDialogue());
    },

    showEnding() {
      const S = G.State;
      const shardN = S.shards.filter((s) => s.collected).length;
      this._panel(`
        <div class="panel ending">
          <h1>THE CITY AWAKENS</h1>
          <p>The three fragments spin home. Light floods the districts, bridges
          re-weave themselves, and the hum of the Aether Core returns.</p>
          <p class="stat">Fragments <b>3/3</b> &nbsp;·&nbsp; Echo Shards <b>${shardN}/6</b></p>
          <p class="tagline">You made the city move again.</p>
          <div class="btnrow">
            <button id="e-free" class="primary">Keep Exploring</button>
            <button id="e-new">New Game</button>
            <button id="e-title">Title</button>
          </div>
        </div>`);
      bind('e-free', () => { G.State.mode = 'playing'; this.hideOverlays(); });
      bind('e-new', () => Game.newGame());
      bind('e-title', () => { G.State.mode = 'title'; this.showTitle(); });
    },

    // ---- per-frame HUD ----
    updateHUD() {
      const S = G.State;
      const show = S.mode !== 'title';
      el.hud.classList.toggle('show', show);
      if (!show) return;

      const zone = zoneFor(S.player.x);
      el.zone.textContent = zone ? zone.name : '';
      el.frag.textContent = S.fragments + '/3';
      el.shard.textContent = S.shards.filter((s) => s.collected).length + '/6';

      // compact quest tracker
      el.quests.innerHTML = Object.values(S.quests).map((q) => {
        const done = q.state === 'done';
        return `<div class="tq ${done ? 'done' : ''}"><span>${done ? '✓' : '○'}</span>${q.def.title}</div>`;
      }).join('') + (S.coreAwake ? '<div class="tq core">★ Wake the Aether Core</div>' : '');

      // event banner
      if (S.event.active) { el.banner.classList.add('show'); el.banner.textContent = '⚠ GRAVITY SURGE'; }
      else el.banner.classList.remove('show');

      // toasts
      el.toasts.innerHTML = S.toast.map((t) => {
        const a = t.t < 0.2 ? t.t / 0.2 : (t.t > t.life - 0.4 ? Math.max(0, (t.life - t.t) / 0.4) : 1);
        return `<div class="toast" style="opacity:${a.toFixed(2)};color:${t.color}">${t.text}</div>`;
      }).join('');

      el.hint.textContent = 'Move ' + keys('left') + keys('right') + ' · Jump ' + keys('jump') +
        ' · Tether ' + keys('tether') + '/Click · Grab ' + keys('grab') + ' · Interact ' + keys('interact') +
        ' · Journal ' + keys('journal') + ' · Pause ' + keys('pause');
    },
  };

  // ---- small helpers ----
  function bind(id, fn) { const n = document.getElementById(id); if (n) n.onclick = () => { Audio.resume(); fn(); }; }
  function keys(a) { return (Input.bindings[a] || []).map(KEY_LABEL).join('/'); }
  function zoneFor(x) { for (const z of WORLD.zones) if (x >= z.x0 && x < z.x1) return z; return WORLD.zones[WORLD.zones.length - 1]; }
  function labelFor(a) {
    const m = { left: 'Move left', right: 'Move right', up: 'Aim up', down: 'Aim down',
      jump: 'Jump', tether: 'Tether / swing', reelIn: 'Reel in', reelOut: 'Reel out',
      grab: 'Grab / carry', interact: 'Interact / launch / talk', journal: 'Journal', pause: 'Pause', debug: 'Physics debug' };
    return m[a] || a;
  }

  G.UI = UI;
  if (G._bindUI) G._bindUI(UI);
})(window.EOTW);

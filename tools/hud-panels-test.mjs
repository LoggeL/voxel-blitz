// Killhouse run overlay and mode scoreboard in Node: a minimal fake DOM,
// a fake clock and manual frame/timer queues drive RunHud through the server
// run events, and Scoreboard through the TTT reveal rules and training roster.
import assert from 'node:assert/strict';
import { MAP_RUN_COURSE } from '../shared/world/metadata.js';

class FakeElement {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = String(tagName).toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classes.has(name) : !!force;
        if (on) this.classes.add(name);
        else this.classes.delete(name);
        return on;
      },
    };
    this.style = { setProperty(name, value) { this[name] = String(value); } };
    this.dataset = {};
    this.attributes = new Map();
    this.id = '';
    this._text = '';
  }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set textContent(value) { this.children.length = 0; this._text = String(value ?? ''); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) {
    assert.equal(value, '', 'the fake DOM only supports clearing innerHTML');
    this.textContent = '';
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.body;
  }
  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener() {}
  matches(selector) {
    const tag = selector.match(/^[a-z]+/i)?.[0];
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    const pid = selector.match(/\[data-pid="([^"]+)"\]/)?.[1];
    return (!tag || this.tagName === tag.toUpperCase())
      && classes.every((name) => this.classes.has(name))
      && (pid === undefined || this.dataset.pid === pid);
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => node.children.forEach((child) => {
      if (child.matches(selector)) found.push(child);
      visit(child);
    });
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class FakeDocument {
  constructor() { this.body = new FakeElement(this, 'body'); }
  createElement(tagName) { return new FakeElement(this, tagName); }
  getElementById(id) {
    const find = (node) => {
      if (node.id === id) return node;
      for (const child of node.children) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    return find(this.body);
  }
}

const storage = new Map();
const saved = { document: globalThis.document, localStorage: globalThis.localStorage };
globalThis.document = new FakeDocument();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
};

const mountHud = () => {
  document.getElementById('hud')?.remove();
  const hud = document.createElement('div');
  hud.id = 'hud';
  document.body.appendChild(hud);
  return hud;
};

let checks = 0;
const check = (fn) => { fn(); checks++; };

try {
  const { RunHud, RUN_BEST_KEY, RUN_STAGES, RUN_RESULT_HOLD_MS, RUN_SPLIT_FADE_MS } =
    await import('../public/js/ui/run-hud.js');
  const { Scoreboard } = await import('../public/js/ui/scoreboard.js');
  const { rankPlayers } = await import('../public/js/ui/mode-presentation.js');

  // ------------------------------------------------------------ RunHud
  {
    mountHud();
    let nowMs = 1000;
    let nextHandle = 1;
    const frames = new Map();
    const timers = new Map();
    const run = new RunHud({
      getMyId: () => 7,
      now: () => nowMs,
      requestFrame: (fn) => { const id = nextHandle++; frames.set(id, fn); return id; },
      cancelFrame: (id) => frames.delete(id),
    });
    run._setTimer = (fn, delay) => { const id = nextHandle++; timers.set(id, { fn, delay }); return id; };
    run._clearTimer = (id) => timers.delete(id);
    const frame = () => {
      const batch = [...frames.values()];
      frames.clear();
      batch.forEach((fn) => fn(nowMs));
    };
    const fireTimer = (delay) => {
      const [id, timer] = [...timers].find(([, entry]) => entry.delay === delay) || [];
      assert.ok(timer, `a ${delay} ms timer is pending`);
      timers.delete(id);
      timer.fn();
    };
    const root = () => document.getElementById('run-overlay');
    const text = (cls) => root().querySelector(`.${cls}`).textContent;
    const state = () => ['idle', 'live', 'result'].filter((name) => root().classList.contains(`state-${name}`));

    check(() => assert.equal(RUN_STAGES, MAP_RUN_COURSE.killhouse.stages.length,
      'the stage count follows the shared killhouse course'));

    run.setMatch({ mode: 'training' });
    check(() => {
      assert.equal(root().classList.contains('hidden'), false, 'training shows the run overlay');
      assert.deepEqual(state(), ['idle']);
      assert.equal(text('vb-run-best'), 'BEST —', 'no stored best renders a dash');
      assert.match(text('vb-run-hint'), /start pad/);
    });

    run.handleEvent({ kind: 'run_start', id: 8 });
    check(() => assert.deepEqual(state(), ['idle'], 'another operator\'s run events are ignored'));

    run.handleEvent({ kind: 'run_start', id: 7 });
    check(() => {
      assert.deepEqual(state(), ['live']);
      assert.equal(text('vb-run-timer'), '0:00.0');
      assert.equal(text('vb-run-stage'), `STAGE 1 / ${RUN_STAGES}`);
      assert.equal(frames.size, 1, 'the live clock schedules one frame');
    });
    nowMs += 12_345;
    frame();
    check(() => {
      assert.equal(text('vb-run-timer'), '0:12.3', 'the live clock floors to tenths');
      assert.equal(frames.size, 1, 'the clock keeps exactly one frame queued');
    });

    run.handleEvent({ kind: 'run_split', id: 7, stage: 0, ms: 12_050 });
    const toast = root().querySelector('.vb-run-toast');
    check(() => {
      assert.equal(toast.textContent, 'STAGE 1 CLEARED · 0:12.0',
        'the split toast uses the run clock format, not a rounded-up m:ss');
      assert.equal(toast.classList.contains('is-visible'), true);
      assert.equal(text('vb-run-stage'), `STAGE 2 / ${RUN_STAGES}`);
    });
    fireTimer(RUN_SPLIT_FADE_MS);
    check(() => assert.equal(toast.classList.contains('is-visible'), false, 'the split toast fades'));
    run.handleEvent({ kind: 'run_split', id: 7, stage: RUN_STAGES - 1, ms: 50_999 });
    check(() => {
      assert.equal(toast.textContent, `STAGE ${RUN_STAGES} CLEARED · 0:50.9`);
      assert.equal(text('vb-run-stage'), 'FINISH PAD', 'the last split points at the finish pad');
    });

    // The HUD root is rebuilt during boot; the overlay reattaches to the new one.
    const rebuilt = mountHud();
    run.handleEvent({ kind: 'run_finish', id: 7, ms: 61_234 });
    check(() => {
      assert.equal(root().parentNode, rebuilt, 'a detached overlay is rebuilt under the new #hud');
      assert.deepEqual(state(), ['result']);
      assert.equal(text('vb-run-timer'), '1:01.2', 'the authoritative run time replaces the local clock');
      assert.equal(text('vb-run-result'), 'KILLHOUSE RUN 1:01.2 · BEST 1:01.2');
      assert.equal(root().classList.contains('is-new-best'), true);
      assert.equal(storage.get(RUN_BEST_KEY), '61234', 'a first finish is stored as the best');
      assert.equal(frames.size, 0, 'finishing stops the local clock');
    });
    fireTimer(RUN_RESULT_HOLD_MS);
    check(() => {
      assert.deepEqual(state(), ['idle'], 'the result holds, then returns to idle');
      assert.equal(root().classList.contains('is-new-best'), false);
      assert.equal(text('vb-run-best'), 'BEST 1:01.2');
    });

    run.handleEvent({ kind: 'run_start', id: 7 });
    run.handleEvent({ kind: 'run_finish', id: 7, ms: 70_000 });
    check(() => {
      assert.equal(text('vb-run-result'), 'KILLHOUSE RUN 1:10.0 · BEST 1:01.2');
      assert.equal(root().classList.contains('is-new-best'), false, 'a slower run is not a new best');
      assert.equal(storage.get(RUN_BEST_KEY), '61234');
    });

    run.handleEvent({ kind: 'run_start', id: 7 });
    check(() => assert.equal(timers.size, 0, 'a new run cancels the pending result hold'));
    run.handleEvent({ kind: 'run_reset', id: 7 });
    check(() => {
      assert.deepEqual(state(), ['idle']);
      assert.equal(frames.size, 0, 'a reset stops the local clock');
    });

    run.handleEvent({ kind: 'run_start', id: 7 });
    run.setMatch({ mode: 'fun' });
    check(() => {
      assert.equal(root().classList.contains('hidden'), true, 'leaving training hides the overlay');
      assert.deepEqual(state(), ['idle']);
      assert.equal(frames.size, 0, 'leaving training stops a live run clock');
    });

    run.dispose();
    check(() => assert.equal(root(), null, 'dispose removes the overlay'));
  }

  // -------------------------------------------------------- Scoreboard
  {
    const parent = mountHud();
    const board = new Scoreboard();
    board.build(parent);
    const body = () => document.getElementById('scores');
    const headers = () => body().querySelectorAll('th').map((th) => th.textContent);
    const row = (id) => body().querySelector(`tr[data-pid="${id}"]`);
    const status = (id) => row(id).querySelector('.vb-sb-state').textContent;
    const badge = (id) => row(id).querySelector('.vb-ttt-role-badge');

    const tttPlayers = [
      { id: 1, name: 'ME', kills: 0, deaths: 0, karma: 1000, state: 'alive' },
      { id: 2, name: 'FOUND', kills: 1, deaths: 1, karma: 940, state: 'dead' },
      { id: 3, name: 'MISSING', kills: 0, deaths: 1, karma: 1000, state: 'dead' },
      { id: 4, name: 'DECOY', kills: 2, deaths: 0, karma: 1000, state: 'alive' },
    ];
    const revealedRoles = { 1: 'innocent', 2: 'detective', 3: 'traitor', 4: 'traitor' };
    const corpses = [
      { playerId: 2, identified: true, role: 'detective' },
      { playerId: 3, identified: false, role: 'traitor' },
      { playerId: 4, identified: true, fake: true, role: 'innocent' },
    ];
    board.update(tttPlayers, { mode: 'ttt', map: 'foundry', phase: 'live', corpses, revealedRoles }, 1);
    check(() => {
      assert.equal(headers().some((name) => /^(K|D|KILLS|DEATHS)$/.test(name)), false,
        'the TTT table has no kill or death columns');
      assert.ok(headers().includes('STATUS') && headers().includes('KARMA'));
      assert.equal(badge(2)?.dataset.role, 'detective', 'an identified corpse reveals its role');
      assert.equal(status(2), 'TOT');
      assert.equal(row(2).classList.contains('dead'), true);
      assert.equal(badge(3), null, 'an unidentified death reveals no role before the post phase');
      assert.equal(status(3), 'UNBEKANNT', 'an unidentified death is not shown as dead');
      assert.equal(row(3).classList.contains('dead'), false);
      assert.equal(badge(4), null, 'a fake body identifies nobody');
      assert.equal(status(4), 'UNBEKANNT');
      assert.equal(badge(1), null, 'revealed roles stay hidden while the round is live');
      assert.equal(row(1).classList.contains('vb-me'), true);
      assert.equal(row(2).querySelectorAll('.vb-sb-number')[0].textContent, '940', 'karma is shown');
      assert.equal(body().textContent.includes('traitor'.toUpperCase()), false, 'no traitor is named live');
    });

    board.update(tttPlayers, { mode: 'ttt', map: 'foundry', phase: 'post', corpses, revealedRoles }, 1);
    check(() => {
      for (const [id, role] of Object.entries(revealedRoles)) {
        assert.equal(badge(id)?.dataset.role, role, `post phase reveals player ${id}'s role`);
      }
      assert.equal(status(3), 'TOT', 'post phase shows every death');
      assert.equal(status(4), 'LEBT', 'post phase marks survivors alive');
    });

    board.update([
      { id: 1, name: 'ME', kills: 3, deaths: 0 },
      { id: 'dummy-0', name: 'TARGET', kills: 0, deaths: 9 },
    ], { mode: 'training', map: 'killhouse', phase: 'live' }, 1);
    check(() => {
      assert.deepEqual(headers(), ['PLAYER', 'PING'], 'training lists participants without counters');
      assert.equal(row('dummy-0'), null, 'training dummies never appear on the scoreboard');
      assert.equal(body().querySelectorAll('tr').filter((tr) => tr.dataset.pid).length, 1);
    });

    board.dispose();
    check(() => assert.equal(document.getElementById('scoreboard'), null, 'dispose removes the scoreboard'));
  }

  // ------------------------------------------------------ rankPlayers
  {
    const ids = (players, mode) => rankPlayers(players, mode).map((player) => player.id);
    const players = [
      { id: 'b', kills: 5, deaths: 2, score: 1 },
      { id: 'a', kills: 5, deaths: 2, score: 0 },
      { id: 'c', kills: 5, deaths: 1, score: 0 },
      { id: 'd', kills: 7, deaths: 9, score: 0 },
    ];
    check(() => {
      assert.deepEqual(ids(players, 'fun'), ['d', 'c', 'a', 'b'],
        'FFA ranks by kills, then fewer deaths, then id');
      assert.deepEqual(ids(players, 'gungame'), ['b', 'd', 'c', 'a'],
        'Gun Game ranks by weapon level before kills');
      assert.deepEqual(players.map((player) => player.id), ['b', 'a', 'c', 'd'], 'ranking does not mutate the roster');
    });
  }
} finally {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
}

console.log(`hud panels test passed (${checks} checks)`);

// Scoreboard layout contracts on a minimal DOM: TTT row order and rank cells
// must not leak kills or unseen deaths, and co-op Bastion shows one squad.
import assert from 'node:assert/strict';
import { rankPlayers } from '../public/js/ui/mode-presentation.js';

class Element {
  constructor(tag) {
    Object.assign(this, { tag, children: [], className: '', id: '', style: {}, dataset: {}, attributes: {}, text: '' });
    this.classList = { toggle: () => {} };
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  set innerHTML(_) { this.children = []; this.text = ''; }
  set textContent(value) { this.children = []; this.text = String(value); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener() {}
  all(predicate, found = []) {
    for (const child of this.children) { if (predicate(child)) found.push(child); child.all(predicate, found); }
    return found;
  }
}
const saved = globalThis.document;
globalThis.document = { createElement: tag => new Element(tag) };
try {
  const { Scoreboard } = await import('../public/js/ui/scoreboard.js');
  const hasClass = name => node => node.className.split(' ').includes(name);

  // A traitor with a kill and an unidentified victim must sort like everyone else.
  const players = [
    { id: 'c', name: 'Cleo', kills: 0, deaths: 1, state: 'dead', karma: 1000 },
    { id: 'a', name: 'Ada', kills: 0, deaths: 0, state: 'alive', karma: 1000 },
    { id: 'b', name: 'Bo', kills: 1, deaths: 0, state: 'alive', karma: 1000 },
  ];
  assert.deepEqual(rankPlayers(players, 'ttt').map(p => p.id), ['a', 'b', 'c'], 'TTT sorts by name only');
  assert.deepEqual(rankPlayers(players, 'fun').map(p => p.id), ['b', 'a', 'c'], 'other modes still rank by kills');
  const parent = new Element('div');
  const live = new Scoreboard();
  live.build(parent);
  live.update(players, { mode: 'ttt', phase: 'live', corpses: [] }, 'a');
  assert.deepEqual(live.body.all(node => node.tag === 'tr' && node.dataset.pid).map(row => row.dataset.pid), ['a', 'b', 'c']);
  assert.equal(live.body.all(hasClass('vb-sb-rank')).length, 0, 'the live TTT table has no rank column');
  assert.equal(live.body.all(node => node.tag === 'th').some(th => th.text === '#'), false);
  assert.equal(live.body.all(hasClass('dead')).length, 0, 'an unidentified body is not marked dead');

  // The post-round result keeps the name order, so it must not number it as placements either.
  for (const mode of ['ttt', 'fun']) {
    const result = new Scoreboard();
    result.build(new Element('div'), { presentation: 'result' });
    result.update(players, { mode, phase: 'post', corpses: [] }, 'a');
    const table = result.body.all(node => node.tag === 'table')[0];
    const headers = table.all(node => node.tag === 'th').map(th => th.text);
    const row = table.all(node => node.tag === 'tr' && node.dataset.pid)[0];
    assert.equal(row.children.length, headers.length, `${mode} result rows line up with their headers`);
    assert.equal(headers.includes('#'), mode !== 'ttt', `${mode} result rank header`);
    assert.equal(result.body.all(hasClass('vb-sb-rank')).length, mode === 'ttt' ? 0 : players.length, `${mode} result rank cells`);
  }

  // Bastion is co-op: one squad section, no enemy table and no TDM score limit.
  const squad = [{ id: 'h1', name: 'Host', team: 'alpha' }, { id: 'h2', name: 'Guest', team: 'alpha' }];
  for (const presentation of ['live', 'result']) {
    const board = new Scoreboard();
    board.build(new Element('div'), { presentation });
    board.update(squad, { mode: 'bastion', phase: presentation === 'result' ? 'post' : 'live' }, 'h1');
    const sections = board.body.all(hasClass('vb-scoreboard-team'));
    assert.equal(sections.length, 1, `${presentation} Bastion board has one squad section`);
    assert.equal(board.body.all(hasClass('vb-sb-bravo')).length, 0);
    assert.doesNotMatch(board.body.textContent, /FIRST TO|BRAVO/, `${presentation} Bastion board shows no TDM framing`);
    assert.match(sections[0].children[0].textContent, /^SQUAD/);
  }
  const tdm = new Scoreboard();
  tdm.build(new Element('div'));
  tdm.update([{ id: 'x', name: 'X', team: 'alpha' }], { mode: 'tdm', scores: { alpha: 3, bravo: 1 } }, 'x');
  assert.equal(tdm.body.all(hasClass('vb-scoreboard-team')).length, 2, 'TDM keeps both team tables');
  assert.match(tdm.body.textContent, /ALPHA 3\s*FIRST TO 40/);
} finally {
  globalThis.document = saved;
}
console.log('Scoreboard: neutral TTT order without rank cells (live and result), single Bastion squad and TDM team tables passed.');

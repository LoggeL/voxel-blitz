import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { karmaDamageFactor, karmaBanRemaining } from '../server/modes/ttt-karma.js';
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-8, `${a} != ${b}`);
const game = new GameEngine({mode:'ttt'});
for (const id of ['a','b','c','d']) game.addClient(id,id);
const p = game.mode.policy, [a,b,c,d]=[...game.entities.values()];
game.now=p.phaseEndsAt;game.mode.tick();
p.roles=new Map([['a','innocent'],['b','innocent'],['c','traitor'],['d','traitor']]);
for (const player of [a,b,c,d]) Object.assign(player,{hp:100,armor:0});
assert.equal(a.tttKarma.base,1000);
b.takeDamage(20,false,a,'rifle');
assert.equal(b.hp,80);assert.equal(a.tttKarma.live,980);assert.equal(a.tttKarma.base,1000);
assert.equal(a.tttKarma.clean,false);
b.takeDamage(999,false,a,'rifle'); // Overkill counts only the remaining 80 HP.
game.killPlayer(b,a,'rifle',false);
assert.equal(a.tttKarma.live,885); // 20 + 80 + 15, victim karma is 1000.
p.karma.end();assert.equal(a.tttKarma.base,890); // Only the ordinary +5 round heal.
p.karma.begin([a,c,d]);close(a.tttKarma.factor,0.8988);
c.takeDamage(10,false,a,'rifle');close(c.hp,91.012);close(a.tttKarma.live,892.6964);
c.takeDamage(10,false,a,'knife');close(c.hp,81.012); // Slash exception.
const before=c.tttKarma.live;
d.takeDamage(5,false,c,'c4');assert.equal(c.tttKarma.live,before);
p.karma.killed(c,d,'c4');assert.equal(c.tttKarma.live,before);
d.takeDamage(5,false,c,'frag');assert.equal(c.tttKarma.live,before-5);
a.tttKarma.live=800;
p.karma.killed(a,c,'rifle');assert.equal(a.tttKarma.live,812); // 40 * .0003 * 1000.
a.tttKarma.clean=true;p.karma.end();assert.equal(a.tttKarma.live,847);
close(karmaDamageFactor(900),0.91);close(karmaDamageFactor(500),0.15);
close(karmaDamageFactor(0),0.1);
const identity='karma-test-'+Date.now();
p.karma.bind(a,identity,()=>{a.kicked=true;});
a.tttKarma.live=700;p.karma.remember(a);
p.karma.bind(c,identity,()=>{});assert.equal(c.tttKarma.base,700);
a.tttKarma.live=445;a.tttKarma.clean=false;p.karma.end();
await Promise.resolve();
assert.equal(a.tttKarma.base,450);assert.equal(a.kicked,true);
assert.ok(karmaBanRemaining(identity)>3599000);
let snapshot;
const wireGame=new GameEngine({mode:'ttt',broadcast:value=>snapshot=value});
wireGame.addClient('wire','Wire');wireGame.step(50);
assert.equal(snapshot.players[0].karma,1000);
assert.equal(snapshot.players[0].tttKarma,undefined,'live changes must not reveal roles on the wire');
console.log('TTT karma: original penalties/rewards, strict damage curve, knife/C4 exceptions, round rebasing, reconnect memory, 450 threshold/60-minute ban and private wire passed.');

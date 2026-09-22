import { TTT_GRENADE_CAP } from '../../../shared/ttt.js';
import { TRAP_RULES } from '../../../shared/world/traps.js';
import { GRENADE_TYPE_IDS } from '../../../shared/grenade-rules.js';
import { TttRadar } from './ttt-radar.js';
import { el, WEAPON_NAMES, THROWABLE_NAMES } from './hud-support.js';
import { bindingLabel, matchesBinding } from '../keybindings.js';
export class TttControls {
  constructor(game) {
    this.game=game;
    this.radar=new TttRadar();
    this.root=el('div','vb-ttt-controls',document.body);
    this.root.id='ttt-controls';this.info=el('p','',this.root);
    this.gearInfo=el('p','vb-ttt-gear-status',this.root);
    this.pickup=el('button','',this.root,'ttt-pickup');this.pickup.onclick=()=>this.take();
    this.inspect=el('button','',this.root,'ttt-inspect');this.inspect.onclick=()=>this.examine();
    this.report=el('p','vb-ttt-body-report',this.root,'ttt-body-report');
    this.report.setAttribute('aria-live','polite');
    this.drop=el('button','',this.root,'ttt-drop');this.drop.onclick=()=>this.send('ttt:drop');
    // Traitor traps: the nearest ready button and the map's trap roster (traitors only).
    this.trapButton=el('button','',this.root,'ttt-trap');this.trapButton.onclick=()=>this.fire();
    this.trapInfo=el('p','vb-ttt-trap-list',this.root,'ttt-trap-list');this.trapInfo.setAttribute('aria-live','polite');
    this.key=event=>{
      if(event.repeat||event.target?.closest('input,textarea,select')||!game.session.gameplayInputEnabled||game.hud.isBuyMenuOpen())return;
      if(matchesBinding(event,'interact')){
        if(this.body&&!this.inspect.disabled&&(!this.body.identified||this.pickup.disabled))this.examine();
        else if(this.nearest&&!this.pickup.disabled)this.take();
        else this.fire();
      }
      if(matchesBinding(event,'dropWeapon'))this.send('ttt:drop');
    };
    document.addEventListener('keydown',this.key);
  }
  send(request) {
    const g=this.game;
    if(g.running&&g.selfRow?.state==='alive'&&g.matchState?.mode==='ttt'&&['prep','live'].includes(g.matchState.phase))g.net?.buyWeapon(request);
  }
  examine() { if(this.body&&!this.inspect.disabled)this.send(`ttt:inspect:${this.body.id}`); }
  take() { if(this.nearest&&!this.pickup.disabled)this.send(`ttt:pickup:${this.nearest.id}`); }
  /**
   * The browser's only trap path: outside S&D and Bastion repair the client
   * zeroes `keys.interact`, so examine/pickup presses near a button never fire
   * it. The server's raw interact-edge path serves protocol clients and tests.
   */
  fire() { if(this.trap&&!this.trapButton.disabled)this.send(`ttt:trap:${this.trap.id}`); }
  trapTriggered(event) { if(this.game.selfRow?.ttt?.role==='traitor'){this.note=`${event.name} ausgelöst`;this.noteUntil=Date.now()+4000;} }
  sync(match,self,players) {
    this.root.hidden=match?.mode!=='ttt'||match.phase==='post';
    if(this.root.hidden)return;
    this.root.dataset.role=self?.ttt?.role||'';
    const rows=match.weaponPickups||[];
    const usable=p=>p.grenade?(self?.grenades?.[GRENADE_TYPE_IDS.indexOf(p.grenade)]||0)<TTT_GRENADE_CAP:!self?.owned?.length;
    this.nearest=self?rows.filter(p=>Math.hypot(p.x-self.x,p.y-self.y,p.z-self.z)<=2.4)
      .sort((a,b)=>Number(usable(b))-Number(usable(a))||Math.hypot(a.x-self.x,a.z-self.z)-Math.hypot(b.x-self.x,b.z-self.z))[0]:null;
    this.body=self?(match.corpses||[]).filter(p=>Math.hypot(p.x-self.x,p.y-self.y,p.z-self.z)<=2.4)
      .sort((a,b)=>Math.hypot(a.x-self.x,a.z-self.z)-Math.hypot(b.x-self.x,b.z-self.z))[0]:null;
    this.inspect.hidden=!this.body;
    this.inspect.disabled=!this.body||self?.state!=='alive'||match.phase!=='live';
    this.inspect.textContent=`[${bindingLabel('interact')}] ${this.body?.identified?this.body.name:'Unbekannte Leiche'} untersuchen`;
    this.report.hidden=!this.body?.identified;
    this.report.textContent=this.body?.identified?`${this.body.name} · ${this.body.role==='traitor'?'TRAITOR':'INNOCENT'} · Todesursache: ${(this.body.weapon==='c4'?'C4':this.body.weapon==='trap'?'Falle':WEAPON_NAMES[this.body.weapon]||THROWABLE_NAMES[this.body.weapon]||'Umgebung')}`:'';
    const traps=self?.ttt?.traps||[];
    this.trap=self?traps.filter(t=>Math.hypot(t.x+.5-self.x,t.z+.5-self.z)<=TRAP_RULES.useRange&&Math.abs(t.y-self.y)<=1.2)
      .sort((a,b)=>Math.hypot(a.x+.5-self.x,a.z+.5-self.z)-Math.hypot(b.x+.5-self.x,b.z+.5-self.z))[0]:null;
    const trapState=t=>t.state==='ready'?'bereit':t.state==='cooldown'?`in ${t.cooldown} s`:'verbraucht';
    this.trapButton.hidden=!this.trap;
    this.trapButton.disabled=!this.trap||this.trap.state!=='ready'||self?.state!=='alive'||match.phase!=='live';
    this.trapButton.textContent=this.trap?`[${bindingLabel('interact')}] Falle: ${this.trap.name} · ${trapState(this.trap)}`:'';
    const note=this.note&&Date.now()<this.noteUntil?`${this.note} · `:'';
    this.trapInfo.hidden=!traps.length;
    this.trapInfo.textContent=traps.length?`${note}Fallen: ${traps.map(t=>`${t.name} ${trapState(t)}`).join(' · ')}`:'';
    const weapon=self?.owned?.[0];
    const allies=self?.ttt?.allies?.filter(id=>id!==self.id).map(id=>players.find(p=>p.id===id)?.name).filter(Boolean);
    this.info.textContent=self?.state==='dead'?'ZUSCHAUER · Nächste Runde abwarten':match.phase==='prep'?(players.filter(p=>p.state==='alive').length<2?'Waffen suchen. Mindestens 2 Spieler für die Rollenvergabe.':'Waffen suchen. Noch keine Rollen, noch kein Schaden.'):
      self?.ttt?.role==='traitor'?`TRAITOR · Eliminiere die Innocents. ${self.ttt.credits} Credits.${allies?.length?' Verbündete: '+allies.join(', '):''}`:'INNOCENT · Finde und stoppe die Traitors.';
    const gear=[`Karma: ${self?.karma ?? 1000} · Schaden: ${Math.round((self?.ttt?.damageFactor ?? 1) * 100)} %`];
    if(self?.ttt?.c4)gear.push(`C4 bereit · ${bindingLabel('buy')} zum Platzieren`);
    if(self?.ttt?.equipment?.includes('fakebody'))gear.push(self.ttt.fakeBodies?`Fake-Leiche bereit · ${bindingLabel('buy')} zum Legen`:'Fake-Leiche gelegt');
    if(self?.ttt?.equipment?.includes('disguiser'))gear.push(self.ttt.disguised?'Identität verborgen':'Identität sichtbar');
    if(self?.ttt?.teleporter)gear.push(`Teleporter: ${self.ttt.teleporter.uses} Ladungen · ${bindingLabel('buy')} für Steuerung`);
    this.gearInfo.textContent=gear.join(' · ');this.gearInfo.hidden=gear.length===0;
    this.pickup.textContent=this.nearest?`${this.body&&!this.body.identified?'':'['+bindingLabel('interact')+'] '} ${THROWABLE_NAMES[this.nearest.grenade]||WEAPON_NAMES[this.nearest.weapon]||this.nearest.weapon} aufheben`:'Keine Waffe in Reichweite';
    this.pickup.disabled=!this.nearest||(this.nearest.grenade?(self?.grenades?.[GRENADE_TYPE_IDS.indexOf(this.nearest.grenade)]||0)>=TTT_GRENADE_CAP:!!weapon)||self?.state!=='alive';
    this.drop.textContent=`[${bindingLabel('dropWeapon')}] ${weapon?WEAPON_NAMES[weapon]||weapon:'Waffe'} ablegen`;
    this.drop.disabled=!weapon||self?.state!=='alive';
  }
  update(){this.radar.update(this.game);}
  dispose(){this.radar.dispose();document.removeEventListener('keydown',this.key);this.root.remove();}
}

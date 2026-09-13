import { TTT_GRENADE_CAP } from '../../../shared/ttt.js';
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
    this.key=event=>{
      if(event.repeat||event.target?.closest('input,textarea,select')||!game.session.gameplayInputEnabled||game.hud.isBuyMenuOpen())return;
      if(matchesBinding(event,'interact')){if(this.body&&!this.inspect.disabled&&(!this.body.identified||this.pickup.disabled))this.examine();else this.take();}
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
    this.report.textContent=this.body?.identified?`${this.body.name} · ${this.body.role==='traitor'?'TRAITOR':'INNOCENT'} · Todesursache: ${(this.body.weapon==='c4'?'C4':WEAPON_NAMES[this.body.weapon]||THROWABLE_NAMES[this.body.weapon]||'Umgebung')}`:'';
    const weapon=self?.owned?.[0];
    const allies=self?.ttt?.allies?.filter(id=>id!==self.id).map(id=>players.find(p=>p.id===id)?.name).filter(Boolean);
    this.info.textContent=self?.state==='dead'?'ZUSCHAUER · Nächste Runde abwarten':match.phase==='prep'?(players.filter(p=>p.state==='alive').length<2?'Waffen suchen. Mindestens 2 Spieler für die Rollenvergabe.':'Waffen suchen. Noch keine Rollen, noch kein Schaden.'):
      self?.ttt?.role==='traitor'?`TRAITOR · Eliminiere die Innocents. ${self.ttt.credits} Credits.${allies?.length?' Verbündete: '+allies.join(', '):''}`:'INNOCENT · Finde und stoppe die Traitors.';
    const gear=[`Karma: ${self?.karma ?? 1000} · Schaden: ${Math.round((self?.ttt?.damageFactor ?? 1) * 100)} %`];
    if(self?.ttt?.c4)gear.push(`C4 bereit · ${bindingLabel('buy')} zum Platzieren`);
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

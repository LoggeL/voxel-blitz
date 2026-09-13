import { TttRadar } from './ttt-radar.js';
import { el, WEAPON_NAMES } from './hud-support.js';
import { bindingLabel, matchesBinding } from '../keybindings.js';
export class TttControls {
  constructor(game) {
    this.game=game;
    this.radar=new TttRadar();
    this.root=el('div','vb-ttt-controls',document.body);
    this.root.id='ttt-controls';this.info=el('p','',this.root);
    this.gearInfo=el('p','vb-ttt-gear-status',this.root);
    this.pickup=el('button','',this.root,'ttt-pickup');this.pickup.onclick=()=>this.take();
    this.drop=el('button','',this.root,'ttt-drop');this.drop.onclick=()=>this.send('ttt:drop');
    this.key=event=>{
      if(event.repeat||event.target?.closest('input,textarea,select')||!game.session.gameplayInputEnabled||game.hud.isBuyMenuOpen())return;
      if(matchesBinding(event,'interact'))this.take();
      if(matchesBinding(event,'dropWeapon'))this.send('ttt:drop');
    };
    document.addEventListener('keydown',this.key);
  }
  send(request) {
    const g=this.game;
    if(g.running&&g.selfRow?.state==='alive'&&g.matchState?.mode==='ttt'&&['prep','live'].includes(g.matchState.phase))g.net?.buyWeapon(request);
  }
  take() { if(this.nearest&&!this.pickup.disabled)this.send(`ttt:pickup:${this.nearest.id}`); }
  sync(match,self,players) {
    this.root.hidden=match?.mode!=='ttt'||match.phase==='post';
    if(this.root.hidden)return;
    this.root.dataset.role=self?.ttt?.role||'';
    const rows=match.weaponPickups||[];
    this.nearest=self?rows.filter(p=>Math.hypot(p.x-self.x,p.y-self.y,p.z-self.z)<=2.4)
      .sort((a,b)=>Math.hypot(a.x-self.x,a.z-self.z)-Math.hypot(b.x-self.x,b.z-self.z))[0]:null;
    const weapon=self?.owned?.[0];
    const allies=self?.ttt?.allies?.filter(id=>id!==self.id).map(id=>players.find(p=>p.id===id)?.name).filter(Boolean);
    this.info.textContent=self?.state==='dead'?'ZUSCHAUER · Nächste Runde abwarten':match.phase==='prep'?(players.filter(p=>p.state==='alive').length<2?'Waffen suchen. Mindestens 2 Spieler für die Rollenvergabe.':'Waffen suchen. Noch keine Rollen, noch kein Schaden.'):
      self?.ttt?.role==='traitor'?`TRAITOR · Eliminiere die Innocents. ${self.ttt.credits} Credits.${allies?.length?' Verbündete: '+allies.join(', '):''}`:'INNOCENT · Finde und stoppe die Traitors.';
    const gear=[];
    if(self?.ttt?.equipment?.includes('disguiser'))gear.push(self.ttt.disguised?'Identität verborgen':'Identität sichtbar');
    if(self?.ttt?.teleporter)gear.push(`Teleporter: ${self.ttt.teleporter.uses} Ladungen · ${bindingLabel('buy')} für Steuerung`);
    this.gearInfo.textContent=gear.join(' · ');this.gearInfo.hidden=gear.length===0;
    this.pickup.textContent=this.nearest?`[${bindingLabel('interact')}] ${WEAPON_NAMES[this.nearest.weapon]||this.nearest.weapon} aufheben`:'Keine Waffe in Reichweite';
    this.pickup.disabled=!this.nearest||!!weapon||self?.state!=='alive';
    this.drop.textContent=`[${bindingLabel('dropWeapon')}] ${weapon?WEAPON_NAMES[weapon]||weapon:'Waffe'} ablegen`;
    this.drop.disabled=!weapon||self?.state!=='alive';
  }
  update(){this.radar.update(this.game);}
  dispose(){this.radar.dispose();document.removeEventListener('keydown',this.key);this.root.remove();}
}

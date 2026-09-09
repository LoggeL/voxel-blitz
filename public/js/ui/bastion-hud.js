import { REACTOR_LAYOUT as L } from '../../../shared/world/reactor-layout.js';
import { el } from './hud-support.js';

export function updateBastionHud(m,match,self,now) {
  const b=match.bastion, phase=match.phase;
  if(!b)return;
  m.alphaBlock.style.display=m.bravoBlock.style.display='flex';
  m.alphaName.textContent='REACTOR';m.alphaRole.textContent='CORE HP';m.alphaScore.textContent=String(Math.ceil(b.core.hp));
  m.bravoName.textContent='HOSTILES';m.bravoRole.textContent=`${b.alive} ACTIVE / ${b.remaining-b.alive} INBOUND`;m.bravoScore.textContent=String(b.remaining);
  m.phaseLabel.textContent=phase==='live'?`WAVE ${b.wave} / 8`:phase==='post'?'RUN COMPLETE':`WAVE ${b.wave+1} / 8 · ${phase==='prep'?'PREPARE':'SUPPLY'}`;
  m.clock.style.display=phase==='prep'||phase==='supply'?'block':'none';
  m.clock.textContent=`${Math.max(0,Math.ceil((match.phaseEndsAt-now)/1000))}s`;
  m.bombBanner.style.display='block';
  const lanes=b.lanes.map(id=>L.lanes.find(l=>l.id===id)?.name||id).join(' + ');
  const nearCore=self&&Math.hypot(self.x-b.core.x,self.z-b.core.z)<4;
  const waiting=self?.bastion?.waiting;
  m.bombBanner.textContent=waiting?'JOINING AT NEXT SUPPLY':b.returnAt?`EMERGENCY RETURN · ${Math.max(0,Math.ceil((b.returnAt-now)/1000))}s`
    :phase==='post'?'REACTOR 9':phase==='live'?`${lanes}${b.supply.active&&!self?.bastion?.supplyUsed?' · SERVICE BAY OPEN':''}`
    :`${b.ready}/${b.defenders} READY${nearCore&&b.core.hp<b.core.maxHp?' · HOLD E TO REPAIR ($150)':' · B: LOADOUT & TEAM UPGRADES'}`;
  m.bombBanner.className='vb-match-bomb-banner vb-bastion-banner';
  m.creditsBox.style.display='flex';m.creditsVal.textContent=`$ ${b.credits}`;
  m.buyPrompt.textContent='[B] SUPPLY · LOADOUT / UPGRADES / READY';
  m.buyPrompt.style.display=(phase==='prep'||phase==='supply')&&self?.state==='alive'?'block':'none';
  const repair=self?.interaction?.kind==='repair';m.interactBar.style.display=repair?'block':'none';
  m.interactLabel.textContent='REPAIRING REACTOR';m.interactFill.style.width=`${Math.round((self?.interaction?.progress||0)*100)}%`;
  if(!m.coreBar) { m.coreBar=el('div','vb-core-health',m.alphaBlock);m.coreFill=el('div','',m.coreBar); }
  m.coreBar.hidden=false;m.coreFill.style.width=`${Math.max(0,b.core.hp/b.core.maxHp)*100}%`;
  m.coreBar.dataset.warning=b.core.hp<=250?'critical':b.core.hp<=500?'damaged':'healthy';
}

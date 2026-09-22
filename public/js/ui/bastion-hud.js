import { bindingLabel } from '../keybindings.js';
import { BASTION_ENEMIES, BASTION_RULES, bastionRepairStatus } from '../../../shared/bastion.js';
import { BASTION_BREAK_PHASES, buyWindowOpen } from '../../../shared/modes.js';
import { el } from './hud-support.js';

/** Transient banner override (vehicle inbound, tier sighted, breach, structure lost). */
export const BASTION_BANNER_MS = 4000;

const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Lane id -> display name from `mapMeta.bastion.lanes`; unknown ids print upper-cased. */
export function bastionLaneName(laneNames, id) {
  return laneNames?.[id] || String(id || '').toUpperCase().replace(/-/g, ' ');
}

/** `b.vehicles` grouped as `APC ×1 · BUGGY ×2`. */
export function bastionVehicleSummary(vehicles) {
  if (!Array.isArray(vehicles) || !vehicles.length) return '';
  const counts = new Map();
  for (const v of vehicles) { const k = BASTION_ENEMIES[v?.kind]?.name || String(v?.kind || '').toUpperCase(); counts.set(k, (counts.get(k) || 0) + 1); }
  return [...counts].map(([k, n]) => `${k} ×${n}`).join(' · ');
}

/**
 * @param {object} m         MatchHud dom bag
 * @param {object} match     match snapshot (mode bastion)
 * @param {object} self      own row
 * @param {number} now       server clock
 * @param {{laneNames?:object, banner?:{text:string,until:number}|null, build?:object, localNow?:number}} ctx
 */
export function updateBastionHud(m,match,self,now,ctx={}) {
  const b=match.bastion, phase=match.phase;
  if(!b)return;
  const core=b.core||{}, stage=b.stage||null, maxHp=core.maxHp||1;
  const stageCount=stage?.count||1, stageNo=(stage?.index??0)+1, stageName=stage?.name||'OBJECTIVE';
  const extract=stage?.kind==='extract';
  const alive=b.alive|0, remaining=b.remaining|0;
  m.alphaBlock.style.display=m.bravoBlock.style.display='flex';
  m.alphaName.textContent=core.name||'OBJECTIVE';m.alphaRole.textContent='OBJECTIVE HP';m.alphaScore.textContent=String(Math.ceil(core.hp||0));
  const vehicles=bastionVehicleSummary(b.vehicles);
  m.bravoName.textContent='HOSTILES';
  m.bravoRole.textContent=extract&&phase==='live'?`${alive} ACTIVE · CONTINUOUS${vehicles?' · '+vehicles:''}`:`${alive} ACTIVE / ${Math.max(0,remaining-alive)} INBOUND${vehicles?' · '+vehicles:''}`;
  m.bravoScore.textContent=String(remaining);
  const waves=stage?.waves||b.waves||0, stageWave=stage?.wave||0;
  let label;
  if(phase==='post') label='RUN COMPLETE';
  else if(phase==='prep') label=`STAGE ${stageNo} / ${stageCount} · ${stageName} · PREPARE`;
  else if(phase==='supply') label=stage?.transition==='regroup'?`STAGE HELD · FALL BACK TO ${stageName}`:`STAGE ${stageNo} / ${stageCount} · WAVE ${Math.min(waves,stageWave+1)} / ${waves} · SUPPLY`;
  else if(extract) {
    const left=Number.isFinite(stage?.holdEndsAt)?stage.holdEndsAt-now:null;
    label=left===null?`EXTRACTION · ${stageName}`:left>0?`EXTRACTION · ${mmss(left)}`:'SHUTTLE HERE · GET TO THE BEACON';
    m.phaseLabel.classList.toggle('vb-bastion-urgent',left!==null&&left<=15000);
  } else label=`STAGE ${stageNo} / ${stageCount} · ${stageName} · WAVE ${stageWave} / ${waves}`;
  if(!extract||phase!=='live') m.phaseLabel.classList.remove('vb-bastion-urgent');
  m.phaseLabel.textContent=label;m.phaseLabel.dataset.compact=label;
  m.clock.style.display=BASTION_BREAK_PHASES.includes(phase)?'block':'none';
  m.clock.textContent=`${Math.max(0,Math.ceil((match.phaseEndsAt-now)/1000))}s`;
  m.bombBanner.style.display='block';
  const laneName=bastionLaneName(ctx.laneNames,stage?.lane||b.lanes?.[0]);
  const repairStatus=bastionRepairStatus(match,self);
  const waiting=self?.bastion?.waiting;
  const localNow=Number.isFinite(ctx.localNow)?ctx.localNow:(typeof performance!=='undefined'?performance.now():Date.now());
  const transient=ctx.banner&&ctx.banner.until>localNow?ctx.banner.text:null;
  m.bombBanner.textContent=waiting?'JOINING AT NEXT BREAK':b.returnAt?`EMERGENCY RETURN · ${Math.max(0,Math.ceil((b.returnAt-now)/1000))}s`
    :transient?transient
    :phase==='post'?stageName:phase==='live'?`${laneName} BREACH${b.supply?.active&&!self?.bastion?.supplyUsed?' · SUPPLY OPEN':''}`
    :repairStatus==='ok'?`HOLD ${bindingLabel('interact')} TO REPAIR ($${BASTION_RULES.repairPrice})`
    :repairStatus==='limit'?`REPAIRS USED · ${BASTION_RULES.repairLimit} PER BREAK`
    :repairStatus==='credits'?`REPAIR NEEDS $${BASTION_RULES.repairPrice}`
    :`${b.ready}/${b.defenders} READY · [${bindingLabel('buy')}] SUPPLY · [${bindingLabel('build')}] BUILD`;
  m.bombBanner.className='vb-match-bomb-banner vb-bastion-banner'+(transient?' vb-bastion-banner-alert':'');
  m.creditsBox.style.display='flex';m.creditsVal.textContent=`$ ${b.credits}`;
  const buildable=buyWindowOpen(match.mode,phase)&&self?.state==='alive';
  m.buyPrompt.textContent=`[${bindingLabel('buy')}] SUPPLY · LOADOUT / UPGRADES / READY`;
  m.buyPrompt.style.display=buildable?'block':'none';
  if(!m.buildPrompt) m.buildPrompt=el('div','vb-build-prompt',m.buyPrompt.parentNode);
  const build=ctx.build;
  if(build?.active) {
    m.buildPrompt.textContent=`BUILD · ${build.name} $${build.price} · ${build.reason||'CLICK TO PLACE'} · [${bindingLabel('reload')}] ROTATE · [${bindingLabel('build')}] NEXT · [ESC] EXIT`;
    m.buildPrompt.dataset.state=build.reason?'blocked':'ok';
  } else if(buildable&&b.budget) {
    const g=b.budget;
    m.buildPrompt.textContent=`WALLS ${g.barricadeVoxels?.used??0}/${g.barricadeVoxels?.max??0} · TURRETS ${g.turrets?.used??0}/${g.turrets?.max??0} · CRATE ${g.crates?.used??0}/${g.crates?.max??0}`;
    m.buildPrompt.dataset.state='budget';
  }
  m.buildPrompt.style.display=build?.active||(buildable&&b.budget)?'block':'none';
  const repair=self?.interaction?.kind==='repair';m.interactBar.style.display=repair?'block':'none';
  m.interactLabel.textContent=`REPAIRING ${core.name||'OBJECTIVE'}`;m.interactFill.style.width=`${Math.round((self?.interaction?.progress||0)*100)}%`;
  if(!m.coreBar) { m.coreBar=el('div','vb-core-health',m.alphaBlock);m.coreFill=el('div','',m.coreBar); }
  m.coreBar.hidden=false;m.coreFill.style.width=`${Math.max(0,(core.hp||0)/maxHp)*100}%`;
  m.coreBar.dataset.warning=core.hp<=maxHp*0.25?'critical':core.hp<=maxHp*0.5?'damaged':'healthy';
}

import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import { OPTICS, GRIPS, ATTACHMENT_SLOTS, normalizeAttachments, normalizeWeaponLoadout, weaponWithAttachments } from '../../../shared/weapon-attachments.js';
import { weaponTurnProfile } from '../../../shared/weapon-handling.js';
import { WeaponPreview } from './weapon-preview.js';

const el = (tag,parent,text='',className='') => {
  const n = document.createElement(tag); n.textContent = text; n.className = className; parent.append(n); return n;
};
const button = (parent,text,fn,className='vb-btn') => {
  const n = el('button',parent,text,className); n.type = 'button'; n.addEventListener('click',fn); return n;
};
const number = (v,d=2) => Number(v.toFixed(d)).toString();
const equal = (a,b) => a.optic === b.optic && a.grip === b.grip;

export class WeaponCustomization {
  constructor({accounts} = {}) {
    this.accounts = accounts; this.weapon = 'rifle'; this.saved = {}; this.drafts = {}; this.version = 0;
    this.dialog = el('dialog',document.body,'','vb-workshop'); this.dialog.id = 'weapon-customization';
    this.dialog.setAttribute('aria-labelledby','workshop-title');
    const header = el('header',this.dialog,'','vb-workshop-header');
    const heading = el('div',header); el('span',heading,'VOXEL BLITZ','vb-workshop-kicker');
    el('h2',heading,'ARMORY').id = 'workshop-title';
    this.identity = el('p',header,'','vb-workshop-identity');
    button(header,'BACK',()=>this.dialog.close()).id = 'workshop-close';
    const layout = el('div',this.dialog,'','vb-workshop-layout');
    this.weapons = el('nav',layout,'','vb-workshop-weapons'); this.weapons.setAttribute('aria-label','Choose weapon');
    for (const id of WEAPON_IDS) {
      const n = button(this.weapons,'',()=>{this.weapon=id;this.render();},'vb-workshop-weapon');
      n.dataset.weapon = id; el('span',n,String(WEAPON_IDS.indexOf(id)+1).padStart(2,'0'));
      el('strong',n,WEAPONS[id].name); el('small',n,id.toUpperCase());
    }
    const center = el('section',layout,'','vb-workshop-center');
    const title = el('div',center,'','vb-workshop-caption');
    this.name = el('h3',title); this.summary = el('p',title);
    this.previewHost = el('div',center,'','vb-workshop-preview');
    el('p',center,'DRAG TO INSPECT','vb-workshop-drag');
    this.stats = el('section',layout,'','vb-workshop-stats'); this.stats.setAttribute('aria-label','Weapon handling values');
    this.slots = el('div',layout,'','vb-workshop-slots');
    const footer = el('footer',this.dialog,'','vb-workshop-footer');
    const info = el('div',footer); this.status = el('p',info); this.status.setAttribute('role','status');
    el('small',info,'Saved setups apply when you join a match or training.');
    this.reset = button(footer,'FACTORY SETUP',()=>{this.drafts[this.weapon]=normalizeAttachments(this.weapon);this.render();});
    this.save = button(footer,'SAVE SETUP',()=>this.persist(),'vb-btn primary'); this.save.id = 'workshop-save';
    this.dialog.addEventListener('keydown',e=>e.stopPropagation());
    this.dialog.addEventListener('close',()=>{this.preview?.dispose();this.preview=null;document.getElementById('workshop-open')?.focus();});
    this.onAccountChange = () => {
      this.version++; this.ready=false; this.saved={};this.drafts={}; this.busy=false;
      if (this.dialog.open) this.refresh();
    };
    window.addEventListener('vb-account-change',this.onAccountChange);
    this.observer = new MutationObserver(()=>this.mount());
    this.observer.observe(document.getElementById('menu'),{childList:true,subtree:true}); this.mount();
  }
  mount() {
    const nav = document.querySelector('#menu .vb-main-nav');
    if (!nav || document.getElementById('workshop-open')) return;
    const open = button(nav,'ARMORY',()=>this.open(),'vb-main-nav-button'); open.id='workshop-open';
    open.setAttribute('aria-haspopup','dialog');
    const career = document.getElementById('career-open'); if (career) nav.insertBefore(open,career);
  }
  async open() {
    if (!this.dialog.open) this.dialog.showModal();
    try { this.preview ||= new WeaponPreview(this.previewHost); } catch { this.previewHost.textContent='3D preview unavailable on this device.'; }
    this.render(); await this.refresh();
  }
  async refresh() {
    const version = ++this.version; this.ready=false; this.busy=true; this.render('Loading your saved setups...');
    try {
      const response = await fetch('/api/career',{credentials:'same-origin',signal:AbortSignal.timeout(5000)});
      const profile = await response.json();
      if (version !== this.version) return;
      if (!response.ok) throw new Error(profile.error || 'Could not load your setups.');
      this.saved=normalizeWeaponLoadout(profile.equipped?.weaponAttachments); this.drafts={}; this.ready=true;
      this.render();
    } catch(error) { if(version===this.version)this.render(error.message); }
    finally { if(version===this.version){this.busy=false;this.controls();} }
  }
  selection() { return this.drafts[this.weapon] || normalizeAttachments(this.weapon,this.saved[this.weapon]); }
  controls() {
    this.save.disabled=this.busy || !this.ready || equal(this.selection(),normalizeAttachments(this.weapon,this.saved[this.weapon]));
    this.reset.disabled=this.busy || !this.ready;
    for(const n of this.slots.querySelectorAll('button')) n.disabled=this.busy || !this.ready;
    this.dialog.setAttribute('aria-busy',String(!!this.busy));
  }
  render(message) {
    const base=WEAPONS[this.weapon], selection=this.selection(), def=weaponWithAttachments(base,selection), h=def.handling;
    this.name.textContent=base.name;
    this.identity.textContent=this.accounts?.user ? `SETUPS FOR ${this.accounts.user.username}` : 'GUEST SETUPS · SAVED IN THIS BROWSER';
    this.summary.textContent=`${this.weapon.toUpperCase()} / ${OPTICS[selection.optic].name} / ${GRIPS[selection.grip].name}`;
    for(const n of this.weapons.children) n.setAttribute('aria-pressed',String(n.dataset.weapon===this.weapon));
    this.preview?.show(this.weapon,selection);
    this.stats.replaceChildren(); el('h3',this.stats,'WEAPON HANDLING');
    const metrics=[['ERGONOMICS',h.ergonomics,base.handling.ergonomics,'',100,true,'Higher values let you turn faster.'],
      ['SWAY',h.sway.amplitudeDeg,base.handling.sway.amplitudeDeg,'°',1.5,false,`${number(h.sway.frequencyHz)} Hz · slower motion at lower rates.`],
      ['VERTICAL RECOIL',h.verticalRecoil,base.handling.verticalRecoil,'°',8,false,'Upward kick per shot. Lower is steadier.'],
      ['HORIZONTAL RECOIL',h.horizontalRecoil,base.handling.horizontalRecoil,'°',4,false,'Sideways kick. Lower is steadier.']];
    for(const [label,value,original,unit,max,higher,detail] of metrics) {
      const row=el('div',this.stats,'','vb-workshop-stat'); el('h4',row,label);
      const readout=el('div',row,'','vb-workshop-readout'); el('strong',readout,number(value)+unit);
      const delta=value-original;
      el('span',readout,Math.abs(delta)<0.0001 ? 'FACTORY' : `${delta>0?'+':''}${number(delta)}${unit}`,Math.abs(delta)<0.0001 ? '' : (delta>0)===higher?'better':'worse');
      const meter=el('meter',row);meter.min=0;meter.max=max;meter.value=value;meter.setAttribute('aria-label',label);
      el('p',row,detail);
    }
    el('p',this.stats,`Turn ceiling: ${Math.round(weaponTurnProfile(h).maxSpeed*180/Math.PI)}°/s. Zoom: ${number(def.zoom || 1)}×.`,'vb-workshop-turn');
    this.slots.replaceChildren();
    for(const [slot,label,catalog,ids] of [['optic','OPTIC',OPTICS,ATTACHMENT_SLOTS[this.weapon].optics],['grip','GRIP',GRIPS,ATTACHMENT_SLOTS[this.weapon].grips]]) {
      const section=el('section',this.slots); el('h3',section,label);
      const options=el('div',section,'','vb-workshop-options');
      for(const id of ids) {
        const item=catalog[id]; const b=button(options,'',()=>{
          this.drafts[this.weapon]=normalizeAttachments(this.weapon,{...this.selection(),[slot]:id});this.render();
        },'vb-workshop-option'); b.dataset[slot]=id;b.setAttribute('aria-pressed',String(selection[slot]===id));
        el('strong',b,item.name); el('small',b,item.detail);
      }
      if(ids.length===1)el('p',section,'This weapon uses its fixed factory mount.','vb-workshop-fixed');
    }
    const dirty=!equal(selection,normalizeAttachments(this.weapon,this.saved[this.weapon]));
    this.status.textContent=message || (dirty?'Unsaved setup.':'Saved setup equipped.'); this.controls();
  }
  async persist() {
    if(this.save.disabled)return;
    const weapon=this.weapon, attachments=this.selection(), account=this.accounts?.user?.id || null;
    const version=++this.version;this.busy=true;this.render('Saving setup...');
    try {
      await this.accounts?.refresh();
      if(version!==this.version || (this.accounts?.user?.id || null)!==account) return;
      const response=await fetch('/api/career/attachments',{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json','X-VB-Career':'1'},body:JSON.stringify({weapon,attachments}),signal:AbortSignal.timeout(5000)});
      const profile=await response.json(); if(version!==this.version)return;
      if(!response.ok)throw new Error(profile.error || 'Could not save. Try again.');
      this.saved=normalizeWeaponLoadout(profile.equipped?.weaponAttachments);delete this.drafts[weapon];
      this.render(`${WEAPONS[weapon].name}: setup saved.`);
    } catch(error){if(version===this.version)this.render(error.message);}
    finally{if(version===this.version){this.busy=false;this.controls();}}
  }
  dispose(){this.version++;this.preview?.dispose();this.observer.disconnect();window.removeEventListener('vb-account-change',this.onAccountChange);this.dialog.remove();}
}

import { normalizeCosmeticLoadout } from '../../../shared/career.js';
import { SkinLayer } from './skin-layer.js';
import * as overdrive from './skins/rifle-overdrive.js';
import * as highNoon from './skins/revolver-high-noon.js';
import * as foundry from './skins/minigun-foundry.js';
import * as salvager from './skins/salvager.js';
import * as revenant from './skins/revenant.js';

const WEAPON_SKINS = { 'rifle-overdrive': overdrive, 'revolver-high-noon': highNoon, 'minigun-foundry': foundry };
const CHARACTER_SKINS = { salvager, revenant };

export function applyGunCosmetics(model, weapon, value) {
  const loadout = normalizeCosmeticLoadout(value);
  const id = loadout.weaponSkins[weapon] || 'standard';
  if (model._skinId !== id) {
    model._skinLayer?.clear();
    model._skinLayer = new SkinLayer();
    WEAPON_SKINS[id]?.apply(model, model._skinLayer);
    model._skinId = id;
    model.root.userData.skin = id;
  }
  const character = loadout.characterSkin;
  if (model._gloveId !== character) {
    model._gloveLayer?.clear();
    model._gloveLayer = new SkinLayer();
    const palette = CHARACTER_SKINS[character]?.palette;
    if (palette) for (const name of ['hand_l', 'hand_r']) {
      const hand = model.root.getObjectByName(name);
      if (hand) model._gloveLayer.tint(hand, { [0x22252a]: palette.glove, [0x15171a]: palette.armor, [0xb09a72]: palette.cuff }, { includeHands: true });
    }
    model._gloveId = character;
  }
}

export function clearGunCosmetics(model) {
  model._skinLayer?.clear(); model._gloveLayer?.clear();
  model._skinLayer = model._gloveLayer = null;
}

export function applyAvatarCosmetics(avatar, value) {
  const loadout = normalizeCosmeticLoadout(value);
  avatar.weaponModel?.setCosmetics(loadout);
  if (avatar._skinId === loadout.characterSkin) return;
  avatar._skinLayer?.clear();
  avatar._skinLayer = new SkinLayer();
  CHARACTER_SKINS[loadout.characterSkin]?.apply(avatar, avatar._skinLayer);
  avatar._skinId = loadout.characterSkin;
  avatar.group.userData.skin = loadout.characterSkin;
  // All additions participate in normal death fade and hit feedback. Team cloth remains unchanged.
  const fades = new Set(), flashes = new Set();
  for (const root of [avatar.head, avatar.torso, avatar.hips, avatar.lArm, avatar.rArm, avatar.lLeg, avatar.rLeg]) {
    root.traverse(object => {
      for (const material of [].concat(object.material || [])) {
        material.transparent = true;
        fades.add(material);
        if (material.emissive && !material.userData.cosmeticGlow) flashes.add(material);
      }
    });
  }
  fades.add(avatar.tag.material); fades.add(avatar.hpSpr.material);
  avatar.fadeMaterials = [...fades]; avatar.flashMaterials = [...flashes];
}

export function applyBodyCosmetics(body, value) {
  if (!body) return;
  const id = normalizeCosmeticLoadout(value).characterSkin;
  if (body._skinId === id) return;
  const palette = CHARACTER_SKINS[id]?.palette;
  body._skinLayer?.clear();
  body._skinLayer = new SkinLayer();
  if (palette) body._skinLayer.tint(body.group, { [0x44515e]: palette.cloth, [0x202831]: palette.armor });
  body._skinId = id;
}

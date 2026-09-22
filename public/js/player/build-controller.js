// Bastion build mode: blueprint selection, the translucent placement ghost and
// the `build` purchase. Placement is never optimistic: the ghost mirrors the
// shared `canPlaceStructure` verdict and the server confirms through the
// ordinary buy path; the ghost stays for repeat placement.
import * as THREE from '../vendor/three.module.js';
import { GROUND } from '../../../shared/world/blocks.js';
import { BASTION_STRUCTURES, STRUCTURE_KINDS, structureFootprint, canPlaceStructure } from '../../../shared/bastion-build.js';
import { BASTION_BREAK_PHASES } from '../../../shared/modes.js';
import { fwdFromAngles } from '../util/look.js';

/** HUD copy per `canPlaceStructure` reason; `kind`/`phase`/`alive` hide the ghost instead. */
export const BUILD_REASON_TEXT = Object.freeze({
  reach: 'TOO FAR', zone: 'OUTSIDE BUILD ZONE', ingress: 'INSIDE ENEMY GATE', objective: 'TOO CLOSE TO OBJECTIVE',
  spawn: 'BLOCKS A SPAWN', air: 'BLOCKED', floor: 'NO FLOOR', occupied: 'SOMEONE IS STANDING THERE',
  structure: 'OVERLAPS A STRUCTURE', budget: 'BUDGET SPENT', credits: 'NOT ENOUGH CREDITS',
});
/** N cycles wall -> sandbag -> turret -> crate -> off (the catalog lists sandbag first). */
const CYCLE_ORDER = Object.freeze(['wall', 'sandbag', 'turret', 'crate']);
const OK_COLOR = 0x46ddb1, BAD_COLOR = 0xff554b;
const GHOST_REACH = 6;

export class BuildController {
  /**
   * @param {object} deps
   * @param {import('../engine/input.js').Input} deps.input
   * @param {(x:number,y:number,z:number)=>number} deps.getBlock  client block store
   * @param {() => object|null} deps.getWorldview   WorldView (scene + pickCameraRay)
   * @param {() => THREE.Camera|null} deps.getCamera
   * @param {() => object|null} deps.getPlayer      LocalPlayer (pos, view, shotYaw/Pitch, alive)
   * @param {() => object|null} deps.getMatch       latest match snapshot
   * @param {() => object|null} deps.getSelfRow     authoritative own row
   * @param {() => object|null} deps.getMapMeta     map meta carrying `.bastion`
   * @param {(action:string, item:string, cell:object, facing:number) => boolean} deps.purchase
   * @param {() => boolean} deps.isBuyMenuOpen
   * @param {() => boolean} deps.inputEnabled
   */
  constructor({ input, getBlock, getWorldview, getCamera, getPlayer, getMatch, getSelfRow, getMapMeta,
    purchase, isBuyMenuOpen = () => false, inputEnabled = () => true }) {
    this.input = input;
    this.getBlock = getBlock;
    this.getWorldview = getWorldview;
    this.getCamera = getCamera;
    this.getPlayer = getPlayer;
    this.getMatch = getMatch;
    this.getSelfRow = getSelfRow;
    this.getMapMeta = getMapMeta;
    this.purchase = purchase;
    this.isBuyMenuOpen = isBuyMenuOpen;
    this.inputEnabled = inputEnabled;
    this.active = false;
    this.kind = 'wall';
    this.rotateOffset = 0;
    this.cell = null;
    this.facing = 0;
    this.result = { ok: false, reason: null };
    this.visible = false;
    this._group = null;
    this._scene = null;
    this._materials = { ok: null, bad: null };
    this._geometries = [];
    this._meshes = [];
    this._signature = '';
  }

  /** Bastion, buildable phase, alive defender. */
  available() {
    const match = this.getMatch(), self = this.getSelfRow(), player = this.getPlayer();
    return !!(match?.mode === 'bastion' && BASTION_BREAK_PHASES.includes(match.phase)
      && self?.state === 'alive' && player?.alive);
  }

  get def() { return BASTION_STRUCTURES[this.kind] || null; }

  /** Armory card or N: enter build mode with a blueprint. */
  select(kind) {
    if (!STRUCTURE_KINDS.includes(kind) || !this.available()) return false;
    this.kind = kind;
    this.active = true;
    this.input.setBuildMode(true);
    return true;
  }

  /** N: off -> on with the last kind; on -> next kind, then off after the last. */
  cycle() {
    if (!this.active) return this.select(this.kind || 'wall');
    const index = CYCLE_ORDER.indexOf(this.kind);
    if (index < 0 || index === CYCLE_ORDER.length - 1) { this.exit(); return false; }
    this.kind = CYCLE_ORDER[index + 1];
    return true;
  }

  rotate(step = 1) { this.rotateOffset = ((this.rotateOffset + step) % 4 + 4) % 4; }

  exit() {
    this.active = false;
    this.input.setBuildMode(false);
    this._hide();
  }

  /** HUD read model for the build prompt line. */
  readModel() {
    const def = this.def;
    return {
      active: this.active, kind: this.kind, name: def?.name || '', price: def?.price || 0,
      reason: this.active && this.visible && !this.result.ok ? (BUILD_REASON_TEXT[this.result.reason] || null) : null,
      ok: this.active && this.visible && this.result.ok,
    };
  }

  /** Per frame after `worldview.update(dt)`: consume input, aim the ghost, place. */
  update() {
    const toggle = this.input.consumeBuildToggle();
    if (toggle === 'exit') this.exit();
    else if (toggle === 'next') this.cycle();
    if (this.active && (!this.available() || this.isBuyMenuOpen() || !this.inputEnabled())) this.exit();
    if (!this.active) { this.input.consumePlaceRequest(); this.input.consumeBuildRotate(); this._hide(); return; }
    if (this.input.consumeBuildRotate()) this.rotate(1);

    const worldview = this.getWorldview(), camera = this.getCamera(), player = this.getPlayer();
    const match = this.getMatch(), self = this.getSelfRow(), layout = this.getMapMeta()?.bastion;
    const b = match?.bastion;
    if (!worldview || !camera || !player || !b || !layout) { this._hide(); return; }
    const dir = fwdFromAngles(player.shotYaw, player.shotPitch);
    const origin = camera.position;
    const hit = worldview.pickCameraRay(origin, dir, GHOST_REACH);
    // The shared DDA returns the solid cell and the entered face; the ghost
    // sits in the empty neighbour or four metres out when nothing is in reach.
    const cell = hit
      ? { x: hit.x + hit.nx, y: GROUND + 1, z: hit.z + hit.nz }
      : { x: Math.floor(origin.x + dir.x * 4), y: GROUND + 1, z: Math.floor(origin.z + dir.z * 4) };
    const facing = ((Math.round(player.view.yaw / (Math.PI / 2)) + this.rotateOffset) % 4 + 4) % 4;
    const pos = player.pos;
    const me = { ...(self || {}), x: pos.x, y: pos.y, z: pos.z, state: self?.state };
    this.cell = cell;
    this.facing = facing;
    this.result = canPlaceStructure({
      getBlock: this.getBlock, layout, stageIndex: b.stage?.index ?? 0, kind: this.kind, cell, facing,
      player: me, phase: match.phase, budget: b.budget, credits: b.credits, structures: b.structures ?? [],
      occupied: () => false,
    });
    this._render(worldview.scene, structureFootprint(this.kind, cell, facing), this.result.ok);
    if (this.input.consumePlaceRequest() && this.result.ok) {
      this.purchase('build', this.kind, { x: cell.x, y: cell.y, z: cell.z }, facing);
    }
  }

  _ensure(scene) {
    if (this._group && this._scene === scene) return;
    this._dropMeshes();
    if (this._group) this._scene?.remove(this._group);
    this._group = new THREE.Group();
    this._group.name = 'bastion-build-ghost';
    this._scene = scene;
    scene.add(this._group);
    if (!this._materials.ok) {
      this._materials.ok = new THREE.MeshBasicMaterial({ color: OK_COLOR, transparent: true, opacity: 0.35, depthWrite: false });
      this._materials.bad = new THREE.MeshBasicMaterial({ color: BAD_COLOR, transparent: true, opacity: 0.35, depthWrite: false });
    }
  }

  _render(scene, cells, ok) {
    this._ensure(scene);
    const material = ok ? this._materials.ok : this._materials.bad;
    const signature = `${this.kind}|${cells.map(c => `${c.x},${c.y},${c.z}`).join(';')}`;
    if (signature !== this._signature) {
      this._signature = signature;
      this._dropMeshes();
      const def = this.def;
      const add = (geometry, x, y, z) => {
        this._geometries.push(geometry);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        this._group.add(mesh);
        this._meshes.push(mesh);
      };
      const c = cells[0];
      if (def?.kind === 'objective' && this.kind === 'turret') {
        add(new THREE.BoxGeometry(0.9, 0.25, 0.9), c.x + 0.5, c.y + 0.125, c.z + 0.5);
        add(new THREE.CylinderGeometry(0.18, 0.18, 0.6, 10), c.x + 0.5, c.y + 0.55, c.z + 0.5);
        add(new THREE.BoxGeometry(0.5, 0.35, 0.5), c.x + 0.5, c.y + 0.95, c.z + 0.5);
      } else if (def?.kind === 'objective') {
        add(new THREE.BoxGeometry(1.0, 0.8, 1.0), c.x + 0.5, c.y + 0.4, c.z + 0.5);
      } else {
        for (const cell of cells) add(new THREE.BoxGeometry(0.98, 0.98, 0.98), cell.x + 0.5, cell.y + 0.5, cell.z + 0.5);
      }
    }
    for (const mesh of this._meshes) mesh.material = material;
    this._group.visible = true;
    this.visible = true;
  }

  _hide() {
    this.visible = false;
    if (this._group) this._group.visible = false;
  }

  _dropMeshes() {
    for (const mesh of this._meshes) this._group?.remove(mesh);
    for (const geometry of this._geometries) geometry.dispose();
    this._meshes.length = 0;
    this._geometries.length = 0;
    this._signature = '';
  }

  dispose() {
    this.active = false;
    this.input?.setBuildMode(false);
    this._dropMeshes();
    if (this._group) this._scene?.remove(this._group);
    this._materials.ok?.dispose();
    this._materials.bad?.dispose();
    this._materials = { ok: null, bad: null };
    this._group = null;
    this._scene = null;
  }
}

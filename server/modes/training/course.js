import { AIR, METAL } from '../../../shared/worlddata.js';

function inside(entity, region) {
  if (!region) return false;
  const x = Math.floor(entity.x);
  const z = Math.floor(entity.z);
  return x >= region.minX && x <= region.maxX && z >= region.minZ && z <= region.maxZ;
}

/** One physical course owns one attempt, its gates, splits, and personal bests. */
export class TrainingCourse {
  constructor({ course, entities, now, emit, blocks, stageTargets, resetTargets }) {
    this.course = course;
    this.entities = entities;
    this.now = now;
    this.emit = emit;
    this.blocks = blocks;
    this.stageTargets = stageTargets;
    this.resetTargets = resetTargets;
    this.active = null;
    this.best = new Map();
  }

  tick() {
    if (!this.course) return;
    const now = this.now();
    if (!this.active) {
      const player = [...this.entities.values()].find((entity) =>
        !entity.bot && entity.state === 'alive' && inside(entity, this.course.start));
      if (player) this.start(player.id, now);
      return;
    }
    const run = this.active;
    const player = this.entities.get(run.id);
    if (!player || player.state !== 'alive') {
      this.reset(run.id, player ? 'death' : 'left');
      return;
    }
    // Returning to the start takes precedence over a simultaneous target kill.
    if (inside(player, this.course.start)) {
      if (run.leftStart) {
        this.reset(run.id, 'rearmed');
        this.start(run.id, now);
        return;
      }
    } else run.leftStart = true;

    const targets = this.stageTargets().get(run.stage);
    if (targets?.length && targets.every((id) => this.entities.get(id)?.state === 'dead')) {
      const ms = now - run.startedAt;
      run.splits.push(ms);
      this.emit('run_split', { id: run.id, stage: run.stage, ms });
      this.setGate(this.course.gates[run.stage], AIR);
      run.stage++;
      return;
    }
    if (run.stage >= this.stageTargets().size && inside(player, this.course.finish)) {
      const ms = now - run.startedAt;
      const best = Math.min(this.best.get(run.id) ?? Infinity, ms);
      this.best.set(run.id, best);
      this.emit('run_finish', { id: run.id, ms, best, splits: run.splits.slice() });
      this.active = null;
    }
  }

  start(id, now) {
    this.active = { id, stage: 0, startedAt: now, splits: [], leftStart: false };
    for (const gate of this.course.gates) this.setGate(gate, METAL);
    this.resetTargets();
    this.emit('run_start', { id, at: now });
  }

  reset(id, reason) {
    if (this.active?.id !== id) return;
    this.active = null;
    this.emit('run_reset', { id, reason });
  }

  removePlayer(id) {
    this.reset(id, 'left');
    this.best.delete(id);
  }

  setGate(gate, value) {
    if (!gate) return;
    const [yMin, yMax] = this.course.gateY;
    const [zMin, zMax] = this.course.gateZ;
    for (let y = yMin; y <= yMax; y++) {
      for (let z = zMin; z <= zMax; z++) this.blocks.set(gate.x, y, z, value);
    }
  }

  dispose() {
    this.active = null;
    this.best.clear();
  }
}

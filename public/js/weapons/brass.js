// Fixed-budget world-space shell pool with voxel collision and settling.
import * as THREE from '../vendor/three.module.js';
import { hideInstance } from './instancing.js';

const BRASS_POOL_SIZE = 32;
const NO_BLOCK = () => 0;
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

export class BrassPool {
  constructor(scene, worldGetBlockFn) {
    this.scene = scene;
    this.getBlockFn = worldGetBlockFn || NO_BLOCK;
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.02, 0.05, 0.02),
      new THREE.MeshStandardMaterial({ color: 0xd4a942, roughness: 0.35, metalness: 0.8 }),
      BRASS_POOL_SIZE,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.shells = Array.from({ length: BRASS_POOL_SIZE }, (_, i) => {
      hideInstance(this.mesh, i);
      return {
        active: false,
        position: new THREE.Vector3(),
        rotation: new THREE.Euler(),
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        t: 0,
      };
    });
    this._matrix = new THREE.Matrix4();
    this._rotation = new THREE.Quaternion();
    this._activeCount = 0;
    this._disposed = false;
  }

  /** Copy a world-space ejection position and velocity into the claimed slot. */
  spawn(posWorld, ejectVelWorld) {
    if (this._disposed) return;
    let index = -1;
    for (let i = 0; i < this.shells.length; i++) {
      if (!this.shells[i].active) { index = i; break; }
    }
    if (index < 0) {
      index = 0;
      for (let i = 1; i < this.shells.length; i++) {
        if (this.shells[i].t >= this.shells[index].t) index = i;
      }
    } else {
      this._activeCount++;
    }
    const shell = this.shells[index];
    shell.active = true;
    if (Array.isArray(posWorld)) {
      shell.position.set(posWorld[0], posWorld[1], posWorld[2]);
    } else if (posWorld) {
      shell.position.copy(posWorld);
    }

    if (Array.isArray(ejectVelWorld)) {
      shell.vel.set(ejectVelWorld[0], ejectVelWorld[1], ejectVelWorld[2]);
    } else if (ejectVelWorld) {
      shell.vel.copy(ejectVelWorld);
    } else {
      shell.vel
        .set(1, 0.45, -0.15)
        .normalize()
        .multiplyScalar(2.2 + Math.random() * 1.2);
      shell.vel.y += 1.4;
    }
    shell.spin.set(
      (Math.random() - 0.5) * 22,
      (Math.random() - 0.5) * 22,
      (Math.random() - 0.5) * 22,
    );
    shell.t = 0;
    this._draw(shell, index);
    this.mesh.visible = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  _draw(shell, index) {
    this._rotation.setFromEuler(shell.rotation);
    this._matrix.compose(shell.position, this._rotation, UNIT_SCALE);
    this.mesh.setMatrixAt(index, this._matrix);
  }

  update(dt) {
    if (!this._activeCount || this._disposed) return;
    for (let i = 0; i < this.shells.length; i++) {
      const shell = this.shells[i];
      if (!shell.active) continue;
      shell.t += dt;
      shell.vel.y -= 18 * dt;
      shell.position.addScaledVector(shell.vel, dt);
      shell.rotation.x += shell.spin.x * dt;
      shell.rotation.y += shell.spin.y * dt;
      shell.rotation.z += shell.spin.z * dt;

      const gy = Math.floor(shell.position.y);
      const gx = Math.floor(shell.position.x);
      const gz = Math.floor(shell.position.z);
      const collided = this.getBlockFn(gx, gy, gz) !== 0;
      if (collided) {
        shell.position.y = gy + 1.03;
        shell.vel.set(0, 0, 0);
        shell.spin.set(0, 0, 0);
      }
      if (shell.t > 3.5 || (collided && shell.t > 2.5)) {
        shell.active = false;
        this._activeCount--;
        hideInstance(this.mesh, i);
      } else {
        this._draw(shell, i);
      }
    }
    this.mesh.visible = this._activeCount > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  reset() {
    for (let i = 0; i < this.shells.length; i++) {
      const shell = this.shells[i];
      shell.active = false;
      shell.vel.set(0, 0, 0);
      shell.spin.set(0, 0, 0);
      shell.t = 0;
      hideInstance(this.mesh, i);
    }
    this._activeCount = 0;
    this.mesh.visible = false;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

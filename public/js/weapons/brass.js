// Fixed-budget world-space shell pool with voxel collision and settling.
import * as THREE from '../vendor/three.module.js';

const BRASS_POOL_SIZE = 32;
const NO_BLOCK = () => 0;

export class BrassPool {
  constructor(scene, worldGetBlockFn) {
    this.scene = scene;
    this.getBlockFn = worldGetBlockFn || NO_BLOCK;
    this.shellGeometry = new THREE.BoxGeometry(0.02, 0.05, 0.02);
    this.shells = new Array(BRASS_POOL_SIZE);

    for (let i = 0; i < BRASS_POOL_SIZE; i++) {
      // Materials remain per-shell so ownership and disposal match Effects.
      const material = new THREE.MeshStandardMaterial({
        color: 0xd4a942,
        roughness: 0.35,
        metalness: 0.8,
      });
      const mesh = new THREE.Mesh(this.shellGeometry, material);
      mesh.visible = false;
      scene.add(mesh);
      this.shells[i] = {
        mesh,
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        t: 0,
      };
    }

    this._disposed = false;
  }

  /** Copy a world-space ejection position and velocity into the claimed slot. */
  spawn(posWorld, ejectVelWorld) {
    let shell = null;
    for (let i = 0; i < this.shells.length; i++) {
      if (!this.shells[i].mesh.visible) {
        shell = this.shells[i];
        break;
      }
    }
    if (!shell) {
      shell = this.shells[0];
      for (let i = 1; i < this.shells.length; i++) {
        if (this.shells[i].t >= shell.t) shell = this.shells[i];
      }
    }

    shell.mesh.visible = true;
    if (Array.isArray(posWorld)) {
      shell.mesh.position.set(posWorld[0], posWorld[1], posWorld[2]);
    } else if (posWorld) {
      shell.mesh.position.copy(posWorld);
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
  }

  update(dt) {
    for (let i = 0; i < this.shells.length; i++) {
      const shell = this.shells[i];
      if (!shell.mesh.visible) continue;
      shell.t += dt;
      shell.vel.y -= 18 * dt;
      shell.mesh.position.addScaledVector(shell.vel, dt);
      shell.mesh.rotation.x += shell.spin.x * dt;
      shell.mesh.rotation.y += shell.spin.y * dt;
      shell.mesh.rotation.z += shell.spin.z * dt;

      const gy = Math.floor(shell.mesh.position.y);
      const gx = Math.floor(shell.mesh.position.x);
      const gz = Math.floor(shell.mesh.position.z);
      if (this.getBlockFn(gx, gy, gz) !== 0) {
        shell.mesh.position.y = gy + 1.03;
        shell.vel.set(0, 0, 0);
        shell.spin.set(0, 0, 0);
        if (shell.t > 2.5) shell.mesh.visible = false;
      }
      if (shell.t > 3.5) shell.mesh.visible = false;
    }
  }

  reset() {
    for (let i = 0; i < this.shells.length; i++) {
      const shell = this.shells[i];
      shell.mesh.visible = false;
      shell.vel.set(0, 0, 0);
      shell.spin.set(0, 0, 0);
      shell.t = 0;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (let i = 0; i < this.shells.length; i++) {
      const mesh = this.shells[i].mesh;
      this.scene.remove(mesh);
      mesh.material.dispose();
    }
    this.shellGeometry.dispose();
  }
}

import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { AvatarDebugView } from '../public/js/avatar/debug-view.js';
import { displaySettings, setDisplaySetting } from '../public/js/ui/display-settings.js';
import { playerHitboxes } from '../shared/player-hitboxes.js';
const scene = new THREE.Scene();
const debug = new AvatarDebugView(scene);
const material = new THREE.MeshBasicMaterial();
const group = new THREE.Group();
group.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
const avatars = new Map([['other', { group }]]);
const remotes = new Map([['other', { id: 'other', x: 2, y: 3, z: 4, state: 'alive' }]]);
debug.sync(remotes, avatars, 'self');
assert.equal(debug.boxes.size, 0);
setDisplaySetting('showHitboxes', true);
setDisplaySetting('showWireframes', true);
debug.sync(remotes, avatars, 'self');
assert.equal(material.wireframe, true);
const bounds = debug.boxes.get('other');
function assertZones() {
  const zones = playerHitboxes(remotes.get('other'));
  assert.equal(bounds.children.length, zones.length);
  zones.forEach((zone, i) => {
    const wire = bounds.children[i];
    assert.deepEqual(wire.position.toArray(), zone.center);
    assert.deepEqual(wire.scale.toArray(), zone.half.map(v => v * 2));
    const expected = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(...zone.basis.map(v => new THREE.Vector3(...v))));
    assert.ok(wire.quaternion.angleTo(expected) < 1e-7);
  });
}
assertZones();
Object.assign(remotes.get('other'), { crouch: true, yaw: 0.8, pitch: 0.4, moveSpeed: 4 });
debug.sync(remotes, avatars, 'self');
assertZones();
assert.equal(bounds.children[1].material.depthTest, true);
remotes.get('other').state = 'dead';
debug.sync(remotes, avatars, 'self');
assert.equal(debug.boxes.size, 0);
setDisplaySetting('showWireframes', false);
debug.sync(remotes, avatars, 'self');
assert.equal(material.wireframe, false);
setDisplaySetting('notASetting', true);
assert.equal(displaySettings().notASetting, undefined);
debug.dispose();
group.children[0].geometry.dispose();
material.dispose();
console.log('ok - debug bounds, oriented stance zones, occlusion, death cleanup and wireframe restoration');

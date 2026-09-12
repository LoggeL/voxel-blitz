// Runs in a real WebGL page; also reusable by the in-app browser's CDP surface.
export async function runKillcamBrowserFixture({ preview = false } = {}) {
  const THREE = await import('/js/vendor/three.module.js');
  const { WorldView } = await import('/js/engine/worldview.js');
  const { Killcam } = await import('/js/player/killcam.js');
  const { KillcamTerrain } = await import('/js/player/killcam-terrain.js');
  const { serializeBlocks } = await import('/shared/world/serialize.js');
  const { DEFAULT_DIMENSIONS } = await import('/shared/world/dimensions.js');
  const { STONE, PLANK } = await import('/shared/world/blocks.js');
  const { sx, sy, sz } = DEFAULT_DIMENSIONS;
  const index = (x, y, z) => (y * sz + z) * sx + x;
  const raw = new Uint8Array(sx * sy * sz);
  for (let z = 8; z < 30; z++) for (let x = 8; x < 24; x++) raw[index(x, 0, z)] = STONE;
  const wall = [];
  for (let y = 1; y <= 3; y++) for (let x = 14; x <= 16; x++) {
    raw[index(x, y, 15)] = PLANK;
    wall.push({ i: index(x, y, 15), x, y, z: 15, v: 0 });
  }
  const bytes = serializeBlocks(raw);
  const live = new KillcamTerrain(bytes);
  const view = new WorldView(live, { id: 'foundry' });
  await view.ready();
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(innerWidth, innerHeight);
  document.body.replaceChildren(renderer.domElement);
  const style = document.createElement('link');
  style.rel = 'stylesheet'; style.href = '/style.css'; document.head.append(style);
  await new Promise((resolve, reject) => { style.onload = resolve; style.onerror = reject; });
  let time = 0;
  const sounds = [];
  const audio = Object.fromEntries(['setListener', 'fire', 'hitmark', 'killConfirm', 'explosion', 'mine', 'impact']
    .map(kind => [kind, (...args) => sounds.push({ kind, args })]));
  const killcam = new Killcam({ scene: view.scene, getBlock: live.getBlock.bind(live),
    worldview: view, mapBytes: bytes, audio, now: () => time });
  const killer = { id: 'killer', name: 'REPLAY TEST', x: 15.5, y: 1, z: 22,
    yaw: 0, pitch: 0, state: 'alive', hp: 100, weapon: 0, grounded: true, moveSpeed: 0 };
  const victim = { ...killer, id: 'victim', name: 'TARGET', z: 12, yaw: Math.PI };
  const death = { kind: 'kill', killer: 'killer', victim: 'victim', w: 'rifle', hs: true };
  const impact = { kind: 'hit', attacker: 'killer', victim: 'victim', vx: 15.5, vy: 2.5, vz: 12,
    dmg: 20, w: 'rifle', dir: [0, 0, -1] };
  for (let serverNow = 0; serverNow <= 3000; serverNow += 50) {
    const blockDamage = serverNow === 1000 ? [{ x: 15, y: 2, z: 15, v: PLANK, progress: .6 }] : [];
    const blocks = serverNow === 1500 ? wall : [];
    const events = serverNow === 1000 ? [{ kind: 'blockDamage', ...blockDamage[0], previousProgress: 0 }]
      : serverNow === 1500 ? wall.map(row => ({ kind: 'block', ...row, from: PLANK }))
      : serverNow === 1750 ? [{ ...impact }]
      : serverNow === 2300 ? [{ ...impact, hs: true }]
      : serverNow === 3000 ? [{ ...impact, hs: true, lethal: true }, death] : [];
    const snapshot = { serverNow, blocks, blockDamage, events,
      players: [killer, { ...victim, state: serverNow === 3000 ? 'dead' : 'alive', hp: serverNow === 3000 ? 0 : 100 }] };
    live.record(snapshot);
    killcam.history.record(snapshot);
    view.applyDeltas([...blocks, ...blockDamage]);
  }
  view.chunkStore.update(Infinity);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const geometrySignature = () => [...view.chunkStore.chunks.values()]
    .flatMap(chunk => chunk.meshes.map(mesh => mesh.geometry.attributes.position.count)).join(',');
  const render = elapsed => {
    time = killcam.started + elapsed;
    killcam.update(.016, innerWidth / innerHeight, 75);
    renderer.render(view.scene, killcam.camera);
    renderer.getContext().finish();
    const marker = killcam.hitmarker;
    // Finish CSS transitions so computed visibility is checked after the pop.
    for (const animation of marker.getAnimations()) animation.finish();
    return { active: killcam.active, wall: view.chunkStore.getBlock(15, 2, 15),
      damage: view.chunkStore.getBlockDamage(15, 2, 15), geometry: geometrySignature(),
      mark: marker.dataset.kind, visible: getComputedStyle(marker).visibility,
      opacity: getComputedStyle(marker).opacity };
  };
  check(killcam.start(death, 'fun'), 'Replay starts');
  const before = render(500);
  check(before.wall === PLANK && before.damage === 0, 'Wall rewinds before destruction');
  check(live.getBlock(15, 2, 15) === 0, 'Live wall remains destroyed');

  // Mutate another chunk-border block while replay is active. Its terrain and
  // later damage must stay live-only, then appear immediately when skipping.
  const future = { i: index(16, 2, 15), x: 16, y: 2, z: 15, v: STONE };
  const futureTick = { serverNow: 3100, blocks: [future], blockDamage: [{ ...future, progress: .4 }],
    players: [killer, { ...victim, state: 'dead', hp: 0 }] };
  live.record(futureTick); killcam.history.record(futureTick);
  view.applyDeltas([future]);
  const damaged = render(1000);
  check(damaged.wall === PLANK && damaged.damage === .6, 'Recorded erosion appears at its frame');
  check(damaged.geometry !== before.geometry, 'Erosion rebuilds visible geometry');
  const particlesAfterChip = killcam.impacts.particlesSpawned;
  const broken = render(1500);
  check(broken.wall === 0 && broken.geometry !== damaged.geometry, 'Recorded destruction removes wall geometry');
  check(killcam.getBlock(16, 2, 15) === 0, 'Live replacement cannot leak into replay collision');
  check(killcam.impacts.particlesSpawned > particlesAfterChip, 'Destruction emits recorded debris');
  check(render(1749).mark === '', 'Hitmarker never appears early');
  const body = render(1750); check(body.mark === 'body' && body.visible === 'visible' && body.opacity === '1',
    'Body hit is visible over hidden live HUD');
  check(render(1960).mark === '', 'Body marker expires');
  const head = render(2300); check(head.mark === 'head' && head.opacity === '1', 'Head hit uses head marker');
  const lethal = render(3000); check(lethal.mark === 'killHead' && lethal.opacity === '1', 'Lethal headshot uses kill confirmation');
  const confirmations = sounds.filter(sound => ['hitmark', 'killConfirm'].includes(sound.kind));
  render(3100);
  check(sounds.filter(sound => ['hitmark', 'killConfirm'].includes(sound.kind)).length === confirmations.length,
    'Held final frame cannot replay confirmation sounds');
  check(confirmations.filter(sound => sound.kind === 'hitmark').length === 3, 'Exactly three recorded hit sounds');
  check(confirmations.filter(sound => sound.kind === 'killConfirm').length === 1, 'Exactly one recorded kill sound');
  killcam.root.querySelector('button').click();
  check(!killcam.active && view.replayTerrain === null, 'Skip exits historical rendering');
  check(view.chunkStore.getBlock(16, 2, 15) === STONE && view.chunkStore.getBlockDamage(16, 2, 15) === .4,
    'Skip restores live terrain and damage including updates during replay');
  check(view.chunkStore.stats.queued === 0 && view.replayTouched.size === 0, 'Restoration is complete before render');
  const restoredGeometry = geometrySignature();
  view.chunkStore.buildAll();
  check(geometrySignature() === restoredGeometry, 'Restored geometry matches a fresh live terrain build');
  check(killcam.hitmarker.dataset.kind === '', 'Skip clears marker');

  // A new clip survives an ordinary timeout; disposal removes every replay resource.
  check(killcam.start(death, 'fun'), 'Second replay starts');
  time = killcam.started + (killcam.clip.end - killcam.clip.start) + 300;
  killcam.update(.016, 1, 75);
  check(!killcam.active && view.replayTerrain === null, 'Completion restores live world');
  const glError = renderer.getContext().getError();
  check(glError === 0, 'WebGL remains healthy');
  const previewFrames = preview ? killcam.history.frames.slice() : null;
  killcam.dispose();
  check(!view.scene.children.includes(killcam.group) && !document.querySelector('.vb-killcam'), 'Replay resources disposed');
  const results = { before, damaged, broken, body, head, lethal, confirmations: confirmations.length,
    particlesAfterChip, skip: true, completion: true, glError };
  if (preview) {
    const previewCam = new Killcam({ scene: view.scene, getBlock: live.getBlock.bind(live),
      worldview: view, now: () => time });
    // Reuse the tested frozen recording; preview controls only seek its clock.
    previewCam.history.frames = previewFrames;
    previewCam.history.terrain = live;
    const controls = document.createElement('nav');
    controls.setAttribute('aria-label', 'Killcam test stages');
    controls.style.cssText = 'position:fixed;right:24px;top:84px;z-index:100;display:flex;gap:8px';
    for (const [label, at] of [['Intakt', 500], ['Beschädigt', 1000], ['Zerstört', 1500], ['Körper', 1750], ['Kopf', 2300], ['Kill', 3000]]) {
      const button = document.createElement('button'); button.textContent = label;
      button.onclick = () => {
        previewCam.start(death, 'fun'); time = previewCam.started + at - previewCam.clip.start;
        previewCam.update(.016, innerWidth / innerHeight, 75);
        renderer.render(view.scene, previewCam.camera);
      };
      controls.append(button);
    }
    document.body.append(controls);
    controls.querySelector('button').click();
    return results;
  }
  view.dispose(); renderer.dispose();
  return results;
}

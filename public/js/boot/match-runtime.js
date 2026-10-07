// Everything a live match needs beyond the menu: three.js, the chunk mesher and
// world view, the weapon and avatar factories (which wait for the Blender
// library), combat effects, the killcam and the spectator camera. main.js
// imports this module dynamically through the asset scheduler so none of it
// sits on the menu's critical path.
export * as THREE from '../vendor/three.module.js';
export { MuzzleLights } from '../engine/muzzle-lights.js';
export { CombatPostProcess, recommendedPostProcessPixelRatio, POST_PROCESS_PROFILE } from '../engine/combat-post-process.js';
export { graphicsQuality, resolveGraphicsProfile, rendererCapabilities, isTouchDevice } from '../engine/graphics-quality.js';
export { ShaderErrorMonitor, warmShaders, VEHICLE_WARMUP_MATERIALS, WORLD_WARMUP_MATERIALS } from '../engine/shader-warmup.js';
export { WorldView } from '../engine/worldview.js';
export { ConquestAmbience } from '../engine/conquest-ambience.js';
export { ViewmodelRig } from '../guns/viewmodel.js';
export { WeaponState, shouldShowViewmodel } from '../guns/weapon-state.js';
export { Effects, attachMuzzleBridge, attachRemoteMuzzleBridge } from '../weapons/effects.js';
export { projectAimReticle } from '../ui/aim-reticle.js';
export { TttControls } from '../ui/ttt-controls.js';
export { LocalPlayer } from '../player/local-player.js';
export { FootstepCadence } from '../audio/footsteps.js';
export { Killcam } from '../player/killcam.js';
export { DEATH_HEAD, deathFadeOpacity } from '../player/death-head-cam.js';
export { DeathFade } from '../ui/death-fade.js';
export { SpectatorCamera } from '../player/spectator-camera.js';
export { AvatarRoster } from '../avatar/avatar-roster.js';
export { makeVehicleAvatar } from '../avatar/bastion-vehicle.js';
export { BuildController } from '../player/build-controller.js';
export { CombatFeedback, applySnapshotBlocks, isWorldPointVisible } from '../combat/feedback.js';
export { disposeFirstPersonBody, makeFirstPersonBody } from '../player/first-person-body.js';

export { VehicleView } from "../engine/vehicle-view.js";
export { VehicleAudio } from "../vehicles/vehicle-audio.js";
export { VehicleDestructionFX } from "../vehicles/vehicle-destruction-fx.js";
export { VehicleController } from "../session/vehicle-controller.js";
export { VehicleFx } from "../vehicles/vehicle-fx.js";
export { ParticleField } from "../fx/particle-field.js";
export { particleCapacityForTier } from "../fx/presets.js";
export { CameraShake } from "../engine/camera-shake.js";
export { ConquestHud } from "../ui/conquest-hud.js";
export { createObjectiveCues } from "../audio/objective-cues.js";

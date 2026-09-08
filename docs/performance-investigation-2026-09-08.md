# Player feedback and freeze investigation, 2026-09-08

Implemented enemy names in red, teammate names in blue, head-to-camera voxel occlusion for name and health labels, and server-measured RTT in every Tab scoreboard. Missing ping is displayed as an em dash. Visibility uses the current voxel store, so destroyed cover stops hiding labels. Dead-player labels are hidden.

## Profiling evidence

Attached the Chromium DevTools Protocol CPU profiler to a disposable browser and ran a local authoritative match with six bots, movement, and held rifle fire for approximately 20 seconds. Captured CPU profiles, animation-frame gaps, long tasks, GPU identification, network state, and browser errors. The machine has Brave rather than Google Chrome. Native runs used Brave's Chromium engine and ANGLE Metal on an Apple M5 Pro, at device scale 1 (1280 x 583 reported render buffer).

| Run | Frame gaps over 50 ms | Largest gap | 95th percentile |
| --- | ---: | ---: | ---: |
| Before fixed muzzle lights, including startup | 10 | 947 ms | 16.8 ms |
| First fixed-light run, including startup | 1 | 246 ms | 16.8 ms |
| Final fixed-light run, after live match readiness | 0 of 1206 | 16.8 ms | 16.7 ms |

The first two runs include startup; the final run explicitly separates it. Bot encounters, spawns, visible geometry, and driver shader caches vary, so these are observations, not a controlled percentage speedup. Final snapshot showed six bots, 325 draw calls, 1 ms local RTT, and a 4 ms snapshot age. No browser exceptions were captured.

An initial headless-shell run fell back to SwiftShader despite removing the forced software-rendering flag. Its timings are not hardware-GPU evidence. The profiling tool now prefers an installed browser, records the actual GPU, and marks software fallback in the output.

## Cause and fix

The native baseline spent about 2.13 seconds of sampled CPU time in `getProgramInfoLog`. Muzzle-flash groups contained point lights and were hidden between shots. Three.js therefore saw different point-light counts as players fired. Each count can require new lighting shader programs, synchronously stalling the render thread on first use.

Gun lights now act as non-rendered position/color/intensity sources. Two permanent scene lights provide local muzzle illumination and the closest active remote muzzle illumination. Their intensity changes without changing the shader's light count. Flash meshes and glow remain unchanged. This intentionally bounds simultaneous remote muzzle illumination to one light; projectile illumination retains its existing separate four-light budget.

A focused browser regression test warms the materials, then cycles all eight firing combinations for three flash sources. Fixed lights retain three compiled programs throughout. Restoring the old variable-light behavior grows that count to twelve. This is repeatable evidence for the shader-variant cause, independently of the gameplay timings.

This addresses a demonstrated source of freezing. It does not establish that it is the only cause on the reported Windows PC. Initial scene/atlas creation and first-use materials can still cause startup work. Long matches, higher resolutions, different maps, and the remote server were not benchmarked here.

## Reproduce

Run `npm run feedback:test` for the 35 browser checks covering scoreboard modes and ping refresh, team colors, blocked/open/dead labels, shader variants, and pool cleanup.

Run `npm run profile:gameplay` to launch a local server and installed Chromium browser. Set `PROFILE_BROWSER` to an explicit browser executable if needed, and `PROFILE_OUT` to change the output directory. On Windows PowerShell, for example:

```powershell
$env:PROFILE_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run profile:gameplay
```

The output includes `gameplay.cpuprofile` and `summary.json`. Load the CPU profile using Chrome DevTools' JavaScript Profiler (More tools). The retained local artifacts are in `.artifacts/gameplay-native/`, `.artifacts/gameplay-fixed/`, and `.artifacts/gameplay-final/`; they are not committed.

For the affected PC itself, record the actual failing match in Chrome DevTools > Performance for 20 to 30 seconds and save the trace. That captures its actual driver, rendering workload, and network conditions; this local profiler cannot attach to another person's PC without access. Check `chrome://gpu` if the trace indicates software rendering.

Validation also passed refactor, avatar pose, animation/throwable, projectile performance, flamethrower, and minigun suites. Changes are local and have not been committed, pushed, or deployed.

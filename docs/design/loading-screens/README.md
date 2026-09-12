# Loading and splash screens

The built-in `image_gen` tool produced `variant-a.png` and `variant-b.png` from the current menu screenshot. The exact prompts are in `prompts.txt`. Variant A was selected: large left-aligned wordmark, existing game art, amber loading rail and a compact bottom action.

The implementation uses the existing menu art for startup/admission and the authoritative map's existing preview for arena preparation. Generated images are design references only. Text and progress remain HTML, including keyboard-accessible cancel/reload actions and reduced-motion styling.

Screens:
- Startup: visible HTML before the module graph loads; account/career stages while their real requests run.
- Admission: indeterminate connection/map transfer status; cancellation returns to the menu and invalidates the attempt.
- Arena: server-provided map and mode, with completed mesh sectors out of the actual column count. The mesher yields between batches so rendering and cancellation can run. No simulated percentages or minimum splash duration.
- Startup failure: a reload action replaces the spinner when the main module fails. Arena boot failures release resources and show the same recovery screen.

Validation (2026-09-13):
- Complete `npm test` passed on the isolated publication snapshot, including the new loading contracts and weapon customization tests.
- Following the final map-image URL fix and stale lobby-status cleanup, loading/connection contracts passed again.
- Browser screenshots at 1280 x 720 and 390 x 844 were compared with variant A. Startup and connection captures used a local QA proxy with delayed responses. Arena captures are frames of the real training boot, with 17 of 48 sectors complete, not a progress fixture.
- Real training successfully reached live play after 48/48 sectors. Desktop Escape and the mobile Cancel button returned admission to the menu. A deliberately blocked main module showed the error screen; restoring the request and pressing Reload recovered startup.
- Temporary CPU throttling and request blocking were cleared after QA.

Screenshots: `boot-desktop.png`, `boot-mobile.png`, `connect-desktop.png`, `connect-mobile.png`, `arena-desktop.png`, `arena-mobile.png`, `error-mobile.png`.

# Career and menu design references

Created on 2026-09-12 with the built-in OpenAI imagegen tool. The two reference screens were generated first, then rebuilt with semantic HTML, CSS and live account/career data. They are design references, not flattened screens used as the interface.

- `main-menu-reference.png` and `main-menu.prompt.txt`: deployment actions on the left, cinematic voxel key art, a prominent account panel and a career preview.
- `career-shop-reference.png` and `career-shop.prompt.txt`: player rank and XP on the left, featured cosmetic art, filterable item grid and a level journey on the right.

Generated preview copy and numbers are illustrative. Actual labels, XP thresholds, prices, ownership and available actions come from the application and `shared/career.js`. Registration stays optional. The original Quick Play, lobby, invitation and training flows remain available.

Production artwork is in `public/assets/ui/armory/` with exact prompts and `sources.json`. The cosmetic atlas has four columns and two rows: Amber, Arctic, Orchid and Mint on top; Rookie, Pathfinder, Vanguard and Veteran below. Each cell is 384 by 512 pixels. The images illustrate HUD color themes and callsigns; they do not add weapon skins or change combat statistics.

The menu and each modal contain a synchronized music volume control. Real controls and readable text are separate from the generated artwork, and layouts adapt to narrow displays.

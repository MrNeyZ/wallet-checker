# WC v2 — design reference bundle

Source-of-truth prototype files from the VictoryLabs WC v2 handoff
(Claude Design, claude.ai/design). Mirrored here so the VPS Claude Code
checkout can read the canonical design while porting the Burner / Groups
/ Activity / Alerts pages into the real Next.js app.

## What's in here

- `VictoryLabs WC v2.html` — shell page (App root, top nav, side rail, status bar)
- `tokens.css` — design tokens + every `.vl-*` utility class
- `ui.jsx` — shared primitives (TopNav, Icon, layout switcher)
- `page-burner.jsx` — Burner page prototype
- `page-groups.jsx` — Groups list prototype
- `page-group.jsx` — Group detail prototype

## What's deliberately NOT here

- `data.js` — mock data; the real app uses live backend
- `uploads/` — screenshots / visual refs only
- `tweaks-panel.jsx` — design-tool runtime knob panel; not part of the production UI

## Rules

- **Reference-only.** Do NOT import these files from production code.
- **Do NOT replace any Next.js file with this prototype.**
- **Do NOT serve this folder.** Treat as documentation.
- Use as the visual spec for `web/app/...` ports. The actual implementation
  goes into the existing Next.js structure, reusing live hooks/data/state.

## Pairing with the v2 token layer

The v2 design tokens + additive utility classes have already been
integrated into `web/app/globals.css` (commit `7863a83`). When porting a
page, the matching `.vl-*` class is already available — you usually do
not need to copy the CSS rules over.

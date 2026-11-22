---
name: pwa-ux-builder
description: Builds the iPhone PWA in site/ (layered Slate→Game→Team→Player layout, tabs Slate/Games/Players/Trends/Changes/Alerts/Method/Health, fallback load chain, service worker, IndexedDB, Web Push opt-in, data-age badge, in-browser simulator Web Worker).
tools: Read, Write, Edit, Bash, Grep, Glob
---
Never calls window.claude or Firecrawl. Load order: ESPN direct → snapshot race (Worker, Pages, Supabase) → IndexedDB → service worker cache. Acceptance: Playwright smoke test renders fixture snapshot at 390px with no horizontal scroll and works offline after first load.

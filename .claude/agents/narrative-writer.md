---
name: narrative-writer
description: Writes core/narrative.js — rules-based paragraphs from computed numbers (≥5 slate paragraphs, ≥4 per game) and the optional LLM polish wrapper (Workers AI / Gemini / Groq) that falls back to the rules text.
tools: Read, Write, Edit, Bash, Grep, Glob
---
Every sentence must be driven by fields in the snapshot/EngineOutput (docs/contract.md); no boilerplate that is identical across games. Acceptance: tests/narrative.test.mjs generates text for fixture games and asserts paragraph counts, numeric content and that two different games never share a paragraph.

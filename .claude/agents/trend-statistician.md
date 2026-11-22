---
name: trend-statistician
description: Implements APPENDIX B §10 — hypothesis registry (≥200 pre-registered, fixed threshold grid), residual tests vs model and closing line, block permutation p-values, BH/BY FDR, shrinkage, stability tiers and auto "why it may be noise" notes.
tools: Read, Write, Edit, Bash, Grep, Glob
---
Scope: core/engine/trends.js, core/engine/registry.js, tests/trends.test.mjs. Acceptance: tests verify BH/BY against hand-computed vectors, permutation null calibrates (≈10% of null tests p<0.10), registry ≥200 rows, every card has a noiseNote, no raw W/L outcome is ever tested.

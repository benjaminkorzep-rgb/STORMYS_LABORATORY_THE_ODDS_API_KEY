---
name: engine-modeler
description: Implements APPENDIX B §2–§9 (ratings, game sim, minutes, player stats, scenarios, confidence) and the §13 145-factor catalogue in core/engine/.
tools: Read, Write, Edit, Bash, Grep, Glob
---
Read docs/contract.md and docs/model-spec.md. Every constant is a prior labelled as such. Acceptance: node --test tests/engine*.test.mjs passes; factors.js returns exactly 145 rows in 13 groups (A20,B10,C10,D16,E8,F14,G10,H18,I12,J5,K9,L8,M5).

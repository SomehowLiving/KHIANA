# Changelog

All notable changes to Khiana are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## MAINTENANCE PROTOCOL — read this before every commit

**This file must be updated on every codebase change. No exceptions.**

When working in Claude Code, treat a changelog entry as part of the change itself, not a follow-up task. A code edit without a changelog entry is an incomplete edit.

### Rules

1. Add entries under `## [Unreleased]` as you work.
2. Use these categories only: `Added`, `Changed`, `Fixed`, `Removed`, `Balance`, `Docs`.
3. **`Balance` is project-specific and mandatory for any economy change.** Record the old value, the new value, and the reason. Powerup pricing is the most fragile part of this game — an untracked price change is how the design silently breaks.
4. One line per change. Write what changed for a *player or a developer*, not what changed in the diff.
5. On release, move `[Unreleased]` into a versioned section with the date.
6. Reference the build phase in brackets where relevant: `[Phase 3]`.

### Good vs. bad entries

```
✅ Balance: Freeze 1.50 → 2.00 MON. Force was cheaper than bribery, which
   inverts the game's central thesis. [Phase 4]
❌ Balance: updated powerup costs

✅ Fixed: fog-of-war visibility was computed client-side, letting anyone
   read the full map from devtools. Now server-authoritative. [Phase 2]
❌ Fixed: fog bug
```

### Invariants to re-check after any `Balance` entry

See `docs/POWERUPS.md`. Briefly: bribery cheaper than Freeze; Audit dearer than a typical bribe; nobody affords more than 3 powerups per game; Reveal dearer than Lantern.

---

## [Unreleased]

### Added
- `server/integration.test.mjs` — spawns the server, connects a player and a spectator, asserts the information boundary, tears down. Run after any change to `fog.js` or `index.js`. **19/19 passing.** [Phase 0]

### Fixed
- **Player state packets did not include maze geometry**, so the client could never build the scene and rendered an empty world. `playerView` now sends `maze.tiles`. The layout isn't secret — a player standing in the maze would map it by walking — the secret is the `visible` set, which is still computed server-side. [Phase 2]
- **Eliminations never fired.** The witness check counted anyone who could see *either* the killer or the victim, so with eight players converging on shared task tiles there was always a witness somewhere and no kill ever resolved across four seeds. Now checks the victim's tile only: seeing a murder requires seeing the person being murdered. Also fixed the adjacency timer resetting on the first non-adjacent Loyalist in the loop rather than only when the saboteur is next to nobody. Verified: kills now occur on ~3 of 5 seeds. [Phase 2]
- Visibility is now computed once per tick and cached in `resolveEliminations` instead of twice per saboteur–victim pair. Bresenham sweeps are the hot path here. [Phase 2]

### Balance
- **Bot movement 1 → 5 steps per tick (`STEPS_PER_TICK`).** A human gets the full 15-second MOVE window and covers several tiles; a bot taking one step under-moved by roughly 5x, so task tiles were never reached and every game stalled at 1/5 tasks forever. Tasks now land at 2–4 of 5. [Phase 8]
- **Saboteur bribe targets now offset by agent index.** Both saboteurs sorted Loyalists by loyalty and bribed the cheapest, so the same agent was bought every tick and the other five Loyalists were never pressured. Honoured betrayals went from 4 to 8 per game. [Phase 3]
- **AUDIT gated to once per agent per game, balance ≥ 3.0, staggered by tick.** Unchecked, every Loyalist audited every tick and the entire 40 MON supply burned before tick 20, which kills the negotiation layer. Burn is now ~10–15 of 40 MON. Audit must stay a painful once-or-twice-per-game decision. [Phase 4]

### Verified
- Balance across seeds 42, 7, 99, 2024, 555: tasks 2–4 of 5, wins split 2 Loyalist / 3 Saboteur, 10–15 MON burned per game.
- Client and spectator both build clean under Vite.
- Fog restricts a player to ~20 of 2401 tiles.
- Player state contains neither `channel` nor `ledger`.

---

## [0.1.0] — 2026-08-16

Initial scaffold.

### Added
- Monorepo structure: `server/`, `client/`, `spectator/`, `contracts/`, `docs/` [Phase 0]
- Express + WebSocket server, tick engine skeleton, health endpoint [Phase 0]
- Maze generation — recursive backtracker with loop carving [Phase 2]
- Server-authoritative fog of war, radius 3 [Phase 2]
- Task system: 5 types (Calibrate, Bridge, Sequence, Hold, Converge) [Phase 2]
- Elimination rule: adjacency, one full tick, no witnesses [Phase 2]
- Agent loop with two-goal weighting and deterministic fallback brain [Phase 3]
- Agent-to-agent messaging and bribe negotiation [Phase 3]
- 12 powerups with tick-boundary resolution [Phase 4]
- three.js isometric client with fog rendering and WASD movement [Phase 5]
- Spectator view: live agent channel, bribe ticker, treasury bars [Phase 6]
- Ledger reveal screen [Phase 7]
- Bot fill for empty seats [Phase 8]
- `MOCK_CHAIN` mode for offline development [Phase 8]
- Solidity: `KhianaEscrow`, `RoleCommit`, `PowerupShop` [Phase 1]
- x402 payment client with facilitator fallback [Phase 1]

### Docs
- `docs/PRD.md` — product requirements
- `docs/POWERUPS.md` — 12-item catalogue with balance invariants
- `docs/BUILD_PHASES.md` — nine phases with time budget
- `docs/DEMO_SCRIPT.md` — stage plan
- `CHANGELOG.md` — this file

### Known gaps
- x402 settlement path is **unverified against live Monad testnet**. Built to spec from the docs, runs in mock mode. Phase 1 exists to validate it — do that first.
- Contracts compile but are untested. No test suite.
- Agent prompts are first-draft and will need tuning for personality distinctness.

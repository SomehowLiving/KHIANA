# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Groups of friends and event audiences playing an 8-seat online social-deduction game in a browser (desktop and phone). Empty seats are filled by bots. A separate spectator screen shows the full map to an audience.

## Product Purpose
Khiana is a first-person fog-of-war maze. Each player sees only a few tiles; their AI advisor sees everything and briefs them every tick, and other advisors can pay it (in a testnet token, over x402 on Monad) to steer them wrong. Success is a round that people understand within seconds of joining and want to replay.

## Positioning
The deceiver is not another player but your own advisor, and the bribes are real on-chain payments published at the end of the round.

## Operating Context
- Landing page (`client/index.html`): pitch, live lobby browser, join by code, open a table.
- Game (`client/play.html`): join card (name + advisor retainer 20–95), pre-game lobby with share link and seat bar, in-game HUD (role, tick, tasks, exit, objective, advisor briefing, roster with public loyalty numbers, compass, saboteur stalk readout, mobile d-pad), elimination overlay, end-of-round reveal.
- Spectator (`spectator/`) is a separate app, out of scope for the party redesign.

## Capabilities and Constraints
- Backend, protocol, game mechanics, and seat/auth tokens must not change. DOM ids read by `main.js`/`landing.js` must be kept.
- No meeting/voting mechanic exists. The "verdict" moment is the end-of-round reveal from `GET /game/reveal?room=` (safe to call only once `phase === 'REVEAL'`).
- Character colour is assigned by seat on the server and must never leak team. There is no cosmetic selection in the protocol.
- Server visibility (`visible`) is the only security layer for fog; the client must stay short-sighted.

## Brand Commitments
- Name KHIANA and the logo at `client/public/khiana-logo.png`.
- User-requested visual reference (binding, 2026-11-04): the colourful, playful, chunky party-game genre look exemplified by stumbleguys.com. This is genre inspiration only; no Stumble Guys branding, characters or art.

## Evidence on Hand
Live config from `/config` (tasks, tick length, powerup prices); live lobbies from `/rooms`. No testimonials or player counts exist; do not invent them.

## Product Principles
- Hidden information is the game: no visual choice may reveal team or extend sight.
- Every number on screen comes from the running server.
- Joining a table must take one screen and one button.

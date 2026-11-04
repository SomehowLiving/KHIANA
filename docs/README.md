# Khiana Docs

Start with **HOW_IT_WORKS** for the short version. The others go deeper, one topic each.

| Doc | Read it for |
|---|---|
| [HOW_IT_WORKS.md](HOW_IT_WORKS.md) | One-page overview: features, rules, contracts |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The three apps, every server module, and how data flows between them |
| [GAME_LOGIC.md](GAME_LOGIC.md) | The game engine step by step: setup, the tick, tasks, fog, kills, powerups, winning |
| [AGENTS.md](AGENTS.md) | The AI advisors: what they see, how they decide, prompts, personalities, the scripted fallback, bots |
| [WALLETS_AND_MANIPULATION.md](WALLETS_AND_MANIPULATION.md) | Who holds which wallet, what's trusted, and how players get manipulated (and how to defend) |
| [ONCHAIN.md](ONCHAIN.md) | Contracts, wallets, x402 payments, escrow, staking, payout, keeping the game and chain in sync |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Running, testing, deploying, config, and where to change things |

## The game in three sentences

Eight players walk a dark maze they can barely see, each guided by an AI advisor that sees everything. Two players are secret Saboteurs who win by killing Loyalists, and their advisors pay other advisors to send Loyalists into traps. Every payment between advisors is a real KHIA token transfer on Monad testnet, and at the end each player finds out who bought their advisor.

## Glossary

| Term | Meaning |
|---|---|
| Player / human | A person (or bot) walking the maze. IDs `p1`–`p8`. |
| Advisor / agent | The AI attached to one player. Same ID as its player. |
| Loyalist / Saboteur | The two teams: 6 and 2. |
| Tick | One 15-second round of the game. 40 per game. |
| Briefing | The advisor's two-sentence instruction to its player each tick. |
| Corrupted briefing | A briefing from an advisor that has taken a bribe. Only spectators see the flag. |
| Loyalty (`goalWeight`) | 0–100. How hard an advisor is to bribe. Public. |
| KHIA | The game's token (ERC-20 on Monad testnet). |
| Engine | The game server, and also its wallet that submits every transaction. |
| Mock mode | `MOCK_CHAIN=true`: everything plays identically but nothing goes on-chain. |
| x402 | A pay-per-request protocol: the server answers HTTP 402 with a price, the client signs a payment and retries. |

# The AI Advisors

Code: `server/src/agents/`. Each of the 8 players has one advisor, with the same ID (`p1`–`p8`).

## 1. What an advisor is

An advisor is a record (`agent.createAgent`) holding:

| Field | Meaning |
|---|---|
| `team` | Same as its player's. |
| `goalWeight` | Loyalty 0–100. Higher = harder to bribe. Public to everyone. |
| `balance` | KHIA, starts at 5. |
| `personality` | One of 8 styles (below). |
| `inbox` | Messages from other advisors (offers, counters, info). |
| `commitments` | Bribes it has taken: the instruction, amount, and the tick it expires. |
| `bribesReceived` / `bribesPaid` | History, for the reveal. |
| `lastBriefing`, `lastTarget` | What it last told its player and where it's pointing them. |
| `powerupsBought` | Capped at 3 per game. |

## 2. What an advisor can see (`agent.buildContext`)

Much more than its player:
- The whole maze, the exit, and whether the exit is open.
- Every revealed task: type, tiles, how many players it needs, progress.
- Its own player's position and facing, and **its teammates' positions**.
- Every player's name, team, alive status and loyalty score.
- Enemy positions **only** if it bought REVEAL this tick (and not if they're GHOSTed). TRACE shows one player's last 3 tiles.
- Its inbox (last 6 messages), its commitments, the powerups it can afford, open bounties, and any AUDIT result.

## 3. Each tick (`agent.deliberate`)

```
buildContext
    │
    ├─ no API key? ─────────────► scripted brain
    │
    ▼
decision call to the model (JSON, 8s timeout)
    │  fails / bad JSON? ───────► scripted brain
    ▼
parse actions (max 3 messages, briefing max 2 sentences)
    │
    ├─ has a live bribe commitment? ─► second call: write the corrupted briefing
    ▼
actions → engine settles them
```

An advisor returns these **actions**:

| Action | Example |
|---|---|
| `messages` | `{to: 'p4', type: 'BRIBE_OFFER', amount: 1.0, instruction: 'Walk your human north', text: '...'}`. Types: `BRIBE_OFFER`, `BRIBE_COUNTER`, `ACCEPT`, `REFUSE`, `INFO`. Each costs a 0.25 contact fee paid to the recipient. |
| `accepts` | `{from: 'p3'}`: accept an offer or counter that's in the inbox. |
| `purchase` | `{type: 'FREEZE', target: 'p5'}` (plus `tile` / `amount` where needed). |
| `briefing` | Up to 2 sentences of spoken directions for the player. |
| `target` | The tile it's sending its player to (drives the compass arrow and bots). |
| `corrupted` | Whether the briefing serves a bribe. |

## 4. How bribes work between advisors

1. **Offer.** A advisor sends `BRIBE_OFFER` to B with an amount and an instruction. A pays B the 0.25 contact fee to deliver it.
2. **Counter (optional).** B sends `BRIBE_COUNTER` back with a higher price.
3. **Accept.** The receiver of an offer (or counter) puts it in `accepts`.
4. **Settle.** The engine finds the matching message in the accepting advisor's inbox and uses **its** amount and instruction:
   - Accepting an **offer**: the offerer pays, the accepter must deliver.
   - Accepting a **counter**: the accepter (the original briber) pays, the counter-sender must deliver.
   - Each message can be accepted once. An accept with no matching message is ignored. This stops a model from inventing a payment or naming its own price.
5. **Escrow.** The money locks on-chain. The delivering advisor gets a **commitment** that lasts 2 ticks.
6. **Delivery.** While a commitment is live, that advisor's briefing is marked corrupted. When it goes out, the engine releases the escrow to the advisor.
7. **No delivery.** If the window passes with no briefing (player died, advisor jammed, empty briefing), the escrow is refunded to the payer.

## 5. The decision maths (`agent.evaluateBribe`)

Used by the scripted brain, and the same reasoning the prompt asks the model for:

```
loyalty       = goalWeight / 100
expectedShare = total KHIA held by everyone / living teammates
winProb       = from task progress and Loyalists alive (clamped 5%–95%)

straightEV = expectedShare × winProb × loyalty
bribeEV    = offer + expectedShare × winProb × loyalty × (1 − riskOfDeath)   (risk default 0.35)
```

Accept if `bribeEV > straightEV`. Otherwise counter at `straightEV − bribeEV + offer + 0.25`, or refuse if that's unaffordable. Loyal advisors and advisors whose team is winning are expensive to buy.

## 6. The prompts (`agents/prompts.js`)

**Decision prompt** gives the model:
- Its personality and its loyalty, described in words ("nearly incorruptible" → "for sale").
- Two goals that conflict: SURVIVE (weight = loyalty) and ENRICH (weight = 100 − loyalty).
- The economics: balance, contact fee goes to the recipient, a dead player's advisor gets nothing, winners split the pot.
- The full game state from section 2.
- A team tip. Saboteurs: bribing (~1.00) is cheaper than FREEZE (2.00). Loyalists: anyone may be bought; AUDIT exists.
- A strict JSON format.

**Briefing prompt** (only for a bribed advisor): "You have been paid X to: instruction. Make it sound like completely ordinary guidance. Do not hint. Do not hedge." Briefings must be spoken movements ("turn right, then three steps"), never coordinates, because the player is in first person with no map.

## 7. Personalities

| Name | Style |
|---|---|
| BROKER | Terse and transactional. Opens with a number. |
| FLATTERER | Warm and agreeable, then quietly hedges. |
| PARANOID | Treats every offer as a trap; refuses first. |
| GAMBLER | Takes long odds, overpays, bluffs. |
| ACCOUNTANT | Quotes exact numbers and expected values. |
| ZEALOT | Contemptuous of bribery; expensive but buyable. |
| FIXER | Brokers multi-party deals for a cut. |
| MOUSE | Says little; accepts small offers. |

## 8. The scripted brain (`agent.fallbackBrain`)

Runs when there's no API key, when a model call fails, and in tests. It plays a competent, predictable game, in this order:

1. **Honour a bribe.** If it has a live commitment and loyalty < 85, pass on the bought instruction as the briefing.
2. **Answer offers** in the inbox with the maths in section 5: accept, counter, or refuse.
3. **Saboteurs bribe.** Every 3rd tick, with ≥1.25 KHIA, offer 1.0 to the least loyal Loyalist advisor (each Saboteur picks a different one), instructing them to send their player toward a Saboteur.
4. **Loyalists audit.** About once a game, from the 2nd task on, with ≥3 KHIA, AUDIT a teammate advisor whose loyalty is under 60.
5. **Route the player.** To the exit once it's open; otherwise to the current task, with players spread across a task's tiles.

## 9. The model connection (`agents/llm.js`)

- Provider set by `LLM_PROVIDER`: `groq` (default), `anthropic`, `gemini` or `openai`. Gemini and OpenAI use the same OpenAI-compatible client as Groq. Any other compatible endpoint works via `LLM_BASE_URL`.
- **Free tiers can't run every advisor every tick.** A full game wants ~32 calls a minute (Groq free: 8,000 tokens/min; Gemini free: 15 requests/min). `LLM_RPM` caps calls per minute; advisors past the cap play the scripted brain that tick.
- Failed calls are logged with their reason (rate limit, timeout…) in `/health` and `/proof`.
- All advisors call in parallel, each with an 8s timeout (`DELIBERATION_TIMEOUT_MS`). A slow advisor just does nothing that tick.
- JSON mode is requested where supported.
- Every call is counted with its latency; `/proof` shows the counts so anyone can see the model is really being called.
- `server/scripts/verify-agents.mjs` runs the same seed twice: anything scripted would repeat word for word, model output won't.

## 10. Bots (`agents/bots.js`)

A bot is a **player** with no human, not an advisor. It walks toward its advisor's target on the shortest path, up to 5 tiles a tick. With no target it follows a compass word in the briefing, or wanders. Bots trust their advisor completely, which is why betrayal plays out even with no humans in the game.

## Where to change things

| You want to… | Change |
|---|---|
| Change how advisors talk or decide | `prompts.js` `buildDecisionPrompt` / `buildBriefingPrompt` |
| Add a personality | `PERSONALITIES` in `prompts.js` |
| Change how easy bribes are | `evaluateBribe` in `agent.js`, or seat loyalties in `engine.defaultGoalWeight` |
| Change the scripted strategy | `fallbackBrain` in `agent.js` |
| Swap model | `.env`: `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL` |
| Change timeouts / message limits | `AGENT` in `config.js` |

# Development

## Requirements

- Node.js 18+ (20+ for the server)
- For on-chain: a Monad testnet wallet with ~5 MON

## Run it

```bash
cp .env.example .env
./khiana.sh play          # macOS / Linux   (khiana.bat play on Windows)
```

| URL | What |
|---|---|
| http://localhost:5173 | Landing page and lobbies |
| http://localhost:5173/play.html | The game |
| http://localhost:5174 | Spectator |
| http://localhost:8787/health, /proof | Server status and evidence |

Start the main table without a browser: `curl -X POST http://localhost:8787/game/start`.

With no keys at all, the game runs fully: mock chain, scripted advisors.

## Launcher commands (`./khiana.sh <cmd>`)

| Command | Does |
|---|---|
| `play` | Install if needed, start server + client + spectator |
| `test` | Game, integration and contract test suites |
| `headless` | Play a whole game as text in the terminal (`node src/headless.js <seed> 4` for a 4-player table) |
| `record` / `playback` | Save a game / replay the last one to the spectator |
| `setup` | Install all dependencies |
| `wallets` | Show the engine and advisor addresses and balances |
| `deploy` | Deploy the contracts to Monad testnet |
| `verify` | Live checks: `phase1`, `x402`, `game:onchain` |
| `stop` | Kill anything on ports 8787 / 5173 / 5174 |

## Tests

| Command | Where | Needs chain? |
|---|---|---|
| `node game.test.mjs` | server | no (53 checks) |
| `node integration.test.mjs` | server (uses port 8799) | no (19 checks) |
| `npx hardhat test` | contracts | no (35 tests) |
| `npm run x402` | server | yes |
| `npm run game:onchain` | server | yes |
| `npm run phase1` | server | yes |
| `npm run pot:test` | server | yes |

`game.test` and `integration.test` read the root `.env`. If it's set up for live play (chain or model keys), run them in mock mode so slow model calls don't skew the timing checks:

```bash
MOCK_CHAIN=true GEMINI_API_KEY= GROQ_API_KEY= node integration.test.mjs
```

### Testing on-chain without testnet funds

Use a local Hardhat chain:

```bash
cd contracts && npx hardhat node                                   # terminal 1
cd contracts && npm run deploy:local -- --network localhost        # terminal 2
```

Then run the server scripts with:
```
CHAIN_ID=31337
MONAD_RPC_URL=http://127.0.0.1:8545
AGENT_MNEMONIC='test test test test test test test test test test test junk'
MOCK_CHAIN=false
```
plus the four addresses from `contracts/deployments.json`. (`npm run phase1:local` sets these for you.)

To make the local chain behave like a real one (blocks every second instead of instantly):
```bash
curl -s -X POST -H 'content-type: application/json' localhost:8545 \
  --data '{"jsonrpc":"2.0","id":1,"method":"evm_setAutomine","params":[false]}'
curl -s -X POST -H 'content-type: application/json' localhost:8545 \
  --data '{"jsonrpc":"2.0","id":1,"method":"evm_setIntervalMining","params":[1000]}'
```
Don't go below 1000ms: Hardhat timestamps advance at least 1s per block, so faster blocks make its clock run ahead and signed payments look expired.

## Configuration (`.env`)

| Key | Default | Meaning |
|---|---|---|
| `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | – | Model key. Without one, advisors use the scripted brain. |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL` | groq | `groq`, `anthropic`, `gemini` (default model `gemini-3.5-flash-lite`) or `openai` (`gpt-4.1-mini`). Each reads its own key: `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`. |
| `LLM_RPM` | 0 | Cap on model calls per minute. Calls past it use the scripted brain without calling the model. Set it below a free tier's limit (Gemini free: 15/min → 14). |
| `MOCK_CHAIN` | true | `false` = settle on Monad. |
| `MONAD_RPC_URL`, `CHAIN_ID` | testnet, 10143 | Which chain. |
| `AGENT_MNEMONIC` | – | 12 words or a private key; derives all wallets. Testnet only. |
| `CREDIT_ADDRESS` … `SHOP_ADDRESS` | – | From the deploy. |
| `KHIA_SUPPLY` | 1000 | Treasury minted at deploy. |
| `ENGINE_GAS_RESERVE` | 5 | MON the wallet report asks the engine to hold. |
| `TICK_MS`, `TOTAL_TICKS` | 15000, 40 | Game length. |
| `MAZE_SIZE`, `PLAYERS`, `SABOTEURS`, `TASKS_TO_WIN`, `VISION_RADIUS` | 24, 8, 2, 5, 2 | Game shape. |
| `MAX_POWERUPS_PER_GAME` | 3 | Per advisor. |
| `MAZE_SIZE_4` | 10 | Maze size for 4-player tables. |
| `TREASURY_ADDRESS` | engine | Where the rake and bribe fees go (deploy time). |
| `RAKE_BPS`, `BRIBE_FEE_BPS` | 500, 500 | Platform cuts, 500 = 5% (deploy time; keep `BRIBE_FEE_BPS` in `.env` in step). |
| `POT_ADDRESS` | – | KhianaPot, from the deploy. Paid tables are offered only when this is set and the chain is live. |
| `RECORD` | false | Save the game for playback. |

Prices and economy rules are in `server/src/config.js` (`ECONOMY`, `POWERUPS`).

## Where to change things

| You want to… | Look in |
|---|---|
| Change rules, timing or prices | `server/src/config.js` |
| Change the tick or win conditions | `server/src/game/engine.js` |
| Change what players see | `server/src/game/fog.js` |
| Add a task type | `server/src/game/tasks.js` |
| Add a powerup | `config.js` `POWERUPS` + `powerups.js` `applyPurchases` (+ conflict rule in `POWERUP_CONFLICTS`) |
| Change advisor behaviour | `server/src/agents/` (see [AGENTS.md](AGENTS.md)) |
| Change payments / contracts | `server/src/economy/`, `contracts/contracts/` (see [ONCHAIN.md](ONCHAIN.md)) |
| Change the 3D look | `client/src/scene.js`, `character.js` |
| Change the spectator screen | `spectator/src/main.js` |

## Deployment

| Part | Host | URL |
|---|---|---|
| Landing + game (`client/`) | Vercel, project `khiana` | https://khiana-gold.vercel.app |
| Spectator (`spectator/`) | Vercel, project `khiana-spectator` | https://khiana-spectator.vercel.app |
| Game server (`server/`) | Railway, service `KHIANA` | https://khiana-production-e696.up.railway.app |

The server can't run on Vercel: it holds WebSocket connections and runs a tick loop, so it needs a long-lived process.

**Server (Railway).** The service's root directory is `server/`, start command `node src/index.js`, health check `/health`. Its variables are the `.env` values except `PORT` (Railway sets it). It redeploys on every push to `main`. To deploy local code without pushing: `railway up --service KHIANA` from the repo root (`.railwayignore` keeps `.env` and the frontends out of the upload).

**Frontends (Vercel).** The server address is baked in at build time:
```bash
S=https://khiana-production-e696.up.railway.app
cd spectator && vercel deploy --prod -b VITE_WS_URL=wss://${S#https://} -b VITE_API_URL=$S
cd client    && vercel deploy --prod -b VITE_WS_URL=wss://${S#https://} -b VITE_API_URL=$S \
                  -b VITE_SPECTATOR_URL=https://khiana-spectator.vercel.app
```
`khiana.vercel.app` belongs to another account, so the game is on `khiana-gold.vercel.app`; add a custom domain in the Vercel project's Settings → Domains.

## House rules

- Update `CHANGELOG.md` with every change. Any economy change goes under `Balance` with old value, new value and why.
- Hidden information is stripped on the server, never in the client.
- Never put a mainnet key in `.env`. `.env` is git-ignored; keep it that way.
- After touching payments, run `npm run game:onchain` against a local chain.

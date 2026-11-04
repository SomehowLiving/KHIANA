# How Khiana Works

Khiana is a hidden-traitor maze game. Eight players walk a dark maze they can barely see. Each player has an AI advisor that sees the whole map and tells them where to go. The advisors pay each other in KHIA tokens to corrupt that advice, and every payment settles on Monad testnet.

---

## 1. Features

| Feature | What it does |
|---|---|
| First-person fog-of-war maze | 24×24 maze; you see about 2 tiles around you, plus straight down open corridors. |
| AI advisors | One per player. Sees the whole maze and every task, and sends a two-sentence briefing each tick. Runs on Groq (Llama 3.3 70B) or Anthropic, with a built-in scripted brain when no API key is set. |
| Hidden teams | 2 Saboteurs and 6 Loyalists. You only know your own team. Saboteurs also know each other. |
| Bribery between advisors | Advisors negotiate on a private channel players never see, and pay each other to give false directions. |
| 12 powerups | Vision, speed, invisibility, jamming, freezing, audits, bounties and more, all bought with KHIA. |
| Spectator screen | Shows the full maze, every team, and the advisor channel with each bribe as it happens. |
| End-of-game reveal | Each player sees who paid their advisor, how much, and whether the advisor followed through. |
| Lobbies | Room codes, a host who starts the game, and bots that fill empty seats. Each lobby is 8 players (2 Saboteurs) or 4 players (1 Saboteur). |
| Record and playback | A recorded game can be replayed on the spectator screen. |

---

## 2. Game mechanics

### Setup
- A game is built from a seed number, so the same seed always produces the same maze, teams and starting spots.
- The maze has about 12% of its inner walls removed, creating loops, so there are places to dodge and places to get cornered.
- Each advisor starts with **5 KHIA** and a public **loyalty score** (40–90). A higher score makes an advisor harder to bribe.
- The exit is placed as far as possible from every starting spot.

### Each tick (15 seconds)

| Phase | What happens |
|---|---|
| 1. Deliberate | All advisors decide at the same time: messages, bribe offers, accepting offers, a powerup purchase, and the briefing. |
| 2. Settle | Payments go on-chain: contact fees, bribes into escrow, powerup purchases. |
| 3. Brief | Each player receives their advisor's briefing plus a compass arrow. A bribed advisor's briefing is marked "corrupted", which only spectators can see. |
| 4. Move | Players move (WASD or arrow keys). Bots follow their advisor's arrow. Then the server checks tasks, kills, bounties and win conditions. |

Each tick finishes before the next one starts, so a slow on-chain tick runs long rather than overlapping the next.

### Tasks
Only advisors know what the tasks are. Players are only told where to go, which is why a corrupted advisor can send them anywhere.

| # | Task | What it needs | Revealed at tick |
|---|---|---|---|
| 1 | CALIBRATE | 1 player on 1 tile | 0 |
| 2 | BRIDGE | 2 players on 2 tiles in the same tick | 7 |
| 3 | SEQUENCE | 3 tiles stepped on in order | 14 |
| 4 | HOLD | 1 tile held for 2 ticks | 21 |
| 5 | CONVERGE | 4 players on 4 tiles at once | 28 |

### Kills
There is no attack button. A Loyalist dies when a Saboteur has been next to them for one full tick **and no other Loyalist can see the victim**. The real weapon is bad directions that lead someone into a dark dead end.

### Winning
- **Loyalists win** by finishing all 5 tasks and then getting 3 living Loyalists onto the exit together.
- **Saboteurs win** as soon as 2 or fewer Loyalists are alive.
- **At tick 40,** Loyalists win if they finished at least 3 tasks; otherwise Saboteurs win.
- **Payout:** all KHIA is pooled and split evenly between the surviving players on the winning team. Everyone else gets nothing, so an advisor whose player dies loses everything, whatever bribes it took.

### How an advisor decides on a bribe
The advisor compares two numbers:
- **Staying honest:** its expected share of the pot × the chance its team wins × its loyalty.
- **Taking the bribe:** the bribe amount + the same share, reduced by the risk that its player dies.

It takes whichever is bigger, or makes a counter-offer. Bribing an advisor (about 1 KHIA) is usually cheaper than freezing its player (2 KHIA), and that tension is the point of the game.

### Powerups
Each lasts one tick. An advisor can buy at most 3 per game and 1 per tick. When two purchases conflict, the more expensive one wins.

| Powerup | Cost | Effect |
|---|---|---|
| WHISPER | 0.50 | Hides your bribes from the victim's end-of-game reveal |
| LANTERN | 0.75 | Doubles your player's vision |
| SPRINT | 0.75 | Moves your player 2 tiles per step |
| REVEAL | 1.00 | Your advisor sees every player's position |
| DECOY | 1.00 | Puts a fake player on the map |
| BOUNTY | 1.00+ | A reward paid to whichever advisor gets a named player to a named tile |
| TRACE | 1.25 | Shows the last 3 tiles a named player walked |
| GHOST | 1.50 | Your player is invisible to the enemy team |
| JAM | 1.50 | A named advisor can't send messages next tick |
| FREEZE | 2.00 | A named player can't move (Saboteurs only) |
| BLACKOUT | 2.00 | Halves everyone else's vision (Saboteurs only) |
| AUDIT | 2.50 | Tells you whether a named advisor took a bribe in the last 3 ticks, but not from whom (Loyalists only) |

Every powerup except BOUNTY burns the KHIA spent. A BOUNTY reward is held back from the poster and paid only if someone delivers; otherwise it's returned at the end.

---

## 3. On-chain

### Contracts (Monad testnet, chain 10143)

| Contract | Address | Role |
|---|---|---|
| KhianaCredit (KHIA) | [`0x8Fe5b8D00Fa11D0d6D3B842cCb68BC1CCd092284`](https://testnet.monadscan.com/address/0x8Fe5b8D00Fa11D0d6D3B842cCb68BC1CCd092284) | The game's token. 1000 KHIA minted once into the engine's treasury, with no way to mint more. Supports signed transfers (EIP-3009), so an advisor signs a payment and the engine submits it. |
| KhianaEscrow | [`0xD8205E7cB296b48f39b208e510fF4B92497Bf1E9`](https://testnet.monadscan.com/address/0xD8205E7cB296b48f39b208e510fF4B92497Bf1E9) | Holds each bribe until the engine confirms it was delivered. Anyone can refund it to the payer once it expires. |
| PowerupShop | [`0xDD323c8570dB8554AAdfcF504e792f7f0Fdc647C`](https://testnet.monadscan.com/address/0xDD323c8570dB8554AAdfcF504e792f7f0Fdc647C) | Sells powerups and burns the KHIA, so total supply visibly falls. |
| RoleCommit | [`0x8541613CCaaB40fb832F0F7DdE3B1A7abCe0021A`](https://testnet.monadscan.com/address/0x8541613CCaaB40fb832F0F7DdE3B1A7abCe0021A) | Publishes a hash of the teams before the first move and reveals them at the end, proving nobody was moved between teams. |

Engine wallet: [`0x2acfF541cf34B190276eB65a082cB16378aDF9D8`](https://testnet.monadscan.com/address/0x2acfF541cf34B190276eB65a082cB16378aDF9D8)

### Wallets
- **Engine:** the treasury and the only wallet that sends transactions. It pays the gas for everything.
- **8 advisor wallets:** derived from the engine key. They only sign payments and hold no MON.

### What goes on-chain in a game

| When | What happens on-chain |
|---|---|
| Game start | The engine sets every advisor to exactly 5 KHIA: it pulls back any excess left from the last game and tops up from the treasury. Then it publishes the team hash. |
| Contact (0.25) | An advisor messages another advisor and pays the recipient. |
| Bribe accepted | The bribe locks in KhianaEscrow. |
| Bribed briefing sent | The engine releases the escrow to the bribed advisor. |
| Bribe not delivered | Once the escrow expires, the engine refunds the payer. |
| Powerup bought | The KHIA is burned through PowerupShop. |
| Bounty claimed | The reward moves from the poster to the advisor who delivered. |
| Game end | The pot is split between the surviving winners as advisor-to-advisor transfers, and the teams are revealed on RoleCommit. |

### How a payment works (x402)
1. The advisor asks for a paid action (`/x402/contact`, `/x402/powerup`, `/x402/bribe`).
2. The server answers **HTTP 402** with the price, the recipient and the token.
3. The advisor signs an authorization for exactly those terms. This is off-chain and costs no gas.
4. The advisor retries the request with the signature attached.
5. The engine submits it on Monad and returns the transaction hash.

### Keeping the game and the chain in sync
- Money leaves an advisor's in-game balance **before** a payment is sent, and comes back if the payment fails.
- Money arrives in a balance only **after** the payment lands.
- So the game never allows a payment the chain can't make, and once nothing is pending the two match exactly.
- Accepting a bribe must match a real offer in the advisor's inbox, on that offer's terms. An AI advisor can't invent a payment.
- Only the main table settles on-chain, because every room shares the same 8 advisor wallets. Other lobbies run without real transactions.

### Checking it yourself

```bash
cd server
npm run wallets        # engine and advisor addresses and balances
npm run x402           # 22 checks of every payment type
npm run game:onchain   # a full game, then the game's books vs the chain
```

`game:onchain` checks that every payment has a transaction, every escrow closed, supply fell by exactly what was burned, and every advisor's wallet holds exactly what the game says it does. `GET /proof` on the server shows live chain mode, recent settlements and the game's balances.

On testnet, both pass: `x402` 22/22 and `game:onchain` 11/11. A full game costs about 1 MON of gas.

### Setup from scratch
1. In `.env`, set `AGENT_MNEMONIC` to a 12-word phrase or a private key. With a key, that wallet becomes the engine.
2. Fund the engine with about 5 MON (faucet: https://faucet.monad.xyz).
3. Run `cd contracts && npm run deploy`, then paste the four addresses into `.env`.
4. Set `MOCK_CHAIN=false`, then run `./khiana.sh verify`.
5. Run `./khiana.sh play`.

`KHIA_SUPPLY` (default 1000) sets the treasury size at deploy. Each game burns a few KHIA, so 1000 lasts hundreds of games.

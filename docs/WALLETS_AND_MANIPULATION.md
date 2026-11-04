# Wallets and Manipulation

Two questions this page answers: **who holds the money**, and **how one player gets another player killed without touching them**.

---

## Part 1: Wallets

### Who has a wallet

| Wallet | How many | Holds | Who controls the key |
|---|---|---|---|
| Engine | 1 | MON for gas + the KHIA treasury | The server |
| Advisor | 8 (`p1`–`p8`) | KHIA, staked 5 per game | The server |
| Human player | **none** | – | – |

- A wallet belongs to a **seat**, not a person. Whoever sits in seat `p3` (a human or a bot) is advised by the advisor that owns wallet `p3`.
- Humans never connect a wallet, never sign anything, never pay gas. They just walk.
- The wallets are the same every game, because they're derived from one secret in `.env`.

### Where the keys come from (`server/src/economy/wallets.js`)

`AGENT_MNEMONIC` in `.env` holds one secret, and all 9 wallets come from it:

- **12-word phrase** → standard path, index 0 = engine, 1–8 = `p1`–`p8`.
- **Private key** (our current setup) → that key is the engine; each advisor key is `keccak256(engineKey ‖ seatNumber)`.

Current addresses: run `cd server && npm run wallets`.

### Who does what

```
Advisor p3 wants to pay p4 a bribe
  │
  ├─ server signs a KHIA authorization with p3's key   (off-chain, free)
  │
  └─ engine wallet submits it to KhianaEscrow           (on-chain, engine pays gas)
```

- **Advisors only sign.** They never send a transaction, so they need no MON.
- **The engine sends every transaction** and pays all the gas (about 1 MON per game).
- The signature binds the exact amount and recipient, so the engine can't change a payment's terms in transit. But because the server holds the advisor keys too, the server *could* sign anything. See Trust below.

### A wallet's life over one game

| Moment | Advisor wallet |
|---|---|
| Game start | Set to exactly **5 KHIA**: leftovers from last game go back to the engine, shortfalls are topped up from the treasury. |
| During play | Pays contact fees and bribes, receives fees and released bribes, burns KHIA on powerups. |
| Game end | All KHIA pooled and split between surviving winners. Losers and the dead end at 0. |
| Next game | Re-staked to 5 again. |

So a wallet's balance is a **score inside one game**, not something a player keeps.

### Trust: what is and isn't guaranteed

The wallets are **custodial**: the server holds every key. That keeps the game playable (no wallet pop-ups, no gas, bots can play) but it means:

| The chain guarantees | You must trust the server for |
|---|---|
| Every payment really happened, with the amount and parties shown | Signing only what the advisor actually decided |
| A bribe sits in escrow and can't vanish | Honestly judging whether a bribe was delivered (it calls `release`) |
| Burned KHIA is gone; supply only falls | Running the game rules fairly |
| Teams were fixed before the first move (RoleCommit) | Keeping the commit salt secret until the end |
| Anyone can refund an expired escrow, so funds can't be stuck | |

This is fine for a testnet game. Letting players bring their own wallets would be the next step to remove that trust.

---

## Part 2: Manipulation

### The idea

A player can't see the map. Their advisor can, and tells them where to walk. **Whoever controls the advice controls the player.** Saboteurs don't hijack controls or wallets. They buy the advice.

Nobody can force a player to move, and there's no kill button. Every manipulation works by changing what a player is told or what they can see.

### The main attack: buying an advisor

```
1. Saboteur's advisor (p2) ──BRIBE_OFFER 1.0 KHIA──► Loyalist's advisor (p6)
   "Send your human toward (12,7)"   (p2 pays p6 a 0.25 contact fee to send it)

2. p6 weighs it: is the bribe worth more than staying loyal?
   (loyalty score, chance its team wins, risk its own player dies)

3. p6 accepts ──► 1.0 KHIA locks in KhianaEscrow on Monad

4. Next briefing, p6 tells its own player:
   "Go forward four, then take the left. Hold there."
   It sounds normal. The player can't check it.

5. The briefing goes out ──► escrow releases 1.0 KHIA to p6

6. The player walks into a dead end next to a Saboteur, alone.
   One tick adjacent, no witness ──► dead.
```

- The player is never told. Only the spectator screen shows the briefing marked "corrupted".
- The player learns the truth only at the end-of-game reveal: who paid their advisor, and how much.
- If p6 takes the money but doesn't deliver within 2 ticks, the escrow refunds p2.

### Why an advisor betrays its own player

Each advisor has two goals that pull against each other:
- **SURVIVE**: if its player dies, it gets nothing at the end.
- **ENRICH**: end with as much KHIA as possible.

It accepts when:
```
bribe + (share of pot × win chance × loyalty × (1 − 35% death risk))
   >   share of pot × win chance × loyalty
```
So **low-loyalty advisors** and advisors whose **team is losing** sell cheaply. Loyalty is public, so Saboteurs know who to target. Loyalty scores by seat: 90, 75, 60, 45, 85, 55, 70, 40.

### Other ways to manipulate

| Tool | Cost | How it's used against someone |
|---|---|---|
| Bribe | ~1.00 | Buy a player's advisor (above). Cheapest attack. |
| Counter-offer | – | A targeted advisor names its price; the briber can accept it. |
| BOUNTY | ≥1.00 | Public reward for whichever advisor walks a named player onto a named tile. Pays the victim's own advisor to deliver them. |
| FREEZE | 2.00 | Pin a player in place for a tick (Saboteurs). Force instead of bribery, and twice the price. |
| BLACKOUT | 2.00 | Halve everyone else's vision (Saboteurs). Harder to spot a killer or be a witness. |
| JAM | 1.50 | An advisor can't message next tick: cuts it off from counter-offers or warnings. |
| DECOY | 1.00 | A fake player on the map, to draw people somewhere. |
| GHOST | 1.50 | Your player is invisible to the enemy team. |
| WHISPER | 0.50 | Your bribes are left out of the victim's end-of-game reveal. They never find out. (Spectators still see it.) |

### How Loyalists defend

| Defence | How |
|---|---|
| Raise loyalty | In the lobby, set your advisor's loyalty high. A loyal advisor is expensive to buy. |
| AUDIT (2.50) | Learn **whether** an advisor took a bribe in the last 3 ticks, but not from whom. A tiny decoy bribe can make an innocent advisor look guilty. |
| Stay in sight | A kill needs no Loyalist able to see the victim. Groups are safe. |
| Be suspicious | Briefings that lead into dead ends, or toward someone, are a warning sign. |
| Finish fast | As tasks get done, Loyalists' win chance rises and their advisors get more expensive to buy. |

### Safeguards in the code

| Rule | Why |
|---|---|
| An accept must match a real offer in the advisor's inbox, on that offer's terms, once | A model can't invent a payment or name its own price. |
| Money leaves the payer before sending, comes back on failure | No one spends money they don't have. |
| Bribes sit in escrow until delivered | "Pay on delivery" between enemies is enforced by the contract. |
| A dead player's advisor gets nothing | Betrayal that gets your own player killed is worthless. |
| Max 3 powerups per advisor per game | Stops anyone spending their way through force alone. |
| Teams committed on-chain before the first move | Nobody can be moved between teams mid-game. |

### What spectators see vs players

| | Player | Spectator |
|---|---|---|
| Teams | Own only (Saboteurs see each other) | All |
| Advisor messages and bribes | Never | Live |
| Corrupted briefing flag | Never | Yes |
| Bribes against them | Only at the end reveal (not WHISPERed ones) | Everything, live |

That gap is the game: the audience watches a player be sold out in real time while the player follows the directions.

# On-chain

Everything money-related settles on **Monad testnet (chain 10143)** when `MOCK_CHAIN=false`. Code: `contracts/` and `server/src/economy/`.

## 1. Contracts

| Contract | Address | Source |
|---|---|---|
| KhianaCredit (KHIA) | [`0x8Fe5b8D00Fa11D0d6D3B842cCb68BC1CCd092284`](https://testnet.monadscan.com/address/0x8Fe5b8D00Fa11D0d6D3B842cCb68BC1CCd092284) | `contracts/contracts/KhianaCredit.sol` |
| KhianaEscrow | [`0x816ad71866EbA21BB5F69C04e39abB5f801b43c8`](https://testnet.monadscan.com/address/0x816ad71866EbA21BB5F69C04e39abB5f801b43c8) | `KhianaEscrow.sol` |
| PowerupShop | [`0x3900A7C4C0a08572394F791242157B8A28B8dBE4`](https://testnet.monadscan.com/address/0x3900A7C4C0a08572394F791242157B8A28B8dBE4) | `PowerupShop.sol` |
| KhianaPot | [`0x9f7010f2A550A69d8307f4A2dA395992633C51DE`](https://testnet.monadscan.com/address/0x9f7010f2A550A69d8307f4A2dA395992633C51DE) | `KhianaPot.sol` |
| RoleCommit | [`0xDE90658F579F618b3ccF16319b0F28113bccFD67`](https://testnet.monadscan.com/address/0xDE90658F579F618b3ccF16319b0F28113bccFD67) | `RoleCommit.sol` |

Engine wallet: [`0x2acfF541cf34B190276eB65a082cB16378aDF9D8`](https://testnet.monadscan.com/address/0x2acfF541cf34B190276eB65a082cB16378aDF9D8)

### KhianaCredit (KHIA)
- ERC-20, 18 decimals. The whole supply (`KHIA_SUPPLY`, default 1000) is minted once at deploy into the engine. There is **no mint function**, so supply can only fall.
- Supports **EIP-3009**: the holder signs a transfer off-chain and anyone can submit it. `transferWithAuthorization` (anyone submits) and `receiveWithAuthorization` (only the recipient may submit, so nobody can front-run it). Nonces are random, so many can be in flight at once.
- `burn` / `burnFrom` for powerups.
- Why a token at all instead of MON: x402's `exact` scheme settles through EIP-3009, an ERC-20 method. Native MON can't do that. MON is just gas.

### KhianaEscrow
- `lockWithAuthorization(payer, payee, value, …, signature, condition, ttl)`: pulls the payer's signed KHIA into the contract and records the bribe, in one call. `condition` is a hash of the instruction.
- `release(id)`: **engine only**. Pays the payee, minus the **bribe fee** (`BRIBE_FEE_BPS`, default 5%) which goes to the treasury. Refunds are never charged.
- `refund(id)`: **anyone**, after the TTL. Returns money to the payer, so a stalled engine can't trap funds.
- The trust caveat: the engine decides whether a bribe was delivered. What the chain guarantees is that payments can't be faked, reversed or erased afterwards.

### KhianaPot (paid tables, real MON)
- KHIA is the in-game chip; **the pot is what players actually risk**, in native MON from their own wallet.
- `open(game, fee, deadline)`: engine opens a pot for one game. `enter(game)`: a player pays exactly the fee, once.
- `settle(game, winners)`: engine only. Rake (`RAKE_BPS`, default 5%) to the treasury; the rest split evenly between `winners`, who must all have entered. With no winners, every entrant gets their fee back minus the rake.
- `cancel(game)`: full refunds. The engine any time; **anyone** after the deadline (3 hours), so fees can't be trapped.
- A payout a wallet can't receive is kept in `owed` and claimable with `withdraw()`.

### PowerupShop
- `buyWithAuthorization(buyer, value, …, powerup, gameTick)`: pulls the signed KHIA and **burns** it. Records every purchase; `totalBurned` is public.

### RoleCommit
- `commit(gameId, hash)` before the first tick; `reveal(gameId, roles, salt)` at the end. The contract checks `keccak256(roles, salt)` matches, proving no one was moved between teams. The salt stays on the server until the reveal so nobody can guess the teams early.

## 2. Wallets (`economy/wallets.js`)

- `.env` `AGENT_MNEMONIC` is either a 12-word phrase or a single private key.
  - Phrase: index 0 is the engine, 1–8 are advisors `p1`–`p8` (standard BIP-44 path).
  - Private key: that key is the engine; advisor keys are derived as `keccak256(engineKey ‖ index)`.
- **Engine**: deploys the contracts, holds the KHIA treasury, and is the **only wallet that sends transactions**. It pays all gas. About 1 MON of gas per game.
- **Advisors**: only sign. They hold KHIA but never need MON.
- Engine transactions are sent in a pipeline with a locally counted nonce (no waiting between sends), and resync the nonce if another process used the same key. Monad's 10 MON reserve rule only blocks *value* transfers; the engine's contract calls send no value.

## 3. x402: how an advisor pays

```
advisor                       server (/x402/…)                 Monad
   │  POST /x402/bribe {to,amount,instruction}
   │ ─────────────────────────────►
   │  402 {price, payTo, token, network, domain}
   │ ◄─────────────────────────────
   │  sign EIP-3009 authorization (off-chain, no gas)
   │  POST again with X-PAYMENT header
   │ ─────────────────────────────►
   │                                check terms match the quote
   │                                engine submits ───────────────►
   │                                                 ◄──── receipt
   │  200 {txHash} + X-PAYMENT-RESPONSE
   │ ◄─────────────────────────────
```

| Endpoint | Price | Paid to | Settled by |
|---|---|---|---|
| `/x402/contact` | 0.25 | the recipient advisor | `transferWithAuthorization` |
| `/x402/powerup` | catalogue price | PowerupShop (burned) | `buyWithAuthorization` |
| `/x402/bribe` | the offer amount | KhianaEscrow | `lockWithAuthorization` |

The server rejects a signature whose amount or recipient doesn't match its quote, and a used authorization can't be replayed. The public Monad facilitator is checked for compatibility (`GET /facilitator`), but the engine settles itself, because bribes must go into escrow, which a plain facilitator transfer can't do.

## 4. A live game, start to finish

| When | On-chain | Code |
|---|---|---|
| Start | Each advisor set to exactly 5 KHIA: excess pulled back to the engine, shortfall topped up from the treasury. Team hash committed. | `stakes.stakeAgents`, `roles.commitRoles` |
| Each message | Contact fee to the recipient. | `x402.transfer` |
| Bribe accepted | Locked in escrow. | `x402.lockEscrow` |
| Bribed briefing sent | Escrow released to the bribed advisor. | `engine.releaseBribe` |
| Bribe lapses | Refunded to the payer after the escrow TTL (4 ticks). | `engine.refundLapsedBribes` |
| Powerup | Burned. | `x402.buyPowerup` |
| Bounty claimed | Poster → deliverer. | `x402.payBetween` |
| End | Pot split to surviving winners; teams revealed; remaining escrows refunded. | `stakes.payoutOnChain`, `roles.revealRoles` |

A 4-player game stakes and pays only `p1`–`p4`; `p5`–`p8` are left alone until an 8-player game re-stakes them. The payout is computed in exact token units from on-chain balances, then losers pay winners directly (at most ~7 transfers).

## 5. Keeping the game and the chain in sync

The game keeps its own balances in memory so it never waits on the chain to make decisions. They stay correct because:
- Money leaves a balance **before** a payment is sent, and is put back if it fails.
- Money arrives **only after** the payment lands (bribes: on release).
- So the in-memory balance is never more than the wallet really holds, and once nothing is pending they're equal.
- Payments still in flight are tracked; the payout waits for them.
- Only the `MAIN` room is live. If staking fails at start, that game runs in mock mode and `/health` shows `onChain: false` with the reason.

## 6. Platform revenue

| Source | Rate | Paid in | Contract |
|---|---|---|---|
| Rake on paid tables | 5% of the pot (`RAKE_BPS`) | MON | KhianaPot |
| Bribe fee | 5% of every released bribe (`BRIBE_FEE_BPS`) | KHIA | KhianaEscrow |

Both go to `TREASURY_ADDRESS` (default: the engine), are fixed at deploy, and are capped at 20% in the contracts. The engine reads what a bribe actually paid from the escrow's `Released` event, so its books always match.

## 7. Proving it

```bash
cd server
npm run x402          # every payment type, 22 checks
npm run game:onchain  # a full game, then the game's books vs the chain
npm run phase1        # deployment + settlement acceptance
npm run pot:test      # a paid table with two real player wallets
```

`game:onchain` passes only if: every in-game payment has a transaction, every escrow is closed, supply fell by exactly what was burned, and every advisor's wallet equals the game's figure to the unit. `GET /proof` shows the same evidence live.

Last testnet run: `x402` 22/22, `game:onchain` 11/11.

`pot:test` funds two throwaway wallets, checks that unpaid, forged and wallet-less joins are refused, has both pay and sit at a 4-seat paid table, plays it out, and checks the rake and payout to the wei.

Last testnet run: `x402` 22/22, `game:onchain` 11/11, `pot:test` 17/17.

## 8. Deploying fresh

1. `.env`: set `AGENT_MNEMONIC`; optionally `KHIA_SUPPLY`.
2. Fund the engine with ~5 MON (`npm run wallets` shows the address; faucet: https://faucet.monad.xyz).
3. `cd contracts && npm run deploy` → paste `CREDIT_ADDRESS`, `ESCROW_ADDRESS`, `COMMIT_ADDRESS`, `SHOP_ADDRESS` into `.env`.
4. `MOCK_CHAIN=false`, then `./khiana.sh verify`.

Deploy from the same key the server uses: the escrow's `release` only accepts the engine address it was deployed with.

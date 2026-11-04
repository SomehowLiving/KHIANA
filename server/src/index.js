import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

import { isAddress, verifyMessage } from 'viem';
import { CONFIG, TABLE_SIZES, rulesFor } from './config.js';
import { hasEntered, joinMessage, potAvailable } from './economy/pot.js';
import { checkFacilitator } from './economy/x402.js';
import { mountX402 } from './economy/x402-server.js';
import { providerStatus } from './agents/llm.js';
import {
  createRoom, getRoom, publicRooms, roomSummary, allRooms,
  attach, detach, seatPlayer, pushState, broadcast, movePlayerIn,
  startRoom, finishRoom, resetRoom, closeRoom, startReaper, startAutoStarter, isHost, canStart, humanCount,
} from './rooms.js';

const app = express();
app.use(cors());
app.use(express.json());

const http = createServer(app);
const wss = new WebSocketServer({ server: http });

/**
 * The default room.
 *
 * Everything used to hang off one module-level game. Rooms replaced that, but
 * a lobby-less single game is still how the tests, the headless runner and a
 * plain `npm start` expect to work — so one room always exists under a fixed
 * code and the unprefixed routes operate on it.
 */
const DEFAULT_CODE = 'MAIN';
// The only room that settles on chain: every room shares one set of agent
// wallets, so a second live room would spend from the same balances.
const defaultRoom = createRoom({
  name: 'Main table', isPublic: true, code: DEFAULT_CODE, onChain: !CONFIG.MOCK_CHAIN,
});

startReaper();
startAutoStarter();

/** Resolve :code / ?room= / body.room, falling back to the main table. */
function resolveRoom(req) {
  const code = req.params?.code ?? req.query?.room ?? req.body?.room;
  return code ? getRoom(code) : defaultRoom;
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

// ── Health & diagnostics ────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mockChain: CONFIG.MOCK_CHAIN,
    // What the current main-table game is actually doing. Differs from
    // mockChain when staking failed at start and the game fell back.
    onChain: defaultRoom.game.onChain,
    ...(defaultRoom.game.chainError ? { chainError: defaultRoom.game.chainError } : {}),
    mockLLM: CONFIG.MOCK_LLM,
    tick: defaultRoom.game.tick,
    phase: defaultRoom.game.phase,
    players: Object.keys(defaultRoom.game.players).length,
    rooms: allRooms().length,
    agent: providerStatus(),
  });
});

/** Run this FIRST in Phase 1. If it isn't green, nothing downstream works. */
app.get('/facilitator', async (_req, res) => res.json(await checkFacilitator()));

/**
 * Everything the landing page needs to describe the game.
 * Served rather than hardcoded in the copy, so tuning CONFIG updates the
 * marketing page too and the two can never drift apart.
 */
app.get('/config', (_req, res) => {
  res.json({
    players: CONFIG.GAME.PLAYERS,
    saboteurs: CONFIG.GAME.SABOTEURS,
    // Lobbies choose a size; these are the rules each size plays by.
    tableSizes: TABLE_SIZES.map(n => {
      const r = rulesFor(n);
      return { players: n, saboteurs: r.SABOTEURS, survivorsToEscape: r.SURVIVORS_TO_ESCAPE, mazeSize: r.MAZE_SIZE };
    }),
    tasksToWin: CONFIG.GAME.TASKS_TO_WIN,
    totalTicks: CONFIG.GAME.TOTAL_TICKS,
    tickSeconds: CONFIG.GAME.TICK_MS / 1000,
    visionRadius: CONFIG.GAME.VISION_RADIUS,
    corridorSight: CONFIG.GAME.CORRIDOR_SIGHT,
    survivorsToEscape: CONFIG.GAME.SURVIVORS_TO_ESCAPE,
    startingBalance: CONFIG.ECONOMY.STARTING_MON,
    contactFee: CONFIG.ECONOMY.CONTACT_FEE,
    maxPowerups: CONFIG.ECONOMY.MAX_POWERUPS_PER_GAME,
    powerups: Object.entries(CONFIG.POWERUPS).map(([name, p]) => ({
      name, cost: p.cost, desc: p.desc, team: p.team,
    })),
    mockChain: CONFIG.MOCK_CHAIN,
    explorer: CONFIG.CHAIN.EXPLORER,
    // Paid tables: offered only when the server is live with a deployed pot.
    paidTables: potAvailable(),
    entryFees: potAvailable() ? CONFIG.ECONOMY.ENTRY_FEES : [0],
    chainId: CONFIG.CHAIN.CHAIN_ID,
    rpcUrl: CONFIG.CHAIN.RPC_URL,
  });
});

/**
 * Everything a judge needs to verify the claims, in one payload.
 *
 * Built because "the agents really call an LLM" and "the payments really
 * settle on Monad" are both unfalsifiable from the outside. This exposes the
 * live counters and the contract addresses so the claims can be checked
 * rather than taken on trust.
 */
app.get('/proof', (_req, res) => {
  const g = defaultRoom.game;
  const ledger = g.ledger?.entries ?? [];
  const settled = ledger.filter(e => e.txHash);

  res.json({
    llm: providerStatus(),

    chain: {
      mode: g.onChain ? 'LIVE' : 'MOCK',
      ...(g.chainError ? { error: g.chainError } : {}),
      chainId: CONFIG.CHAIN.CHAIN_ID,
      explorer: CONFIG.CHAIN.EXPLORER,
      contracts: {
        KhianaCredit: CONFIG.CHAIN.CREDIT_ADDRESS || null,
        KhianaEscrow: CONFIG.CHAIN.ESCROW_ADDRESS || null,
        PowerupShop: CONFIG.CHAIN.SHOP_ADDRESS || null,
        RoleCommit: CONFIG.CHAIN.COMMIT_ADDRESS || null,
      },
    },

    /** Every x402 settlement this game has produced, newest first. */
    x402: {
      resources: ['/x402/contact', '/x402/powerup', '/x402/bribe'],
      settlements: settled.slice(-25).reverse().map(e => ({
        tick: e.tick, kind: e.kind, from: e.from, to: e.to, amount: e.amount,
        txHash: e.txHash,
        url: g.onChain ? `${CONFIG.CHAIN.EXPLORER}/tx/${e.txHash}` : null,
        ...(e.escrow ? { escrow: e.escrow, releaseTx: e.releaseTx, refundTx: e.refundTx } : {}),
      })),
      totals: {
        contacts: ledger.filter(e => e.kind === 'CONTACT').length,
        bribes: ledger.filter(e => e.kind === 'BRIBE').length,
        powerups: ledger.filter(e => e.kind === 'POWERUP').length,
      },
    },

    /** What each advisor has bought, so powerup use is visible not implied. */
    powerups: {
      catalogue: Object.entries(CONFIG.POWERUPS).map(([n, p]) => ({ name: n, cost: p.cost, team: p.team ?? 'BOTH' })),
      purchased: ledger.filter(e => e.kind === 'POWERUP').map(e => ({
        tick: e.tick, by: e.from, item: e.memo, cost: e.amount, txHash: e.txHash,
      })),
      activeThisTick: {
        reveal: [...(g.effects?.reveal ?? [])],
        lantern: [...(g.effects?.lantern ?? [])],
        sprint: [...(g.effects?.sprint ?? [])],
        ghost: [...(g.effects?.ghost ?? [])],
        freeze: [...(g.effects?.freeze ?? [])],
        jam: [...(g.effects?.jam ?? [])],
        whisper: [...(g.effects?.whisper ?? [])],
        blackout: Boolean(g.effects?.blackout),
        bounties: (g.effects?.bounties ?? []).length,
      },
    },

    game: { tick: g.tick, phase: g.phase, started: g.started, winner: g.winner },

    /**
     * The engine's view of every agent's KHIA. Once no settlement is in
     * flight these must equal the on-chain balances exactly — that is the
     * check `npm run game:onchain` makes, and anyone can repeat it against
     * the token contract.
     */
    balances: Object.fromEntries(
      Object.values(g.players).map(p => [p.id, Number(p.agent.balance.toFixed(6))])
    ),
    inFlight: g.chainOps?.size ?? 0,
  });
});

// ── Rooms ───────────────────────────────────────────────────────────────────

app.get('/rooms', (_req, res) => res.json({ rooms: publicRooms() }));

app.post('/rooms', (req, res) => {
  try {
    const room = createRoom({
      name: req.body?.name,
      isPublic: req.body?.isPublic !== false,
      hostName: req.body?.hostName,
      seed: req.body?.seed,
      players: req.body?.players,
      entryFee: req.body?.entryFee,
    });
    res.json({ ok: true, room: roomSummary(room) });
  } catch (err) {
    res.status(503).json({ ok: false, error: String(err.message ?? err) });
  }
});

app.get('/rooms/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: 'No such room' });
  res.json({ ok: true, room: roomSummary(room) });
});

app.delete('/rooms/:code', (req, res) => {
  if (String(req.params.code).toUpperCase() === DEFAULT_CODE) {
    return res.status(400).json({ ok: false, error: 'The main table cannot be closed' });
  }
  res.json({ ok: closeRoom(String(req.params.code).toUpperCase()) });
});

// ── Game control (room-scoped, defaulting to the main table) ────────────────

app.post('/game/new', (req, res) => {
  const room = resolveRoom(req);
  if (!room) return res.status(404).json({ ok: false, error: 'No such room' });
  resetRoom(room, req.body?.seed);
  res.json({ ok: true, seed: room.game.seed, room: room.code });
});

app.post('/game/start', async (req, res) => {
  const room = resolveRoom(req);
  if (!room) return res.status(404).json({ ok: false, error: 'No such room' });
  res.json({ ...(await startRoom(room)), room: room.code });
});

app.get('/game/reveal', (req, res) => {
  const room = resolveRoom(req);
  if (!room) return res.status(404).json({ ok: false, error: 'No such room' });
  res.json(room.game.reveal ?? finishRoom(room));
});

/**
 * x402 paid resources: /x402/contact, /x402/powerup, /x402/bribe.
 *
 * Scoped to the main table. Agent wallets are server-held and shared across
 * rooms, so per-room settlement would need per-room wallets — out of scope
 * until more than one room runs on chain at once.
 */
mountX402(app, () => defaultRoom.game);

/**
 * A paid seat needs two proofs: the wallet signed this game's join message,
 * so nobody can sit in a seat someone else paid for, and the pot contract
 * shows that wallet paid. Winnings go to that same address.
 */
async function verifyPaidEntry(room, msg) {
  const pot = room.pot;
  if (pot.status !== 'open') {
    return { ok: false, error: `This table's pot is ${pot.status}. Try again in a moment.` };
  }
  if (!isAddress(msg.wallet ?? '') || !msg.signature) {
    return { ok: false, error: `Connect a wallet and pay the ${pot.fee} MON entry fee to sit here.` };
  }
  const signed = await verifyMessage({
    address: msg.wallet, message: joinMessage(pot.gameId), signature: msg.signature,
  }).catch(() => false);
  if (!signed) return { ok: false, error: 'Wallet signature did not match.' };
  if (!(await hasEntered(pot.gameId, msg.wallet))) {
    return { ok: false, error: `No entry fee from this wallet yet. Pay ${pot.fee} MON first.` };
  }
  return { ok: true, address: msg.wallet };
}

// ── WebSocket ───────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  // ?room=CODE on the socket URL, so a spectator can deep-link a lobby.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const requested = url.searchParams.get('room');
  let room = requested ? getRoom(requested) : defaultRoom;

  if (!room) {
    send(ws, { type: 'ERROR', error: `Room ${requested} not found` });
    room = defaultRoom;
  }

  attach(room, ws, 'spectator');

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // A client may switch rooms on an open socket rather than reconnecting.
    if (msg.room) {
      const target = getRoom(msg.room);
      if (target && target !== room) {
        detach(room, ws);
        room = target;
        attach(room, ws, 'spectator');
      }
    }

    const meta = room.sockets.get(ws);

    switch (msg.type) {
      case 'JOIN': {
        // Paid tables: a returning seat (token) is let straight back in;
        // anyone new must prove they own a wallet that paid this game's pot.
        const returning = msg.token && room.seatTokens.has(msg.token);
        if (room.pot && !returning) {
          verifyPaidEntry(room, msg).then(wallet => {
            if (!wallet.ok) return send(ws, { type: 'ERROR', context: 'PAY', error: wallet.error });
            join(wallet.address);
          }).catch(err => send(ws, { type: 'ERROR', context: 'PAY', error: String(err?.message ?? err) }));
          break;
        }
        join(null);
        break;
      }

      default:
        break;
    }

    function join(wallet) {
        const r = seatPlayer(room, ws, { name: msg.name, token: msg.token, playerId: msg.playerId, wallet });
        if (r.error) return send(ws, { type: 'ERROR', error: r.error });
        send(ws, {
          type: 'JOINED',
          playerId: r.seat.id, team: r.seat.team,
          token: r.token, resumed: r.resumed, room: room.code,
          isHost: r.isHost,
          started: room.game.started,
        });
        pushState(room, ws);
        broadcast(room);   // the roster changed for everyone watching
    }

    switch (msg.type) {
      case 'SPECTATE':
        room.sockets.set(ws, { role: 'spectator', playerId: null });
        pushState(room, ws);
        break;

      case 'SET_GOAL_WEIGHT': {
        // Public and set in the lobby: everyone knows how corruptible your
        // advisor is, nobody knows whether it's been bought yet.
        const p = room.game.players[meta?.playerId];
        if (p && !room.game.started) {
          p.agent.goalWeight = Math.max(0, Math.min(100, Number(msg.value) || 70));
        }
        broadcast(room);
        break;
      }

      /**
       * Only the host starts the game.
       *
       * It used to begin the moment the tick loop was kicked, which meant a
       * player who opened a table was thrown straight into a solo game with
       * seven bots and no chance to share the code.
       */
      case 'START':
        if (room.game.started) break;
        if (!canStart(room, msg.token)) {
          // Only reachable if the caller holds no seat in this room at all.
          send(ws, {
            type: 'ERROR', context: 'START',
            error: 'Rejoin the table before starting it.',
          });
          break;
        }
        /**
         * startRoom is async (it publishes the role commitment on chain
         * first). Broadcasting synchronously after it sent everyone the
         * PRE-start state, so the lobby never learned the game had begun and
         * sat on "Starting…" until the next tick fifteen seconds later.
         */
        startRoom(room)
          .then(() => broadcast(room))
          .catch(err => send(ws, {
            type: 'ERROR', context: 'START',
            error: `Could not start: ${String(err?.message ?? err)}`,
          }));
        break;

      case 'MOVE': {
        if (!meta?.playerId) break;
        const p = room.game.players[meta.playerId];
        // A dead player is a spectator with a keyboard.
        if (!p?.alive) break;
        if (Number.isInteger(msg.facing)) p.facing = ((msg.facing % 4) + 4) % 4;
        movePlayerIn(room, meta.playerId, msg.dx | 0, msg.dy | 0);
        pushState(room, ws);
        break;
      }

      /** Look direction only, so the advisor can say "turn left". */
      case 'FACE': {
        const p = room.game.players[meta?.playerId];
        if (p && Number.isInteger(msg.facing)) p.facing = ((msg.facing % 4) + 4) % 4;
        break;
      }
        break;
    }
  });

  ws.on('close', () => {
    detach(room, ws);
    broadcast(room);
  });

  pushState(room, ws);
});

http.listen(CONFIG.PORT, () => {
  const a = providerStatus();
  console.log(`\nKhiana server :${CONFIG.PORT}`);
  console.log(`  chain   ${CONFIG.MOCK_CHAIN ? 'MOCK' : `LIVE on chain ${CONFIG.CHAIN.CHAIN_ID} (main table only)`}`);
  console.log(`  agents  ${a.mock ? 'FALLBACK BRAIN' : `${a.provider} / ${a.model}`}`);
  console.log(`  rooms   GET /rooms · POST /rooms · main table "${DEFAULT_CODE}"`);
  console.log(`  POST /game/start to begin\n`);
});

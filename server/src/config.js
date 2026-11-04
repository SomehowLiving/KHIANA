import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

/**
 * Load the repo-root .env explicitly.
 *
 * Bare `import 'dotenv/config'` resolves relative to process.cwd(), which is
 * server/ for every npm script in this package — so the root .env was never
 * being read. It went unnoticed because MOCK_CHAIN defaults to true and the
 * game is fully playable mocked. contracts/hardhat.config.js already pins
 * '../.env' for the same reason.
 */
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

/**
 * Every tunable number in the game lives here.
 * If you change anything under ECONOMY or POWERUPS, add a `Balance` entry
 * to CHANGELOG.md and re-check the invariants in docs/POWERUPS.md.
 */

/**
 * Verified against each provider's live model list on 2026-08-16 — not
 * guessed. Override with LLM_MODEL rather than editing this.
 */
const DEFAULT_MODELS = {
  groq: 'llama-3.3-70b-versatile',
  anthropic: 'claude-sonnet-4-6',
};

const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? 'groq').toLowerCase();
const LLM_KEYS = { groq: 'GROQ_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
const LLM_KEY_PRESENT = Boolean(process.env[LLM_KEYS[LLM_PROVIDER] ?? 'GROQ_API_KEY']);

export const CONFIG = {
  PORT: Number(process.env.PORT ?? 8787),

  // Set MOCK_CHAIN=true to run the entire game with zero network calls.
  // Use this for local dev and as the demo parachute.
  MOCK_CHAIN: process.env.MOCK_CHAIN !== 'false',
  // Falls back to the deterministic brain whenever the ACTIVE provider's key
  // is missing — keyed off LLM_PROVIDER, so setting a Groq key while pointing
  // at Anthropic correctly still counts as "no key" instead of failing on
  // every call at tick 1.
  MOCK_LLM: !LLM_KEY_PRESENT,

  CHAIN: {
    // Monad testnet. Mainnet is 143 — do not mix. Overridable only so the
    // whole settlement layer can be dry-run against a local hardhat node
    // (31337) without testnet MON; the game itself never sets this.
    CHAIN_ID: Number(process.env.CHAIN_ID ?? 10143),
    RPC_URL: process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz',
    EXPLORER: 'https://testnet.monadscan.com',
    FACILITATOR: process.env.X402_FACILITATOR ?? 'https://x402-facilitator.molandak.org',
    // Only set this once you have an x402-gated shop endpoint that actually
    // answers 402. Unset means powerups settle directly against PowerupShop.sol.
    SHOP_URL: process.env.X402_SHOP_URL ?? '',
    CREDIT_ADDRESS: process.env.CREDIT_ADDRESS ?? '',
    ESCROW_ADDRESS: process.env.ESCROW_ADDRESS ?? '',
    SHOP_ADDRESS: process.env.SHOP_ADDRESS ?? '',
    COMMIT_ADDRESS: process.env.COMMIT_ADDRESS ?? '',
  },

  /**
   * Every dial is env-overridable. Defaults are the tuned values from the PRD;
   * the overrides exist so a demo can be reshaped (shorter game, smaller maze,
   * fewer players) without editing code, and so tests can run a four-tick game
   * instead of waiting ten minutes for a reveal.
   */
  GAME: {
    TICK_MS: Number(process.env.TICK_MS ?? 15_000),
    TOTAL_TICKS: Number(process.env.TOTAL_TICKS ?? 40),   // 40 * 15s = 10 minutes
    MAZE_SIZE: Number(process.env.MAZE_SIZE ?? 24),       // drop to 16 if you cut scope
    LOOP_CARVE_RATIO: Number(process.env.LOOP_CARVE_RATIO ?? 0.12),
                                // % of walls removed after maze gen; a perfect
                                // maze makes hiding impossible and chasing trivial
    // The near bubble: what you know about your immediate surroundings.
    // Tight, because the game is first-person — you should feel boxed in.
    VISION_RADIUS: Number(process.env.VISION_RADIUS ?? 2),
    // How far sight carries straight down an open corridor before a wall
    // stops it. Much longer than the bubble: standing in a hallway you can
    // see to the end of it, but nothing to either side.
    CORRIDOR_SIGHT: Number(process.env.CORRIDOR_SIGHT ?? 7),
    PLAYERS: Number(process.env.PLAYERS ?? 8),
    SABOTEURS: Number(process.env.SABOTEURS ?? 2),
    TASKS_TO_WIN: Number(process.env.TASKS_TO_WIN ?? 5),
    TASK_REVEAL_EVERY: Number(process.env.TASK_REVEAL_EVERY ?? 7),   // ticks
    LOYALISTS_ALIVE_TO_LOSE: Number(process.env.LOYALISTS_ALIVE_TO_LOSE ?? 2),
    ELIMINATION_TICKS: Number(process.env.ELIMINATION_TICKS ?? 1),  // full ticks of adjacency

    // PRD §5: Loyalists complete the tasks, THEN reach the exit with 3+
    // survivors. Task completion alone is not a win — the escape is what
    // forces the group back together while a bought agent is still steering.
    SURVIVORS_TO_ESCAPE: 3,

    // PRD §5 defines a Saboteur clock win as "fewer than 3 tasks complete",
    // which leaves 3–4 tasks at timeout undefined. We resolve that band to
    // the Loyalists: they did the work, they just didn't get out.
    TIMEOUT_TASKS_FOR_LOYALIST_WIN: 3,
  },

  ECONOMY: {
    STARTING_MON: 5.0,
    CONTACT_FEE: 0.25,          // paid TO the recipient, not burned
    MIN_BRIBE: 0.10,

    // docs/POWERUPS.md invariant #3: "No agent affords more than 3 powerups
    // per game." Prices alone don't enforce it — WHISPER at 0.50 means a
    // 5 MON stake buys ten. Observed consequence: agents burned 17.5 MON on
    // powerups in a 40-tick run and the bribery layer, which is the entire
    // thesis, went silent after tick 8. Enforced as a rule so the tuned price
    // table stays untouched.
    MAX_POWERUPS_PER_GAME: Number(process.env.MAX_POWERUPS_PER_GAME ?? 3),
    // Payout: winning team splits all remaining MON across SURVIVING pairs.
    // Dead humans' agents get nothing regardless of team.
  },

  /**
   * All powerups last exactly one tick. Cost is burned (paid to shop endpoint).
   * `team: null` means available to both.
   *
   * INVARIANTS — do not break these:
   *  1. bribery (~1.0) must stay cheaper than FREEZE. This is the thesis.
   *  2. AUDIT must cost more than a typical bribe.
   *  3. No agent affords more than 3 powerups per game (5 MON total).
   *  4. REVEAL must cost more than LANTERN.
   *  5. Saboteur-only items are the expensive ones.
   */
  POWERUPS: {
    REVEAL:   { cost: 1.00, team: null,        desc: 'Full map for one tick, including every player position' },
    LANTERN:  { cost: 0.75, team: null,        desc: 'Your human\'s vision radius doubles' },
    SPRINT:   { cost: 0.75, team: null,        desc: 'Your human moves at 2x speed' },
    GHOST:    { cost: 1.50, team: null,        desc: 'Your human is invisible to the enemy team' },
    WHISPER:  { cost: 0.50, team: null,        desc: 'Message another agent; its human never sees it' },
    TRACE:    { cost: 1.25, team: null,        desc: 'See the last 3 tiles a named human walked' },
    DECOY:    { cost: 1.00, team: null,        desc: 'Spawn a false player blip at a tile of your choosing' },
    JAM:      { cost: 1.50, team: null,        desc: 'A named agent cannot send or receive messages next tick' },
    FREEZE:   { cost: 2.00, team: 'SABOTEUR',  desc: 'A named human cannot move for one tick' },
    BLACKOUT: { cost: 2.00, team: 'SABOTEUR',  desc: 'Every other human\'s vision radius halves' },
    AUDIT:    { cost: 2.50, team: 'LOYALIST',  desc: 'Reveals WHETHER a named agent took a bribe in 3 ticks — not from whom' },
    BOUNTY:   { cost: 1.00, team: null,        desc: 'Public reward, auto-paid to whoever moves a named human to a named tile', variableCost: true },
  },

  /**
   * x402. Every agent-to-agent payment in the game travels this way:
   * request → 402 with requirements → sign an EIP-3009 authorization →
   * retry with X-PAYMENT → settled on chain → resource served.
   */
  X402: {
    // How long a signed authorization stays valid. Long enough to survive a
    // slow tick and a retry, short enough that a leaked signature goes stale
    // before the next game.
    AUTHORIZATION_TTL_SECONDS: Number(process.env.X402_AUTH_TTL ?? 300),
    // Where the resource server lives. Defaults to this process.
    RESOURCE_BASE: process.env.X402_RESOURCE_BASE ?? '',
    // Settlement executor. 'engine' submits authorizations ourselves; the
    // escrow leg always uses this, because the public facilitator settles
    // plain token transfers and cannot call escrow.lockWithAuthorization.
    SETTLER: process.env.X402_SETTLER ?? 'engine',
  },

  /**
   * Powerup conflict resolution — docs/POWERUPS.md: "if two agents buy
   * conflicting effects on the same target, the more expensive one wins."
   *
   * Two distinct kinds of conflict, and conflating them was the bug:
   *
   * CLAIMS are purchase-time exclusivity. Each entry maps a powerup to the
   * "slot" it occupies on a target. Two purchases claiming the same slot are
   * mutually exclusive and only the dearer one lands. `scope` says whose slot:
   * 'target' = the named victim, 'self' = the buyer's own human, 'global' =
   * every human at once.
   *
   * PRECEDENCE is effect-time. Ghost (1.50) must beat Reveal (1.00) and Trace
   * (1.25) when someone looks for a ghosted player — that isn't decided when
   * the purchase settles, it's decided when vision is computed. Listed here so
   * fog.js reads the rule from config instead of hardcoding a comparison.
   */
  POWERUP_CONFLICTS: {
    CLAIMS: {
      FREEZE:   { slot: 'movement', scope: 'target' },
      SPRINT:   { slot: 'movement', scope: 'self' },
      LANTERN:  { slot: 'vision',   scope: 'self' },
      BLACKOUT: { slot: 'vision',   scope: 'global' },
      JAM:      { slot: 'comms',    scope: 'target' },
    },
    // A ghosted player is hidden from these, because GHOST costs more.
    GHOST_BEATS: ['REVEAL', 'TRACE'],
  },

  AGENT: {
    // Provider is env-driven so vendor and model can change without a code
    // edit. Groq's free tier is the default: it removes the per-call cost
    // pressure that otherwise pushes you into under-prompting the agents.
    PROVIDER: LLM_PROVIDER,
    MODEL: process.env.LLM_MODEL ?? DEFAULT_MODELS[LLM_PROVIDER] ?? DEFAULT_MODELS.groq,
    BASE_URL: process.env.LLM_BASE_URL ?? 'https://api.groq.com/openai/v1',
    JSON_MODE: process.env.LLM_JSON_MODE !== 'false',

    BRIEF_MAX_TOKENS: Number(process.env.BRIEF_MAX_TOKENS ?? 150),
    NEGOTIATE_MAX_TOKENS: Number(process.env.NEGOTIATE_MAX_TOKENS ?? 300),
    DELIBERATION_TIMEOUT_MS: Number(process.env.DELIBERATION_TIMEOUT_MS ?? 8_000),
    MAX_MESSAGES_PER_TICK: 3,
    BRIEF_MAX_SENTENCES: 2,
  },
};

export const TEAM = { LOYALIST: 'LOYALIST', SABOTEUR: 'SABOTEUR' };
export const PHASE = {
  DELIBERATE: 'DELIBERATE',
  SETTLE: 'SETTLE',
  BRIEF: 'BRIEF',
  MOVE: 'MOVE',
};

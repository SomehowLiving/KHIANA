import { CONFIG } from '../config.js';

/**
 * Provider-agnostic model wrapper with a hard timeout.
 *
 * Groq by default — the free tier removes the per-call cost anxiety that
 * otherwise pushes you into under-prompting the agents, and its latency is
 * well inside the tick budget. Anthropic is kept as a drop-in alternative
 * because the two differ only in wire format, and being locked to one vendor
 * on demo night is a risk with no upside.
 *
 * Everything is env-driven (LLM_PROVIDER / LLM_MODEL / LLM_BASE_URL) so
 * swapping model or vendor never requires a code change.
 *
 * Latency discipline is the difference between a game that breathes and one
 * that stalls. All 8 agents deliberate in PARALLEL with a hard cap. An agent
 * that times out simply does nothing that tick — never let one slow call
 * stall the world, and never show the room a spinner longer than 2 seconds.
 */

const { PROVIDER, MODEL, BASE_URL, JSON_MODE } = CONFIG.AGENT;

/**
 * Live call telemetry.
 *
 * Exists so the claim "the advisors are really calling an LLM" can be checked
 * rather than believed. A judge should be able to watch the call count climb
 * and the round-trip latency move while the game runs; a canned script cannot
 * fake a latency distribution.
 */
export const llmStats = {
  calls: 0,
  failures: 0,
  totalMs: 0,
  lastMs: null,
  lastAt: null,
  lastModel: null,
  recent: [],          // rolling window of the last few calls
};

function recordCall(ms, ok, kind) {
  llmStats.calls++;
  if (!ok) llmStats.failures++;
  llmStats.totalMs += ms;
  llmStats.lastMs = ms;
  llmStats.lastAt = new Date().toISOString();
  llmStats.lastModel = MODEL;
  llmStats.recent.unshift({ ms, ok, kind, at: llmStats.lastAt });
  if (llmStats.recent.length > 12) llmStats.recent.pop();
}

function apiKey() {
  return PROVIDER === 'anthropic'
    ? process.env.ANTHROPIC_API_KEY
    : process.env.GROQ_API_KEY;
}

export function providerStatus() {
  return {
    provider: PROVIDER,
    model: MODEL,
    keyPresent: Boolean(apiKey()),
    mock: CONFIG.MOCK_LLM,
    baseUrl: BASE_URL,
    calls: llmStats.calls,
    failures: llmStats.failures,
    avgMs: llmStats.calls ? Math.round(llmStats.totalMs / llmStats.calls) : null,
    lastMs: llmStats.lastMs,
    lastAt: llmStats.lastAt,
    recent: llmStats.recent,
  };
}

/**
 * One completion.
 *
 * @param {string}  system    system prompt
 * @param {string}  user      user turn
 * @param {number}  maxTokens hard output cap
 * @param {number}  timeoutMs abort budget
 * @param {boolean} json      ask the provider to guarantee parseable JSON
 */
export async function callModel({ system, user, maxTokens = 300, timeoutMs = 8000, json = false }) {
  const key = apiKey();
  if (!key) throw new Error(`No ${PROVIDER} API key — using fallback brain`);

  // AbortController rather than a dangling Promise.race: a raced-away fetch
  // keeps running and, with 8 agents a tick for 40 ticks, those add up into
  // rate-limit pressure for responses nobody will ever read.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();

  try {
    const out = PROVIDER === 'anthropic'
      ? await callAnthropic({ key, system, user, maxTokens, signal: ac.signal })
      : await callOpenAICompatible({ key, system, user, maxTokens, json, signal: ac.signal });
    recordCall(Date.now() - t0, true, json ? 'decision' : 'briefing');
    return out;
  } catch (err) {
    recordCall(Date.now() - t0, false, json ? 'decision' : 'briefing');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Groq and anything else speaking the OpenAI chat-completions dialect.
 * Plain fetch — the wire format is three fields, and a dependency whose only
 * job is to build this object is a dependency that can break the build.
 */
async function callOpenAICompatible({ key, system, user, maxTokens, json, signal }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  // Structured output turns a whole class of "the model wrapped it in prose"
  // parse failures into non-events. Not every model supports it, so a refusal
  // is retried unstructured rather than dropping the agent's whole turn.
  if (json && JSON_MODE) body.response_format = { type: 'json_object' };

  let res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok && body.response_format) {
    delete body.response_format;
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${PROVIDER} ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error(`${PROVIDER}: no content in response`);
  return text;
}

async function callAnthropic({ key, system, user, maxTokens, signal }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

/**
 * Run every agent's deliberation concurrently. Failures are swallowed
 * individually so one bad agent can't take down the tick.
 */
export async function deliberateAll(agents, runner) {
  const results = await Promise.allSettled(agents.map(a => runner(a)));
  return results.map((r, i) => ({
    agent: agents[i],
    actions: r.status === 'fulfilled' ? r.value : null,
    failed: r.status === 'rejected',
  }));
}

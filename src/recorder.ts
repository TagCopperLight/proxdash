// Every minute: account quota readings and the per-request usage queue, into SQLite.
import { credentials, drainUsage, type UsageRecord } from "./admin";
import { db, insertReading, insertRequest, prune, RETENTION_MS, type Reading, type RequestRow } from "./db";
import { projectOf, subagents } from "./transcripts";

const INTERVAL_MS = 60_000;
const PREFIX = "Anthropic-Ratelimit-Unified-";

/** Readings ride on every Anthropic response; the proxy also keeps each account's latest. */
function reading(account: string, ts: number, get: (name: string) => string | undefined): Reading | null {
  const num = (name: string) => {
    const v = get(PREFIX + name);
    return v === undefined || v === "" ? null : Number(v);
  };
  const r = {
    account, ts,
    u5: num("5h-Utilization"), r5: num("5h-Reset"), s5: get(PREFIX + "5h-Status") ?? null,
    u7: num("7d-Utilization"), r7: num("7d-Reset"), s7: get(PREFIX + "7d-Status") ?? null,
  };
  if (r.u5 === null && r.u7 === null) return null;
  return { ...r, r5: r.r5 && r.r5 * 1000, r7: r.r7 && r.r7 * 1000 };
}

export async function recordRequest(r: UsageRecord) {
  const ts = Date.parse(r.timestamp);
  const b = r.token_breakdown;
  insertRequest.run({
    id: r.request_id,
    ts,
    account: r.source,
    model: r.model,
    input: b?.input.uncached_tokens ?? r.tokens.input_tokens,
    output: b?.output.total_tokens ?? r.tokens.output_tokens,
    cache_read: b?.input.cache_read_tokens ?? r.tokens.cache_read_tokens,
    cache_write: b?.input.cache_write_tokens ?? r.tokens.cache_creation_tokens,
    latency_ms: r.latency_ms,
    ttft_ms: r.ttft_ms ?? null,
    status: r.failed ? r.fail?.status_code || 0 : 200,
    error: r.failed ? r.fail?.body.slice(0, 2000) || null : null,
    session_id: r.session_id || null,
    project: r.session_id ? await projectOf(r.session_id) : null,
    parent: null,
  });
  const headers = r.response_headers;
  const rd = headers && reading(r.source, ts, (n) => headers[n]?.[0]);
  if (rd) insertReading.run(rd);
}

const unresolved = db.query<{ id: string; session_id: string }, [number]>(
  "SELECT id, session_id FROM requests WHERE project IS NULL AND session_id IS NOT NULL AND ts > ?",
);
const setProject = db.query("UPDATE requests SET project = ? WHERE id = ?");
// A failed request has no reply in any transcript.
const unmatched = db.query<RequestRow, [number]>("SELECT * FROM requests WHERE parent IS NULL AND status = 200 AND ts > ?");
// A subagent works for its parent's project.
const setParent = db.query("UPDATE requests SET parent = ?, project = ? WHERE id = ?");
/** Subagent replies reach their transcript within seconds; requests stay open to a match for this long. */
const AGENT_LAG_MS = 10 * 60_000;

async function matchAgents(since: number) {
  const parentOf = await subagents(since);
  for (const r of unmatched.all(since)) {
    const parent = parentOf(r, r.ts);
    if (parent) setParent.run(parent, await projectOf(parent), r.id);
  }
}

export async function tick() {
  for (const c of await credentials()) {
    if (c.provider !== "claude" || !c.quota || !c.email) continue;
    const signals = c.quota.signals;
    const rd = reading(c.email, Date.parse(c.quota.observed_at), (n) => signals[n]);
    if (rd) insertReading.run(rd);
  }
  for (const r of await drainUsage()) await recordRequest(r);
  // A transcript can appear after its first request was recorded.
  for (const { id, session_id } of unresolved.all(Date.now() - 24 * 3600_000)) {
    const p = await projectOf(session_id);
    if (p) setProject.run(p, id);
  }
  await matchAgents(Date.now() - AGENT_LAG_MS);
  prune();
}

export function start() {
  const run = () => tick().catch((e) => console.error("recorder:", e.message ?? e));
  // Requests recorded before subagents were told apart, or while the service was down.
  matchAgents(Date.now() - RETENTION_MS).catch((e) => console.error("recorder:", e.message ?? e));
  run();
  setInterval(run, INTERVAL_MS);
}

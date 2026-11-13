// Anthropic's usage endpoint: reset credits, limit resets Anthropic grants an account, which Claude Code can spend
// to clear its limits early; and the account's quota, which costs no tokens to read, unlike a request.
import { $ } from "bun";
import { AdminError, accountGet, credentials, type Credential } from "./admin";
import { insertReading } from "./db";

/** Resets change a few times a month: asking Anthropic on every one-minute page refresh would only add load. */
const FRESH_MS = 5 * 60_000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";

/** One grant: `clears` and `percent_used` name limits by Anthropic's keys (five_hour, seven_day, …). */
type Grant = {
  id: string;
  label: string;
  resets_total: number;
  resets_left: number;
  starts_at: string | null;
  ends_at: string | null;
  clears: string[];
  percent_used: Record<string, number>;
  paused: boolean;
  usable_now: boolean;
  unavailable_reason: string | null;
};
type Window = { utilization: number; resets_at: string } | null;
type Usage = {
  five_hour: Window;
  seven_day: Window;
  cedar_ember: {
    eligible: boolean;
    ineligible_reason: string | null;
    grants: Grant[];
    next_grant_id: string | null;
    cooldown_until: string | null;
  } | null;
  limits: { kind: string; scope: { model: { display_name: string } | null } | null }[];
};

export type Resets =
  | { email: string; error: string }
  | {
      email: string;
      eligible: boolean;
      ineligible_reason: string | null;
      cooldown_until: string | null;
      next_grant_id: string | null;
      grants: Grant[];
      /** The model of the weekly limit kept for one model, which grants call seven_day_overage_included. */
      scoped: string | null;
    };

/** Anthropic only offers resets to Claude Code, and to a recent enough one: it asks as the installed CLI. */
const userAgent = async () => `claude-cli/${(await $`claude --version`.text()).split(" ")[0]} (external, cli)`;

/** Utilization comes in percent here, in fractions in the response headers readings are made from. */
const used = (w: Window) => (w ? w.utilization / 100 : null);
const resetAt = (w: Window) => (w ? Date.parse(w.resets_at) : null);

async function read(email: string, authIndex: string): Promise<Resets> {
  const usage = await accountGet<Usage>(authIndex, USAGE_URL, {
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": await userAgent(),
  });
  const { five_hour: h5, seven_day: d7 } = usage;
  if (h5 || d7)
    insertReading.run({ account: email, ts: Date.now(), u5: used(h5), r5: resetAt(h5), s5: null, u7: used(d7), r7: resetAt(d7), s7: null });
  const c = usage.cedar_ember;
  if (!c) return { email, error: "Anthropic sent no reset credits" };
  return {
    email,
    eligible: c.eligible,
    ineligible_reason: c.ineligible_reason,
    cooldown_until: c.cooldown_until,
    next_grant_id: c.next_grant_id,
    grants: c.grants,
    scoped: usage.limits.find((l) => l.kind === "weekly_scoped")?.scope?.model?.display_name ?? null,
  };
}

const cache = new Map<string, { at: number; value: Resets }>();

async function readAndCache({ email, auth_index }: Credential) {
  const value = await read(email!, auth_index);
  cache.set(email!, { at: Date.now(), value });
  return value;
}

export async function resets(): Promise<Resets[]> {
  const now = Date.now();
  const claude = (await credentials()).filter((c) => c.provider === "claude" && c.email);
  return Promise.all(claude.map(async (c) => {
    const hit = cache.get(c.email!);
    if (hit && now - hit.at < FRESH_MS) return hit.value;
    // A failure is asked again on the next refresh, not held for minutes.
    try {
      return await readAndCache(c);
    } catch (e) {
      return { email: c.email!, error: (e as Error).message };
    }
  }));
}

/** Asks Anthropic now for one account, past the cache: its quota lands in readings, its resets in the cache. */
export async function refresh(id: string) {
  const c = (await credentials()).find((c) => c.name === id);
  if (!c?.email) throw new AdminError(404, `no account ${id}`);
  await readAndCache(c);
}

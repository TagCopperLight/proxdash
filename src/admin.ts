// Client for CLIProxyAPI's management API. Only this service holds the key; the page goes through it.
import { homedir } from "node:os";

export const PROXY = process.env.PROXDASH_PROXY ?? "http://127.0.0.1:8317";
const BASE = `${PROXY}/v8/management`;
/** The older management API, kept by the proxy for the routes v8 lacks. */
const BASE_V0 = `${PROXY}/v0/management`;
const KEY_FILE = process.env.PROXDASH_KEY_FILE ?? `${homedir()}/.cli-proxy-api/management-key`;
const key = (await Bun.file(KEY_FILE).text()).trim();

export class AdminError extends Error {
  constructor(readonly status: number, body: string) {
    super(body || `proxy answered ${status}`);
  }
}

/** Raw call: the page's forwarded requests and the recorder both go through here. */
export const call = (method: string, path: string, body?: string, contentType?: string) => send(BASE + path, method, body, contentType);

async function send(url: string, method: string, body?: string, contentType = "application/json", signal?: AbortSignal) {
  const res = await fetch(url, {
    method,
    body,
    signal,
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": contentType }) },
  });
  if (!res.ok) throw new AdminError(res.status, await res.text());
  return res;
}

export const json = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
  (await call(method, path, body === undefined ? undefined : JSON.stringify(body))).json() as Promise<T>;

/** Anthropic's own words from an error body, or the body itself when it isn't their JSON. */
function anthropicError(body: string) {
  try {
    return (JSON.parse(body) as { error: { message: string } }).error.message;
  } catch {
    return body.slice(0, 300);
  }
}

/** A GET to Anthropic made with an account's own token, which the proxy puts in place of $TOKEN$. */
export async function accountGet<T>(authIndex: string, url: string, headers: Record<string, string>): Promise<T> {
  // The proxy waits on Anthropic for as long as it takes, and the Usage page waits on this.
  const res = await send(`${BASE_V0}/api-call`, "POST", JSON.stringify({
    auth_index: authIndex, method: "GET", url, header: { ...headers, Authorization: "Bearer $TOKEN$" },
  }), undefined, AbortSignal.timeout(10_000));
  const { status_code, body } = (await res.json()) as { status_code: number; body: string };
  if (status_code < 200 || status_code >= 300) throw new AdminError(502, `Anthropic answered ${status_code}: ${anthropicError(body)}`);
  return JSON.parse(body) as T;
}

export type Signals = Record<string, string>;
export type Credential = {
  name: string;
  auth_index: string;
  email?: string;
  label?: string;
  provider: string;
  disabled: boolean;
  quota?: { observed_at: string; signals: Signals };
};

export type UsageRecord = {
  timestamp: string;
  latency_ms: number;
  ttft_ms?: number;
  source: string;
  model: string;
  failed: boolean;
  fail?: { status_code: number; body: string };
  request_id: string;
  session_id?: string;
  token_breakdown?: {
    input: { uncached_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
    output: { total_tokens: number };
  };
  tokens: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number };
  response_headers?: Record<string, string[]>;
};

export const credentials = async () => (await json<{ files: Credential[] }>("GET", "/credentials")).files;
const BATCH = 500;
/** Pops every queued record: whoever reads the queue first gets them, so proxdash must be its only reader. */
export async function drainUsage() {
  const all: UsageRecord[] = [];
  for (;;) {
    // The queue hands out one record per call unless asked for more.
    const batch = await json<UsageRecord[]>("GET", `/observability/usage/queue?count=${BATCH}`);
    all.push(...batch);
    if (batch.length < BATCH) return all;
  }
}

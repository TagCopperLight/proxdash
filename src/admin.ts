// Client for CLIProxyAPI's management API. Only this service holds the key; the page goes through it.
import { homedir } from "node:os";

export const PROXY = process.env.PROXDASH_PROXY ?? "http://127.0.0.1:8317";
const BASE = `${PROXY}/v8/management`;
const KEY_FILE = process.env.PROXDASH_KEY_FILE ?? `${homedir()}/.cli-proxy-api/management-key`;
const key = (await Bun.file(KEY_FILE).text()).trim();

export class AdminError extends Error {
  constructor(readonly status: number, body: string) {
    super(body || `proxy answered ${status}`);
  }
}

/** Raw call: the page's forwarded requests and the recorder both go through here. */
export async function call(method: string, path: string, body?: string, contentType = "application/json") {
  const res = await fetch(BASE + path, {
    method,
    body,
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": contentType }) },
  });
  if (!res.ok) throw new AdminError(res.status, await res.text());
  return res;
}

export const json = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
  (await call(method, path, body === undefined ? undefined : JSON.stringify(body))).json() as Promise<T>;

export type Signals = Record<string, string>;
export type Credential = {
  name: string;
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

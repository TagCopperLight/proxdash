import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

const DIR = process.env.PROXDASH_DATA ?? `${homedir()}/.local/share/proxdash`;
mkdirSync(DIR, { recursive: true });

export const db = new Database(`${DIR}/proxdash.db`, { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");
db.run(`CREATE TABLE IF NOT EXISTS readings (
  account TEXT NOT NULL,
  ts INTEGER NOT NULL,           -- ms, when the proxy saw these numbers
  u5 REAL, r5 INTEGER, s5 TEXT,  -- 5h window: utilization 0..1, reset (ms), status
  u7 REAL, r7 INTEGER, s7 TEXT,  -- 7d window
  PRIMARY KEY (account, ts)
)`);
db.run(`CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  account TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL, ttft_ms INTEGER,
  status INTEGER NOT NULL, error TEXT,
  session_id TEXT, project TEXT,
  parent TEXT                    -- for a subagent's request, the session that started the subagent
)`);
// Databases from before subagents were told apart lack the column.
if (!db.query<{ name: string }, []>("PRAGMA table_info(requests)").all().some((c) => c.name === "parent"))
  db.run("ALTER TABLE requests ADD COLUMN parent TEXT");
db.run("CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts)");
// The proxy only knows accounts by email; the name shown everywhere is chosen here.
db.run("CREATE TABLE IF NOT EXISTS names (account TEXT PRIMARY KEY, name TEXT NOT NULL)");

export const RETENTION_MS = 30 * 24 * 3600_000;

export type Reading = {
  account: string;
  ts: number;
  u5: number | null; r5: number | null; s5: string | null;
  u7: number | null; r7: number | null; s7: string | null;
};
export type RequestRow = {
  id: string; ts: number; account: string; model: string;
  input: number; output: number; cache_read: number; cache_write: number;
  latency_ms: number; ttft_ms: number | null; status: number; error: string | null;
  session_id: string | null; project: string | null; parent: string | null;
};

export const insertReading = db.prepare<void, Reading>(
  `INSERT OR IGNORE INTO readings VALUES ($account, $ts, $u5, $r5, $s5, $u7, $r7, $s7)`,
);
export const insertRequest = db.prepare<void, RequestRow>(
  `INSERT OR IGNORE INTO requests VALUES ($id, $ts, $account, $model, $input, $output, $cache_read, $cache_write,
   $latency_ms, $ttft_ms, $status, $error, $session_id, $project, $parent)`,
);

export function prune(now = Date.now()) {
  db.run("DELETE FROM requests WHERE ts < ?", [now - RETENTION_MS]);
  db.run("DELETE FROM readings WHERE ts < ?", [now - RETENTION_MS]);
}

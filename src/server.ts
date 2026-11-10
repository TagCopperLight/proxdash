import { parseDocument } from "yaml";
import { AdminError, call, credentials, json } from "./admin";
import { db, type Reading, type RequestRow } from "./db";
import { start } from "./recorder";

const PORT = Number(process.env.PROXDASH_PORT ?? 8318);
const PUBLIC = `${import.meta.dir}/../public`;

const latestReading = db.query<Reading, [string]>("SELECT * FROM readings WHERE account = ? ORDER BY ts DESC LIMIT 1");
const readingsSince = db.query<Reading, [number]>("SELECT * FROM readings WHERE ts >= ? ORDER BY ts");

async function accounts() {
  return (await credentials())
    .filter((c) => c.provider === "claude")
    .map((c) => ({
      name: c.name,
      email: c.email ?? c.label ?? c.name,
      disabled: c.disabled,
      reading: (c.email && latestReading.get(c.email)) || null,
    }));
}

function requests(q: URLSearchParams) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const eq = (col: string, v: string | null) => v && (where.push(`${col} = ?`), args.push(v));
  eq("account", q.get("account"));
  eq("model", q.get("model"));
  if (q.get("project") === "(none)") where.push("project IS NULL");
  else eq("project", q.get("project"));
  if (q.get("status") === "ok") where.push("status = 200");
  if (q.get("status") === "failed") where.push("status <> 200");
  const before = Number(q.get("before"));
  if (before) where.push("ts < ?"), args.push(before);
  const sql = `SELECT * FROM requests ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT 200`;
  const facet = (col: string) =>
    db.query<{ v: string }, []>(`SELECT DISTINCT ${col} AS v FROM requests WHERE ${col} IS NOT NULL ORDER BY v`).all().map((r) => r.v);
  return {
    rows: db.query<RequestRow, (string | number)[]>(sql).all(...args),
    facets: { account: facet("account"), project: facet("project"), model: facet("model") },
  };
}

// The few settings the form edits; everything else goes through the raw YAML tab.
const FORM = {
  strategy: { path: ["routing", "strategy"], fallback: "round-robin" },
  affinity: { path: ["routing", "session-affinity"], fallback: false },
  affinityTtl: { path: ["routing", "session-affinity-ttl"], fallback: "1h" },
  retry: { path: ["routing", "retry", "request-retry"], fallback: 3 },
} as const;

const configYaml = async () => (await call("GET", "/config.yaml")).text();
const saveYaml = (text: string) => call("PUT", "/config.yaml", text, "application/yaml");

async function config() {
  const text = await configYaml();
  const doc = parseDocument(text);
  const form = Object.fromEntries(Object.entries(FORM).map(([k, f]) => [k, doc.getIn(f.path) ?? f.fallback]));
  return { yaml: text, form };
}

async function saveForm(form: Record<string, unknown>) {
  const doc = parseDocument(await configYaml());
  for (const [k, f] of Object.entries(FORM)) if (k in form) doc.setIn(f.path, form[k]);
  await saveYaml(doc.toString());
}

type Handler = (req: Request, params: Record<string, string>) => Promise<unknown>;
const ok = { status: "ok" };
const routes: [string, string, Handler][] = [
  ["GET", "/api/accounts", () => accounts()],
  ["GET", "/api/readings", async (req) => readingsSince.all(Number(new URL(req.url).searchParams.get("since") ?? 0))],
  ["PATCH", "/api/accounts/:name", async (req, p) => {
    const { disabled } = (await req.json()) as { disabled: boolean };
    return json("PATCH", "/credentials/status", { name: p.name, disabled });
  }],
  ["DELETE", "/api/accounts/:name", (_, p) => json("DELETE", "/credentials", { names: [p.name] })],
  ["POST", "/api/signin", () => json("GET", "/oauth/auth-url?provider=claude&is_webui=true")],
  ["GET", "/api/signin/:state", (_, p) => json("GET", `/oauth/status?state=${encodeURIComponent(p.state!)}`)],
  ["DELETE", "/api/signin/:state", (_, p) => json("DELETE", `/oauth/session?state=${encodeURIComponent(p.state!)}`)],
  ["POST", "/api/signin-callback", async (req) => {
    const { redirect_url } = (await req.json()) as { redirect_url: string };
    return json("POST", "/oauth/callback", { provider: "claude", redirect_url });
  }],
  ["GET", "/api/requests", async (req) => requests(new URL(req.url).searchParams)],
  ["GET", "/api/config", () => config()],
  ["PUT", "/api/config/form", async (req) => (await saveForm((await req.json()) as Record<string, unknown>), ok)],
  ["PUT", "/api/config/yaml", async (req) => (await saveYaml(await req.text()), ok)],
];

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) {
      const found = route(req.method, pathname);
      if (!found) return Response.json({ error: "not found" }, { status: 404 });
      try {
        return Response.json((await found.handler(req, found.params)) ?? ok);
      } catch (e) {
        const status = e instanceof AdminError ? e.status : 500;
        return Response.json({ error: (e as Error).message }, { status });
      }
    }
    const file = Bun.file(`${PUBLIC}${pathname === "/" ? "/index.html" : pathname}`);
    return (await file.exists()) && !pathname.includes("..") ? new Response(file) : new Response(Bun.file(`${PUBLIC}/index.html`));
  },
});

function route(method: string, path: string) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const want = pattern.split("/");
    const got = path.split("/");
    if (want.length !== got.length) continue;
    const params: Record<string, string> = {};
    const hit = want.every((w, i) => {
      if (!w.startsWith(":")) return w === got[i];
      params[w.slice(1)] = decodeURIComponent(got[i]!);
      return true;
    });
    if (hit) return { handler, params };
  }
  return null;
}

start();
console.log(`proxdash on http://127.0.0.1:${PORT}`);

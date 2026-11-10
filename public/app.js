// proxdash page: four views over the proxdash service's /api.
const H = 3600_000;
const WINDOWS = { "7d": { ms: 7 * 24 * H, key: "7", label: "weekly" }, "5h": { ms: 5 * H, key: "5", label: "5-hour" } };
const STALE_MS = 30 * 60_000;
const $page = document.getElementById("page");
const $tip = document.getElementById("tooltip");

const pref = {
  get: (k, d) => { try { return localStorage.getItem("proxdash." + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem("proxdash." + k, v); } catch {} },
};

async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (f) => `${Math.round(f * 100)}%`;
/** Rates are small: keep one decimal under 10%. */
const pct1 = (f) => (f * 100 < 10 ? `${(f * 100).toFixed(1)}%` : pct(f));
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

function ago(ts, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function until(ts, now = Date.now()) {
  const m = Math.round(Math.max(0, (ts - now) / 60_000));
  if (m < 60) return `in ${m} min`;
  if (m < 48 * 60) return `in ${Math.floor(m / 60)} h ${m % 60} min`;
  return `in ${Math.round(m / 1440)} d`;
}
const clock = (ts) => {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
};

// Emails stay blurred until clicked; one click reveals them all for the visit.
let revealed = false;
const email = (e) => `<span class="email ${revealed ? "" : "blur"}" title="click to show">${esc(e)}</span>`;
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".email")) return;
  revealed = !revealed;
  document.querySelectorAll(".email").forEach((el) => el.classList.toggle("blur", !revealed));
});

function seg(name, options, current) {
  return `<div class="seg" data-seg="${name}">${options
    .map(([v, label]) => `<button data-v="${v}" class="${v === current ? "on" : ""}">${label}</button>`)
    .join("")}</div>`;
}
function onSeg(name, fn) {
  $page.querySelector(`[data-seg="${name}"]`)?.addEventListener("click", (ev) => {
    const v = ev.target.closest("button")?.dataset.v;
    if (v) fn(v);
  });
}

// ---------------------------------------------------------------- quota model

/** Used fraction at time t from a reading: a reading whose reset has passed means a fresh window. */
function usedAt(rd, w, t) {
  const u = rd?.["u" + w.key];
  if (u == null) return 0;
  const r = rd["r" + w.key];
  return r && t >= r ? 0 : u;
}
/** The next reset after t, rolling a passed reset forward by whole windows. */
function nextReset(rd, w, t) {
  let r = rd?.["r" + w.key];
  if (!r) return t + w.ms;
  if (r <= t) r += Math.ceil((t - r) / w.ms) * w.ms;
  return r;
}

/** Pool remaining (sum over accounts, each 0..1) sampled on a grid, from the readings history. */
function history(readings, accounts, w, from, to, step) {
  const latest = new Map();
  const points = [];
  let i = 0;
  for (let t = from; t <= to + 1; t += step) {
    const at = Math.min(t, to);
    while (i < readings.length && readings[i].ts <= at) latest.set(readings[i].account, readings[i++]);
    if (!latest.size) continue;
    points.push([at, accounts.reduce((s, a) => s + 1 - usedAt(latest.get(a), w, at), 0)]);
  }
  return points;
}

/** Pool burn per hour (in account fractions) over the last `hours`, adding up rises between readings. */
function burnRate(readings, accounts, w, now, hours) {
  const from = now - hours * H;
  let used = 0;
  for (const a of accounts) {
    let prev = null;
    for (const rd of readings) {
      if (rd.account !== a) continue;
      if (rd.ts < from) { prev = rd; continue; }
      const u = usedAt(rd, w, rd.ts);
      if (prev) {
        const reset = prev["r" + w.key] && prev["r" + w.key] <= rd.ts;
        used += Math.max(0, reset ? u : u - usedAt(prev, w, rd.ts));
      }
      prev = rd;
    }
  }
  return used / hours;
}

/** Walks forward at the burn rate, spreading it over accounts that still have room, refilling at resets. */
function project(latest, accounts, w, now, rate, horizon) {
  const state = accounts.map((a) => ({ a, rem: 1 - usedAt(latest.get(a), w, now), reset: nextReset(latest.get(a), w, now) }));
  const step = horizon / 240;
  const points = [[now, state.reduce((s, x) => s + x.rem, 0)]];
  let firstOut = null, poolOut = null;
  const firstReset = Math.min(...state.map((x) => x.reset));
  for (let t = now + step; t <= now + horizon; t += step) {
    for (const x of state) if (t >= x.reset) { x.rem = 1; x.reset += w.ms; }
    const live = state.filter((x) => x.rem > 0);
    let burn = rate * (step / H);
    while (burn > 1e-9 && live.length) {
      const share = burn / live.length;
      burn = 0;
      for (const x of live) {
        const take = Math.min(x.rem, share);
        x.rem -= take;
        burn += share - take;
      }
      live.splice(0, live.length, ...live.filter((x) => x.rem > 0));
    }
    if (firstOut == null && state.some((x) => x.rem <= 0)) firstOut = t;
    if (poolOut == null && state.every((x) => x.rem <= 0)) poolOut = t;
    points.push([t, state.reduce((s, x) => s + x.rem, 0)]);
  }
  return { points, firstOut, poolOut, firstReset };
}

// ---------------------------------------------------------------- chart

function chart(el, { recorded, projected, max, from, to, now }) {
  const W = el.clientWidth || 800, Hh = 240, m = { l: 44, r: 12, t: 10, b: 26 };
  const x = (t) => m.l + ((t - from) / (to - from)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v / max) * (Hh - m.t - m.b);
  const path = (pts) => pts.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const yTicks = Array.from({ length: max * 2 + 1 }, (_, i) => i * 0.5);
  const span = to - from;
  const tickStep = span > 3 * 24 * H ? 24 * H : span > 12 * H ? 3 * H : H;
  const xTicks = [];
  const start = new Date(from); start.setMinutes(0, 0, 0);
  if (tickStep === 24 * H) start.setHours(0);
  for (let t = start.getTime() + tickStep; t < to; t += tickStep) if (t > from) xTicks.push(t);
  const fmt = (t) => new Date(t).toLocaleString(undefined, tickStep === 24 * H ? { weekday: "short" } : { hour: "2-digit", minute: "2-digit" });
  const area = recorded.length ? `${path(recorded)}L${x(recorded.at(-1)[0])},${y(0)}L${x(recorded[0][0])},${y(0)}Z` : "";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" height="${Hh}">
    <g class="grid">${yTicks.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`).join("")}</g>
    <g class="axis">${yTicks.map((v) => `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`).join("")}
      ${xTicks.map((t) => `<text x="${x(t)}" y="${Hh - 6}" text-anchor="middle">${fmt(t)}</text>`).join("")}</g>
    <line class="now" x1="${x(now)}" x2="${x(now)}" y1="${m.t}" y2="${y(0)}"/>
    <path class="area" d="${area}"/>
    <path class="rec" d="${path(recorded)}"/>
    <path class="proj" d="${path(projected)}"/>
    <line class="cross" y1="${m.t}" y2="${y(0)}" visibility="hidden"/>
    <circle class="marker" r="4.5" visibility="hidden"/>
    <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${Hh}" fill="transparent"/>
  </svg>`;
  const all = [...recorded.map((p) => [...p, false]), ...projected.slice(1).map((p) => [...p, true])];
  const svg = el.querySelector("svg"), cross = svg.querySelector(".cross"), mark = svg.querySelector(".marker");
  svg.addEventListener("mousemove", (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    let best = null;
    for (const p of all) if (!best || Math.abs(x(p[0]) - px) < Math.abs(x(best[0]) - px)) best = p;
    if (!best) return;
    for (const [k, v] of [["x1", x(best[0])], ["x2", x(best[0])]]) cross.setAttribute(k, v);
    mark.setAttribute("cx", x(best[0])); mark.setAttribute("cy", y(best[1]));
    cross.setAttribute("visibility", "visible"); mark.setAttribute("visibility", "visible");
    $tip.innerHTML = `<div class="t">${clock(best[0])}${best[2] ? " · projected" : ""}</div><b>${pct(best[1])}</b> left of ${max * 100}%`;
    $tip.hidden = false;
    $tip.style.left = Math.min(ev.clientX + 14, innerWidth - $tip.offsetWidth - 8) + "px";
    $tip.style.top = ev.clientY - 44 + "px";
  });
  svg.addEventListener("mouseleave", () => {
    $tip.hidden = true;
    cross.setAttribute("visibility", "hidden"); mark.setAttribute("visibility", "hidden");
  });
}

// ---------------------------------------------------------------- pages

const meter = (rem) => `<div class="meter"><div class="track"><i style="width:${Math.max(0, rem) * 100}%"></i></div><span>${pct(rem)}</span></div>`;

function statusBadge(acc, now) {
  if (acc.disabled) return `<span class="badge">disabled</span>`;
  const rd = acc.reading;
  if (!rd) return `<span class="badge warn">no reading yet</span>`;
  for (const w of Object.values(WINDOWS)) {
    const blocked = rd["s" + w.key] && rd["s" + w.key] !== "allowed";
    if ((blocked || usedAt(rd, w, now) >= 1) && rd["r" + w.key] > now)
      return `<span class="badge bad">out until ${clock(rd["r" + w.key])}</span>`;
  }
  return `<span class="badge ok">ok</span>`;
}

const readingAge = (rd, now) =>
  rd ? `<span class="${now - rd.ts > STALE_MS ? "stale" : "muted"}">${ago(rd.ts, now)}</span>` : `<span class="muted">never</span>`;

async function usagePage() {
  const win = pref.get("window", "7d"), burnH = Number(pref.get("burn", "3"));
  const w = WINDOWS[win];
  const now = Date.now();
  const back = win === "7d" ? w.ms : 2 * w.ms;
  const [accs, readings] = await Promise.all([api("GET", "/accounts"), api("GET", `/readings?since=${now - back - 8 * 24 * H}`)]);
  const pool = accs.filter((a) => !a.disabled).map((a) => a.email);
  const n = pool.length || 1;
  const latest = new Map();
  for (const rd of readings) if (rd.ts <= now) latest.set(rd.account, rd);
  const rate = burnRate(readings, pool, w, now, burnH);
  const proj = project(latest, pool, w, now, rate, back);
  const remaining = proj.points[0][1];
  const recorded = history(readings, pool, w, now - back, now, back / 300);
  const refill = pool.reduce((s, a) => s + (nextReset(latest.get(a), w, now) === proj.firstReset ? usedAt(latest.get(a), w, proj.firstReset - 1) : 0), 0);
  const perDay = win === "7d" ? ` · ≈${pct(rate * 24)} a day` : "";
  const when = (t) => (t ? `<div class="v">${until(t, now)}</div><div class="n">${clock(t)}</div>` : `<div class="v">not in view</div><div class="n">at this pace</div>`);

  $page.innerHTML = `
    <div class="head">
      <div><h1>Usage</h1><div class="sub">${pool.length} account${pool.length === 1 ? "" : "s"} in the pool · ${w.label} window</div></div>
      <div class="controls">${seg("window", [["7d", "Weekly"], ["5h", "5 hours"]], win)}</div>
    </div>
    <div class="panel">
      <h2>Pool left</h2>
      <div class="hero"><b>${pct(remaining)}</b><span>of ${n * 100}%</span></div>
      <div class="bar">${pool.map((a) => `<i style="flex:${Math.max(0.001, 1 - usedAt(latest.get(a), w, now))}"></i>`).join("")}<span style="flex:${Math.max(0.001, n - remaining)}"></span></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">Pool runs out</div>${rate ? when(proj.poolOut) : `<div class="v">—</div><div class="n">no use in the last ${burnH} h</div>`}</div>
      <div class="stat"><div class="k">First account runs out</div>${rate ? when(proj.firstOut) : `<div class="v">—</div><div class="n">no use in the last ${burnH} h</div>`}</div>
      <div class="stat"><div class="k">Next reset</div><div class="v">${until(proj.firstReset, now)}</div><div class="n">${clock(proj.firstReset)} · refills ${pct(refill)}</div></div>
      <div class="stat"><div class="k">Burn rate</div><div class="v">${pct1(rate)} / h</div><div class="n">last ${burnH} h${perDay}</div></div>
    </div>
    <div class="panel">
      <div class="head" style="margin-bottom:10px">
        <div class="legend"><span><i></i>Recorded</span><span><i class="dash"></i>Projected at the last ${burnH} h pace</span></div>
        <div class="controls"><label>Pace from</label>${seg("burn", [["1", "1 h"], ["3", "3 h"], ["6", "6 h"]], String(burnH))}</div>
      </div>
      <div class="chart" id="chart"></div>
    </div>
    <div class="panel wrap">
      <h2>Accounts</h2>
      <table>
        <tr><th>Account</th><th>Weekly left</th><th>Resets</th><th>5 h left</th><th>Resets</th><th>Status</th><th>Last reading</th></tr>
        ${accs.map((a) => {
          const rd = a.reading;
          return `<tr class="${a.disabled ? "dim" : ""}"><td>${email(a.email)}</td>
            <td>${meter(1 - usedAt(rd, WINDOWS["7d"], now))}</td><td class="muted">${rd ? until(nextReset(rd, WINDOWS["7d"], now), now) : "—"}</td>
            <td>${meter(1 - usedAt(rd, WINDOWS["5h"], now))}</td><td class="muted">${rd ? until(nextReset(rd, WINDOWS["5h"], now), now) : "—"}</td>
            <td>${statusBadge(a, now)}</td><td>${readingAge(rd, now)}</td></tr>`;
        }).join("")}
      </table>
      <div class="sub">Readings come with traffic: an idle account keeps its last numbers until it is used again.</div>
    </div>`;

  const draw = () => chart(document.getElementById("chart"), { recorded, projected: proj.points, max: n, from: now - back, to: now + back, now });
  draw();
  onSeg("window", (v) => { pref.set("window", v); render(); });
  onSeg("burn", (v) => { pref.set("burn", v); render(); });
  return draw;
}

async function accountsPage() {
  const accs = await api("GET", "/accounts");
  const now = Date.now();
  $page.innerHTML = `
    <div class="head"><div><h1>Accounts</h1><div class="sub">Claude accounts the proxy pools. Click an email to show it.</div></div>
      <button class="btn primary" id="signin">Sign in an account</button></div>
    <div id="signin-box"></div>
    <div class="panel wrap"><table>
      <tr><th>Enabled</th><th>Account</th><th>Weekly left</th><th>5 h left</th><th>Status</th><th>Last reading</th><th></th></tr>
      ${accs.map((a) => `<tr class="${a.disabled ? "dim" : ""}">
        <td><label class="switch"><input type="checkbox" data-toggle="${esc(a.name)}" ${a.disabled ? "" : "checked"}><i></i></label></td>
        <td>${email(a.email)}</td>
        <td>${meter(1 - usedAt(a.reading, WINDOWS["7d"], now))}</td>
        <td>${meter(1 - usedAt(a.reading, WINDOWS["5h"], now))}</td>
        <td>${statusBadge(a, now)}</td><td>${readingAge(a.reading, now)}</td>
        <td style="text-align:right"><button class="btn danger" data-remove="${esc(a.name)}">Remove</button></td></tr>`).join("")}
    </table></div>`;

  $page.querySelectorAll("[data-toggle]").forEach((el) =>
    el.addEventListener("change", async () => {
      try { await api("PATCH", `/accounts/${encodeURIComponent(el.dataset.toggle)}`, { disabled: !el.checked }); } catch (e) { alert(e.message); }
      render();
    }));
  $page.querySelectorAll("[data-remove]").forEach((el) =>
    el.addEventListener("click", async () => {
      if (!confirm("Remove this account from the proxy? Its sign-in file is deleted; you would need to sign in again.")) return;
      try { await api("DELETE", `/accounts/${encodeURIComponent(el.dataset.remove)}`); } catch (e) { alert(e.message); }
      render();
    }));
  document.getElementById("signin").addEventListener("click", signIn);
}

let signinPoll = null;
async function signIn() {
  const box = document.getElementById("signin-box");
  let s;
  try { s = await api("POST", "/signin"); } catch (e) { box.innerHTML = `<div class="panel err">${esc(e.message)}</div>`; return; }
  box.innerHTML = `<div class="panel">
    <h2>Sign in a Claude account</h2>
    <div>Open this link in a browser signed in to the account you want to add:</div>
    <div class="signin">
      <div class="row"><a href="${esc(s.url)}" target="_blank" rel="noopener" class="btn primary" style="text-decoration:none">Open Claude sign-in</a>
        <span id="signin-state" class="muted">Waiting for the sign-in…</span><button class="btn" id="signin-cancel">Cancel</button></div>
      <div class="muted">If the browser ends on an error page at localhost:54545, paste that page's address here:</div>
      <div class="row"><input type="text" id="signin-url" placeholder="http://localhost:54545/callback?code=…"><button class="btn" id="signin-send">Send</button></div>
    </div></div>`;
  const state = document.getElementById("signin-state");
  const stop = () => { clearInterval(signinPoll); signinPoll = null; };
  stop();
  signinPoll = setInterval(async () => {
    try {
      const st = await api("GET", `/signin/${encodeURIComponent(s.state)}`);
      if (st.status === "ok" || st.status === "success" || st.status === "done") { stop(); state.textContent = "Signed in."; state.className = "msg ok"; setTimeout(render, 1200); }
      else if (st.status === "error" || st.error) { stop(); state.textContent = st.error || "Sign-in failed."; state.className = "msg bad"; }
    } catch (e) { stop(); state.textContent = e.message; state.className = "msg bad"; }
  }, 2000);
  document.getElementById("signin-cancel").addEventListener("click", async () => {
    stop();
    await api("DELETE", `/signin/${encodeURIComponent(s.state)}`).catch(() => {});
    box.innerHTML = "";
  });
  document.getElementById("signin-send").addEventListener("click", async () => {
    try { await api("POST", "/signin-callback", { redirect_url: document.getElementById("signin-url").value.trim() }); state.textContent = "Sent, finishing…"; }
    catch (e) { state.textContent = e.message; state.className = "msg bad"; }
  });
}

let logFilter = {};
async function logsPage() {
  const q = new URLSearchParams(Object.entries(logFilter).filter(([, v]) => v));
  const first = await api("GET", `/requests?${q}`);
  const rows = [...first.rows];
  const pick = (name, values, label) => `<select data-filter="${name}"><option value="">${label}</option>${values
    .map((v) => `<option ${logFilter[name] === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>`;

  const row = (r) => `<tr>
    <td class="mono" title="${new Date(r.ts).toLocaleString()}">${clock(r.ts)}</td>
    <td>${r.project ? esc(r.project) : `<span class="muted">—</span>`}${r.session_id ? ` <span class="muted mono" title="${esc(r.session_id)}">${esc(r.session_id.slice(0, 8))}</span>` : ""}</td>
    <td>${email(r.account)}</td>
    <td class="mono">${esc(r.model.replace(/^claude-/, ""))}</td>
    <td class="num">${kfmt(r.input)}</td><td class="num">${kfmt(r.output)}</td><td class="num">${kfmt(r.cache_read)}</td><td class="num">${kfmt(r.cache_write)}</td>
    <td class="num">${(r.latency_ms / 1000).toFixed(1)} s</td>
    <td>${r.status === 200 ? `<span class="badge ok">200</span>` : `<span class="badge bad" title="${esc(r.error)}">${r.status || "failed"}</span>`}</td></tr>`;

  $page.innerHTML = `
    <div class="head"><div><h1>Logs</h1><div class="sub">Every request through the proxy, kept 30 days.</div></div>
      <div class="controls">
        ${pick("account", first.facets.account, "All accounts")}
        ${pick("project", ["(none)", ...first.facets.project], "All projects")}
        ${pick("model", first.facets.model, "All models")}
        <select data-filter="status"><option value="">Any status</option>
          <option value="ok" ${logFilter.status === "ok" ? "selected" : ""}>ok</option>
          <option value="failed" ${logFilter.status === "failed" ? "selected" : ""}>failed</option></select>
      </div></div>
    <div class="panel wrap"><table id="logs">
      <tr><th>Time</th><th>Project · session</th><th>Account</th><th>Model</th><th class="num">In</th><th class="num">Out</th>
        <th class="num">Cache read</th><th class="num">Cache write</th><th class="num">Duration</th><th>Status</th></tr>
      ${rows.length ? rows.map(row).join("") : `<tr><td colspan="10" class="muted">No requests recorded yet.</td></tr>`}
    </table>
    ${rows.length === 200 ? `<div class="more"><button class="btn" id="more">Load older</button></div>` : ""}</div>`;

  $page.querySelectorAll("[data-filter]").forEach((el) =>
    el.addEventListener("change", () => { logFilter = { ...logFilter, [el.dataset.filter]: el.value }; render(); }));
  document.getElementById("more")?.addEventListener("click", async (ev) => {
    const next = await api("GET", `/requests?${new URLSearchParams({ ...Object.fromEntries(q), before: rows.at(-1).ts })}`);
    rows.push(...next.rows);
    document.getElementById("logs").insertAdjacentHTML("beforeend", next.rows.map(row).join(""));
    if (next.rows.length < 200) ev.target.remove();
  });
}

async function configPage() {
  const tab = pref.get("configTab", "form");
  const { yaml, form } = await api("GET", "/config");
  $page.innerHTML = `
    <div class="head"><div><h1>Config</h1><div class="sub">The proxy's config.yaml. The proxy checks it on save.</div></div>
      ${seg("tab", [["form", "Settings"], ["yaml", "Raw YAML"]], tab)}</div>
    <div class="panel">${tab === "form" ? `
      <div class="form">
        <label for="f-strategy">Routing</label>
        <select id="f-strategy">${["round-robin", "fill-first", "weighted-round-robin"].map((s) => `<option ${form.strategy === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <div class="hint">round-robin spreads requests over the accounts; fill-first uses one until it runs out.</div>
        <label for="f-affinity">Session affinity</label>
        <label class="switch"><input type="checkbox" id="f-affinity" ${form.affinity ? "checked" : ""}><i></i></label>
        <div class="hint">Keeps a conversation on the same account, so its prompt cache stays warm.</div>
        <label for="f-ttl">Affinity lasts</label>
        <input type="text" id="f-ttl" value="${esc(form.affinityTtl)}" style="width:120px">
        <div class="hint">After this much idle time a conversation can move account (e.g. 30m, 1h).</div>
        <label for="f-retry">Retry rounds</label>
        <input type="number" id="f-retry" min="0" max="10" value="${esc(form.retry)}" style="width:120px">
        <div class="hint">Extra rounds over the accounts when every one failed (429, 5xx…).</div>
      </div>
      <div style="margin-top:20px"><button class="btn primary" id="save">Save</button><span id="msg" class="msg"></span></div>` : `
      <textarea id="yaml" spellcheck="false">${esc(yaml)}</textarea>
      <div style="margin-top:12px"><button class="btn primary" id="save">Save</button><span id="msg" class="msg"></span></div>`}
    </div>`;

  onSeg("tab", (v) => { pref.set("configTab", v); render(); });
  document.getElementById("save").addEventListener("click", async () => {
    const msg = document.getElementById("msg");
    try {
      if (tab === "form") {
        await api("PUT", "/config/form", {
          strategy: document.getElementById("f-strategy").value,
          affinity: document.getElementById("f-affinity").checked,
          affinityTtl: document.getElementById("f-ttl").value.trim(),
          retry: Number(document.getElementById("f-retry").value),
        });
      } else await api("PUT", "/config/yaml", document.getElementById("yaml").value);
      msg.textContent = "Saved."; msg.className = "msg ok";
    } catch (e) { msg.textContent = e.message; msg.className = "msg bad"; }
  });
}

// ---------------------------------------------------------------- shell

const PAGES = { usage: usagePage, accounts: accountsPage, logs: logsPage, config: configPage };
let redraw = null;

async function render() {
  const name = location.hash.slice(1) in PAGES ? location.hash.slice(1) : "usage";
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === name));
  try {
    redraw = (await PAGES[name]()) ?? null;
    setPulse(true);
  } catch (e) {
    $page.innerHTML = `<div class="panel err">${esc(e.message)}</div>`;
    setPulse(false);
  }
}
function setPulse(ok) {
  document.getElementById("pulse").className = "dot " + (ok ? "ok" : "bad");
  document.getElementById("pulse-text").textContent = ok ? "proxy reachable" : "proxy unreachable";
}

addEventListener("hashchange", render);
addEventListener("resize", () => redraw?.());
// Usage refreshes on its own; the other pages hold forms or scroll positions.
setInterval(() => { if (!document.hidden && (location.hash || "#usage") === "#usage") render(); }, 60_000);
render();

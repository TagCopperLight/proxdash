// proxdash page: four views over the proxdash service's /api.
const H = 3600_000;
const DAY = 24 * H;
const WINDOWS = { "7d": { ms: 7 * DAY, key: "7", name: "Week" }, "5h": { ms: 5 * H, key: "5", name: "5h" } };
/** How much of the chart is past and future, per window: enough future to see every account reset. */
const VIEW = { "7d": { back: 3 * DAY, ahead: 7 * DAY }, "5h": { back: 5 * H, ahead: 10 * H } };
const STALE_MS = 30 * 60_000;
/** Chart heights, also reserved in the markup so a redraw never shortens the page and pulls the scroll up. */
const POOL_H = 300, REQUESTS_H = 150;
/** An account keeps its colour on every page; past the fourth, colours would stop being told apart. */
const COLORS = ["var(--blue)", "var(--orange)", "var(--purple)", "var(--teal)"];
const OTHER_COLOR = "var(--text-disabled)";
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

// ---------------------------------------------------------------- formatting

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (f) => `${Math.round(f * 100)}%`;
/** Rates are small: keep one decimal under 10%. */
const pct1 = (f) => (f * 100 < 10 ? `${(f * 100).toFixed(1)}%` : pct(f));
const kfmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
/** Every input token a request sent, whether the prompt cache served it or not. */
const tokensIn = (t) => t.input + t.cache_read + t.cache_write;
const tokensAll = (t) => tokensIn(t) + t.output;
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const hm = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const weekday = (ts) => new Date(ts).toLocaleDateString("en-GB", { weekday: "short" }).toUpperCase();
const date = (ts) => `${weekday(ts)} ${new Date(ts).getDate()} ${new Date(ts).toLocaleDateString("en-GB", { month: "short" }).toUpperCase()} ${hm(ts)}`;
/** Today's times need no day; others get their weekday. */
const clock = (ts, now = Date.now()) => (sameDay(ts, now) ? hm(ts) : `${weekday(ts)} ${hm(ts)}`);

function span(ms) {
  const m = Math.round(Math.max(0, ms) / 60_000);
  const [big, small] = m < 60 ? [[m, "m"], [0]] : m < 1440 ? [[Math.floor(m / 60), "h"], [m % 60, "m"]] : [[Math.floor(m / 1440), "d"], [Math.floor((m % 1440) / 60), "h"]];
  return small[0] ? `${big.join("")} ${small.join("")}` : big.join("");
}
const ago = (ts, now = Date.now()) => (now - ts < 90_000 ? "NOW" : `${span(now - ts)} AGO`);

/** claude-opus-5-5 → Opus 5.5 */
function modelName(id) {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : id.replace(/^claude-/, "");
}
const projectName = (p) => p ?? "No project";

// ---------------------------------------------------------------- accounts

/** Name and colour per email, from the accounts list (logs can hold emails of removed accounts). */
function people(accs) {
  const by = new Map(accs.map((a, i) => [a.email, { name: a.name, color: COLORS[i] ?? OTHER_COLOR }]));
  return (email) => by.get(email) ?? { name: email.split("@")[0], color: OTHER_COLOR };
}
const dot = (color) => `<span class="dot" style="--c:${color}"></span>`;
const who = (p) => `<span class="who">${dot(p.color)}<span class="ell">${esc(p.name)}</span></span>`;

// Emails stay blurred until clicked; one click reveals them all for the visit.
let revealed = false;
const email = (e) => `<span class="email ${revealed ? "" : "blur"}" title="Click to show">${esc(e)}</span>`;
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".email")) return;
  revealed = !revealed;
  document.querySelectorAll(".email").forEach((el) => el.classList.toggle("blur", !revealed));
});

// ---------------------------------------------------------------- controls

function seg(name, options, current, label) {
  return `<div class="seg" data-seg="${name}">${label ? `<span class="label">${label}</span>` : ""}${options
    .map(([v, text, title]) => `<button data-v="${esc(v)}" class="${v === current ? "on" : ""}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</button>`)
    .join("")}</div>`;
}
function onSeg(name, fn) {
  $page.querySelectorAll(`[data-seg="${name}"]`).forEach((el) => el.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (b && !b.classList.contains("on")) fn(b.dataset.v, el);
  }));
}
const CHEVRON = `<svg class="i" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>`;
/** LABEL VALUE ⌄, opening the options as a column; the options are a seg, so onSeg handles the choice. */
function drop(name, options, current, label) {
  const shown = options.find(([v]) => v === current) ?? options[0];
  return `<div class="drop"><button class="drop-btn" aria-haspopup="listbox"><span class="label">${label}</span>
    <span class="v ${current ? "" : "dim"}" style="--w:${Math.max(...options.map(([, text]) => text.length))}ch">${esc(shown[1])}</span>${CHEVRON}</button><div class="menu" hidden>${seg(name, options, current)}</div></div>`;
}
const closeDrops = (except) => document.querySelectorAll(".drop .menu").forEach((m) => { if (m !== except) m.hidden = true; });
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".drop-btn");
  const menu = btn?.nextElementSibling;
  closeDrops(menu);
  if (menu) menu.hidden = !menu.hidden;
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeDrops(); });
const segValue = (name) => $page.querySelector(`[data-seg="${name}"] button.on`)?.dataset.v;
const section = (title, tools, body) =>
  `<section class="section"><div class="section-head"><h2>[${title}]</h2><div class="tools">${tools}</div></div>${body}</section>`;
const kv = (k, v, cls = "", title = "") => `<div class="kv ${cls}"${title ? ` title="${esc(title)}"` : ""}><span class="k">${k}</span><span class="v">${v}</span></div>`;
const keys = (colors, names, extra = "") =>
  `<div class="keys">${names.map((n, i) => `<span>${dot(colors[i])}${esc(n)}</span>`).join("")}${extra}</div>`;

function showTip(ev, html) {
  $tip.innerHTML = html;
  $tip.hidden = false;
  const x = ev.clientX + 18 + $tip.offsetWidth > innerWidth - 8 ? ev.clientX - 18 - $tip.offsetWidth : ev.clientX + 18;
  $tip.style.left = x + "px";
  $tip.style.top = Math.max(8, ev.clientY - $tip.offsetHeight / 2) + "px";
}
const hideTip = () => { $tip.hidden = true; };
const tipRow = (color, label, value, cls = "") => `<div class="r ${cls}">${color ? dot(color) : ""}<span>${esc(label)}</span><b>${value}</b></div>`;

// ---------------------------------------------------------------- quota model

/**
 * Used fraction at time t from a reading: a reading whose reset has passed means a fresh window.
 * A window Anthropic refuses is used up, though its rounded utilization can still read 99%.
 */
function usedAt(rd, w, t) {
  const u = rd?.["u" + w.key];
  if (u == null) return 0;
  const r = rd["r" + w.key];
  if (r && t >= r) return 0;
  return rd["s" + w.key] === "rejected" ? 1 : u;
}
/** The next reset after t, rolling a passed reset forward by whole windows. */
function nextReset(rd, w, t) {
  let r = rd?.["r" + w.key];
  if (!r) return t + w.ms;
  if (r <= t) r += Math.ceil((t - r) / w.ms) * w.ms;
  return r;
}

/** Each account's remaining (0..1) sampled on a grid, from the readings history. */
function history(readings, accounts, w, from, to, step) {
  const latest = new Map();
  const points = [];
  let i = 0;
  for (let t = from; t <= to + 1; t += step) {
    const at = Math.min(t, to);
    while (i < readings.length && readings[i].ts <= at) latest.set(readings[i].account, readings[i++]);
    if (!latest.size) continue;
    points.push([at, accounts.map((a) => 1 - usedAt(latest.get(a), w, at))]);
  }
  return points;
}

/**
 * Pool burn per hour (in account fractions) over the last `hours`, adding up rises between readings.
 * A fresh install has less history than that: the rate is over the time actually covered.
 */
function burnRate(readings, accounts, w, now, hours) {
  const from = now - hours * H;
  const first = readings.find((rd) => accounts.includes(rd.account))?.ts ?? now;
  const covered = now - Math.max(from, first);
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
  return { rate: covered > 0 ? used / (covered / H) : 0, covered };
}

/**
 * Walks forward at the burn rate, spreading it over accounts that still have room, refilling at resets.
 * An account the other window shuts out (a spent 5h in the week view) takes nothing until that window refills.
 */
function project(latest, accounts, w, now, rate, horizon) {
  const state = accounts.map((a) => {
    const rem = 1 - usedAt(latest.get(a), w, now);
    // An account already empty is out now, not running out in the forecast.
    return { rem, reset: nextReset(latest.get(a), w, now), out: rem <= 0, until: outUntil(latest.get(a), now) ?? now };
  });
  const rems = () => state.map((x) => x.rem);
  const step = horizon / 400;
  const points = [[now, rems()]];
  const refills = [], outs = [];
  let poolOut = null;
  for (let t = now + step; t <= now + horizon; t += step) {
    const due = state.filter((x) => t >= x.reset);
    if (due.length) {
      // Two points at the reset time draw the refill as a straight step.
      const at = Math.min(...due.map((x) => x.reset));
      points.push([at, rems()]);
      for (const x of due) { refills.push({ t: at, i: state.indexOf(x), gain: 1 - x.rem }); x.rem = 1; x.out = false; x.reset += w.ms; }
      points.push([at, rems()]);
    }
    let burn = rate * (step / H);
    let live = state.filter((x) => x.rem > 0 && t >= x.until);
    while (burn > 1e-9 && live.length) {
      const share = burn / live.length;
      burn = 0;
      for (const x of live) {
        const take = Math.min(x.rem, share);
        x.rem -= take;
        burn += share - take;
      }
      live = live.filter((x) => x.rem > 0);
    }
    state.forEach((x, i) => { if (x.rem <= 0 && !x.out) { x.out = true; outs.push({ t, i }); } });
    if (poolOut == null && state.every((x) => x.rem <= 0)) poolOut = t;
    points.push([t, rems()]);
  }
  return { points, refills, outs, poolOut };
}

// ---------------------------------------------------------------- charts

/** Time ticks for an axis `width` px wide, thinned so labels never touch. */
function timeTicks(from, to, width) {
  const span = to - from;
  const step = span > 3 * DAY ? DAY : span > 12 * H ? 3 * H : H;
  const t0 = new Date(from);
  t0.setMinutes(0, 0, 0);
  if (step === DAY) t0.setHours(0);
  else t0.setHours(Math.floor(t0.getHours() / (step / H)) * (step / H));
  const ticks = [];
  for (let t = t0.getTime() + step; t < to; t += step) if (t > from) ticks.push(t);
  const label = (t) => (step === DAY ? `${weekday(t)} ${new Date(t).getDate()}` : hm(t)).toUpperCase();
  const every = Math.ceil((step === DAY ? 72 : 56) / (width * (step / span)));
  return { ticks: ticks.filter((_, i) => i % every === 0), label };
}

/** Forecast: each account's own line (0–100% of it) and the pool's sum, on one axis; recorded solid, projected dashed. */
function poolChart(el, { colors, names, recorded, projected, refills, outs, poolOut, max, from, to, now, thin }) {
  const W = el.clientWidth || 900, Hh = POOL_H, m = { l: 48, r: 8, t: 34, b: 30 };
  const plotR = W - m.r;
  const x = (t) => m.l + ((t - from) / (to - from)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v / max) * (Hh - m.t - m.b);
  const sum = (r) => r.reduce((s, v) => s + Math.max(0, v), 0);
  const path = (pts, f) => pts.map(([t, r], k) => `${k ? "L" : "M"}${x(t).toFixed(1)},${y(f(r)).toFixed(1)}`).join("");
  // An empty account (or pool) leaves the axis bare until its reset, so lines never pile up along 0.
  const gapped = (pts, f) => pts.map(([t, r], k) => {
    const empty = (j) => j < 0 || f(pts[j][1]) <= 0;
    if (f(r) <= 0 && empty(k - 1)) return "";
    return `${k && !(empty(k - 1) && empty(k - 2)) ? "L" : "M"}${x(t).toFixed(1)},${y(Math.max(0, f(r))).toFixed(1)}`;
  }).join("");
  const layer = (pts, cls) => pts.length < 2 ? "" : `
    <path class="pool-area ${cls}" d="${path(pts, sum)}L${x(pts.at(-1)[0])},${y(0)}L${x(pts[0][0])},${y(0)}Z"/>
    <path class="edge pool ${cls}" d="${gapped(pts, sum)}"/>
    ${colors.map((c, i) => `<path class="edge ${cls}" style="--c:${c}" d="${gapped(pts, (r) => r[i])}"/>`).join("")}`;
  const yStep = max <= 2 ? 0.5 : 1;
  const yTicks = Array.from({ length: Math.round(max / yStep) + 1 }, (_, i) => i * yStep);
  const { ticks, label } = timeTicks(from, to, W - m.l - m.r);
  // Labels stay inside the plot (anchored away from the edges) and move up a row rather than overlap.
  const CHAR = 7.3, ROW = 16;
  const placed = [];
  const note = (px, py, text, cls = "") => {
    const w = text.length * CHAR;
    const anchor = px > plotR - w / 2 ? "end" : px < m.l + w / 2 ? "start" : "middle";
    const left = anchor === "end" ? px - w : anchor === "start" ? px : px - w / 2;
    let row = py;
    while (placed.some((b) => b.y === row && left < b.right + 12 && left + w > b.left - 12)) row -= ROW;
    placed.push({ y: row, left, right: left + w });
    return `<rect class="knock" x="${left - 4}" y="${row - 12}" width="${w + 8}" height="16"/><text class="${cls}" x="${px}" y="${row}" text-anchor="${anchor}">${esc(text)}</text>`;
  };
  const roomy = W > 640;
  const guess = thin ? "~" : "";
  const poolMark = poolOut && poolOut < to ? note(x(poolOut), y(0) - 12, `POOL EMPTY ${guess}${clock(poolOut, now)}`, thin ? "" : "bad") : "";
  // The last account to run out is the pool running out, already labelled.
  const accountOuts = outs.filter((o) => o.t < to && o.t !== poolOut);
  const emptyMarks = outs.filter((o) => o.t < to).map((o) => `<circle class="out" style="--c:${colors[o.i]}" cx="${x(o.t)}" cy="${y(0)}" r="4"/>`).join("")
    + (roomy ? accountOuts.map((o) => note(x(o.t), y(0) - 12, `${names[o.i]} empty ${guess}${clock(o.t, now)}`.toUpperCase())).join("") : "");
  const resetNotes = roomy ? refills.filter((r) => r.gain >= 0.05 && r.t < to).map((r) =>
    note(x(r.t), y(1) - 8, `${names[r.i]} resets`.toUpperCase())).join("") : "";

  el.innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" height="${Hh}">
    <g class="grid">${yTicks.map((v) => `<line x1="${m.l}" x2="${plotR}" y1="${y(v)}" y2="${y(v)}"/>`).join("")}</g>
    <g class="axis">${yTicks.map((v) => `<text x="${m.l - 12}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`).join("")}
      ${ticks.map((t) => `<text x="${x(t)}" y="${Hh - 6}" text-anchor="middle">${label(t)}</text>`).join("")}</g>
    ${layer(recorded, "rec")}${layer(projected, "proj")}
    <g class="now"><line x1="${x(now)}" x2="${x(now)}" y1="${m.t - 14}" y2="${y(0)}"/><text x="${x(now)}" y="${m.t - 20}" text-anchor="middle">NOW</text></g>
    <g class="note">${resetNotes}${emptyMarks}${poolMark}</g>
    <line class="cross" y1="${m.t}" y2="${y(0)}" visibility="hidden"/>
    <g class="marks" visibility="hidden">${colors.map((c) => `<circle class="mark" r="4" style="--c:${c}"/>`).join("")}<circle class="mark pool" r="4"/></g>
    <rect class="hit" x="${m.l}" y="0" width="${W - m.l - m.r}" height="${Hh}"/>
  </svg>`;

  const all = [...recorded.map((p) => [...p, false]), ...projected.slice(1).map((p) => [...p, true])];
  const svg = el.querySelector("svg"), cross = svg.querySelector(".cross"), marks = svg.querySelector(".marks");
  svg.addEventListener("mousemove", (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    let best = null;
    for (const p of all) if (!best || Math.abs(x(p[0]) - px) < Math.abs(x(best[0]) - px)) best = p;
    if (!best) return;
    const [t, r, projectedPoint] = best;
    cross.setAttribute("x1", x(t)); cross.setAttribute("x2", x(t)); cross.setAttribute("visibility", "visible");
    marks.setAttribute("visibility", "visible");
    const circles = marks.querySelectorAll("circle");
    [...r, sum(r)].forEach((v, i) => { circles[i].setAttribute("cx", x(t)); circles[i].setAttribute("cy", y(v)); });
    showTip(ev, `<div class="t">${esc(clock(t, now))}${projectedPoint ? " · projected" : ""}</div>
      ${colors.map((c, i) => tipRow(c, names[i], pct(r[i]))).join("")}
      ${tipRow("", "Pool", `${pct(sum(r))} <span class="dim">/ ${max * 100}%</span>`, "total")}`);
  });
  svg.addEventListener("mouseleave", () => {
    hideTip();
    cross.setAttribute("visibility", "hidden"); marks.setAttribute("visibility", "hidden");
  });
}

/** Requests per time bucket, stacked by account. */
function requestChart(el, { buckets, bucketMs, colors, names, from, to }) {
  const W = el.clientWidth || 900, Hh = REQUESTS_H, m = { l: 48, r: 8, t: 8, b: 30 };
  const peak = Math.max(1, ...buckets.map((b) => b.counts.reduce((s, v) => s + v, 0)));
  const unit = 10 ** Math.floor(Math.log10(peak));
  const top = Math.ceil(peak / unit) * unit;
  const x = (t) => m.l + ((t - from) / (to - from)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v / top) * (Hh - m.t - m.b);
  const bw = Math.max(2, x(from + bucketMs) - x(from) - 3);
  const { ticks, label } = timeTicks(from, to, W - m.l - m.r);
  const cols = buckets.map((b) => {
    let base = 0;
    const segs = b.counts.map((v, i) => {
      if (!v) return "";
      const y0 = y(base), y1 = y(base + v);
      base += v;
      // A 1px seam between stacked pieces keeps the accounts apart.
      return `<rect class="bar" style="--c:${colors[i]}" x="${x(b.t) + 1.5}" y="${y1}" width="${bw}" height="${Math.max(1, y0 - y1 - 1)}" rx="1.5"/>`;
    }).join("");
    return `<g class="col" data-t="${b.t}">${segs}<rect class="hit" x="${x(b.t)}" y="${m.t}" width="${bw + 3}" height="${Hh - m.t - m.b}"/></g>`;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" height="${Hh}">
    <g class="grid">${[0, top / 2, top].map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`).join("")}</g>
    <g class="axis">${[0, top / 2, top].map((v) => `<text x="${m.l - 12}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("")}
      ${ticks.map((t) => `<text x="${x(t) + 1.5 + bw / 2}" y="${Hh - 6}" text-anchor="middle">${label(t)}</text>`).join("")}</g>
    ${cols}</svg>`;
  el.querySelectorAll(".col").forEach((g) => {
    const b = buckets.find((k) => k.t === Number(g.dataset.t));
    g.addEventListener("mousemove", (ev) => showTip(ev, `<div class="t">${esc(clock(b.t))} – ${esc(hm(b.t + bucketMs))}</div>
      ${colors.map((c, i) => tipRow(c, names[i], b.counts[i])).join("")}
      ${tipRow("", "Requests", b.counts.reduce((s, v) => s + v, 0), "total")}`));
    g.addEventListener("mouseleave", hideTip);
  });
}

/** Request and token totals as LABEL … value rows; a failure count links to the failed requests. */
function totalsList(t, extra = "") {
  const prompt = tokensIn(t);
  const none = `<span class="dim">—</span>`;
  return `<div class="list two">
    ${kv("Requests", kfmt(t.requests))}
    ${kv("Failed", t.failed ? `<a href="#logs" class="bad-t go-link" data-failed>${t.failed} <span class="dim">· ${pct1(t.failed / t.requests)}</span> →</a>` : `<span class="dim">0</span>`)}
    ${kv("Tokens in", prompt ? kfmt(prompt) : none)}
    ${kv("Tokens out", t.output ? kfmt(t.output) : none)}
    ${kv("Cached input", prompt ? pct(t.cache_read / prompt) : none, "", "Share of input tokens read from the prompt cache")}
    ${extra}
  </div>`;
}

// ---------------------------------------------------------------- account rows (Usage and Accounts)

const PENCIL = `<svg class="i" viewBox="0 0 24 24"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
const PLUS = `<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`;
const CHILD = `<svg class="i" viewBox="0 0 24 24"><path d="M5 4v6a4 4 0 0 0 4 4h11"/><path d="m15 9 5 5-5 5"/></svg>`;
const BIN = `<svg class="i" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>`;
const REFRESH = `<svg class="i" viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/></svg>`;
const RESET = `<svg class="i" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;

/** What's left of one window, red when nearly gone. */
function left(rd, w, now) {
  const rem = 1 - usedAt(rd, w, now);
  return `<span class="n ${rem < 0.1 ? "bad-t" : ""}">${pct(rem)}</span>`;
}

/** One window's state: bar, what's left, when it refills. */
function quota(rd, w, color, now) {
  const rem = 1 - usedAt(rd, w, now);
  const reset = rd ? `<span class="when" title="Refills to 100%">${RESET}${esc(clock(nextReset(rd, w, now), now))}</span>` : "";
  return `<div class="meter"><div class="track"><i style="width:${Math.max(0, Math.min(1, rem)) * 100}%;--c:${color}"></i></div>${left(rd, w, now)}${reset}</div>`;
}

/** When a used-up account gets its quota back, or null when it is serving. */
function outUntil(rd, now) {
  for (const w of Object.values(WINDOWS)) if (usedAt(rd, w, now) >= 1 && rd["r" + w.key] > now) return rd["r" + w.key];
  return null;
}
const outFor = (until, now) => `<span class="bad-t nowrap" title="Back at ${esc(clock(until, now))}">[OUT ${span(until - now)}]</span>`;

function status(acc, now) {
  if (acc.disabled) return `<span class="dim">[OFF]</span>`;
  if (!acc.reading) return `<span class="dim">[NO DATA]</span>`;
  const until = outUntil(acc.reading, now);
  return until ? outFor(until, now) : `<span class="dim">OK</span>`;
}
const lastReading = (rd, now) =>
  rd ? `<span class="${now - rd.ts > STALE_MS ? "dim" : ""}" title="${esc(new Date(rd.ts).toLocaleString("en-GB"))}">${ago(rd.ts, now)}</span>` : `<span class="dim">NEVER</span>`;

/**
 * The account columns both pages draw from: header, width, and width on small screens (none: hidden there).
 * Cells get the account, its person and now.
 */
const ACCOUNT_COLS = {
  name: { head: "Account", w: "minmax(18ch,1fr)", s: "minmax(10ch,1fr)", cell: (a, p) => who(p) },
  email: { head: "Email", w: "minmax(20ch,1.2fr)", cell: (a) => email(a.email) },
  week: { head: "Week left", w: "minmax(28ch,1.6fr)", s: "auto", cell: (a, p, now) => quota(a.reading, WINDOWS["7d"], p.color, now) },
  five: { head: "5h left", w: "minmax(28ch,1.6fr)", s: "auto", cell: (a, p, now) => quota(a.reading, WINDOWS["5h"], p.color, now) },
  status: { head: "Status", w: "14ch", s: "auto", cell: (a, p, now) => status(a, now) },
  seen: { head: "Last reading", w: "13ch", r: true, cell: (a, p, now) => lastReading(a.reading, now) },
};

/**
 * Grid rows with one header; columns are { head, w, s, r, cls, cell } and `cell` builds the html from each item.
 * An item `{ divider }` is a full-width row of that html instead.
 */
function rows(cols, items, cell, cls = "") {
  const end = (i) => (i === cols.length - 1 ? "end" : "");
  const hide = (c) => (c.s ? "" : "hide-s");
  const head = cols.map((c, i) => `<div class="h ${c.r ? "r" : ""} ${end(i)} ${hide(c)} ${c.cls ?? ""}">${c.head}</div>`).join("");
  const body = items.map((it, k) => it.divider ? `<div class="divider">${it.divider}</div>` : cols.map((c, i) =>
    `<div class="c ${c.r ? "r" : ""} ${end(i)} ${hide(c)} ${c.cls ?? ""} ${k === items.length - 1 ? "last" : ""}">${cell(c, it)}</div>`).join("")).join("");
  const style = `--cols:${cols.map((c) => c.w).join(" ")};--cols-s:${cols.filter((c) => c.s).map((c) => c.s).join(" ")}`;
  return `<div class="rows ${cls}" style="${style}">${head}${body}</div>`;
}

// ---------------------------------------------------------------- resets

/** Anthropic's keys for the limits a reset clears; the weekly limit kept for one model is named after it. */
function limitName(key, scoped) {
  if (key === "five_hour") return WINDOWS["5h"].name;
  if (key === "seven_day") return WINDOWS["7d"].name;
  if (key === "seven_day_overage_included" && scoped) return `${scoped} week`;
  return key;
}
/** A reset is named by what it clears: the week makes it full, anything less lists its limits. */
const resetName = (g, scoped) => (g.clears.includes("seven_day") ? "Full reset" : `${g.clears.map((k) => limitName(k, scoped)).join(" + ")} reset`);
const INELIGIBLE = { surface: "Only Claude Code is offered resets", cli_version: "Claude Code is too old for resets" };
/** Anthropic's reason codes, readable as they are: not_at_limit → NOT AT LIMIT. */
const words = (code) => code.replaceAll("_", " ").toUpperCase();
/** The order limits take in "Gives back", shortest window first; anything new goes after. */
const LIMIT_ORDER = ["five_hour", "seven_day", "seven_day_overage_included"];
const endOf = (g) => (g.ends_at ? Date.parse(g.ends_at) : Infinity);

/** Why one account can't spend this grant now, or null when it can. */
function blocker(g, acc, now) {
  const dim = (text, title = "") => `<span class="dim nowrap"${title ? ` title="${esc(title)}"` : ""}>[${esc(text)}]</span>`;
  if (!g.resets_left) return dim("USED");
  if (endOf(g) <= now) return dim("EXPIRED");
  const cooldown = acc.cooldown_until ? Date.parse(acc.cooldown_until) : 0;
  if (cooldown > now) return dim(`COOLDOWN ${span(cooldown - now)}`, `Resets wait until ${clock(cooldown, now)}`);
  if (g.starts_at && Date.parse(g.starts_at) > now) return dim(`FROM ${clock(Date.parse(g.starts_at), now)}`);
  if (g.paused) return dim("PAUSED");
  if (!g.usable_now) return dim(g.unavailable_reason ? words(g.unavailable_reason) : "UNAVAILABLE");
  return null;
}
const ready = (g, acc) => (acc.next_grant_id === g.id ? `<span class="nowrap" title="Claude Code spends this one first">READY <span class="dim">· NEXT</span></span>` : "READY");

/** Each reset type with the accounts holding it, then the accounts Anthropic shows no resets for. */
function resetsSection(list, person, now) {
  if (list.error) return section("Resets", "", `<div class="err">${esc(list.error)}</div>`);
  const issues = list.filter((a) => a.error || !a.eligible).map((a) => kv(who(person(a.email)), a.error
    ? `<span class="bad-t ell" title="${esc(a.error)}">${esc(a.error)}</span>`
    : `<span class="dim">${esc(INELIGIBLE[a.ineligible_reason] ?? `Not offered: ${words(a.ineligible_reason)}`).toUpperCase()}</span>`)).join("");
  const types = new Map();
  for (const acc of list) if (!acc.error && acc.eligible) for (const g of acc.grants) {
    if (!types.has(g.id)) types.set(g.id, { g, holders: [] });
    types.get(g.id).holders.push({ acc, g });
  }
  const groups = [...types.values()].sort((a, b) => endOf(a.g) - endOf(b.g));
  const count = (g) => `<span class="nowrap ${g.resets_left ? "" : "dim"}">${g.resets_left} <span class="dim">OF ${g.resets_total}</span></span>`;
  // Each limit keeps one slot across every row, empty where a reset doesn't clear it, so the same limit lines up down the list.
  // Every account names its one-model weekly limit the same way.
  const scoped = list.find((a) => a.scoped)?.scoped;
  const rank = (k) => (LIMIT_ORDER.includes(k) ? LIMIT_ORDER.indexOf(k) : LIMIT_ORDER.length);
  const slots = [...new Set(groups.flatMap((t) => t.g.clears))].sort((a, b) => rank(a) - rank(b));
  const slotCols = slots.map((k) => `${limitName(k, scoped).length + 6}ch`).join(" ");
  const usable = groups.reduce((n, t) => n + t.holders.reduce((m, h) => m + (blocker(h.g, h.acc, now) ? 0 : h.g.resets_left), 0), 0);
  const cols = [
    { ...ACCOUNT_COLS.name, cell: ({ acc }) => who(person(acc.email)) },
    { head: "Left", w: "9ch", cell: ({ g }) => count(g) },
    { head: "Gives back", w: "minmax(24ch,2fr)", s: "auto", cls: "gives-col", cell: ({ g }) => `<span class="gives" style="--slots:${slotCols}"><span class="phone-only">${count(g)}</span>${slots.map((k) => {
      if (!g.clears.includes(k)) return `<span class="slot-empty"></span>`;
      const used = g.percent_used[k];
      return `<span class="nowrap ${g.resets_left && used ? "" : "dim"}"><span class="dim">${esc(limitName(k, scoped)).toUpperCase()}</span> ${used == null ? "—" : `+${used}%`}</span>`;
    }).join("")}</span>` },
    { head: "Status", w: "24ch", s: "auto", r: true, cell: ({ acc, g }) => blocker(g, acc, now) ?? ready(g, acc) },
  ];
  const expiryText = (ends) => ends === Infinity ? "NO END" : ends <= now ? "EXPIRED" : `EXPIRES ${date(ends)} IN ${span(ends - now)}`;
  // Expiries start at one column, as wide as the longest, so they line up from group to group.
  const expiryW = Math.max(...groups.map((t) => expiryText(endOf(t.g)).length));
  const items = groups.flatMap(({ g, holders }) => {
    const ends = endOf(g);
    const unspent = holders.some((h) => h.g.resets_left);
    const expiry = ends === Infinity || ends <= now ? `<span class="dim">${expiryText(ends)}</span>`
      : `<span class="nowrap ${unspent && ends - now < 2 * DAY ? "bad-t" : ""}" title="Unspent resets are lost then">EXPIRES ${esc(date(ends))} <span class="dim">IN ${span(ends - now)}</span></span>`;
    return [
      { divider: `<div class="reset-head" style="--expiry:${expiryW}ch"><span title="${esc(g.label)}">${esc(resetName(g, scoped))}</span>${expiry}</div><div class="reset-label dim">${esc(g.label)}</div>` },
      ...holders,
    ];
  });
  return section("Resets", groups.length ? `<span class="dim nowrap" title="Resets an account can spend right now">${usable} READY</span>` : "", `
    ${groups.length ? rows(cols, items, (c, it) => c.cell(it), "accounts resets") : issues ? "" : `<div class="empty-note">No resets granted</div>`}
    ${issues ? `<div class="list">${issues}</div>` : ""}`);
}

// ---------------------------------------------------------------- usage

let resetsHtml = section("Resets", "", `<div class="empty-note">Asking Anthropic</div>`);

async function usagePage() {
  const win = pref.get("window", "7d"), burnH = Number(pref.get("burn", "3")), actWin = pref.get("activity", "24h");
  const w = WINDOWS[win], view = VIEW[win];
  const now = Date.now();
  const actFrom = now - (actWin === "24h" ? DAY : 7 * DAY);
  const [accs, readings, act] = await Promise.all([
    api("GET", "/accounts"),
    // A week before the view starts, so every account's state at its left edge is known.
    api("GET", `/readings?since=${now - view.back - 7 * DAY}`),
    api("GET", `/activity?since=${actFrom}`),
  ]);
  const person = people(accs);
  const pool = accs.filter((a) => !a.disabled).map((a) => a.email);
  const colors = pool.map((e) => person(e).color), names = pool.map((e) => person(e).name);
  const n = pool.length;
  const latest = new Map();
  for (const rd of readings) if (rd.ts <= now) latest.set(rd.account, rd);
  const { rate, covered } = burnRate(readings, pool, w, now, burnH);
  const proj = project(latest, pool, w, now, rate, view.ahead);
  const rems = proj.points[0][1];
  const remaining = rems.reduce((s, v) => s + v, 0);
  // A fresh install starts the axis at its first reading instead of showing days of nothing.
  const from = Math.max(now - view.back, readings.find((r) => pool.includes(r.account))?.ts ?? now);
  const recorded = history(readings, pool, w, from, now, (now + view.ahead - from) / 600);
  const first = proj.outs[0], next = proj.refills[0];
  const named = (i, rest) => `${dot(colors[i])}<span class="up ell">${esc(names[i])}</span><span class="dim sep">·</span>${rest}`;
  const out = pool.map((e, i) => [i, outUntil(latest.get(e), now)]).filter(([, until]) => until);
  const at = (t) => `${esc(clock(t, now))} <span class="dim">IN ${span(t - now)}</span>`;
  // Under the pace window's worth of history, forecasts are rough: marked ~, dim, and never alarming.
  const thin = covered < burnH * H;
  const guess = (t) => `<span class="nowrap ${thin ? "dim" : t - now < 2 * DAY ? "bad-t" : ""}">${thin ? "~" : ""}${at(t)}</span>`;
  const never = `NOT ${win === "7d" ? "THIS WEEK" : `IN ${span(view.ahead)}`}`;
  const idle = `<span class="dim">IDLE</span>`;
  const none = `<span class="dim">—</span>`;
  const wasted = next && 1 - next.gain;

  const t = act.totals;
  const bucketMs = actWin === "24h" ? H : 6 * H;
  const buckets = [];
  const start = Math.floor(actFrom / bucketMs) * bucketMs;
  for (let b = start; b < now; b += bucketMs) buckets.push({ t: b, counts: pool.map(() => 0) });
  for (const h of act.byHour) {
    const b = buckets[Math.floor((h.hour - start) / bucketMs)];
    const i = pool.indexOf(h.account);
    if (b && i >= 0) b.counts[i] += h.requests;
  }
  const shares = (list, label) => {
    const top = Math.max(1, ...list.map(tokensAll));
    return list.length ? `<div class="share">${list.slice(0, 6).map((r) => `<span class="name ${r.key ? "" : "dim"}">${esc(label(r.key))}</span>
      <span class="track"><i style="width:${(tokensAll(r) / top) * 100}%"></i></span>
      <span class="num dim" title="Requests">${r.requests}</span><span class="num" title="Tokens in and out, cache included">${kfmt(tokensAll(r))}</span>`).join("")}</div>`
      : `<div class="empty-note">No requests</div>`;
  };

  $page.innerHTML = `
    ${section("Pool", seg("window", [["7d", "Week"], ["5h", "5h"]], win, "Window"), `
      <div class="hero">
        <div>
          <div class="big">${pct(remaining)}<small>left of ${n * 100}%</small></div>
          <div class="split">${rems.map((r, i) => `<i style="flex:${Math.max(0.002, r)};--c:${colors[i]}" title="${esc(names[i])} ${pct(r)}"></i>`).join("")}<i class="used" style="flex:${Math.max(0.002, n - remaining)}"></i></div>
          <div class="lead"><span class="k">First empty</span><span class="v">${!rate ? idle : first ? named(first.i, guess(first.t)) : never}</span></div>
        </div>
        <div class="list two">
          ${out.map(([i, until]) => kv("Out now", named(i, outFor(until, now)))).join("")}
          ${kv("Pool empty", !rate ? idle : proj.poolOut ? guess(proj.poolOut) : never)}
          ${kv("Next reset", next ? named(next.i, `<span class="nowrap">${at(next.t)}</span>`) : none)}
          ${kv("Unused at next reset", next ? named(next.i, `<span class="${thin ? "dim" : ""}">${thin ? "~" : ""}${pct(wasted)}</span>`) : none, "", "Quota the account will not have used when it refills, lost at the reset")}
          ${kv("Pool burn", `<span class="${thin ? "dim" : ""}">${thin ? "~" : ""}${pct1(rate)}/h</span>`)}
        </div>
      </div>`)}
    ${section("Forecast", `${seg("burn", [["1", "1h"], ["3", "3h"], ["6", "6h"]], String(burnH), "Pace over")}`, `
      <div class="chart" id="chart" style="height:${POOL_H}px"></div>
      ${keys(["var(--text)", ...colors], ["Pool", ...names], `<span class="dim nowrap"><i class="dash"></i>Projected</span>${thin && rate ? `<span class="dim">~ Estimate from ${span(covered)} of data</span>` : ""}`)}`)}
    ${section("Accounts", "", rows(Object.values(ACCOUNT_COLS).filter((c) => c !== ACCOUNT_COLS.email), accs,
      (c, a) => c.cell(a, person(a.email), now), "accounts"))}
    ${section("Activity", seg("activity", [["24h", "24h"], ["7d", "7d"]], actWin, "Last"), `
      ${totalsList(t, kv("Conversations moved", t.sessions ? `${t.split} <span class="dim">OF ${t.sessions}</span>` : none, "",
        "Conversations served by more than one account, which loses their prompt cache"))}
      <div class="activity">
        <div class="wide"><div class="sub-h"><span>Requests per ${actWin === "24h" ? "hour" : "6 hours"}</span>${keys(colors, names)}</div><div class="chart" id="requests" style="height:${REQUESTS_H}px"></div></div>
        <div><div class="sub-h">By project</div>${shares(act.byProject, projectName)}</div>
        <div><div class="sub-h">By model</div>${shares(act.byModel, modelName)}</div>
      </div>`)}
    <div id="resets">${resetsHtml}</div>`;

  const draw = () => {
    poolChart(document.getElementById("chart"), { colors, names, recorded, projected: proj.points, refills: proj.refills, outs: proj.outs, poolOut: proj.poolOut, max: n, from, to: now + view.ahead, now, thin });
    requestChart(document.getElementById("requests"), { buckets, bucketMs, colors, names, from: start, to: buckets.at(-1).t + bucketMs });
  };
  draw();
  // Resets come from Anthropic's site, which can be slow or down: the page doesn't wait for them, and shows the last ones meanwhile.
  api("GET", "/resets").catch((e) => ({ error: e.message })).then((list) => {
    resetsHtml = resetsSection(list, person, Date.now());
    const el = document.getElementById("resets");
    if (el) el.innerHTML = resetsHtml;
  });
  onSeg("window", (v) => { pref.set("window", v); render(); });
  onSeg("burn", (v) => { pref.set("burn", v); render(); });
  onSeg("activity", (v) => { pref.set("activity", v); render(); });
  return draw;
}

// ---------------------------------------------------------------- accounts

async function accountsPage() {
  const now = Date.now();
  const [accs, act] = await Promise.all([api("GET", "/accounts"), api("GET", `/activity?since=${now - DAY}`)]);
  const person = people(accs);
  const day = new Map(act.byAccount.map((r) => [r.key, r.requests]));
  const cols = [
    { ...ACCOUNT_COLS.name, cell: (a, p) => `<span class="who">${dot(p.color)}<button class="rename" data-rename="${esc(a.email)}" title="Rename"><span class="ell">${esc(p.name)}</span><span class="icon hint">${PENCIL}</span></button></span>` },
    ACCOUNT_COLS.email,
    { head: "Week left", w: "11ch", r: true, cell: (a) => left(a.reading, WINDOWS["7d"], now) },
    { head: "5h left", w: "9ch", r: true, cell: (a) => left(a.reading, WINDOWS["5h"], now) },
    ACCOUNT_COLS.status,
    { head: "Requests 24h", w: "14ch", r: true, cell: (a) => day.get(a.email) ?? `<span class="dim">0</span>` },
    { head: "In pool", w: "12ch", s: "auto", cell: (a) => seg(`on-${a.id}`, [["on", "On"], ["off", "Off"]], a.disabled ? "off" : "on") },
    { head: "&nbsp;", w: "8ch", s: "auto", r: true, cell: (a) => `<span class="row-actions"><button class="icon" data-refresh="${esc(a.id)}" title="Ask Anthropic for this account's usage now">${REFRESH}</button><button class="danger icon" data-remove="${esc(a.id)}" title="Remove from the proxy">${BIN}</button></span>` },
  ];
  $page.innerHTML = `
    <div id="signin-box"></div>
    ${section("Accounts", `<button id="signin" class="with-icon">${PLUS}Add account</button>`,
      rows(cols, accs, (c, a) => c.cell(a, person(a.email), now), "accounts"))}`;

  $page.querySelectorAll("[data-rename]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const name = btn.textContent;
      const input = Object.assign(document.createElement("input"), { type: "text", className: "name-edit", value: name });
      btn.replaceWith(input);
      input.focus();
      input.select();
      const save = async () => {
        if (input.value.trim() && input.value.trim() !== name) {
          try { await api("PUT", `/names/${encodeURIComponent(btn.dataset.rename)}`, { name: input.value }); } catch (e) { alert(e.message); }
        }
        render();
      };
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") input.blur(); if (ev.key === "Escape") { input.value = ""; input.blur(); } });
      input.addEventListener("blur", save, { once: true });
    }));
  for (const a of accs)
    onSeg(`on-${a.id}`, async (v) => {
      try { await api("PATCH", `/accounts/${encodeURIComponent(a.id)}`, { disabled: v === "off" }); } catch (e) { alert(e.message); }
      render();
    });
  $page.querySelectorAll("[data-refresh]").forEach((el) =>
    el.addEventListener("click", async () => {
      el.disabled = true;
      try { await api("POST", `/accounts/${encodeURIComponent(el.dataset.refresh)}/refresh`); } catch (e) { alert(e.message); }
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
  try { s = await api("POST", "/signin"); } catch (e) { box.innerHTML = section("Sign in", "", `<div class="err">${esc(e.message)}</div>`); return; }
  box.innerHTML = `<div class="signin">${section("Sign in", `<button id="signin-cancel">Cancel</button>`, `
    <div class="list">
      ${kv("1 · Sign in with the account to add", `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="go">Open Claude ↗</a>`)}
      ${kv("2 · If it ends on localhost:54545, paste that address", `<span class="paste"><input type="text" id="signin-url"><button id="signin-send">Send</button></span>`)}
      ${kv("State", `<span id="signin-state" class="dim">Waiting</span>`)}
    </div>`)}</div>`;
  const state = document.getElementById("signin-state");
  const stop = () => { clearInterval(signinPoll); signinPoll = null; };
  stop();
  signinPoll = setInterval(async () => {
    try {
      const st = await api("GET", `/signin/${encodeURIComponent(s.state)}`);
      if (st.status === "ok" || st.status === "success" || st.status === "done") { stop(); state.textContent = "[Signed in]"; state.className = "ok-t"; setTimeout(render, 1200); }
      else if (st.status === "error" || st.error) { stop(); state.textContent = st.error || "[Failed]"; state.className = "bad-t"; }
    } catch (e) { stop(); state.textContent = e.message; state.className = "bad-t"; }
  }, 2000);
  document.getElementById("signin-cancel").addEventListener("click", async () => {
    stop();
    await api("DELETE", `/signin/${encodeURIComponent(s.state)}`).catch(() => {});
    box.innerHTML = "";
  });
  document.getElementById("signin-send").addEventListener("click", async () => {
    try { await api("POST", "/signin-callback", { redirect_url: document.getElementById("signin-url").value.trim() }); state.textContent = "Finishing"; }
    catch (e) { state.textContent = e.message; state.className = "bad-t"; }
  });
}

// ---------------------------------------------------------------- logs

let logFilter = {};
// The proxy's status codes, as a word a person can act on.
const failure = (status) => (status === 429 ? "Limit" : status === 401 || status === 403 ? "Auth" : status >= 500 ? "Server" : "Error");
document.addEventListener("click", (ev) => {
  if (!ev.target.closest("[data-failed]")) return;
  logFilter = { status: "failed" };
  if (location.hash === "#logs") render();
});
async function logsPage() {
  const q = new URLSearchParams(Object.entries(logFilter).filter(([, v]) => v));
  const [first, accs] = await Promise.all([api("GET", `/requests?${q}`), api("GET", "/accounts")]);
  const person = people(accs);
  const list = [...first.rows];
  const pick = (name, values, show) => drop(`filter-${name}`, [["", "Any"], ...values.map((v) => [v, show(v)])], logFilter[name] ?? "", name);
  const today = Date.now();
  const dayLabel = (ts) => sameDay(ts, today) ? "Today" : sameDay(ts, today - DAY) ? "Yesterday"
    : new Date(ts).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const cols = [
    { head: "Time", w: "8ch", s: "6ch", cell: (r) => `<span class="dim" title="${esc(new Date(r.ts).toLocaleString("en-GB"))}">${hm(r.ts)}</span>` },
    { head: "Project", w: "minmax(12ch,1fr)", s: "minmax(8ch,1fr)", cell: (r) => `<span class="project"><span class="ell up ${r.project ? "" : "dim"}">${esc(projectName(r.project))}</span>${r.parent
      ? `<span class="agent" title="Made by a subagent">${CHILD}</span>` : ""}</span>` },
    { head: "Account", w: "minmax(12ch,1fr)", s: "auto", cell: (r) => who(person(r.account)) },
    { head: "Model", w: "13ch", cell: (r) => `<span class="up">${esc(modelName(r.model))}</span>` },
    { head: "Tokens in", w: "11ch", r: true, cell: (r) => kfmt(tokensIn(r)) },
    { head: "From cache", w: "12ch", r: true, cell: (r) => `<span class="dim">${tokensIn(r) ? pct(r.cache_read / tokensIn(r)) : "—"}</span>` },
    { head: "Tokens out", w: "12ch", r: true, cell: (r) => kfmt(r.output) },
    { head: "Duration", w: "10ch", r: true, cell: (r) => `${(r.latency_ms / 1000).toFixed(1)}s` },
    { head: "Status", w: "14ch", s: "auto", r: true, cell: (r) => r.status === 200 ? `<span class="dim">OK</span>`
      : `<span class="bad-t" title="${esc(r.error)}">[${r.status ? `${r.status} ${failure(r.status)}` : "No reply"}]</span>` },
  ];
  // A day row wherever the date changes.
  const logRows = (items) => {
    let lastDay = null;
    const withDays = items.flatMap((r) => {
      const day = dayLabel(r.ts);
      const out = day !== lastDay ? [{ divider: esc(day) }, r] : [r];
      lastDay = day;
      return out;
    });
    return rows(cols, withDays, (c, r) => c.cell(r), "logs");
  };

  $page.innerHTML = section("Requests", `
      ${pick("account", [...accs.map((a) => a.email).filter((e) => first.facets.account.includes(e)), ...first.facets.account.filter((e) => !accs.some((a) => a.email === e))], (e) => person(e).name)}
      ${pick("project", ["(none)", ...first.facets.project], (p) => (p === "(none)" ? "No project" : p))}
      ${pick("model", first.facets.model, modelName)}
      ${pick("status", ["ok", "failed"], (s) => s)}`, `
    ${totalsList(first.totals)}
    <div class="scroll" id="logs">${list.length ? logRows(list) : `<div class="empty-note">No requests match</div>`}</div>
    ${list.length === 200 ? `<button class="more" id="more">Load older ↓</button>` : ""}`);

  for (const name of ["account", "project", "model", "status"])
    onSeg(`filter-${name}`, (v) => { logFilter = { ...logFilter, [name]: v }; render(); });
  document.getElementById("more")?.addEventListener("click", async (ev) => {
    const next = await api("GET", `/requests?${new URLSearchParams({ ...Object.fromEntries(q), before: list.at(-1).ts })}`);
    list.push(...next.rows);
    document.getElementById("logs").innerHTML = logRows(list);
    if (next.rows.length < 200) ev.target.remove();
  });
}

// ---------------------------------------------------------------- config


async function configPage() {
  const tab = pref.get("configTab", "form");
  const { yaml, form } = await api("GET", "/config");
  $page.innerHTML = section("Routing", seg("tab", [["form", "Settings"], ["yaml", "Raw YAML"]], tab), tab === "form" ? `
      <div class="list form">
        ${kv("Spread requests", seg("strategy", [
          ["round-robin", "Round-robin", "Each new conversation goes to the next account"],
          ["fill-first", "Fill first", "Use one account until its quota runs out, then the next"],
          ["weighted-round-robin", "Weighted", "Round-robin, sending more to accounts with more quota left"]], form.strategy), "field-strategy")}
        ${kv("Keep a conversation on one account", seg("affinity", [["on", "On"], ["off", "Off"]], form.affinity ? "on" : "off"), "field-affinity",
          "Keeps the prompt cache: a conversation that changes account pays its whole prompt again")}
        ${kv(`${CHILD}Until it is idle for`, `<input type="text" id="f-ttl" value="${esc(form.affinityTtl)}">`, `field-affinityTtl child ${form.affinity ? "" : "off"}`)}
        ${kv(`${CHILD}Move it to another account on`, seg("rebind", [
          ["any", "Any error", "Any failed request moves the conversation"],
          ["quota", "Quota or auth", "Only an exhausted quota or a lost sign-in moves it"],
          ["never", "Never", "The conversation fails rather than move"]], form.rebind), `field-rebind child ${form.affinity ? "" : "off"}`)}
        ${kv("Retry rounds when all accounts fail", `<input type="number" id="f-retry" min="0" max="10" value="${esc(form.retry)}">`, "field-retry")}
      </div>` : `<textarea id="yaml" spellcheck="false">${esc(yaml)}</textarea>`) + `
    <div class="actions"><span id="msg" class="msg"></span><button id="revert" hidden>Revert</button><button id="save" class="primary" hidden>Save</button></div>`;

  const save = document.getElementById("save"), revert = document.getElementById("revert"), msg = document.getElementById("msg");
  const read = () => tab === "form"
    ? { strategy: segValue("strategy"), affinity: segValue("affinity") === "on", rebind: segValue("rebind"), affinityTtl: document.getElementById("f-ttl").value.trim(), retry: Number(document.getElementById("f-retry").value) }
    : document.getElementById("yaml").value;
  const initial = read();
  // Save and Revert only show while something differs from what the proxy holds; a dot marks each changed setting.
  const changed = () => {
    const current = read();
    const dirty = JSON.stringify(current) !== JSON.stringify(initial);
    if (tab === "form") for (const k in current) $page.querySelector(`.field-${k}`).classList.toggle("changed", current[k] !== initial[k]);
    save.hidden = revert.hidden = !dirty;
    // A reload of the proxy's config forgets which account each conversation was kept on.
    msg.textContent = dirty ? "Saving forgets which account each conversation is on" : "";
    msg.className = "msg dim";
    $page.querySelectorAll(".child").forEach((el) => el.classList.toggle("off", segValue("affinity") !== "on"));
  };
  onSeg("tab", (v) => { pref.set("configTab", v); render(); });
  for (const name of ["strategy", "affinity", "rebind"])
    onSeg(name, (v, el) => { el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v)); changed(); });
  $page.querySelectorAll("input, textarea").forEach((el) => el.addEventListener("input", changed));
  revert.addEventListener("click", render);
  save.addEventListener("click", async () => {
    try {
      if (tab === "form") await api("PUT", "/config/form", read());
      else await api("PUT", "/config/yaml", read());
      await render();
      const m = document.getElementById("msg");
      m.textContent = "Saved"; m.className = "msg ok";
      setTimeout(() => { if (m.textContent === "Saved") m.textContent = ""; }, 1000);
    } catch (e) { msg.textContent = e.message; msg.className = "msg bad"; }
  });
}

// ---------------------------------------------------------------- shell

const PAGES = { usage: usagePage, accounts: accountsPage, logs: logsPage, config: configPage };
let redraw = null;

async function render() {
  const name = location.hash.slice(1) in PAGES ? location.hash.slice(1) : "usage";
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === name));
  hideTip();
  try {
    redraw = (await PAGES[name]()) ?? null;
    setPulse(true);
  } catch (e) {
    $page.innerHTML = section("Error", "", `<div class="err">${esc(e.message)}</div>`);
    setPulse(false);
  }
}
function setPulse(ok) {
  const el = document.getElementById("pulse");
  el.textContent = ok ? "[Up]" : "[Down]";
  el.className = `link ${ok ? "ok-t" : "bad-t"}`;
}

// A page opens at its top; its own link, clicked again, reloads it there.
const open = async () => { await render(); scrollTo(0, 0); };
addEventListener("hashchange", open);
document.querySelector(".top").addEventListener("click", (ev) => {
  const a = ev.target.closest("a[href^='#']");
  if (!a || a.getAttribute("href") !== (location.hash || "#usage")) return;
  ev.preventDefault();
  open();
});
addEventListener("resize", () => redraw?.());
// Usage refreshes on its own; the other pages hold forms or scroll positions.
setInterval(() => { if (!document.hidden && (location.hash || "#usage") === "#usage") render(); }, 60_000);
render();

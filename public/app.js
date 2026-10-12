"use strict";

/* ---------- Defaults ---------- */

const DEFAULT_HABITS = [
  { id: "business", name: "Building the business", weeklyMin: 300, dailyMin: 0 },
  { id: "active", name: "Active lifestyle", weeklyMin: 300, dailyMin: 0 },
  { id: "reading", name: "Reading", weeklyMin: 120, dailyMin: 15 },
  { id: "wife", name: "Time with my wife", weeklyMin: 300, dailyMin: 0 },
  { id: "riley", name: "Time with Riley", weeklyMin: 300, dailyMin: 0 },
  { id: "eitan", name: "Time with Eitan", weeklyMin: 300, dailyMin: 0 },
];

function freshData() {
  return { version: 1, habits: DEFAULT_HABITS.map((h) => ({ ...h, archived: false })), habitsT: 0, logs: {} };
}

/* ---------- Dates (local time, weeks start Monday) ---------- */

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
const todayKey = () => keyOf(new Date());
const weekStart = (k) => { const d = parseKey(k); return addDays(k, -((d.getDay() + 6) % 7)); };
const weekDays = (k) => { const s = weekStart(k); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(s, i)); };

function prettyDate(k) {
  const t = todayKey();
  if (k === t) return "Today";
  if (k === addDays(t, -1)) return "Yesterday";
  return parseKey(k).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function fmtMin(m) {
  m = Math.round(m || 0);
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/* ---------- Store: local cache + server sync ---------- */

const LS_STATE = "ht.state";
const LS_PASS = "ht.passcode";

const store = {
  data: null,
  updatedAt: 0,
  dirty: false,

  load() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_STATE));
      if (s?.data) Object.assign(this, { data: s.data, updatedAt: s.updatedAt || 0, dirty: !!s.dirty });
    } catch {}
    if (!this.data) this.data = freshData();
  },

  save() {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify({ data: this.data, updatedAt: this.updatedAt, dirty: this.dirty }));
    } catch {}
  },

  // Call after any edit.
  touch() {
    this.updatedAt = Date.now();
    this.dirty = true;
    this.save();
    sync.schedule();
  },
};

// Merge two copies: per-entry timestamps for logs, whole-list timestamp for habits.
function merge(a, b) {
  const out = { version: 1, logs: {} };
  const newer = (b.habitsT || 0) > (a.habitsT || 0) ? b : a;
  out.habits = newer.habits;
  out.habitsT = newer.habitsT || 0;
  for (const src of [a.logs || {}, b.logs || {}]) {
    for (const [day, entries] of Object.entries(src)) {
      out.logs[day] ??= {};
      for (const [hid, e] of Object.entries(entries)) {
        const cur = out.logs[day][hid];
        if (!cur || (e.t || 0) > (cur.t || 0)) out.logs[day][hid] = e;
      }
    }
  }
  return out;
}

const sync = {
  timer: null,
  state: "idle", // idle | syncing | ok | offline | locked | error

  pass() { try { return localStorage.getItem(LS_PASS) || ""; } catch { return ""; } },

  setStatus(state, msg) {
    this.state = state;
    const el = document.getElementById("sync");
    const labels = { syncing: "Syncing…", ok: "Synced", offline: "Offline · saved on this device", locked: "Not synced · tap to unlock", error: "Sync error" };
    el.textContent = msg || labels[state] || "";
    el.className = "sync" + (state === "error" || state === "locked" ? " err" : "");
    el.onclick = state === "locked" ? askPasscode : null;
    el.style.cursor = state === "locked" ? "pointer" : "";
  },

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 700);
  },

  async request(method, body) {
    const res = await fetch("/api/data", {
      method,
      headers: { "content-type": "application/json", "x-passcode": this.pass() },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  },

  // Pull, merge, push if anything local is newer.
  async run() {
    if (this.state === "locked" && !this.pass()) return;
    this.setStatus("syncing");
    try {
      const got = await this.request("GET");
      if (got.status === 401) return this.setStatus("locked");
      if (got.status === 404 || !got.json) return this.setStatus("offline");
      if (got.status !== 200) return this.setStatus("error", "Sync error: " + (got.json?.error || got.status));

      const server = got.json;
      if (server.data) {
        const merged = merge(server.data, store.data);
        const changed = JSON.stringify(merged) !== JSON.stringify(store.data);
        store.data = merged;
        if (changed) render();
      }
      const needsPush = store.dirty || !server.data;
      if (needsPush) {
        const ts = Math.max(Date.now(), server.updatedAt + 1);
        const put = await this.request("PUT", { data: store.data, updatedAt: ts });
        if (put.status === 409) return this.schedule(); // someone else wrote in between; merge again
        if (put.status !== 200) return this.setStatus("error", "Sync error: " + (put.json?.error || put.status));
        store.updatedAt = ts;
      } else {
        store.updatedAt = server.updatedAt;
      }
      store.dirty = false;
      store.save();
      this.setStatus("ok");
    } catch {
      this.setStatus("offline");
    }
  },
};

function askPasscode() {
  const dlg = document.getElementById("passDialog");
  const input = document.getElementById("passInput");
  input.value = "";
  dlg.showModal();
  dlg.onclose = () => {
    if (dlg.returnValue === "ok" && input.value) {
      try { localStorage.setItem(LS_PASS, input.value); } catch {}
      sync.state = "idle";
      sync.run().then(() => { if (sync.state === "locked") askPasscode(); });
    }
  };
}

/* ---------- Data helpers ---------- */

const activeHabits = () => store.data.habits.filter((h) => !h.archived);
const entry = (day, hid) => store.data.logs[day]?.[hid] || { done: false, min: 0 };

function setEntry(day, hid, patch) {
  const cur = entry(day, hid);
  const next = { ...cur, ...patch, t: Date.now() };
  if (next.min > 0) next.done = true;
  if (!next.done) next.min = 0;
  store.data.logs[day] ??= {};
  store.data.logs[day][hid] = next;
  store.touch();
}

function weekTotal(hid, anyDayInWeek) {
  return weekDays(anyDayInWeek).reduce((sum, d) => sum + (entry(d, hid).min || 0), 0);
}

function touchHabits() {
  store.data.habitsT = Date.now();
  store.touch();
}

/* ---------- Views ---------- */

let tab = "today";
let selectedDay = todayKey();
let selectedWeek = weekStart(todayKey());
// Review defaults to the week just finished, or this week if it's Sunday.
const defaultReviewWeek = () => (parseKey(todayKey()).getDay() === 0 ? weekStart(todayKey()) : addDays(weekStart(todayKey()), -7));
let reviewWeek = defaultReviewWeek();
let historyWeeks = 12;
let charts = [];
const view = document.getElementById("view");

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function render() {
  charts.forEach((c) => c.destroy());
  charts = [];
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  ({ today: renderToday, week: renderWeek, review: renderReview, history: renderHistory, settings: renderSettings }[tab])();
}

function renderToday() {
  const d = selectedDay;
  const isToday = d === todayKey();
  const habits = activeHabits();

  view.innerHTML = `
    <div class="datebar">
      <button class="icon-btn" data-nav="-1" aria-label="Previous day">‹</button>
      <label class="label">${esc(prettyDate(d))}
        <input type="date" id="datePick" value="${d}" max="${todayKey()}" />
      </label>
      <button class="icon-btn" data-nav="1" aria-label="Next day" ${isToday ? "disabled" : ""}>›</button>
      ${isToday ? "" : '<button class="icon-btn" data-nav="today">Today</button>'}
    </div>
    ${habits.length ? "" : '<div class="empty">No habits yet. Add some in Settings.</div>'}
    ${habits.map((h) => {
      const e = entry(d, h.id);
      const total = weekTotal(h.id, d);
      const floor = h.dailyMin > 0
        ? `<span class="tag ${e.min >= h.dailyMin ? "" : "warn"}">${e.min >= h.dailyMin ? "Daily min hit" : `${h.dailyMin}m daily min`}</span>`
        : "";
      return `
      <div class="card" data-hid="${esc(h.id)}">
        <div class="spread">
          <h3>${esc(h.name)}</h3>
          <button class="check ${e.done ? "on" : ""}" data-act="toggle" aria-pressed="${e.done}" aria-label="Did ${esc(h.name)} today">${e.done ? CHECK_SVG : ""}</button>
        </div>
        <div class="minutes">
          <input type="number" inputmode="numeric" min="0" step="5" value="${e.min || ""}" placeholder="0" data-act="min" aria-label="Minutes" />
          <span class="muted">min</span>
          <button class="chip" data-add="15">+15</button>
          <button class="chip" data-add="30">+30</button>
          <button class="chip" data-add="60">+60</button>
        </div>
        <div class="weekline spread">
          <span>This week: ${fmtMin(total)} / ${fmtMin(h.weeklyMin)}</span>
          ${floor}
        </div>
      </div>`;
    }).join("")}
  `;
}

const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];

function fmtRange(start) {
  const opts = { month: "short", day: "numeric" };
  const a = parseKey(start).toLocaleDateString(undefined, opts);
  const b = parseKey(addDays(start, 6)).toLocaleDateString(undefined, opts);
  return `${a} – ${b}`;
}

// Progress for one habit in the week starting `ws`.
function weekStatus(h, ws) {
  const days = weekDays(ws);
  const today = todayKey();
  const isCurrent = ws === weekStart(today);
  const total = days.reduce((sum, d) => sum + (entry(d, h.id).min || 0), 0);
  // Pace counts only full days already behind you, so Monday morning isn't "behind".
  const daysDone = isCurrent ? days.indexOf(today) : 7;
  const expected = (h.weeklyMin * daysDone) / 7;
  const daysLeft = 7 - daysDone;
  const hit = total >= h.weeklyMin;
  const behind = isCurrent && !hit && total < expected;
  const perDay = !hit && daysLeft > 0 ? (h.weeklyMin - total) / daysLeft : 0;
  const cells = days.map((d) => {
    const e = entry(d, h.id);
    const future = d > today;
    const ok = h.dailyMin > 0 ? e.min >= h.dailyMin : e.done;
    // Today isn't a miss until it's over.
    const state = ok ? "hit" : future || d === today ? "open" : h.dailyMin > 0 ? "miss" : "off";
    return { d, state, future };
  });
  const floorHits = cells.filter((c) => c.state === "hit").length;
  return { total, expected, hit, behind, perDay, isCurrent, cells, floorHits, daysDone };
}

function renderWeek() {
  const ws = selectedWeek;
  const isCurrent = ws === weekStart(todayKey());
  const habits = activeHabits();
  const stats = habits.map((h) => [h, weekStatus(h, ws)]);
  const good = stats.filter(([, s]) => (isCurrent ? !s.behind : s.hit)).length;

  view.innerHTML = `
    <div class="datebar">
      <button class="icon-btn" data-wnav="-7" aria-label="Previous week">‹</button>
      <span class="label">${isCurrent ? "This week" : fmtRange(ws)}</span>
      <button class="icon-btn" data-wnav="7" aria-label="Next week" ${isCurrent ? "disabled" : ""}>›</button>
      ${isCurrent ? "" : '<button class="icon-btn" data-wnav="now">Now</button>'}
    </div>
    <p class="muted summary">${isCurrent ? `${fmtRange(ws)} · ${good} of ${habits.length} on pace` : `${good} of ${habits.length} targets hit`}</p>
    ${stats.map(([h, s]) => {
      const pct = h.weeklyMin ? Math.min(100, (s.total / h.weeklyMin) * 100) : 100;
      const pacePct = h.weeklyMin ? Math.min(100, (s.expected / h.weeklyMin) * 100) : 0;
      const tag = s.hit ? '<span class="tag">Target hit</span>'
        : s.behind ? '<span class="tag warn">Behind pace</span>'
        : s.isCurrent ? '<span class="tag neutral">On pace</span>'
        : '<span class="tag warn">Missed</span>';
      const floorLine = h.dailyMin > 0
        ? `<span>Daily ${h.dailyMin}m: ${s.floorHits}/${s.isCurrent ? s.daysDone + (s.cells[s.daysDone]?.state === "hit" ? 1 : 0) : 7} days</span>`
        : "";
      return `
      <div class="card">
        <div class="spread"><h3>${esc(h.name)}</h3>${tag}</div>
        <div class="bar ${s.hit ? "done" : s.behind ? "behind" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="${h.weeklyMin}" aria-valuenow="${s.total}">
          <div class="fill" style="width:${pct}%"></div>
          ${s.isCurrent && !s.hit && pacePct > 0 ? `<div class="pace" style="left:${pacePct}%" title="Where you should be by now"></div>` : ""}
        </div>
        <div class="weekline spread">
          <span><b>${fmtMin(s.total)}</b> / ${fmtMin(h.weeklyMin)}</span>
          <span>${s.perDay ? `~${fmtMin(s.perDay)}/day to finish` : s.hit && s.total > h.weeklyMin ? `+${fmtMin(s.total - h.weeklyMin)} over` : ""}</span>
        </div>
        <div class="days">
          ${s.cells.map((c, i) => `<button class="day ${c.state}" data-day="${c.d}" ${c.future ? "disabled" : ""} title="${esc(prettyDate(c.d))}">${DAY_LETTERS[i]}</button>`).join("")}
        </div>
        ${floorLine ? `<div class="weekline">${floorLine}</div>` : ""}
      </div>`;
    }).join("")}
    <p class="muted legend">
      <span><span class="day hit"></span>${habits.some((h) => h.dailyMin) ? "Touched / daily min hit" : "Touched"}</span>
      ${habits.some((h) => h.dailyMin) ? '<span><span class="day miss"></span>Daily min missed</span>' : ""}
      <span>Tap a day to edit it</span>
    </p>
  `;
}

function renderReview() {
  const ws = reviewWeek;
  const current = weekStart(todayKey());
  const prev = addDays(ws, -7);
  // Active habits, plus archived ones that still have time logged that week.
  const habits = store.data.habits.filter((h) => !h.archived || weekTotal(h.id, ws) > 0);
  const rows = habits.map((h) => {
    const s = weekStatus(h, ws);
    return { h, s, delta: s.total - weekTotal(h.id, prev), pct: h.weeklyMin ? Math.round((s.total / h.weeklyMin) * 100) : 100 };
  });
  const hits = rows.filter((r) => r.s.hit).length;
  const logged = rows.reduce((a, r) => a + r.s.total, 0);
  const target = rows.reduce((a, r) => a + r.h.weeklyMin, 0);
  const inProgress = ws === current;

  view.innerHTML = `
    <div class="datebar">
      <button class="icon-btn" data-rnav="-7" aria-label="Previous week">‹</button>
      <span class="label">${fmtRange(ws)}</span>
      <button class="icon-btn" data-rnav="7" aria-label="Next week" ${ws >= current ? "disabled" : ""}>›</button>
    </div>
    ${inProgress ? '<p class="muted summary">Week still in progress</p>' : ""}
    <div class="card score">
      <div><div class="big">${hits}<span class="muted"> / ${rows.length}</span></div><div class="muted">targets hit</div></div>
      <div><div class="big">${fmtMin(logged)}</div><div class="muted">of ${fmtMin(target)} total (${target ? Math.round((logged / target) * 100) : 0}%)</div></div>
    </div>
    <div class="card list">
      ${rows.map(({ h, s, delta, pct }) => `
        <div class="review-row">
          <div class="spread">
            <h3>${esc(h.name)}${h.archived ? ' <span class="muted">(archived)</span>' : ""}</h3>
            <span class="tag ${s.hit ? "" : inProgress ? "neutral" : "warn"}">${s.hit ? "✓ Hit" : inProgress ? "Open" : "✗ Miss"}</span>
          </div>
          <div class="bar ${s.hit ? "done" : inProgress ? "" : "behind"}"><div class="fill" style="width:${Math.min(100, pct)}%"></div></div>
          <div class="weekline spread">
            <span><b>${fmtMin(s.total)}</b> / ${fmtMin(h.weeklyMin)} · ${pct}%</span>
            <span class="${delta > 0 ? "up" : delta < 0 ? "down" : ""}">${delta === 0 ? "same as last week" : `${delta > 0 ? "▲" : "▼"} ${fmtMin(Math.abs(delta))} vs last week`}</span>
          </div>
          ${h.dailyMin > 0 ? `<div class="weekline">Daily ${h.dailyMin}m minimum: ${s.floorHits} of 7 days</div>` : ""}
        </div>`).join("")}
    </div>
  `;
}

// Week starts to chart: up to `n` weeks ending with the current one, not before the first log.
function historyRange(n) {
  const current = weekStart(todayKey());
  const days = Object.keys(store.data.logs).filter((d) => Object.values(store.data.logs[d]).some((e) => e.min > 0)).sort();
  const first = days.length ? weekStart(days[0]) : current;
  const weeks = [];
  for (let w = current; weeks.length < n && (w >= first || weeks.length < 4); w = addDays(w, -7)) weeks.unshift(w);
  return weeks;
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function trend(h, weeks) {
  const done = weeks.slice(0, -1); // complete weeks only
  const totals = done.map((w) => weekTotal(h.id, w));
  const last4 = totals.slice(-4), prev4 = totals.slice(-8, -4);
  let streak = 0;
  for (let i = totals.length - 1; i >= 0 && totals[i] >= h.weeklyMin; i--) streak++;
  return {
    avg4: avg(last4),
    change: prev4.length ? avg(last4) - avg(prev4) : null,
    hits: totals.filter((t) => t >= h.weeklyMin).length,
    of: totals.length,
    streak,
  };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderHistory() {
  const weeks = historyRange(historyWeeks);
  const habits = activeHabits();
  const label = (w) => parseKey(w).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  view.innerHTML = `
    <div class="row chips-row">
      ${[8, 12, 26, 52].map((n) => `<button class="chip ${n === historyWeeks ? "on" : ""}" data-range="${n}">${n} wks</button>`).join("")}
    </div>
    <div class="card">
      <div class="spread"><h3>Targets hit per week</h3><span class="muted">of ${habits.length}</span></div>
      <div class="chart-box small"><canvas id="ch-overview" aria-label="Targets hit per week"></canvas></div>
    </div>
    ${habits.map((h) => {
      const t = trend(h, weeks);
      const change = t.change == null ? "" : t.change === 0 ? " · flat" : ` · <span class="${t.change > 0 ? "up" : "down"}">${t.change > 0 ? "▲" : "▼"} ${fmtMin(Math.abs(t.change))}</span> vs prior 4`;
      return `
      <div class="card">
        <div class="spread"><h3>${esc(h.name)}</h3><span class="muted">target ${fmtMin(h.weeklyMin)}</span></div>
        <div class="weekline">4-wk avg <b>${fmtMin(t.avg4)}</b>${change}</div>
        <div class="weekline">Hit ${t.hits} of ${t.of} weeks${t.streak > 1 ? ` · ${t.streak}-week streak` : ""}</div>
        <div class="chart-box"><canvas id="ch-${esc(h.id)}" aria-label="${esc(h.name)} weekly totals"></canvas></div>
      </div>`;
    }).join("")}
    <p class="muted legend"><span><span class="swatch"></span>Weekly total</span><span><span class="swatch dash"></span>Target</span><span>Latest bar is this week (in progress)</span></p>
  `;

  if (!window.Chart) {
    view.querySelectorAll(".chart-box").forEach((el) => (el.innerHTML = '<p class="muted">Charts need an internet connection to load.</p>'));
    return;
  }

  const ink = cssVar("--muted"), line = cssVar("--line"), accent = cssVar("--accent"), text = cssVar("--text"), surface = cssVar("--surface");
  const labels = weeks.map(label);
  const lastIdx = weeks.length - 1;
  const base = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: text, titleColor: surface, bodyColor: surface, displayColors: false, padding: 8 },
    },
    scales: {
      x: { grid: { display: false }, border: { color: line }, ticks: { color: ink, maxRotation: 0, autoSkipPadding: 12, font: { size: 11 } } },
      y: { beginAtZero: true, grid: { color: line }, border: { display: false }, ticks: { color: ink, font: { size: 11 }, maxTicksLimit: 5 } },
    },
  };
  const barStyle = (n) => ({
    backgroundColor: weeks.map((_, i) => (i === lastIdx ? accent + "66" : accent)),
    borderRadius: { topLeft: 4, topRight: 4 },
    borderSkipped: "bottom",
    maxBarThickness: 28,
    categoryPercentage: n > 26 ? 0.95 : 0.8,
  });
  const inProgress = (i) => (i === lastIdx ? " (in progress)" : "");

  // Overview: number of targets hit each week.
  const hitsPerWeek = weeks.map((w) => habits.filter((h) => weekTotal(h.id, w) >= h.weeklyMin).length);
  charts.push(new Chart(document.getElementById("ch-overview"), {
    type: "bar",
    data: { labels, datasets: [{ data: hitsPerWeek, ...barStyle(weeks.length) }] },
    options: {
      ...base,
      plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: {
        title: (it) => fmtRange(weeks[it[0].dataIndex]) + inProgress(it[0].dataIndex),
        label: (it) => `${it.raw} of ${habits.length} targets hit`,
      } } },
      scales: { ...base.scales, y: { ...base.scales.y, max: habits.length || 1, ticks: { ...base.scales.y.ticks, stepSize: 1 } } },
    },
  }));

  // One chart per habit: weekly total (hours) vs target line.
  for (const h of habits) {
    const totals = weeks.map((w) => weekTotal(h.id, w));
    const hrs = (m) => Math.round((m / 60) * 100) / 100;
    charts.push(new Chart(document.getElementById("ch-" + h.id), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { type: "bar", data: totals.map(hrs), ...barStyle(weeks.length), order: 2 },
          { type: "line", data: weeks.map(() => hrs(h.weeklyMin)), borderColor: text, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, pointHitRadius: 0, order: 1 },
        ],
      },
      options: {
        ...base,
        plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, filter: (it) => it.datasetIndex === 0, callbacks: {
          title: (it) => fmtRange(weeks[it[0].dataIndex]) + inProgress(it[0].dataIndex),
          label: (it) => {
            const m = totals[it.dataIndex];
            return `${fmtMin(m)} of ${fmtMin(h.weeklyMin)} (${h.weeklyMin ? Math.round((m / h.weeklyMin) * 100) : 100}%)${m >= h.weeklyMin ? " ✓" : ""}`;
          },
        } } },
        scales: { ...base.scales, y: { ...base.scales.y, suggestedMax: hrs(h.weeklyMin) * 1.15, ticks: { ...base.scales.y.ticks, callback: (v) => v + "h" } } },
      },
    }));
  }
}

function renderSettings() {
  const habits = store.data.habits;
  const active = habits.filter((h) => !h.archived);
  const archived = habits.filter((h) => h.archived);

  view.innerHTML = `
    <div class="section-title">Habits</div>
    ${active.map((h, i) => `
      <div class="card" data-hid="${esc(h.id)}">
        <div class="habit-edit">
          <label class="field">Name<input data-edit="name" value="${esc(h.name)}" /></label>
          <label class="field">Weekly (hrs)<input data-edit="weekly" type="number" inputmode="decimal" min="0" step="0.25" value="${h.weeklyMin / 60}" /></label>
          <label class="field">Daily min (m)<input data-edit="daily" type="number" inputmode="numeric" min="0" step="5" value="${h.dailyMin || ""}" placeholder="—" /></label>
        </div>
        <div class="habit-actions">
          <button class="ghost small" data-move="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button class="ghost small" data-move="1" ${i === active.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
          <span style="flex:1"></span>
          <button class="ghost small" data-archive="1">Archive</button>
        </div>
      </div>`).join("")}
    <button class="primary" id="addHabit">+ Add habit</button>

    ${archived.length ? `
      <div class="section-title">Archived</div>
      <p class="muted">Hidden from check-in. History is kept.</p>
      ${archived.map((h) => `
        <div class="card spread" data-hid="${esc(h.id)}">
          <span>${esc(h.name)}</span>
          <button class="ghost small" data-archive="0">Restore</button>
        </div>`).join("")}` : ""}

    <div class="section-title">Sync</div>
    <div class="card">
      <div class="spread">
        <span class="muted">${sync.pass() ? "Passcode saved on this device." : "No passcode set."}</span>
        <button class="ghost small" id="setPass">${sync.pass() ? "Change" : "Set"} passcode</button>
      </div>
    </div>

    <div class="section-title">Backup</div>
    <div class="card row">
      <button class="ghost small" id="exportBtn">Export JSON</button>
      <label class="ghost small" style="cursor:pointer">Import JSON<input type="file" id="importFile" accept="application/json" hidden /></label>
    </div>
  `;
}

/* ---------- Events ---------- */

document.getElementById("tabs").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  render();
});

view.addEventListener("click", (ev) => {
  const t = ev.target;
  const card = t.closest("[data-hid]");
  const hid = card?.dataset.hid;

  const wnav = t.closest("[data-wnav]");
  if (wnav) {
    const v = wnav.dataset.wnav;
    const now = weekStart(todayKey());
    selectedWeek = v === "now" ? now : addDays(selectedWeek, Number(v));
    if (selectedWeek > now) selectedWeek = now;
    return render();
  }
  const range = t.closest("[data-range]");
  if (range) {
    historyWeeks = Number(range.dataset.range);
    return render();
  }
  const rnav = t.closest("[data-rnav]");
  if (rnav) {
    reviewWeek = addDays(reviewWeek, Number(rnav.dataset.rnav));
    const now = weekStart(todayKey());
    if (reviewWeek > now) reviewWeek = now;
    return render();
  }
  const dayBtn = t.closest("[data-day]");
  if (dayBtn) {
    selectedDay = dayBtn.dataset.day;
    tab = "today";
    return render();
  }

  const nav = t.closest("[data-nav]");
  if (nav) {
    const v = nav.dataset.nav;
    selectedDay = v === "today" ? todayKey() : addDays(selectedDay, Number(v));
    if (selectedDay > todayKey()) selectedDay = todayKey();
    return render();
  }
  if (t.closest(".datebar .label")) {
    const p = document.getElementById("datePick");
    return p.showPicker ? p.showPicker() : p.click();
  }

  if (t.closest("[data-act=toggle]")) {
    setEntry(selectedDay, hid, { done: !entry(selectedDay, hid).done });
    return render();
  }
  const add = t.closest("[data-add]");
  if (add) {
    setEntry(selectedDay, hid, { min: (entry(selectedDay, hid).min || 0) + Number(add.dataset.add) });
    return render();
  }

  const move = t.closest("[data-move]");
  if (move) {
    const list = store.data.habits;
    const active = list.filter((h) => !h.archived);
    const i = active.findIndex((h) => h.id === hid);
    const j = i + Number(move.dataset.move);
    if (j < 0 || j >= active.length) return;
    const a = list.indexOf(active[i]), b = list.indexOf(active[j]);
    [list[a], list[b]] = [list[b], list[a]];
    touchHabits();
    return render();
  }
  const arch = t.closest("[data-archive]");
  if (arch) {
    store.data.habits.find((h) => h.id === hid).archived = arch.dataset.archive === "1";
    touchHabits();
    return render();
  }

  if (t.id === "addHabit") {
    store.data.habits.push({ id: "h" + Date.now().toString(36), name: "New habit", weeklyMin: 60, dailyMin: 0, archived: false });
    touchHabits();
    render();
    const inputs = view.querySelectorAll('[data-edit="name"]');
    inputs[inputs.length - 1]?.select();
    return;
  }
  if (t.id === "setPass") return askPasscode();
  if (t.id === "exportBtn") return exportJson();
});

view.addEventListener("change", (ev) => {
  const t = ev.target;
  const hid = t.closest("[data-hid]")?.dataset.hid;

  if (t.id === "datePick" && t.value) {
    selectedDay = t.value > todayKey() ? todayKey() : t.value;
    return render();
  }
  if (t.dataset.act === "min") {
    setEntry(selectedDay, hid, { min: Math.max(0, Math.round(Number(t.value) || 0)) });
    return render();
  }
  if (t.dataset.edit) {
    const h = store.data.habits.find((x) => x.id === hid);
    if (t.dataset.edit === "name") h.name = t.value.trim() || h.name;
    if (t.dataset.edit === "weekly") h.weeklyMin = Math.max(0, Math.round((Number(t.value) || 0) * 60));
    if (t.dataset.edit === "daily") h.dailyMin = Math.max(0, Math.round(Number(t.value) || 0));
    touchHabits();
    return;
  }
  if (t.id === "importFile" && t.files[0]) importJson(t.files[0]);
});

function exportJson() {
  const blob = new Blob([JSON.stringify(store.data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `habits-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.habits) || typeof data.logs !== "object") throw new Error("Not a habit tracker export");
    if (!confirm("Replace all current data with this file?")) return;
    // Stamp everything as new so it wins the merge on other devices.
    const now = Date.now();
    for (const day of Object.values(data.logs)) for (const e of Object.values(day)) e.t = now;
    data.habitsT = now;
    store.data = data;
    store.touch();
    render();
  } catch (e) {
    alert("Import failed: " + e.message);
  }
}

/* ---------- Boot ---------- */

store.load();
render();
sync.run().then(() => { if (sync.state === "locked" && !sync.pass()) askPasscode(); });
// Pick up changes from the other device when coming back to the app.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (selectedDay > todayKey()) selectedDay = todayKey();
    sync.run();
  }
});

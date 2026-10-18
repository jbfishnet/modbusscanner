/**
 * Dashboard tab: multiple persisted dashboards, each a grid of panels
 * (time series, stat, gauge, table) backed by the server-side history
 * (POST /api/query). Config lives in SQLite via /api/dashboards.
 * Depends on uPlot and DashboardCore (loaded before this file) and on the
 * page's toast() helper.
 */
const Dashboard = (function () {
  "use strict";

  const Core = DashboardCore;
  const RANGES = [
    [300, "Last 5 minutes"], [900, "Last 15 minutes"], [3600, "Last 1 hour"], [21600, "Last 6 hours"],
    [86400, "Last 24 hours"], [604800, "Last 7 days"], [2592000, "Last 30 days"],
  ];
  const REFRESHES = [[0, "Off"], [5, "5s"], [10, "10s"], [30, "30s"], [60, "1m"]];
  const TYPES = [["timeseries", "Time series"], ["stat", "Stat"], ["gauge", "Gauge"], ["table", "Table"]];
  const STYLES = [["line", "Line"], ["smooth", "Smooth"], ["step", "Step"], ["area", "Area"], ["points", "Points"]];
  const WIDTHS = [[4, "1/3"], [6, "1/2"], [8, "2/3"], [12, "Full"]];
  const HEIGHTS = [[1, "Small"], [2, "Medium"], [3, "Large"]];
  const ROW_PX = 170;
  const SYNC_KEY = "modbus-dash";

  let registers = new Map(); // tag name -> { unit, section }
  let dashboards = [];
  let current = null;
  let visible = false;
  let refreshTimer = null;
  let saveTimer = null;
  let pollIntervalSec = 10;
  let views = new Map(); // panel id -> { el, body, plot, sig, ro }
  let root = null;

  const $ = (sel, el = root) => el.querySelector(sel);
  const escHtml = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const notify = (msg, isErr) => (typeof toast === "function" ? toast(msg, isErr) : console.log(msg));
  const optionList = (list, selected) =>
    list.map(([v, l]) => `<option value="${v}"${String(v) === String(selected) ? " selected" : ""}>${l}</option>`).join("");

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
    return payload;
  }

  const shortName = (name) => name.replace(/^EU\d+[A-Z]?_/, "").replace(/_/g, " ");
  const seriesLabel = (s) => s.label || shortName(s.name);
  const seriesUnit = (s) => s.unit || (registers.get(s.name) || {}).unit || "";
  const seriesColor = (s, i) => s.color || Core.PALETTE[i % Core.PALETTE.length];

  // ── Persistence ────────────────────────────────────────────────────────────
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (!current) return;
    try {
      const { dashboard } = await api("/api/dashboards", {
        method: "POST",
        body: JSON.stringify({ id: current.id, name: current.name, config: current.config }),
      });
      // Server returns the sanitized document; adopt its generated ids.
      current.config = dashboard.config;
    } catch (err) {
      notify(`Could not save dashboard: ${err.message}`, true);
    }
  }

  async function load() {
    try {
      dashboards = (await api("/api/dashboards")).dashboards;
      pollIntervalSec = (await api("/api/dashboard-settings")).pollIntervalSec;
    } catch (err) {
      console.error("Could not load dashboards:", err.message);
      return;
    }
    const wanted = Number(localStorage.getItem("dashboardId"));
    current = dashboards.find((d) => d.id === wanted) || dashboards[0] || null;
    if (root) renderShell();
    if (visible) refresh();
  }

  // ── Shell (toolbar + grid) ─────────────────────────────────────────────────
  function renderShell() {
    destroyViews();
    if (!current) {
      root.innerHTML = `<div class="dash-shell"><div class="dash-empty">Loading dashboards…</div></div>`;
      return;
    }
    root.innerHTML = `
      <div class="dash-shell">
        <div class="dash-toolbar">
          <select id="dashSelect" aria-label="Dashboard">${dashboards.map((d) =>
            `<option value="${d.id}"${d.id === current.id ? " selected" : ""}>${escHtml(d.name)}</option>`).join("")}</select>
          <button class="dash-btn" id="dashNew" type="button">New</button>
          <button class="dash-btn" id="dashRename" type="button">Rename</button>
          <button class="dash-btn danger" id="dashDelete" type="button"${dashboards.length <= 1 ? " disabled" : ""}>Delete</button>
          <span class="spacer"></span>
          <label>Sample every <input id="dashPoll" type="number" min="2" max="3600" value="${pollIntervalSec}" /> s</label>
          <button class="dash-btn" id="dashPollApply" type="button">Apply</button>
          <select id="dashRange" aria-label="Time range">${optionList(RANGES, current.config.timeRangeSec)}</select>
          <label>Refresh <select id="dashRefresh">${optionList(REFRESHES, current.config.refreshSec)}</select></label>
          <button class="dash-btn" id="dashNow" type="button" title="Refresh now">↻</button>
          <button class="dash-btn primary" id="dashAddPanel" type="button">+ Add panel</button>
        </div>
        <div class="dash-grid" id="dashGrid"></div>
      </div>`;
    $("#dashSelect").onchange = (e) => switchDashboard(Number(e.target.value));
    $("#dashNew").onclick = createDashboard;
    $("#dashRename").onclick = renameDashboard;
    $("#dashDelete").onclick = deleteDashboard;
    $("#dashPollApply").onclick = applyPollInterval;
    $("#dashRange").onchange = (e) => { current.config.timeRangeSec = Number(e.target.value); saveSoon(); refresh(); };
    $("#dashRefresh").onchange = (e) => { current.config.refreshSec = Number(e.target.value); saveSoon(); armTimer(); };
    $("#dashNow").onclick = refresh;
    $("#dashAddPanel").onclick = () => openEditor(null);
    renderPanels();
  }

  function switchDashboard(id) {
    const next = dashboards.find((d) => d.id === id);
    if (!next) return;
    current = next;
    localStorage.setItem("dashboardId", String(id));
    renderShell();
    armTimer();
    refresh();
  }

  async function createDashboard() {
    const name = (prompt("Name for the new dashboard:") || "").trim();
    if (!name) return;
    try {
      const { dashboard } = await api("/api/dashboards", {
        method: "POST",
        body: JSON.stringify({ name, config: { panels: [], timeRangeSec: 3600, refreshSec: 10 } }),
      });
      dashboards.push(dashboard);
      switchDashboard(dashboard.id);
    } catch (err) {
      notify(err.message, true);
    }
  }

  async function renameDashboard() {
    const name = (prompt("Dashboard name:", current.name) || "").trim();
    if (!name || name === current.name) return;
    current.name = name;
    await saveNow();
    renderShell();
    refresh();
  }

  async function deleteDashboard() {
    if (dashboards.length <= 1 || !confirm(`Delete dashboard "${current.name}"?`)) return;
    try {
      await api(`/api/dashboards?id=${current.id}`, { method: "DELETE" });
      dashboards = dashboards.filter((d) => d.id !== current.id);
      switchDashboard(dashboards[0].id);
    } catch (err) {
      notify(err.message, true);
    }
  }

  async function applyPollInterval() {
    try {
      const res = await api("/api/dashboard-settings", {
        method: "POST",
        body: JSON.stringify({ pollIntervalSec: Number($("#dashPoll").value) }),
      });
      pollIntervalSec = res.pollIntervalSec;
      notify(`Background sampling every ${pollIntervalSec} s.`);
    } catch (err) {
      notify(err.message, true);
    }
  }

  // ── Panels ─────────────────────────────────────────────────────────────────
  function destroyViews() {
    for (const v of views.values()) {
      if (v.plot) v.plot.destroy();
      if (v.ro) v.ro.disconnect();
    }
    views = new Map();
  }

  function renderPanels() {
    const grid = $("#dashGrid");
    destroyViews();
    grid.innerHTML = "";
    const panels = current.config.panels;
    if (!panels.length) {
      grid.innerHTML = `<div class="dash-empty">This dashboard has no panels yet. Click <strong>+ Add panel</strong>, or use the <strong>+</strong> buttons in the YAML table.</div>`;
      return;
    }
    for (const panel of panels) {
      const el = document.createElement("div");
      el.className = "dash-panel";
      el.dataset.panelId = panel.id;
      el.style.gridColumn = `span ${panel.width}`;
      el.style.height = `${panel.height * ROW_PX + 34}px`;
      el.innerHTML = `
        <div class="dash-panel-head">
          <div class="dash-panel-title">${escHtml(panel.title)}</div>
          <button class="dash-icon" data-act="left" title="Move earlier" aria-label="Move panel earlier">◀</button>
          <button class="dash-icon" data-act="right" title="Move later" aria-label="Move panel later">▶</button>
          <button class="dash-icon" data-act="edit" title="Edit panel" aria-label="Edit panel">✎</button>
          <button class="dash-icon" data-act="remove" title="Remove panel" aria-label="Remove panel">✕</button>
        </div>
        <div class="dash-panel-body"></div>`;
      el.querySelector('[data-act="edit"]').onclick = () => openEditor(panel.id);
      el.querySelector('[data-act="remove"]').onclick = () => removePanel(panel.id);
      el.querySelector('[data-act="left"]').onclick = () => movePanel(panel.id, -1);
      el.querySelector('[data-act="right"]').onclick = () => movePanel(panel.id, 1);
      grid.appendChild(el);
      views.set(panel.id, { el, body: el.querySelector(".dash-panel-body"), plot: null, sig: null, ro: null });
    }
  }

  function removePanel(id) {
    current.config.panels = current.config.panels.filter((p) => p.id !== id);
    saveSoon();
    renderPanels();
    refresh();
  }

  function movePanel(id, delta) {
    const list = current.config.panels;
    const i = list.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    saveSoon();
    renderPanels();
    refresh();
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  async function refresh() {
    if (!visible || !current) return;
    const to = Date.now();
    const from = to - current.config.timeRangeSec * 1000;
    await Promise.all(current.config.panels.map(async (panel) => {
      const view = views.get(panel.id);
      if (!view) return;
      if (!panel.series.length) return showMessage(view, "No series. Edit the panel to add registers.");
      try {
        const maxPoints = Math.max(60, Math.round(view.body.clientWidth || 600));
        const res = await api("/api/query", {
          method: "POST",
          body: JSON.stringify({ series: panel.series.map(({ name, ip }) => ({ name, ip })), from, to, maxPoints }),
        });
        renderPanel(panel, view, res.series, from, to);
      } catch (err) {
        showMessage(view, `Query failed: ${err.message}`);
      }
    }));
  }

  function armTimer() {
    clearInterval(refreshTimer);
    refreshTimer = null;
    const sec = current && current.config.refreshSec;
    if (visible && sec > 0) refreshTimer = setInterval(refresh, sec * 1000);
  }

  function showMessage(view, text) {
    if (view.plot) { view.plot.destroy(); view.plot = null; }
    if (view.ro) { view.ro.disconnect(); view.ro = null; }
    view.sig = null;
    view.body.innerHTML = `<div class="dash-msg">${escHtml(text)}</div>`;
  }

  const hasData = (results) => results.some((r) => r.points.length);

  function renderPanel(panel, view, results, from, to) {
    if (!hasData(results)) {
      return showMessage(view, `No data in this time range yet. The background poller records every ${pollIntervalSec} s.`);
    }
    if (panel.type === "timeseries") renderTimeSeries(panel, view, results, from, to);
    else {
      if (view.plot) { view.plot.destroy(); view.plot = null; }
      view.sig = null;
      if (panel.type === "stat") renderStat(panel, view, results);
      else if (panel.type === "gauge") renderGauge(panel, view, results);
      else renderTable(panel, view, results);
    }
  }

  const lastValue = (points) => {
    for (let i = points.length - 1; i >= 0; i--) if (Number.isFinite(points[i][1])) return points[i][1];
    return null;
  };

  function fmt(panel, value, unit) {
    const d = panel.options.decimals;
    if (d === null || d === undefined) return Core.formatValue(value, unit);
    return Number.isFinite(value) ? `${value.toFixed(d)}${unit ? (unit === "%" ? "" : " ") + unit : ""}` : "–";
  }

  const valueColor = (panel, v) => Core.thresholdColor(v, panel.options.thresholds, "var(--text)");

  // ── Time series ────────────────────────────────────────────────────────────
  function alignData(results) {
    const xs = [...new Set(results.flatMap((r) => r.points.map((p) => Math.round(p[0] / 1000))))].sort((a, b) => a - b);
    const index = new Map(xs.map((x, i) => [x, i]));
    const ys = results.map((r) => {
      const col = new Array(xs.length).fill(null);
      for (const p of r.points) col[index.get(Math.round(p[0] / 1000))] = p[1];
      return col;
    });
    return [xs, ...ys];
  }

  function buildPlotOptions(panel, width, height, from, to) {
    const o = panel.options;
    const scaleOf = (s) => `u:${seriesUnit(s)}`;
    const scaleOrder = [];
    const scaleSide = new Map();
    panel.series.forEach((s) => {
      const key = scaleOf(s);
      if (!scaleSide.has(key)) {
        scaleOrder.push(key);
        // Explicit side wins; otherwise the first unit goes left, further units right.
        scaleSide.set(key, s.axis === "right" ? 1 : s.axis === "left" ? 3 : scaleOrder.length === 1 ? 3 : 1);
      }
    });

    // Fixed x window = the selected time range, even when data is sparse.
    const scales = { x: { time: true, auto: false, min: from / 1000, max: to / 1000 } };
    for (const key of scaleOrder) {
      scales[key] = {
        auto: true,
        range: (u, dmin, dmax) => {
          const sc = Core.niceScale(dmin, dmax, { min: o.min, max: o.max });
          return [sc.min, sc.max];
        },
      };
    }

    const textColor = "#94a3b8";
    const axes = [{
      stroke: textColor, grid: { stroke: "rgba(148,163,184,.12)", width: 1 }, ticks: { stroke: "rgba(148,163,184,.25)", width: 1 },
      font: "11px system-ui, sans-serif",
    }];
    scaleOrder.forEach((key, i) => {
      const unit = key.slice(2);
      axes.push({
        scale: key,
        side: scaleSide.get(key),
        stroke: textColor,
        font: "11px system-ui, sans-serif",
        grid: i === 0 ? { stroke: "rgba(148,163,184,.12)", width: 1 } : { show: false },
        ticks: { stroke: "rgba(148,163,184,.25)", width: 1 },
        splits: (u, axisIdx, min, max) => Core.tickSplits(min, max, Math.max(3, Math.round(u.bbox.height / devicePixelRatio / 45))),
        values: (u, splits) => {
          const step = splits.length > 1 ? Math.abs(splits[1] - splits[0]) : 1;
          return Core.formatAxisTicks(splits, unit, step);
        },
        size: (u, values) => {
          const longest = (values || []).reduce((m, v) => Math.max(m, String(v).length), 3);
          return Math.max(44, longest * 7 + 16);
        },
      });
    });

    const series = [{}];
    panel.series.forEach((s, i) => {
      const color = seriesColor(s, i);
      const unit = seriesUnit(s);
      const style = o.drawStyle;
      series.push({
        label: seriesLabel(s),
        scale: scaleOf(s),
        stroke: color,
        width: 2,
        fill: style === "area" ? color + "33" : undefined,
        paths: style === "points" ? () => null
          : style === "smooth" ? uPlot.paths.spline()
          : style === "step" ? uPlot.paths.stepped({ align: 1 })
          : uPlot.paths.linear(),
        points: { ...(style === "points" ? { show: true } : {}), size: 5, fill: color, stroke: color },
        spanGaps: false,
        value: (u, v) => Core.formatValue(v, unit),
      });
    });

    return {
      width, height, scales, axes, series,
      cursor: { sync: { key: SYNC_KEY }, drag: { x: true, y: false }, points: { size: 8 } },
      legend: { live: true },
    };
  }

  function renderTimeSeries(panel, view, results, from, to) {
    const data = alignData(results);
    const sig = JSON.stringify([panel.series, panel.options]);
    const width = Math.max(120, view.body.clientWidth - 16);
    const legendH = 24 + Math.ceil(panel.series.length / 3) * 18;
    const height = Math.max(80, view.body.clientHeight - 14 - legendH);

    if (view.plot && view.sig === sig) {
      view.plot.batch(() => {
        view.plot.setData(data, false);
        view.plot.setScale("x", { min: from / 1000, max: to / 1000 });
      });
      return;
    }
    showMessage(view, "");
    view.body.innerHTML = "";
    const opts = buildPlotOptions(panel, width, height, from, to);
    view.plot = new uPlot(opts, data, view.body);
    view.sig = sig;
    view.ro = new ResizeObserver(() => {
      if (!view.plot) return;
      const h = Math.max(80, view.body.clientHeight - 14 - (view.plot.root.querySelector(".u-legend")?.offsetHeight || legendH));
      view.plot.setSize({ width: Math.max(120, view.body.clientWidth - 16), height: h });
    });
    view.ro.observe(view.body);
  }

  // ── Stat / gauge / table ───────────────────────────────────────────────────
  function renderStat(panel, view, results) {
    view.body.innerHTML = `<div class="dash-tiles">${results.map((r, i) => {
      const s = panel.series[i];
      const v = lastValue(r.points);
      return `<div class="dash-tile">
        <div class="dash-tile-label">${escHtml(seriesLabel(s))}</div>
        <div class="dash-tile-value" style="color:${v === null ? "var(--muted)" : valueColor(panel, v)}">${escHtml(fmt(panel, v, seriesUnit(s)))}</div>
        ${sparkline(r.points, seriesColor(s, i))}
      </div>`;
    }).join("")}</div>`;
  }

  function sparkline(points, color) {
    const vals = points.map((p) => p[1]).filter(Number.isFinite);
    if (vals.length < 2) return "";
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const w = 120, h = 28;
    const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(" ");
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="trend"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  function renderGauge(panel, view, results) {
    view.body.innerHTML = `<div class="dash-tiles">${results.map((r, i) => {
      const s = panel.series[i];
      const v = lastValue(r.points);
      const unit = seriesUnit(s);
      const auto = Core.niceScale(Math.min(0, v ?? 0), v ?? 1, { includeZero: true });
      const lo = Number.isFinite(panel.options.min) ? panel.options.min : auto.min;
      const hi = Number.isFinite(panel.options.max) ? panel.options.max : auto.max;
      const frac = v === null ? 0 : Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1)));
      const color = v === null ? "var(--muted)" : Core.thresholdColor(v, panel.options.thresholds, seriesColor(s, i));
      const R = 52, C = Math.PI * R;
      return `<div class="dash-tile">
        <svg width="100%" style="max-width:200px" viewBox="0 0 140 96" role="img" aria-label="${escHtml(seriesLabel(s))} gauge">
          <path d="M18 74 A52 52 0 0 1 122 74" fill="none" stroke="rgba(148,163,184,.2)" stroke-width="12" stroke-linecap="round"/>
          <path d="M18 74 A52 52 0 0 1 122 74" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(C * frac).toFixed(1)} ${C.toFixed(1)}"/>
          <text x="18" y="92" fill="#94a3b8" font-size="9" text-anchor="middle">${escHtml(Core.formatValue(lo, unit, 2))}</text>
          <text x="122" y="92" fill="#94a3b8" font-size="9" text-anchor="middle">${escHtml(Core.formatValue(hi, unit, 2))}</text>
        </svg>
        <div class="dash-tile-value" style="font-size:1.4rem;color:${color}">${escHtml(fmt(panel, v, unit))}</div>
        <div class="dash-tile-label">${escHtml(seriesLabel(s))}</div>
      </div>`;
    }).join("")}</div>`;
  }

  function renderTable(panel, view, results) {
    const rows = results.map((r, i) => {
      const s = panel.series[i];
      const unit = seriesUnit(s);
      const vals = r.points.map((p) => p[1]).filter(Number.isFinite);
      const last = lastValue(r.points);
      const mins = r.points.map((p) => p[2]).filter(Number.isFinite);
      const maxs = r.points.map((p) => p[3]).filter(Number.isFinite);
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      return `<tr>
        <td><span class="dash-swatch" style="background:${seriesColor(s, i)}"></span>${escHtml(seriesLabel(s))}</td>
        <td style="color:${last === null ? "var(--muted)" : valueColor(panel, last)}">${escHtml(fmt(panel, last, unit))}</td>
        <td>${escHtml(fmt(panel, mins.length ? Math.min(...mins) : null, unit))}</td>
        <td>${escHtml(fmt(panel, avg, unit))}</td>
        <td>${escHtml(fmt(panel, maxs.length ? Math.max(...maxs) : null, unit))}</td>
      </tr>`;
    }).join("");
    view.body.innerHTML = `<table class="dash-table"><thead><tr><th>Series</th><th>Last</th><th>Min</th><th>Avg</th><th>Max</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ── Panel editor ───────────────────────────────────────────────────────────
  function newPanelId() {
    return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  }

  function openEditor(panelId) {
    const existing = panelId ? current.config.panels.find((p) => p.id === panelId) : null;
    const draft = existing
      ? JSON.parse(JSON.stringify(existing))
      : { id: newPanelId(), type: "timeseries", title: "New panel", width: 6, height: 2, series: [], options: { drawStyle: "line", min: null, max: null, decimals: null, thresholds: [] } };

    const dlg = document.createElement("dialog");
    dlg.className = "dash-dialog";
    const tagOptions = [...registers.keys()].sort().map((n) => `<option value="${escHtml(n)}">${escHtml(shortName(n))}</option>`).join("");

    const draw = () => {
      dlg.innerHTML = `<form method="dialog">
        <h3>${existing ? "Edit panel" : "Add panel"}</h3>
        <div class="dash-row">
          <label style="flex:1">Title <input name="title" value="${escHtml(draft.title)}" maxlength="80" /></label>
          <label>Type <select name="type">${optionList(TYPES, draft.type)}</select></label>
          <label>Width <select name="width">${optionList(WIDTHS, draft.width)}</select></label>
          <label>Height <select name="height">${optionList(HEIGHTS, draft.height)}</select></label>
        </div>
        <fieldset><legend>Series</legend>
          ${draft.series.map((s, i) => `<div class="dash-row" data-series="${i}">
            <input type="color" data-f="color" value="${seriesColor(s, i)}" aria-label="Colour" />
            <select data-f="name" aria-label="Register">${tagOptions.replace(`value="${escHtml(s.name)}"`, `value="${escHtml(s.name)}" selected`) || ""}${registers.has(s.name) ? "" : `<option value="${escHtml(s.name)}" selected>${escHtml(s.name)}</option>`}</select>
            <input data-f="label" placeholder="Label" value="${escHtml(s.label || "")}" style="width:120px" />
            <input data-f="unit" placeholder="Unit (${escHtml((registers.get(s.name) || {}).unit || "auto")})" value="${escHtml(s.unit || "")}" style="width:90px" />
            <select data-f="axis" aria-label="Axis">${optionList([["auto", "Axis: auto"], ["left", "Axis: left"], ["right", "Axis: right"]], s.axis || "auto")}</select>
            <button type="button" class="dash-btn danger" data-rm="${i}">✕</button>
          </div>`).join("") || `<div class="dash-msg" style="position:static;padding:6px">No series yet.</div>`}
          <div><button type="button" class="dash-btn" id="dashAddSeries"${registers.size ? "" : " disabled"}>+ Add series</button></div>
        </fieldset>
        <fieldset><legend>Options</legend>
          <div class="dash-row">
            ${draft.type === "timeseries" ? `<label>Style <select name="drawStyle">${optionList(STYLES, draft.options.drawStyle)}</select></label>` : ""}
            <label>Min <input name="min" type="number" step="any" placeholder="auto" value="${draft.options.min ?? ""}" style="width:80px" /></label>
            <label>Max <input name="max" type="number" step="any" placeholder="auto" value="${draft.options.max ?? ""}" style="width:80px" /></label>
            <label>Decimals <input name="decimals" type="number" min="0" max="6" placeholder="auto" value="${draft.options.decimals ?? ""}" style="width:70px" /></label>
          </div>
          ${draft.type === "timeseries" ? "" : `<div>${draft.options.thresholds.map((t, i) => `<div class="dash-row" data-th="${i}">
              <label>From value <input data-t="value" type="number" step="any" value="${t.value}" style="width:90px" /></label>
              <label>Colour <input data-t="color" type="color" value="${t.color}" /></label>
              <button type="button" class="dash-btn danger" data-thrm="${i}">✕</button></div>`).join("")}
            <button type="button" class="dash-btn" id="dashAddThreshold">+ Threshold</button></div>`}
        </fieldset>
        <div class="dash-dialog-actions">
          <button type="button" class="dash-btn" id="dashCancel">Cancel</button>
          <button type="submit" class="dash-btn primary" id="dashSavePanel">Save</button>
        </div>
      </form>`;
      const form = $("form", dlg);
      form.onchange = (e) => {
        collect(); // keep edits, redraw only for structural changes
        if (e.target.name === "type") draw();
        else if (e.target.dataset && e.target.dataset.f === "name") draw();
      };
      $("#dashCancel", dlg).onclick = () => dlg.close();
      $("#dashAddSeries", dlg).onclick = () => {
        collect();
        const used = new Set(draft.series.map((s) => s.name));
        const next = [...registers.keys()].sort().find((n) => !used.has(n)) || [...registers.keys()][0];
        draft.series.push({ name: next, axis: "auto" });
        draw();
      };
      dlg.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { collect(); draft.series.splice(Number(b.dataset.rm), 1); draw(); }));
      const addTh = $("#dashAddThreshold", dlg);
      if (addTh) addTh.onclick = () => { collect(); draft.options.thresholds.push({ value: 0, color: "#22c55e" }); draw(); };
      dlg.querySelectorAll("[data-thrm]").forEach((b) => (b.onclick = () => { collect(); draft.options.thresholds.splice(Number(b.dataset.thrm), 1); draw(); }));
      form.onsubmit = (e) => {
        e.preventDefault();
        collect();
        commitPanel(draft, existing);
        dlg.close();
      };
    };

    const collect = () => {
      const f = $("form", dlg);
      if (!f) return;
      draft.title = f.elements.title.value.trim() || "Panel";
      draft.type = f.elements.type.value;
      draft.width = Number(f.elements.width.value);
      draft.height = Number(f.elements.height.value);
      if (f.elements.drawStyle) draft.options.drawStyle = f.elements.drawStyle.value;
      const numOrNull = (v) => (v === "" ? null : Number(v));
      draft.options.min = numOrNull(f.elements.min.value);
      draft.options.max = numOrNull(f.elements.max.value);
      draft.options.decimals = numOrNull(f.elements.decimals.value);
      dlg.querySelectorAll("[data-series]").forEach((row) => {
        const s = draft.series[Number(row.dataset.series)];
        const get = (k) => row.querySelector(`[data-f="${k}"]`).value;
        s.name = get("name");
        s.color = get("color");
        s.label = get("label").trim();
        s.unit = get("unit").trim();
        s.axis = get("axis");
      });
      dlg.querySelectorAll("[data-th]").forEach((row) => {
        const t = draft.options.thresholds[Number(row.dataset.th)];
        t.value = Number(row.querySelector('[data-t="value"]').value);
        t.color = row.querySelector('[data-t="color"]').value;
      });
    };

    draw();
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  function commitPanel(draft, existing) {
    // Colour inputs always report a value; only keep it when it differs from the default for that slot.
    draft.series.forEach((s, i) => {
      if (s.color && s.color.toLowerCase() === Core.PALETTE[i % Core.PALETTE.length].toLowerCase()) s.color = null;
    });
    if (existing) {
      const i = current.config.panels.findIndex((p) => p.id === existing.id);
      current.config.panels[i] = draft;
    } else {
      current.config.panels.push(draft);
    }
    saveSoon();
    renderPanels();
    refresh();
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    init() {
      root = document.getElementById("dashboardWrap");
      window.addEventListener("beforeunload", () => { clearInterval(refreshTimer); });
      return load();
    },
    setRegisters(list) {
      registers = new Map(list.map((r) => [r.name, { unit: r.unit || "", section: r.section }]));
    },
    onShow() {
      visible = true;
      if (!current) { load(); return; }
      // Panel sizes are only known once the tab is visible, so (re)build now.
      renderShell();
      armTimer();
      refresh();
    },
    onHide() {
      visible = false;
      clearInterval(refreshTimer);
      refreshTimer = null;
    },
    /** "+" button in the register tables: pin a tag to the first time-series panel. */
    async addSeries(name) {
      if (!current || !name) return;
      let panel = current.config.panels.find((p) => p.type === "timeseries");
      if (!panel) {
        panel = { id: newPanelId(), type: "timeseries", title: "Live Metrics", width: 12, height: 2, series: [], options: { drawStyle: "line", min: null, max: null, decimals: null, thresholds: [] } };
        current.config.panels.push(panel);
      }
      if (panel.series.some((s) => s.name === name)) return notify(`${shortName(name)} is already on "${current.name}".`);
      panel.series.push({ name, axis: "auto" });
      notify(`Added ${shortName(name)} to "${current.name}".`);
      await saveNow();
      if (visible) { renderPanels(); refresh(); }
    },
  };
})();

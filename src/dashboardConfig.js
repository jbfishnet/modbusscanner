"use strict";

// Whitelist-sanitizes a dashboard document coming from the UI before it is
// stored, so the stored JSON always has a known shape and bounded size.

const PANEL_TYPES = ["timeseries", "stat", "gauge", "table"];
const DRAW_STYLES = ["line", "smooth", "step", "area", "points"];
const RANGES_SEC = [300, 900, 3600, 21600, 86400, 604800, 2592000];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_PANELS = 40;
const MAX_SERIES = 16;
const MAX_THRESHOLDS = 8;

const str = (v, max, fallback = "") => (typeof v === "string" ? v.slice(0, max) : fallback);
const num = (v) => (v === null || v === "" || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

function sanitizeSeries(s) {
  if (!s || typeof s.name !== "string" || !s.name) return null;
  return {
    name: s.name.slice(0, 200),
    ip: s.ip ? str(s.ip, 64) : null,
    label: str(s.label, 80),
    color: COLOR_RE.test(s.color) ? s.color : null,
    unit: str(s.unit, 16),
    axis: oneOf(s.axis, ["auto", "left", "right"], "auto"),
  };
}

function sanitizePanel(p, index) {
  if (!p || typeof p !== "object") return null;
  const o = p.options || {};
  return {
    id: str(p.id, 40) || `p${index + 1}`,
    type: oneOf(p.type, PANEL_TYPES, "timeseries"),
    title: str(p.title, 80, "Panel"),
    width: oneOf(Number(p.width), [4, 6, 8, 12], 6),
    height: oneOf(Number(p.height), [1, 2, 3], 2),
    series: (Array.isArray(p.series) ? p.series : []).map(sanitizeSeries).filter(Boolean).slice(0, MAX_SERIES),
    options: {
      drawStyle: oneOf(o.drawStyle, DRAW_STYLES, "line"),
      min: num(o.min),
      max: num(o.max),
      decimals: num(o.decimals) === null ? null : Math.min(6, Math.max(0, Math.round(num(o.decimals)))),
      thresholds: (Array.isArray(o.thresholds) ? o.thresholds : [])
        .filter((t) => t && num(t.value) !== null && COLOR_RE.test(t.color))
        .map((t) => ({ value: num(t.value), color: t.color }))
        .sort((a, b) => a.value - b.value)
        .slice(0, MAX_THRESHOLDS),
    },
  };
}

function sanitizeDashboard(input) {
  if (!input || typeof input !== "object") throw new Error("Dashboard must be an object");
  const name = str(input.name, 80).trim();
  if (!name) throw new Error("Dashboard name is required");
  const cfg = input.config || {};
  const panels = (Array.isArray(cfg.panels) ? cfg.panels : [])
    .slice(0, MAX_PANELS)
    .map(sanitizePanel)
    .filter(Boolean);
  const ids = new Set();
  panels.forEach((p, i) => {
    if (ids.has(p.id)) p.id = `${p.id}-${i}`;
    ids.add(p.id);
  });
  return {
    name,
    config: {
      panels,
      timeRangeSec: oneOf(Number(cfg.timeRangeSec), RANGES_SEC, 3600),
      refreshSec: oneOf(Number(cfg.refreshSec), [0, 5, 10, 30, 60], 10),
    },
  };
}

module.exports = { sanitizeDashboard, PANEL_TYPES, DRAW_STYLES, RANGES_SEC };

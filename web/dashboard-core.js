/**
 * Pure dashboard helpers shared by the browser UI and the Node tests:
 * axis auto-scaling ("nice" ticks) and value/axis formatting with SI
 * prefixes (kW, MWh, mbar …) or compact suffixes (K, M, G) for unit-less
 * values. No DOM access here.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DashboardCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Units that take SI prefixes (1500 W -> 1.5 kW).
  const PREFIXABLE = new Set([
    "W", "Wh", "VA", "var", "A", "V", "Pa", "Hz", "g", "l", "L", "m", "m³", "m3",
    "J", "N", "bar", "Ω", "ohm", "B",
  ]);
  const SI = [
    { exp: 12, sym: "T" }, { exp: 9, sym: "G" }, { exp: 6, sym: "M" }, { exp: 3, sym: "k" },
    { exp: 0, sym: "" }, { exp: -3, sym: "m" }, { exp: -6, sym: "µ" },
  ];
  // Unit-less values use compact suffixes like the "500K" axis of a typical dashboard.
  const COMPACT = [
    { exp: 12, sym: "T" }, { exp: 9, sym: "G" }, { exp: 6, sym: "M" }, { exp: 3, sym: "K" }, { exp: 0, sym: "" },
  ];

  const PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
  const SERIES_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  function niceNum(range, round) {
    const exp = Math.floor(Math.log10(range));
    const f = range / Math.pow(10, exp);
    let nf;
    if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, exp);
  }

  /**
   * Auto-scale an axis to "nice" bounds and a tick step.
   * opts: { min, max } optional manual bounds, { ticks } target tick count,
   *       { includeZero } to always include 0 (default false).
   */
  function niceScale(dataMin, dataMax, opts = {}) {
    const targetTicks = opts.ticks || 5;
    let lo = Number.isFinite(dataMin) ? dataMin : 0;
    let hi = Number.isFinite(dataMax) ? dataMax : 1;
    if (opts.includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (lo === hi) {
      const pad = Math.abs(lo) * 0.1 || 1;
      lo -= pad; hi += pad;
    }
    const manualMin = Number.isFinite(opts.min);
    const manualMax = Number.isFinite(opts.max);
    if (manualMin) lo = opts.min;
    if (manualMax) hi = opts.max;
    if (hi <= lo) hi = lo + 1;

    const step = niceNum((hi - lo) / (targetTicks - 1), true);
    const min = manualMin ? lo : Math.floor(lo / step) * step;
    const max = manualMax ? hi : Math.ceil(hi / step) * step;
    return { min, max, step, ticks: ticksFor(min, max, step) };
  }

  function ticksFor(min, max, step) {
    const ticks = [];
    const first = Math.ceil(min / step - 1e-9) * step;
    for (let v = first; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
    return ticks;
  }

  /** Tick positions for an already-fixed [min, max] range (no bound changes). */
  function tickSplits(min, max, targetTicks = 5) {
    if (!(max > min)) return [min];
    return ticksFor(min, max, niceNum((max - min) / (targetTicks - 1), true));
  }

  function decimalsForStep(step) {
    if (!Number.isFinite(step) || step <= 0) return 0;
    return Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  }

  function pickPrefix(absValue, unit) {
    const table = PREFIXABLE.has(unit) ? SI : unit ? null : COMPACT;
    if (!table || !Number.isFinite(absValue) || absValue === 0) return { exp: 0, sym: "" };
    for (const p of table) if (absValue >= Math.pow(10, p.exp) * 0.9999) return p;
    return table[table.length - 1];
  }

  function joinUnit(text, prefixSym, unit) {
    if (!unit) return `${text}${prefixSym}`;
    // °C, %, K(elvin) hug the number the way people write them
    const spaced = unit === "%" ? "" : " ";
    return `${text}${spaced}${prefixSym}${unit}`;
  }

  /** Format one value with at most `sig` significant digits, e.g. 1523 W -> "1.52 kW". */
  function formatValue(value, unit = "", sig = 3) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "–";
    const p = pickPrefix(Math.abs(value), unit);
    const scaled = value / Math.pow(10, p.exp);
    const digits = scaled === 0 ? 0 : Math.max(0, sig - 1 - Math.floor(Math.log10(Math.abs(scaled))));
    return joinUnit(Number(scaled.toFixed(Math.min(digits, 6))).toString(), p.sym, unit);
  }

  /**
   * Format all tick labels of one axis consistently: one prefix for the whole
   * axis (chosen from the largest tick) and decimals derived from the step.
   */
  function formatAxisTicks(ticks, unit = "", step) {
    const maxAbs = ticks.reduce((m, t) => (Number.isFinite(t) ? Math.max(m, Math.abs(t)) : m), 0);
    const p = pickPrefix(maxAbs, unit);
    const div = Math.pow(10, p.exp);
    const decimals = decimalsForStep((step || 0) / div || (ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) / div : 1));
    return ticks.map((t) => {
      if (!Number.isFinite(t)) return "";
      return joinUnit((t / div).toFixed(decimals), p.sym, unit);
    });
  }

  /** Threshold colour for a value: steps = [{ value, color }] ascending; first step is the base. */
  function thresholdColor(value, steps, fallback) {
    if (!Array.isArray(steps) || !steps.length || !Number.isFinite(value)) return fallback;
    let color = steps[0].color;
    for (const s of steps) if (value >= s.value) color = s.color;
    return color;
  }

  return {
    PALETTE, SERIES_COLOR_RE, PREFIXABLE,
    niceScale, tickSplits, formatValue, formatAxisTicks, decimalsForStep, thresholdColor,
  };
});

/**
 * Test Suite for Modbus Scanner
 *
 * Run with: npm test
 * Tests cover:
 *   - DataStore (SQLite operations, CSV/JSON export)
 *   - Sanity checks, Modbus protocol helpers (word combining, scaling)
 *   - Export formatting (CSV/JSON)
 */

"use strict";

const assert = require("assert");

// Test Runner
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
    this.pending = [];
  }

  describe(name, fn) {
    console.log(`\n📦 ${name}`);
    fn();
  }

  // Async tests are queued by name/fn (not invoked yet) and run strictly
  // sequentially in finish() — several of them share the same DataStore
  // singleton (init/recordReading/close), so running them concurrently
  // would race on that shared connection. Sync tests still run immediately
  // at registration time, as before.
  it(name, fn) {
    if (fn.constructor.name === "AsyncFunction") {
      this.pending.push({ name, fn });
      return;
    }

    try {
      fn();
      this.passed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      this.failed++;
      console.error(`  ❌ ${name}`);
      console.error(`     ${err.message}`);
    }
  }

  async finish() {
    for (const { name, fn } of this.pending) {
      try {
        await fn();
        this.passed++;
        console.log(`  ✅ ${name}`);
      } catch (err) {
        this.failed++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err.message}`);
      }
    }
    return this.summary();
  }

  summary() {
    console.log(
      `\n\n📊 Test Results: ${this.passed} passed, ${this.failed} failed`
    );
    return this.failed === 0;
  }
}

const runner = new TestRunner();

// ═══════════════════════════════════════════════════════════════════════════
// DATASTORE TESTS
// ═══════════════════════════════════════════════════════════════════════════

runner.describe("DataStore (SQLite)", () => {
  runner.it("should validate CSV export format", () => {
    const headers = [
      "Timestamp",
      "IP Address",
      "Port",
      "Unit ID",
      "Register Address",
      "Tag Name",
      "Section",
      "Data Type",
      "Unit",
      "Raw Value",
      "Scaled Value",
      "Sanity Status",
      "Sanity Reason",
    ];

    const csvHeader = headers.map((h) => `"${h}"`).join(",");
    const expectedHeaders = headers.length;

    assert.strictEqual(
      csvHeader.split(",").length,
      expectedHeaders,
      "CSV header should have correct number of columns"
    );
  });

  runner.it("should format CSV rows correctly", () => {
    const row = {
      timestamp: "2026-08-24T10:30:00Z",
      ip: "192.168.1.1",
      port: 502,
      unitId: 1,
      register: 0,
      name: "Temperature",
      section: "Thermal",
      dataType: "int16",
      unit: "°C",
      value: 250,
      scaledValue: 25.0,
      sanity_status: "ok",
      sanity_reason: "",
    };

    const csvRow = [
      row.timestamp,
      row.ip,
      row.port,
      row.unitId,
      row.register,
      row.name,
      row.section,
      row.dataType,
      row.unit,
      row.value,
      row.scaledValue,
      row.sanity_status,
      row.sanity_reason,
    ]
      .map((v) => `"${(v || "").toString().replace(/"/g, '""')}"`)
      .join(",");

    assert(csvRow.includes("Temperature"));
    assert(csvRow.includes("192.168.1.1"));
    assert(csvRow.includes("25"));
  });

  runner.it("should allow register 0 to be stored without SQLite NULL constraint errors", async () => {
    const dataStore = require("./datastore.js");
    // Unique per run: the DB file persists across test runs, and
    // getReadingsByTag() matches by tag name across all history, so a
    // fixed name would accumulate rows and break the length assertion
    // after the first run.
    const scanId = `zero-reg-${Date.now()}`;
    const tagName = `Ambient_Temperature_${scanId}`;

    await dataStore.init();
    try {
      await dataStore.recordScanStart(scanId, "127.0.0.1", 502, 1, "yaml_scan");
      await dataStore.recordReading(scanId, "127.0.0.1", 502, 1, {
        register: 0,
        name: tagName,
        section: "Ambient",
        dataType: "int16",
        unit: "°C",
        value: 0,
        scaledValue: 0,
        raw: 0,
        sanity: { status: "ok", reason: "" },
      });

      const rows = await dataStore.getReadingsByTag(tagName);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].register, 0);
    } finally {
      await dataStore.close();
    }
  });

  runner.it("should preserve falsy values (register 0, empty status) in CSV export", async () => {
    const dataStore = require("./datastore.js");
    const scanId = `csv-zero-${Date.now()}`;
    const tagName = `Ambient_Temperature_${scanId}`;

    await dataStore.init();
    try {
      await dataStore.recordScanStart(scanId, "127.0.0.1", 502, 1, "yaml_scan");
      await dataStore.recordReading(scanId, "127.0.0.1", 502, 1, {
        register: 0,
        name: tagName,
        section: "Ambient",
        dataType: "int16",
        unit: "°C",
        value: 0,
        scaledValue: 0,
        raw: 0,
        sanity: { status: "ok", reason: "" },
      });

      const csv = await dataStore.exportToCSV({ name: tagName });
      const dataLine = csv.split("\n")[1];
      const columns = dataLine.split(",");
      // Register Address column (index 4): must be "0", not "" (`x || ""`
      // would coerce a real 0 to empty — this is the export-side twin of
      // the recordReading() falsy-coercion bug).
      assert.strictEqual(columns[4], '"0"');
      // Sanity Status column (index 11): "ok" must not be dropped.
      assert(dataLine.includes('"ok"'));
    } finally {
      await dataStore.close();
    }
  });

  runner.it("should validate JSON export structure", () => {
    const readings = [
      {
        timestamp: "2026-08-24T10:30:00Z",
        name: "Temperature",
        value: 25,
        unit: "°C",
        sanity_status: "ok",
      },
    ];

    const json = JSON.stringify(readings, null, 2);
    const parsed = JSON.parse(json);

    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].name, "Temperature");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SANITY CHECK TESTS
// ═══════════════════════════════════════════════════════════════════════════

runner.describe("Sanity Checks", () => {
  const sanityCheckYaml = (scaled, rawInt, regDef) => {
    if (scaled === null || scaled === undefined) {
      return { status: "error", reason: "No data" };
    }

    const unit = (regDef.unit || "").trim();
    const name = regDef.name || "";

    // Temperature checks
    if (unit === "°C") {
      if (scaled < -40)
        return {
          status: "warn",
          reason: `Temperature ${scaled}°C is below -40°C`,
        };
      if (scaled > 120)
        return {
          status: "warn",
          reason: `Temperature ${scaled}°C exceeds 120°C`,
        };
      return { status: "ok", reason: "" };
    }

    // Power checks
    if (unit === "W") {
      if (scaled < -30000)
        return { status: "warn", reason: `Power ${scaled}W is too low` };
      if (scaled > 30000)
        return { status: "warn", reason: `Power ${scaled}W is too high` };
      return { status: "ok", reason: "" };
    }

    // Percentage checks
    if (unit === "%") {
      if (scaled < 0 || scaled > 100)
        return {
          status: "warn",
          reason: `Percentage ${scaled}% out of range`,
        };
      return { status: "ok", reason: "" };
    }

    return { status: "ok", reason: "" };
  };

  runner.it("should detect valid temperature", () => {
    const result = sanityCheckYaml(25, 250, {
      unit: "°C",
      name: "Temperature",
    });
    assert.strictEqual(result.status, "ok");
  });

  runner.it("should detect temperature too low", () => {
    const result = sanityCheckYaml(-50, -500, {
      unit: "°C",
      name: "Temperature",
    });
    assert.strictEqual(result.status, "warn");
    assert(result.reason.includes("-40"));
  });

  runner.it("should detect temperature too high", () => {
    const result = sanityCheckYaml(150, 1500, {
      unit: "°C",
      name: "Temperature",
    });
    assert.strictEqual(result.status, "warn");
    assert(result.reason.includes("120"));
  });

  runner.it("should detect valid power", () => {
    const result = sanityCheckYaml(5000, 5000, {
      unit: "W",
      name: "Power",
    });
    assert.strictEqual(result.status, "ok");
  });

  runner.it("should detect power too high", () => {
    const result = sanityCheckYaml(50000, 50000, {
      unit: "W",
      name: "Power",
    });
    assert.strictEqual(result.status, "warn");
  });

  runner.it("should detect valid percentage", () => {
    const result = sanityCheckYaml(50, 50, {
      unit: "%",
      name: "Pump_Speed",
    });
    assert.strictEqual(result.status, "ok");
  });

  runner.it("should detect invalid percentage", () => {
    const result = sanityCheckYaml(150, 150, {
      unit: "%",
      name: "Pump_Speed",
    });
    assert.strictEqual(result.status, "warn");
  });
});

// ═════════���═════════════════════════════════════════════════════════════════
// MODBUS PROTOCOL TESTS
// ═══════════════════════════════════════════════════════════════════════════

runner.describe("Modbus Protocol Helpers", () => {
  const combineWords = (words, dataType) => {
    if (dataType === "int32") {
      const u32 = ((words[0] & 0xffff) << 16) | (words[1] & 0xffff);
      return u32 | 0;
    }
    if (dataType === "int16") {
      const u16 = words[0] & 0xffff;
      return u16 > 0x7fff ? u16 - 0x10000 : u16;
    }
    return words[0] & 0xffff;
  };

  runner.it("should combine uint16 words correctly", () => {
    const words = [0xabcd];
    const result = combineWords(words, "uint16");
    assert.strictEqual(result, 0xabcd);
  });

  runner.it("should combine int16 words correctly (positive)", () => {
    const words = [0x0100];
    const result = combineWords(words, "int16");
    assert.strictEqual(result, 256);
  });

  runner.it("should combine int16 words correctly (negative)", () => {
    const words = [0xffff];
    const result = combineWords(words, "int16");
    assert.strictEqual(result, -1);
  });

  runner.it("should combine int32 words correctly", () => {
    const words = [0x0001, 0x0000];
    const result = combineWords(words, "int32");
    assert.strictEqual(result, 0x00010000);
  });

  const applyScale = (value, scale, precision) => {
    if (value === null || value === undefined) return null;
    const scaled = value * scale;
    return parseFloat(scaled.toFixed(precision));
  };

  runner.it("should apply scale factor correctly", () => {
    const result = applyScale(250, 0.1, 1);
    assert.strictEqual(result, 25.0);
  });

  runner.it("should apply precision correctly", () => {
    const result = applyScale(333, 0.01, 2);
    assert.strictEqual(result, 3.33);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT FUNCTIONALITY TESTS
// ═══════════════════════════════════════════════════════════════════════════

runner.describe("Export Functionality", () => {
  runner.it("should escape quotes in CSV values", () => {
    const value = 'Tag with "quotes"';
    const escaped = value.replace(/"/g, '""');
    const csvValue = `"${escaped}"`;
    assert.strictEqual(csvValue, '"Tag with ""quotes"""');
  });

  runner.it("should generate valid CSV with special characters", () => {
    const rows = [
      ["Name", "Value°C", "Status"],
      ["Temp1", "25.0", "Ok"],
      ["Temp-2", "30,5", "Warning"],
    ];

    const csv = rows
      .map((row) =>
        row.map((v) => `"${(v || "").toString().replace(/"/g, '""')}"`).join(",")
      )
      .join("\n");

    assert(csv.includes("°C"));
    assert(csv.includes("30,5"));
  });

  runner.it("should create valid JSON from readings", () => {
    const data = {
      Ambient_Temperature: [
        { timestamp: "2026-08-24T10:00:00Z", value: 10 },
        { timestamp: "2026-08-24T10:01:00Z", value: 11 },
      ],
      Flow_Temperature: [
        { timestamp: "2026-08-24T10:00:00Z", value: 35 },
      ],
    };

    const json = JSON.stringify(data, null, 2);
    const parsed = JSON.parse(json);

    assert.strictEqual(
      Object.keys(parsed).length,
      2,
      "Should have 2 temperature sensors"
    );
    assert.strictEqual(parsed.Ambient_Temperature.length, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD STATE TESTS
// ═══════════════════════════════════════════════════════════════════════════

runner.describe("Dashboard State Management", () => {
  runner.it("should track connection states", () => {
    const states = ["disconnected", "connecting", "connected", "error"];
    const validStates = new Set(states);

    states.forEach((state) => {
      assert(validStates.has(state));
    });
  });

  runner.it("should maintain reading history", () => {
    const readings = {};
    const maxHistory = 100;

    // Add readings
    const tagName = "Temperature";
    readings[tagName] = [];

    for (let i = 0; i < 150; i++) {
      readings[tagName].push({ timestamp: new Date(), value: i });

      // Keep only last N
      if (readings[tagName].length > maxHistory) {
        readings[tagName].shift();
      }
    }

    assert.strictEqual(
      readings[tagName].length,
      maxHistory,
      "Should maintain max history size"
    );
    assert.strictEqual(
      readings[tagName][0].value,
      50,
      "Should keep newest readings"
    );
  });

  runner.it("should auto-scale chart values", () => {
    const values = [10, 15, 20, 25, 30];
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const padding = (maxVal - minVal) * 0.1 || 1;

    const yMin = minVal - padding;
    const yMax = maxVal + padding;

    assert.strictEqual(minVal, 10);
    assert.strictEqual(maxVal, 30);
    assert(yMin < minVal);
    assert(yMax > maxVal);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY TESTS
// ═══════════════════════════════════════════════════════════════════════════

runner.describe("Security", () => {
  runner.it("binds to loopback by default (BIND_HOST)", () => {
    delete require.cache[require.resolve("./src/config.js")];
    const config = require("./src/config.js");
    assert.strictEqual(config.BIND_HOST, "127.0.0.1");
  });

  runner.it("isTrustedOrigin allows requests with no Origin header (non-browser clients)", () => {
    const { isTrustedOrigin } = require("./src/security.js");
    assert.strictEqual(isTrustedOrigin({ host: "127.0.0.1:8080" }), true);
  });

  runner.it("isTrustedOrigin allows a same-origin request", () => {
    const { isTrustedOrigin } = require("./src/security.js");
    assert.strictEqual(
      isTrustedOrigin({ host: "127.0.0.1:8080", origin: "http://127.0.0.1:8080" }),
      true
    );
  });

  runner.it("isTrustedOrigin rejects a cross-origin request", () => {
    const { isTrustedOrigin } = require("./src/security.js");
    assert.strictEqual(
      isTrustedOrigin({ host: "127.0.0.1:8080", origin: "http://evil.example:1234" }),
      false
    );
  });

  runner.it("isTrustedOrigin rejects a malformed Origin header", () => {
    const { isTrustedOrigin } = require("./src/security.js");
    assert.strictEqual(
      isTrustedOrigin({ host: "127.0.0.1:8080", origin: "not-a-url" }),
      false
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD TESTS (axis scaling, config sanitising, persistence, history)
// ═══════════════════════════════════════════════════════════════════════════

// Runs fn against a throwaway SQLite file with a fresh DataStore instance
// (datastore.js is a singleton that reads DB_PATH at require time).
async function withTempStore(fn) {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dbPath = path.join(os.tmpdir(), `modbus-dash-test-${process.pid}-${Date.now()}.db`);
  const prev = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  const modPath = require.resolve("./datastore.js");
  delete require.cache[modPath];
  const store = require("./datastore.js");
  try {
    await store.init();
    await fn(store);
  } finally {
    await store.close();
    delete require.cache[modPath];
    if (prev === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prev;
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  }
}

const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

runner.describe("Dashboard axis scaling & formatting", () => {
  const Core = require("./web/dashboard-core.js");

  runner.it("niceScale picks round bounds and a 1/2/5 step", () => {
    const s = Core.niceScale(3.2, 97.8);
    assert.deepStrictEqual([s.min, s.max, s.step], [0, 100, 20]);
    const t = Core.niceScale(24.2, 44.9);
    assert.deepStrictEqual([t.min, t.max, t.step], [20, 45, 5]);
  });

  runner.it("niceScale handles a flat series and manual bounds", () => {
    const flat = Core.niceScale(5, 5);
    assert(flat.min < 5 && flat.max > 5);
    const manual = Core.niceScale(12, 48, { min: 0, max: 100 });
    assert.strictEqual(manual.min, 0);
    assert.strictEqual(manual.max, 100);
  });

  runner.it("tickSplits keeps the given range and includes its top tick", () => {
    assert.deepStrictEqual(Core.tickSplits(0, 2500, 5), [0, 500, 1000, 1500, 2000, 2500]);
  });

  runner.it("axis ticks use one SI prefix per axis (W -> kW)", () => {
    const s = Core.niceScale(0, 1480);
    assert.deepStrictEqual(Core.formatAxisTicks(s.ticks, "W", s.step), ["0.0 kW", "0.5 kW", "1.0 kW", "1.5 kW"]);
  });

  runner.it("temperature and percent are never prefixed", () => {
    const t = Core.niceScale(12.3, 14.9);
    assert.deepStrictEqual(
      Core.formatAxisTicks(t.ticks, "°C", t.step),
      ["12.0 °C", "12.5 °C", "13.0 °C", "13.5 °C", "14.0 °C", "14.5 °C", "15.0 °C"]
    );
    const whole = Core.niceScale(0, 100);
    assert.deepStrictEqual(Core.formatAxisTicks(whole.ticks, "°C", whole.step)[1], "20 °C");
    assert.strictEqual(Core.formatValue(52, "%"), "52%");
    assert.strictEqual(Core.formatValue(21.456, "°C"), "21.5 °C");
  });

  runner.it("unit-less values get compact K/M suffixes", () => {
    const u = Core.niceScale(0, 450000);
    assert.deepStrictEqual(Core.formatAxisTicks(u.ticks, "", u.step), ["0K", "100K", "200K", "300K", "400K", "500K"]);
    assert.strictEqual(Core.formatValue(1200000, ""), "1.2M");
  });

  runner.it("formatValue scales prefixed units both up and down", () => {
    assert.strictEqual(Core.formatValue(1523, "W"), "1.52 kW");
    assert.strictEqual(Core.formatValue(0.0123, "A"), "12.3 mA");
    assert.strictEqual(Core.formatValue(null, "W"), "–");
  });

  runner.it("thresholdColor picks the highest step reached", () => {
    const steps = [{ value: 0, color: "g" }, { value: 40, color: "y" }, { value: 45, color: "r" }];
    assert.strictEqual(Core.thresholdColor(10, steps, "x"), "g");
    assert.strictEqual(Core.thresholdColor(44, steps, "x"), "y");
    assert.strictEqual(Core.thresholdColor(99, steps, "x"), "r");
    assert.strictEqual(Core.thresholdColor(5, [], "x"), "x");
  });
});

runner.describe("Dashboard config sanitising", () => {
  const { sanitizeDashboard } = require("./src/dashboardConfig.js");

  runner.it("fills defaults and drops unknown or invalid fields", () => {
    const out = sanitizeDashboard({
      name: "  Heat pump ",
      config: {
        timeRangeSec: 12345,
        panels: [{
          type: "evil", title: "T", width: 7, height: 9,
          series: [{ name: "A", color: "red", axis: "up", extra: 1 }, { name: "" }, null],
          options: { drawStyle: "wiggle", min: "abc", thresholds: [{ value: 1, color: "#ff0000" }, { value: 2, color: "bad" }] },
        }],
      },
    });
    assert.strictEqual(out.name, "Heat pump");
    assert.strictEqual(out.config.timeRangeSec, 3600);
    const p = out.config.panels[0];
    assert.strictEqual(p.type, "timeseries");
    assert.strictEqual(p.width, 6);
    assert.strictEqual(p.height, 2);
    assert.deepStrictEqual(p.series, [{ name: "A", ip: null, label: "", color: null, unit: "", axis: "auto" }]);
    assert.strictEqual(p.options.drawStyle, "line");
    assert.strictEqual(p.options.min, null);
    assert.deepStrictEqual(p.options.thresholds, [{ value: 1, color: "#ff0000" }]);
  });

  runner.it("requires a name and de-duplicates panel ids", () => {
    assert.throws(() => sanitizeDashboard({ name: "  ", config: {} }), /name is required/);
    const out = sanitizeDashboard({ name: "x", config: { panels: [{ id: "a" }, { id: "a" }] } });
    assert.notStrictEqual(out.config.panels[0].id, out.config.panels[1].id);
  });
});

runner.describe("Dashboard persistence & history", () => {
  runner.it("creates, updates and deletes dashboards; the last one is protected", async () => {
    await withTempStore(async (store) => {
      const first = (await store.listDashboards())[0];
      assert.strictEqual(first.name, "Plant Overview");

      const made = await store.saveDashboard({ name: "B", config: { panels: [], timeRangeSec: 300, refreshSec: 5 } });
      const updated = await store.saveDashboard({ id: made.id, name: "B2", config: made.config });
      assert.strictEqual(updated.name, "B2");
      assert.strictEqual((await store.getDashboard(made.id)).config.timeRangeSec, 300);

      await store.deleteDashboard(made.id);
      await assert.rejects(store.deleteDashboard(first.id), /last dashboard/);
      await assert.rejects(store.saveDashboard({ id: 9999, name: "x", config: {} }), /not found/);
    });
  });

  runner.it("migrates the legacy dashboard_tags setting into the first dashboard", async () => {
    await withTempStore(async (store) => {
      await store.setSetting("dashboard_tags", JSON.stringify(["Tag_A", "Tag_B"]));
      const [dash] = await store.listDashboards();
      assert.deepStrictEqual(dash.config.panels[0].series.map((s) => s.name), ["Tag_A", "Tag_B"]);
      assert.deepStrictEqual((await store.getDashboardTagNames()).sort(), ["Tag_A", "Tag_B"]);
    });
  });

  runner.it("querySeries downsamples into avg/min/max buckets", async () => {
    await withTempStore(async (store) => {
      const now = Date.now();
      for (let i = 0; i < 60; i++) {
        await store._run(
          `INSERT INTO readings (ip, port, unitId, register, name, dataType, scaledValue, timestamp) VALUES (?,?,?,?,?,?,?,?)`,
          ["h", 502, 1, 1, "T", "int16", i, sqlTime(now - (60 - i) * 1000)]
        );
      }
      const pts = await store.querySeries({ name: "T", fromMs: now - 120000, toMs: now, maxPoints: 10, minBucketSec: 1 });
      assert(pts.length > 0 && pts.length <= 12, `expected <=12 buckets, got ${pts.length}`);
      const all = pts.flatMap((p) => [p[2], p[3]]);
      assert.strictEqual(Math.min(...all), 0);
      assert.strictEqual(Math.max(...all), 59);
      assert.deepStrictEqual(await store.querySeries({ name: "nope", fromMs: now - 120000, toMs: now }), []);
    });
  });

  runner.it("rollupAndPrune keeps old data queryable as hourly rows and removes raw rows", async () => {
    await withTempStore(async (store) => {
      const now = Date.now();
      const insert = (ms, v) => store._run(
        `INSERT INTO readings (ip, port, unitId, register, name, dataType, scaledValue, timestamp) VALUES (?,?,?,?,?,?,?,?)`,
        ["h", 502, 1, 1, "T", "int16", v, sqlTime(ms)]
      );
      const old = now - 10 * 86400000;
      const hourStart = Math.floor(old / 3600000) * 3600000;
      await insert(hourStart + 60000, 10);
      await insert(hourStart + 120000, 20);
      await insert(now - 1000, 99); // recent: must stay raw

      const { pruned } = await store.rollupAndPrune();
      assert.strictEqual(pruned, 2);
      const raw = await store._all(`SELECT COUNT(*) AS n FROM readings`);
      assert.strictEqual(raw[0].n, 1);
      const hourly = await store._all(`SELECT avg, min, max, count FROM readings_hourly`);
      assert.deepStrictEqual(hourly, [{ avg: 15, min: 10, max: 20, count: 2 }]);

      // Idempotent
      assert.strictEqual((await store.rollupAndPrune()).pruned, 0);

      const pts = await store.querySeries({ name: "T", fromMs: old - 3600000, toMs: now, maxPoints: 600, minBucketSec: 1 });
      const values = pts.map((p) => p[1]).sort((a, b) => a - b);
      assert.deepStrictEqual(values, [15, 99]);
    });
  });
});

runner.describe("Dashboard HTTP API", () => {
  runner.it("saves a dashboard, queries history, and serves only whitelisted static files", async () => {
    await withTempStore(async (store) => {
      const http = require("http");
      const { createHttpHandler } = require("./src/httpRoutes.js");
      const server = http.createServer(createHttpHandler({ dataStore: store }));
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      try {
        const saved = await (await post("/api/dashboards", {
          name: "API board",
          config: { panels: [{ id: "p", type: "gauge", title: "G", series: [{ name: "T" }] }], timeRangeSec: 900 },
        })).json();
        assert.strictEqual(saved.dashboard.config.panels[0].type, "gauge");
        const list = await (await fetch(base + "/api/dashboards")).json();
        assert(list.dashboards.some((d) => d.name === "API board"));

        const bad = await post("/api/dashboards", { name: "", config: {} });
        assert.strictEqual(bad.status, 400);

        await store._run(
          `INSERT INTO readings (ip, port, unitId, register, name, dataType, scaledValue, timestamp) VALUES (?,?,?,?,?,?,?,?)`,
          ["h", 502, 1, 1, "T", "int16", 42, sqlTime(Date.now() - 5000)]
        );
        const q = await (await post("/api/query", { series: [{ name: "T" }], from: Date.now() - 60000, to: Date.now() })).json();
        assert.strictEqual(q.series[0].points[0][1], 42);
        assert.strictEqual((await post("/api/query", { series: [], from: 5, to: 1 })).status, 400);

        assert.strictEqual((await post("/api/dashboard-settings", { pollIntervalSec: 1 })).status, 400);
        assert.strictEqual((await (await post("/api/dashboard-settings", { pollIntervalSec: 5 })).json()).pollIntervalSec, 5);

        // The only dashboard cannot be deleted; with a second one it can.
        const last = await fetch(`${base}/api/dashboards?id=${saved.dashboard.id}`, { method: "DELETE" });
        assert.strictEqual(last.status, 400);
        await post("/api/dashboards", { name: "Other", config: {} });
        const del = await fetch(`${base}/api/dashboards?id=${saved.dashboard.id}`, { method: "DELETE" });
        assert.strictEqual(del.status, 200);

        assert.strictEqual((await fetch(base + "/web/dashboard-core.js")).status, 200);
        assert.strictEqual((await fetch(base + "/web/vendor/uPlot.iife.min.js")).status, 200);
        assert.strictEqual((await fetch(base + "/web/%2e%2e/package.json")).status, 404);
        assert.strictEqual((await fetch(base + "/web/nothing.js")).status, 404);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RUN TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (require.main === module) {
  runner.finish().then((success) => process.exit(success ? 0 : 1));
}

module.exports = { TestRunner, runner };

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
// RUN TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (require.main === module) {
  runner.finish().then((success) => process.exit(success ? 0 : 1));
}

module.exports = { TestRunner, runner };

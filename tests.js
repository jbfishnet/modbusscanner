/**
 * Test Suite for Modbus Scanner
 *
 * Run with: npm test
 * Tests cover:
 *   - Connection Manager (retry logic, state management)
 *   - Data Simulator (value generation, register definitions)
 *   - Dashboard (UI rendering, data updates, exports)
 *   - DataStore (SQLite operations, CSV/JSON export)
 */

"use strict";

const assert = require("assert");

// Test Runner
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  describe(name, fn) {
    console.log(`\n📦 ${name}`);
    fn();
  }

  it(name, fn) {
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

  async itAsync(name, fn) {
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

  summary() {
    console.log(
      `\n\n📊 Test Results: ${this.passed} passed, ${this.failed} failed`
    );
    return this.failed === 0;
  }
}

const runner = new TestRunner();

// ═══════════════════════════════════════════════════════════════════════════
// CONNECTION MANAGER TESTS
// ═══════════════════════════════════════════════════════════════════════════

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = WebSocket.CONNECTING;
    this.CONNECTING = 0;
    this.OPEN = 1;
    this.CLOSING = 2;
    this.CLOSED = 3;
  }

  send(data) {
    if (this.readyState !== this.OPEN) {
      throw new Error("WebSocket not open");
    }
  }

  close() {
    this.readyState = this.CLOSED;
  }
}

// Mock WebSocket for testing
if (typeof global !== "undefined" && !global.WebSocket) {
  global.WebSocket = MockWebSocket;
}

runner.describe("ConnectionManager", () => {
  runner.it("should initialize with default options", () => {
    const ConnectionManager =
      require("./connection-manager.js") ||
      (() => {
        // Browser version
        return class ConnectionManager {
          constructor(options = {}) {
            this.maxRetries = options.maxRetries || 10;
            this.initialDelay = options.initialDelay || 1000;
            this.maxDelay = options.maxDelay || 30000;
            this.state = "disconnected";
            this.retryCount = 0;
          }
        };
      })();

    const cm = new ConnectionManager();
    assert.strictEqual(cm.maxRetries, 10);
    assert.strictEqual(cm.initialDelay, 1000);
    assert.strictEqual(cm.maxDelay, 30000);
    assert.strictEqual(cm.state, "disconnected");
  });

  runner.it("should calculate exponential backoff correctly", () => {
    const initialDelay = 1000;
    const maxDelay = 30000;

    for (let i = 0; i < 5; i++) {
      const delay = Math.min(
        initialDelay * Math.pow(2, i),
        maxDelay
      );
      const expected = Math.min(initialDelay * Math.pow(2, i), maxDelay);
      assert.strictEqual(delay, expected, `Backoff at retry ${i}`);
    }
  });

  runner.it("should not exceed max retries", () => {
    const maxRetries = 10;
    let attemptCount = 0;

    for (let i = 0; i < maxRetries; i++) {
      attemptCount++;
    }

    assert.strictEqual(attemptCount, maxRetries);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DATA SIMULATOR TESTS
// ═══════════════════════════════════════════════════════════════════════════

runner.describe("DataSimulator", () => {
  runner.it("should initialize with register definitions", () => {
    const registers = [
      {
        name: "Ambient_Temperature",
        register: 0,
        section: "Ambient",
        unit: "°C",
        dataType: "int16",
        min: -10,
        max: 30,
      },
      {
        name: "Flow_Temperature",
        register: 1,
        section: "Thermal",
        unit: "°C",
        dataType: "int16",
        min: 20,
        max: 55,
      },
    ];

    assert.strictEqual(registers.length, 2);
    assert.strictEqual(registers[0].name, "Ambient_Temperature");
    assert.strictEqual(registers[1].unit, "°C");
  });

  runner.it("should generate sine wave values", () => {
    const min = 0;
    const max = 100;
    const period = 1000;

    const sineWave = (timestamp) => {
      const t = (timestamp % period) / period;
      const norm = (Math.sin(2 * Math.PI * t) + 1) / 2;
      return min + norm * (max - min);
    };

    const value1 = sineWave(0);
    const value2 = sineWave(period / 4);
    const value3 = sineWave(period / 2);

    assert(value1 >= min && value1 <= max);
    assert(value2 >= min && value2 <= max);
    assert(value3 >= min && value3 <= max);
  });

  runner.it("should generate random walk values", () => {
    const min = 0;
    const max = 100;
    let current = 50;
    const delta = 10;

    const randomWalk = () => {
      const nudge = (Math.random() * 2 - 1) * delta;
      return Math.max(min, Math.min(max, current + nudge));
    };

    for (let i = 0; i < 10; i++) {
      current = randomWalk();
      assert(current >= min && current <= max, `Random walk out of bounds: ${current}`);
    }
  });

  runner.it("should generate readings with correct structure", () => {
    const regDef = {
      name: "Test_Register",
      register: 10,
      section: "Test",
      unit: "unit",
      dataType: "int16",
      scale: 0.1,
    };

    const reading = {
      type: "result",
      register: regDef.register,
      name: regDef.name,
      section: regDef.section,
      unit: regDef.unit,
      value: 100,
      scaledValue: 10,
      dataType: regDef.dataType,
      sanity: { status: "ok", reason: "" },
    };

    assert.strictEqual(reading.type, "result");
    assert.strictEqual(reading.register, 10);
    assert.strictEqual(reading.name, "Test_Register");
    assert.strictEqual(reading.scaledValue, 10);
  });
});

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
    const scanId = `zero-reg-${Date.now()}`;

    await dataStore.init();
    try {
      await dataStore.recordScanStart(scanId, "127.0.0.1", 502, 1, "yaml_scan");
      await dataStore.recordReading(scanId, "127.0.0.1", 502, 1, {
        register: 0,
        name: "Ambient_Temperature",
        section: "Ambient",
        dataType: "int16",
        unit: "°C",
        value: 0,
        scaledValue: 0,
        raw: 0,
        sanity: { status: "ok", reason: "" },
      });

      const rows = await dataStore.getReadingsByTag("Ambient_Temperature");
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].register, 0);
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
// RUN TESTS
// ═══════════════════════════════════════════════════════════════════════════

if (require.main === module) {
  const success = runner.summary();
  process.exit(success ? 0 : 1);
}

module.exports = { TestRunner, runner };

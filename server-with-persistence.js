/**
 * Modbus TCP Scanner – Enhanced with SQLite persistence
 *
 * This file demonstrates how to integrate the DataStore module into the scanner.
 * It records all scan results to SQLite for long-term analysis and Excel export.
 *
 * Features:
 *   - Automatic persistence of all Modbus readings
 *   - Scan metadata tracking (start time, duration, device info)
 *   - HTTP endpoint for CSV/JSON export
 *   - Statistics API
 */

"use strict";

const http = require("http");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { WebSocketServer } = require("ws");
const ModbusRTU = require("modbus-serial");
const yaml = require("js-yaml");
const dataStore = require("./datastore");

const HTTP_PORT = process.env.PORT || 8080;

// Load YAML configuration
let yamlRegisters = [];

function loadYamlConfig() {
  const yamlPath = path.join(__dirname, "modbus.yaml");
  if (!fs.existsSync(yamlPath)) {
    console.warn("modbus.yaml not found – YAML scan mode unavailable");
    return;
  }
  try {
    const raw = fs.readFileSync(yamlPath, "utf8");
    const docs = yaml.load(raw);
    const device = Array.isArray(docs) ? docs[0] : docs;
    const sensors = device?.sensors || [];

    yamlRegisters = sensors.map((s) => ({
      name: s.name,
      address: Number(s.address),
      input_type: s.input_type || "holding",
      data_type: s.data_type || "uint16",
      scale: s.scale != null ? Number(s.scale) : 1,
      precision: s.precision != null ? Number(s.precision) : 0,
      unit: s.unit_of_measurement || "",
      section: deriveSection(s.name),
    }));

    console.log(`Loaded ${yamlRegisters.length} register definitions`);
  } catch (err) {
    console.error("Failed to parse modbus.yaml:", err.message);
  }
}

function deriveSection(name) {
  if (/(Ambient|ambient)_/i.test(name)) return "Ambient";
  if (/(EMgr|emgr)_/i.test(name)) return "E-Manager";
  if (/_Hp(\d+)_/i.test(name)) return "Heat Pump " + name.match(/_Hp(\d+)_/i)[1];
  if (/_Boil(\d+)_/i.test(name)) return "Boiler " + name.match(/_Boil(\d+)_/i)[1];
  if (/_Buff(\d+)_/i.test(name)) return "Buffer " + name.match(/_Buff(\d+)_/i)[1];
  if (/_Sol(\d+)_/i.test(name)) return "Solar " + name.match(/_Sol(\d+)_/i)[1];
  if (/_Hc(\d+)_/i.test(name)) return "Heating Circuit " + name.match(/_Hc(\d+)_/i)[1];
  return "Other";
}

loadYamlConfig();

// Initialize DataStore on startup
async function initDataStore() {
  try {
    await dataStore.init();
    const stats = await dataStore.getStats();
    console.log(`[DataStore] Database ready. Stats:`, stats);
  } catch (err) {
    console.error("[DataStore] Initialization failed:", err.message);
    process.exit(1);
  }
}

// HTTP server with data export endpoints
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Serve main UI
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const filePath = path.join(__dirname, "index.html");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("index.html not found");
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data);
      }
    });
  }
  // Export CSV endpoint
  else if (url.pathname === "/api/export/csv") {
    handleExportCSV(url, res);
  }
  // Export JSON endpoint
  else if (url.pathname === "/api/export/json") {
    handleExportJSON(url, res);
  }
  // Statistics endpoint
  else if (url.pathname === "/api/stats") {
    handleStats(res);
  }
  // List unique tags endpoint
  else if (url.pathname === "/api/tags") {
    handleTags(res);
  }
  // Get latest readings endpoint
  else if (url.pathname === "/api/readings/latest") {
    handleLatestReadings(res);
  } else if (url.pathname === "/api/bootstrap" && req.method === "GET") {
    handleBootstrap(res);
  } else if (url.pathname === "/api/scan-targets" && req.method === "GET") {
    handleGetScanTargets(res);
  } else if (url.pathname === "/api/scan-targets" && req.method === "POST") {
    handleSaveScanTargets(req, res);
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

async function handleExportCSV(url, res) {
  try {
    const tagName = url.searchParams.get("tag");
    const all = url.searchParams.get("all") === "true";
    const query = all ? { all: true } : tagName ? { name: tagName } : null;

    const csv = await dataStore.exportToCSV(query);
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="modbus_readings.csv"',
    });
    res.end(csv);
  } catch (err) {
    res.writeHead(500);
    res.end(`Error: ${err.message}`);
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function normalizeTarget(target) {
  const ip = typeof target?.ip === "string" ? target.ip.trim() : "";
  const port = Number(target?.port);
  const unitId = Number(target?.unitId);

  if (!net.isIP(ip)) throw new Error(`Invalid IP address: ${ip || "missing"}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port for ${ip}`);
  }
  if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) {
    throw new Error(`Invalid unit ID for ${ip}`);
  }

  return { ip, port, unitId };
}

function testTargetAccess(target) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: target.ip, port: target.port });
    const finish = (status, error = null) => {
      socket.destroy();
      resolve({ ...target, lastStatus: status, lastError: error });
    };

    socket.setTimeout(3000);
    socket.once("connect", () => finish("reachable"));
    socket.once("timeout", () => finish("unreachable", "Connection timed out"));
    socket.once("error", (err) => finish("unreachable", err.message));
  });
}

async function handleGetScanTargets(res) {
  try {
    sendJson(res, 200, { targets: await dataStore.getScanTargets() });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleBootstrap(res) {
  try {
    const targets = await dataStore.getScanTargets();
    sendJson(res, 200, {
      targets,
      yamlRegisters: yamlRegisters.length,
      bootedAt: new Date().toISOString(),
    });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let rejected = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (rejected) return;
      if (body.length + chunk.length > 1024 * 1024) {
        rejected = true;
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

async function handleSaveScanTargets(req, res) {
  try {
    const payload = await readJsonBody(req);
    if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
      throw new Error("At least one scan target is required");
    }
    if (payload.targets.length > 64) throw new Error("A maximum of 64 scan targets is supported");

    const targets = payload.targets.map(normalizeTarget);
    const uniqueIps = new Set(targets.map((target) => target.ip));
    if (uniqueIps.size !== targets.length) throw new Error("Scan targets must be unique");

    const checkedTargets = [];
    for (const target of targets) checkedTargets.push(await testTargetAccess(target));
    const savedTargets = await dataStore.saveScanTargets(checkedTargets);
    sendJson(res, 200, { targets: savedTargets });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleExportJSON(url, res) {
  try {
    const tagName = url.searchParams.get("tag");
    const all = url.searchParams.get("all") === "true";
    const query = all ? { all: true } : tagName ? { name: tagName } : null;

    const data = await dataStore.exportToJSON(query);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleStats(res) {
  try {
    const stats = await dataStore.getStats();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats, null, 2));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleTags(res) {
  try {
    const tags = await dataStore.getUniqueTags();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(tags, null, 2));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleLatestReadings(res) {
  try {
    const readings = await dataStore.getLatestReadings();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readings, null, 2));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// WebSocket server
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const activeSessions = new Map();

  // Send YAML config on connect
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "config", registers: yamlRegisters }));
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "scan") {
      handleScan(ws, msg, activeSessions);
    } else if (msg.type === "scan_yaml") {
      handleScanYaml(ws, msg, activeSessions);
    } else if (msg.type === "scan_discover") {
      handleDiscover(ws, msg, activeSessions);
    } else if (msg.type === "get_config") {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "config", registers: yamlRegisters }));
      }
    } else if (msg.type === "cancel") {
      const sess = activeSessions.get(msg.id);
      if (sess) sess.cancelled = true;
    }
  });

  ws.on("close", () => {
    for (const sess of activeSessions.values()) {
      sess.cancelled = true;
    }
  });
});

// Scan handlers (simplified for brevity)
async function handleScan(ws, msg, activeSessions) {
  const { id, ip, port, unitId, regType, startReg, count, batchSize } = msg;
  const session = { cancelled: false, startTime: Date.now() };
  activeSessions.set(id, session);

  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ ...obj, id }));
  };

  // Record scan start
  await dataStore.recordScanStart(id, ip, port, unitId, "raw_range_scan");

  const client = new ModbusRTU();
  client.setTimeout(3000);

  try {
    await client.connectTCP(ip, { port: Number(port) || 502 });
    client.setID(Number(unitId) || 1);
  } catch (err) {
    send({ type: "error", message: `Connection failed: ${err.message}` });
    activeSessions.delete(id);
    return;
  }

  const total = Number(count) || 100;
  const batch = Math.min(Number(batchSize) || 10, 125);
  let done = 0;

  try {
    for (let offset = 0; offset < total && !session.cancelled; offset += batch) {
      const qty = Math.min(batch, total - offset);
      const reg = Number(startReg) + offset;

      let data;
      try {
        data = await readRegisters(client, regType, reg, qty);
      } catch (err) {
        for (let i = 0; i < qty; i++) {
          const reading = {
            type: "result",
            register: reg + i,
            value: null,
            raw: null,
            dataType: regType,
            sanity: { status: "error", reason: err.message },
          };
          send(reading);
          await dataStore.recordReading(id, ip, port, unitId, reading);
        }
        done += qty;
        send({ type: "progress", done, total });
        continue;
      }

      for (let i = 0; i < qty && i < data.length; i++) {
        const reading = {
          type: "result",
          register: reg + i,
          value: data[i],
          raw: data[i],
          dataType: regType,
          sanity: sanityCheck(data[i], regType),
        };
        send(reading);
        await dataStore.recordReading(id, ip, port, unitId, reading);
      }

      done += qty;
      send({ type: "progress", done, total });
      if (!session.cancelled) await sleep(20);
    }
  } finally {
    try {
      client.close();
    } catch (closeErr) {
      console.error("Error closing client:", closeErr.message);
    }

    // Record scan end
    const duration = Date.now() - session.startTime;
    await dataStore.recordScanEnd(id, duration);

    send({ type: "done" });
    activeSessions.delete(id);
  }
}

async function handleScanYaml(ws, msg, activeSessions) {
  const { id, ip, port, unitId } = msg;
  const session = { cancelled: false, startTime: Date.now() };
  activeSessions.set(id, session);

  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ ...obj, id }));
  };

  if (yamlRegisters.length === 0) {
    send({ type: "error", message: "No YAML registers loaded" });
    activeSessions.delete(id);
    return;
  }

  // Record scan start
  await dataStore.recordScanStart(id, ip, port, unitId, "yaml_scan");

  const client = new ModbusRTU();
  client.setTimeout(3000);

  try {
    await client.connectTCP(ip, { port: Number(port) || 502 });
    client.setID(Number(unitId) || 1);
  } catch (err) {
    send({ type: "error", message: `Connection failed: ${err.message}` });
    activeSessions.delete(id);
    return;
  }

  const total = yamlRegisters.length;
  let done = 0;

  try {
    for (const regDef of yamlRegisters) {
      if (session.cancelled) break;

      const qty = regDef.data_type === "int32" ? 2 : 1;
      let rawWords;
      try {
        rawWords = await readHoldingWords(client, regDef.address, qty);
      } catch (err) {
        const reading = {
          type: "result",
          register: regDef.address,
          name: regDef.name,
          section: regDef.section,
          unit: regDef.unit,
          value: null,
          raw: null,
          scaledValue: null,
          dataType: regDef.data_type,
          sanity: { status: "error", reason: err.message },
        };
        send(reading);
        await dataStore.recordReading(id, ip, port, unitId, reading);
        done++;
        send({ type: "progress", done, total });
        await sleep(20);
        continue;
      }

      const rawInt = combineWords(rawWords, regDef.data_type);
      const scaled = applyScale(rawInt, regDef.scale, regDef.precision);

      const reading = {
        type: "result",
        register: regDef.address,
        name: regDef.name,
        section: regDef.section,
        unit: regDef.unit,
        value: rawInt,
        raw: rawWords[0],
        scaledValue: scaled,
        dataType: regDef.data_type,
        sanity: sanityCheckYaml(scaled, rawInt, regDef),
      };
      send(reading);
      await dataStore.recordReading(id, ip, port, unitId, reading);

      done++;
      send({ type: "progress", done, total });
      if (!session.cancelled) await sleep(20);
    }
  } finally {
    try {
      client.close();
    } catch (closeErr) {
      console.error("Error closing client:", closeErr.message);
    }

    const duration = Date.now() - session.startTime;
    await dataStore.recordScanEnd(id, duration);

    send({ type: "done" });
    activeSessions.delete(id);
  }
}

const DISCOVER_TYPES = ["holding", "input", "coil", "discrete"];
const DISCOVER_BATCH = 10;
const DISCOVER_MAX = 65536;
const DISCOVER_TIMEOUT = 2000;

async function handleDiscover(ws, msg, activeSessions) {
  const { id, ip, port, unitId } = msg;
  const session = { cancelled: false };
  activeSessions.set(id, session);
  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ ...obj, id }));
  };
  const client = new ModbusRTU();
  client.setTimeout(DISCOVER_TIMEOUT);

  try {
    await client.connectTCP(ip, { port: Number(port) || 502 });
    client.setID(Number(unitId) || 1);
  } catch (err) {
    send({ type: "error", message: `Connection failed for ${ip}: ${err.message}` });
    activeSessions.delete(id);
    return;
  }

  const totalSteps = DISCOVER_TYPES.length * DISCOVER_MAX;
  let doneSteps = 0;
  try {
    for (const regType of DISCOVER_TYPES) {
      let address = 0;
      while (address < DISCOVER_MAX && !session.cancelled) {
        const quantity = Math.min(DISCOVER_BATCH, DISCOVER_MAX - address);
        try {
          const data = await readRegisters(client, regType, address, quantity);
          data.forEach((value, index) => send({
            type: "result", discover: true, regType,
            register: address + index, value, raw: value,
            dataType: regType, sanity: sanityCheck(value, regType),
          }));
        } catch {
          for (let index = 0; index < quantity && !session.cancelled; index++) {
            try {
              const data = await readRegisters(client, regType, address + index, 1);
              send({
                type: "result", discover: true, regType,
                register: address + index, value: data[0], raw: data[0],
                dataType: regType, sanity: sanityCheck(data[0], regType),
              });
            } catch {
              // Illegal addresses are expected during discovery.
            }
          }
        }
        doneSteps += quantity;
        send({ type: "progress", done: doneSteps, total: totalSteps, phase: regType });
        address += quantity;
        await sleep(10);
      }
    }
  } finally {
    try { client.close(); } catch (closeErr) { console.error("Error closing Modbus client:", closeErr.message); }
    send({ type: "done" });
    activeSessions.delete(id);
  }
}

// Modbus helpers
async function readRegisters(client, regType, address, qty) {
  switch (regType) {
    case "coil":
      return (await client.readCoils(address, qty)).data.map((b) => (b ? 1 : 0));
    case "discrete":
      return (await client.readDiscreteInputs(address, qty)).data.map((b) => (b ? 1 : 0));
    case "holding":
      return (await client.readHoldingRegisters(address, qty)).data;
    case "input":
      return (await client.readInputRegisters(address, qty)).data;
    default:
      throw new Error(`Unknown register type: ${regType}`);
  }
}

async function readHoldingWords(client, address, qty) {
  return (await client.readHoldingRegisters(address, qty)).data;
}

function combineWords(words, dataType) {
  if (dataType === "int32") {
    const u32 = ((words[0] & 0xffff) << 16) | (words[1] & 0xffff);
    return u32 | 0;
  }
  if (dataType === "int16") {
    const u16 = words[0] & 0xffff;
    return u16 > 0x7fff ? u16 - 0x10000 : u16;
  }
  return words[0] & 0xffff;
}

function applyScale(value, scale, precision) {
  if (value === null || value === undefined) return null;
  const scaled = value * scale;
  return parseFloat(scaled.toFixed(precision));
}

function sanityCheck(raw, regType) {
  if (raw === null || raw === undefined) {
    return { status: "error", reason: "No data" };
  }
  if (regType === "coil" || regType === "discrete") {
    return { status: "ok", reason: "" };
  }
  if (raw === 0xffff) {
    return { status: "warn", reason: "0xFFFF – possible error" };
  }
  return { status: "ok", reason: "" };
}

function sanityCheckYaml(scaled, rawInt, regDef) {
  if (scaled === null || scaled === undefined) {
    return { status: "error", reason: "No data" };
  }
  const unit = (regDef.unit || "").trim();
  if (unit === "°C" && scaled < -40) {
    return { status: "warn", reason: `Temperature ${scaled}°C is too low` };
  }
  return { status: "ok", reason: "" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Server startup
async function start() {
  try {
    await initDataStore();

    httpServer.listen(HTTP_PORT, () => {
      console.log(`Modbus Scanner with persistence running → http://localhost:${HTTP_PORT}`);
      console.log(`Database: modbus_readings.db`);
      console.log(`Export CSV: GET /api/export/csv?all=true`);
      console.log(`Export JSON: GET /api/export/json?tag=<tag_name>`);
      console.log(`Statistics: GET /api/stats`);
      console.log(`Unique Tags: GET /api/tags`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await dataStore.close();
  httpServer.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

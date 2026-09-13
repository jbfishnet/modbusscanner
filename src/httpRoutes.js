"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { normalizeTarget } = require("./validation");
const { isTrustedOrigin } = require("./security");
const config = require("./config");

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function serveIndex(req, res) {
  const filePath = path.join(__dirname, "..", "index.html");
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let rejected = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (rejected) return;
      if (body.length + chunk.length > config.MAX_BODY_BYTES) {
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

function testTargetAccess(target) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: target.ip, port: target.port });
    const finish = (status, error = null) => {
      socket.destroy();
      resolve({ ...target, lastStatus: status, lastError: error });
    };

    socket.setTimeout(config.TARGET_TEST_TIMEOUT_MS);
    socket.once("connect", () => finish("reachable"));
    socket.once("timeout", () => finish("unreachable", "Connection timed out"));
    socket.once("error", (err) => finish("unreachable", err.message));
  });
}

// Builds the (req, res) => void handler passed to http.createServer().
// `dataStore` is injected rather than required directly so this module has
// no hidden dependency on a specific DataStore instance/lifecycle.
function createHttpHandler({ dataStore }) {
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
      sendJson(res, 200, stats);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  }

  async function handleTags(res) {
    try {
      const tags = await dataStore.getUniqueTags();
      sendJson(res, 200, tags);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  }

  async function handleLatestReadings(res) {
    try {
      const readings = await dataStore.getLatestReadings();
      sendJson(res, 200, readings);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
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
        yamlRegisters: config.getYamlRegisters().length,
        bootedAt: new Date().toISOString(),
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  }

  async function handleSaveScanTargets(req, res) {
    try {
      const payload = await readJsonBody(req);
      if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
        throw new Error("At least one scan target is required");
      }
      if (payload.targets.length > config.MAX_SCAN_TARGETS) {
        throw new Error(`A maximum of ${config.MAX_SCAN_TARGETS} scan targets is supported`);
      }

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

  async function handleGetDashboardConfig(res) {
    try {
      sendJson(res, 200, { tags: await dataStore.getDashboardConfig() });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  }

  async function handleSaveDashboardConfig(req, res) {
    try {
      const payload = await readJsonBody(req);
      if (!Array.isArray(payload.tags)) {
        throw new Error("tags must be an array of tag names");
      }
      const tags = await dataStore.saveDashboardConfig(payload.tags);
      sendJson(res, 200, { tags });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  }

  const routes = [
    { method: "GET", path: "/", handle: serveIndex },
    { method: "GET", path: "/index.html", handle: serveIndex },
    { method: "GET", path: "/api/export/csv", handle: (req, res, url) => handleExportCSV(url, res) },
    { method: "GET", path: "/api/export/json", handle: (req, res, url) => handleExportJSON(url, res) },
    { method: "GET", path: "/api/stats", handle: (req, res) => handleStats(res) },
    { method: "GET", path: "/api/tags", handle: (req, res) => handleTags(res) },
    { method: "GET", path: "/api/readings/latest", handle: (req, res) => handleLatestReadings(res) },
    { method: "GET", path: "/api/bootstrap", handle: (req, res) => handleBootstrap(res) },
    { method: "GET", path: "/api/scan-targets", handle: (req, res) => handleGetScanTargets(res) },
    { method: "POST", path: "/api/scan-targets", handle: handleSaveScanTargets },
    { method: "GET", path: "/api/dashboard-config", handle: (req, res) => handleGetDashboardConfig(res) },
    { method: "POST", path: "/api/dashboard-config", handle: handleSaveDashboardConfig },
  ];

  return function handleRequest(req, res) {
    if (!isTrustedOrigin(req.headers)) {
      res.writeHead(403);
      res.end("Forbidden: cross-origin request rejected");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname);

    if (!route) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    route.handle(req, res, url);
  };
}

module.exports = { createHttpHandler };

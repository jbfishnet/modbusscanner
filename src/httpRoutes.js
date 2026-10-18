"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { normalizeTarget } = require("./validation");
const { isTrustedOrigin } = require("./security");
const config = require("./config");
const { sanitizeDashboard } = require("./dashboardConfig");

const WEB_DIR = path.resolve(__dirname, "..", "web");
const STATIC_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

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
function createHttpHandler({ dataStore, poller, onDashboardSettingsChanged }) {
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
      if (poller) poller.pollOnce({ full: true }); // read new/changed targets in the background
      sendJson(res, 200, { targets: savedTargets });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  }

  const MAX_QUERY_SERIES = 32;
  const MAX_RANGE_MS = 366 * 24 * 3600 * 1000;

  function respond(res, fn) {
    return Promise.resolve()
      .then(fn)
      .then((payload) => sendJson(res, 200, payload))
      .catch((err) => sendJson(res, err.status || 400, { error: err.message }));
  }

  const handleListDashboards = (res) =>
    respond(res, async () => ({ dashboards: await dataStore.listDashboards() }));

  const handleSaveDashboard = (req, res) =>
    respond(res, async () => {
      const payload = await readJsonBody(req);
      const clean = sanitizeDashboard(payload);
      const id = payload.id === undefined || payload.id === null ? null : Number(payload.id);
      if (id !== null && !Number.isInteger(id)) throw new Error("Invalid dashboard id");
      const dashboard = await dataStore.saveDashboard({ id, ...clean });
      if (poller) poller.pollSoon(); // newly pinned tags get a first sample right away
      return { dashboard };
    });

  const handleDeleteDashboard = (url, res) =>
    respond(res, async () => {
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id)) throw new Error("Invalid dashboard id");
      await dataStore.deleteDashboard(id);
      return { ok: true };
    });

  // POST body: { series: [{name, ip?}], from, to (ms epoch), maxPoints? }
  const handleQuery = (req, res) =>
    respond(res, async () => {
      const body = await readJsonBody(req);
      const series = Array.isArray(body.series) ? body.series.slice(0, MAX_QUERY_SERIES) : [];
      const toMs = Number.isFinite(Number(body.to)) ? Number(body.to) : Date.now();
      const fromMs = Number.isFinite(Number(body.from)) ? Number(body.from) : toMs - 3600 * 1000;
      if (fromMs >= toMs || toMs - fromMs > MAX_RANGE_MS) throw new Error("Invalid time range");
      const maxPoints = Math.min(2000, Math.max(10, Number(body.maxPoints) || 600));
      const minBucketSec = await dataStore.getDashboardPollIntervalSec();
      const out = [];
      for (const s of series) {
        if (!s || typeof s.name !== "string") continue;
        out.push({
          name: s.name,
          ip: s.ip || null,
          points: await dataStore.querySeries({ name: s.name, ip: s.ip || null, fromMs, toMs, maxPoints, minBucketSec }),
        });
      }
      return { from: fromMs, to: toMs, series: out };
    });

  const handleGetDashboardSettings = (res) =>
    respond(res, async () => ({ pollIntervalSec: await dataStore.getDashboardPollIntervalSec() }));

  const handleSaveDashboardSettings = (req, res) =>
    respond(res, async () => {
      const body = await readJsonBody(req);
      const pollIntervalSec = await dataStore.setDashboardPollIntervalSec(body.pollIntervalSec);
      if (onDashboardSettingsChanged) onDashboardSettingsChanged();
      return { pollIntervalSec };
    });

  // Live register values come from the background poller, never from the browser.
  const handleYamlSnapshot = (res) =>
    respond(res, async () => (poller ? poller.getSnapshot() : { updatedAt: null, rows: [], errors: [] }));

  const handleYamlRefresh = (res) =>
    respond(res, async () => (poller ? poller.refreshAll() : { updatedAt: null, rows: [], errors: [] }));

  const handleStatic = (url, res) => {
    const rel = decodeURIComponent(url.pathname).replace(/^\/web\//, "");
    const filePath = path.resolve(WEB_DIR, rel);
    const type = STATIC_TYPES[path.extname(filePath)];
    if (!type || !filePath.startsWith(WEB_DIR + path.sep)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
      } else {
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
        res.end(data);
      }
    });
  };

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
    { method: "GET", path: "/api/dashboards", handle: (req, res) => handleListDashboards(res) },
    { method: "POST", path: "/api/dashboards", handle: handleSaveDashboard },
    { method: "DELETE", path: "/api/dashboards", handle: (req, res, url) => handleDeleteDashboard(url, res) },
    { method: "POST", path: "/api/query", handle: handleQuery },
    { method: "GET", path: "/api/yaml-snapshot", handle: (req, res) => handleYamlSnapshot(res) },
    { method: "POST", path: "/api/yaml-snapshot/refresh", handle: (req, res) => handleYamlRefresh(res) },
    { method: "GET", path: "/api/dashboard-settings", handle: (req, res) => handleGetDashboardSettings(res) },
    { method: "POST", path: "/api/dashboard-settings", handle: handleSaveDashboardSettings },
  ];

  return function handleRequest(req, res) {
    if (!isTrustedOrigin(req.headers)) {
      res.writeHead(403);
      res.end("Forbidden: cross-origin request rejected");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname.startsWith("/web/")) {
      handleStatic(url, res);
      return;
    }
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

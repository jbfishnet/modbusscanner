"use strict";

const crypto = require("crypto");
const ModbusRTU = require("modbus-serial");
const config = require("./config");
const logger = require("./logger");
const { readYamlReading, connectWithRetry, sleep } = require("./modbusHelpers");

const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
// Registers used by dashboard panels are sampled (and stored) every poll
// interval; the complete register list is only read this often, to keep the
// YAML tab's live values fresh without storing ~70 rows per cycle.
const FULL_SNAPSHOT_EVERY_MS = 60 * 1000;
const POLL_SOON_DELAY_MS = 300;

// The only component that talks to the heat pump on its own: it samples the
// registers used by dashboard panels on its own interval, independent of any
// open browser tab (history keeps accumulating while the UI is closed), keeps
// an in-memory snapshot of all register values for the YAML tab, and runs the
// hourly rollup/prune. The UI only ever reads results from here.
function createDashboardPoller({ dataStore }) {
  let pollTimer = null;
  let soonTimer = null;
  let rollupTimer = null;
  let stopped = true;
  let running = null; // promise of the poll in flight
  let forceFull = false;
  let lastFullAt = 0;

  const snapshot = new Map(); // `${ip}|${name}` -> reading (+ ip, at)
  const errors = new Map(); // ip -> message of the last failed cycle
  let snapshotAt = null;

  async function pollTarget(target, regDefs, persistNames) {
    const scanId = crypto.randomUUID();
    const client = new ModbusRTU();
    client.setTimeout(config.MODBUS_CONNECT_TIMEOUT_MS);
    try {
      await connectWithRetry(client, target.ip, Number(target.port) || 502, Number(target.unitId) || 1, {
        retries: 0,
        backoffMs: config.CONNECT_RETRY_BACKOFF_MS,
      });
    } catch (err) {
      logger.warn(`[Poller] ${target.ip}: connection failed: ${err.message}`);
      errors.set(target.ip, `Connection failed: ${err.message}`);
      return;
    }
    errors.delete(target.ip);
    const started = Date.now();
    let persisted = 0;
    try {
      for (const regDef of regDefs) {
        const reading = await readYamlReading(client, regDef);
        snapshot.set(`${target.ip}|${regDef.name}`, { ...reading, ip: target.ip, at: Date.now() });
        snapshotAt = Date.now(); // rows are served as they arrive, even mid-cycle
        if (persistNames.has(regDef.name)) {
          if (!persisted) await dataStore.recordScanStart(scanId, target.ip, target.port, target.unitId, "dashboard_poll");
          persisted++;
          await dataStore.recordReading(scanId, target.ip, target.port, target.unitId, reading);
        }
        await sleep(config.SCAN_STEP_DELAY_MS);
      }
      if (persisted) await dataStore.recordScanEnd(scanId, Date.now() - started);
    } finally {
      try { client.close(); } catch (err) { logger.error("[Poller] close failed:", err.message); }
    }
  }

  async function runCycle() {
    try {
      const dashboardNames = new Set(await dataStore.getDashboardTagNames());
      const all = config.getYamlRegisters();
      const full = forceFull || Date.now() - lastFullAt >= FULL_SNAPSHOT_EVERY_MS;
      forceFull = false;
      const regDefs = full ? all : all.filter((r) => dashboardNames.has(r.name));
      if (!regDefs.length) return;
      for (const target of await dataStore.getScanTargets()) {
        if (stopped) break;
        await pollTarget(target, regDefs, dashboardNames);
      }
      if (full) lastFullAt = Date.now();
      snapshotAt = Date.now();
    } catch (err) {
      logger.error("[Poller] poll failed:", err.message);
    }
  }

  // Runs one cycle; if one is already in flight, waits for it (and, when a
  // full read is requested, follows up with one) instead of overlapping.
  function pollOnce({ full = false } = {}) {
    if (full) forceFull = true;
    if (running) return full ? running.then(() => pollOnce({ full: true })) : running;
    running = runCycle().finally(() => { running = null; });
    return running;
  }

  async function schedule() {
    if (stopped) return;
    let intervalSec = 10;
    try { intervalSec = await dataStore.getDashboardPollIntervalSec(); } catch { /* store closing */ }
    pollTimer = setTimeout(async () => {
      await pollOnce();
      schedule();
    }, intervalSec * 1000);
  }

  async function rollup() {
    try {
      const { pruned } = await dataStore.rollupAndPrune();
      if (pruned) logger.info(`[Poller] rolled up and pruned ${pruned} raw readings`);
    } catch (err) {
      logger.error("[Poller] rollup failed:", err.message);
    }
  }

  return {
    start() {
      stopped = false;
      pollOnce({ full: true });
      schedule();
      rollup();
      rollupTimer = setInterval(rollup, ROLLUP_INTERVAL_MS);
    },
    // Re-arm the timer after the interval setting changed.
    reschedule() {
      clearTimeout(pollTimer);
      schedule();
    },
    // A dashboard was saved (maybe with a newly pinned tag): sample soon so
    // the panel has data within seconds instead of after the next interval.
    pollSoon() {
      if (stopped) return;
      clearTimeout(soonTimer);
      soonTimer = setTimeout(() => pollOnce(), POLL_SOON_DELAY_MS);
    },
    // Forces a read of every register now; resolves once the snapshot is updated.
    async refreshAll() {
      await pollOnce({ full: true });
      return this.getSnapshot();
    },
    getSnapshot() {
      const order = new Map(config.getYamlRegisters().map((r, i) => [r.name, i]));
      const rows = [...snapshot.values()].sort(
        (a, b) => (order.get(a.name) ?? 1e9) - (order.get(b.name) ?? 1e9) || a.ip.localeCompare(b.ip)
      );
      return {
        updatedAt: snapshotAt,
        rows,
        errors: [...errors].map(([ip, message]) => ({ ip, message })),
      };
    },
    stop() {
      stopped = true;
      clearTimeout(pollTimer);
      clearTimeout(soonTimer);
      clearInterval(rollupTimer);
    },
    pollOnce,
  };
}

module.exports = { createDashboardPoller };

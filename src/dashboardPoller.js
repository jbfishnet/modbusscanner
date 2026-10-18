"use strict";

const crypto = require("crypto");
const ModbusRTU = require("modbus-serial");
const config = require("./config");
const logger = require("./logger");
const { readYamlReading, connectWithRetry, sleep } = require("./modbusHelpers");

const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;

// Samples exactly the registers used by dashboard panels, on its own
// interval and independent of any open browser tab, so history keeps
// accumulating while the UI is closed. Also runs the hourly rollup/prune.
function createDashboardPoller({ dataStore }) {
  let pollTimer = null;
  let rollupTimer = null;
  let running = false;
  let stopped = true;

  async function pollTarget(target, regDefs) {
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
      return;
    }
    const started = Date.now();
    try {
      await dataStore.recordScanStart(scanId, target.ip, target.port, target.unitId, "dashboard_poll");
      for (const regDef of regDefs) {
        const reading = await readYamlReading(client, regDef);
        await dataStore.recordReading(scanId, target.ip, target.port, target.unitId, reading);
        await sleep(config.SCAN_STEP_DELAY_MS);
      }
      await dataStore.recordScanEnd(scanId, Date.now() - started);
    } finally {
      try { client.close(); } catch (err) { logger.error("[Poller] close failed:", err.message); }
    }
  }

  async function pollOnce() {
    if (running) return;
    running = true;
    try {
      const names = new Set(await dataStore.getDashboardTagNames());
      const regDefs = config.getYamlRegisters().filter((r) => names.has(r.name));
      if (!regDefs.length) return;
      for (const target of await dataStore.getScanTargets()) {
        if (stopped) break;
        await pollTarget(target, regDefs);
      }
    } catch (err) {
      logger.error("[Poller] poll failed:", err.message);
    } finally {
      running = false;
    }
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
      schedule();
      rollup();
      rollupTimer = setInterval(rollup, ROLLUP_INTERVAL_MS);
    },
    // Re-arm the timer after the interval setting changed.
    reschedule() {
      clearTimeout(pollTimer);
      schedule();
    },
    stop() {
      stopped = true;
      clearTimeout(pollTimer);
      clearInterval(rollupTimer);
    },
    pollOnce,
  };
}

module.exports = { createDashboardPoller };

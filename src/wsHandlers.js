"use strict";

const ModbusRTU = require("modbus-serial");
const config = require("./config");
const logger = require("./logger");
const { validateScanMessage } = require("./validation");
const {
  readRegisters,
  readHoldingWords,
  combineWords,
  applyScale,
  sanityCheck,
  sanityCheckYaml,
  sleep,
  isProtocolException,
  connectWithRetry,
} = require("./modbusHelpers");

// Shared connect/loop/finally skeleton for handleScan and handleScanYaml,
// which used to duplicate this almost verbatim. `iterate` does the
// scan-type-specific reads; everything else (session bookkeeping, scan
// start/end persistence, client cleanup, the final "done" message) lives
// here once.
async function runScanSession({ ws, msg, activeSessions, dataStore, scanType, iterate }) {
  const { id, ip, port, unitId } = msg;
  const session = { cancelled: false, startTime: Date.now() };
  activeSessions.set(id, session);

  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ ...obj, id }));
  };

  await dataStore.recordScanStart(id, ip, port, unitId, scanType);

  const client = new ModbusRTU();
  client.setTimeout(config.MODBUS_CONNECT_TIMEOUT_MS);

  try {
    await connectWithRetry(client, ip, Number(port) || 502, Number(unitId) || 1, {
      retries: config.CONNECT_RETRIES,
      backoffMs: config.CONNECT_RETRY_BACKOFF_MS,
    });
  } catch (err) {
    send({ type: "error", message: `Connection failed: ${err.message}` });
    activeSessions.delete(id);
    return;
  }

  const recordReading = (reading) => dataStore.recordReading(id, ip, port, unitId, reading);

  try {
    await iterate({ client, session, send, recordReading });
  } finally {
    try {
      client.close();
    } catch (closeErr) {
      logger.error("Error closing Modbus client:", closeErr.message);
    }

    const duration = Date.now() - session.startTime;
    await dataStore.recordScanEnd(id, duration);

    send({ type: "done" });
    activeSessions.delete(id);
  }
}

async function handleScan(ws, msg, activeSessions, { dataStore }) {
  const { startReg, count, batchSize, regType } = msg;
  const total = Number(count) || 100;
  const batch = Math.min(Number(batchSize) || 10, config.MAX_BATCH_SIZE);

  await runScanSession({
    ws,
    msg,
    activeSessions,
    dataStore,
    scanType: "raw_range_scan",
    iterate: async ({ client, session, send, recordReading }) => {
      let done = 0;
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
            await recordReading(reading);
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
          await recordReading(reading);
        }

        done += qty;
        send({ type: "progress", done, total });
        if (!session.cancelled) await sleep(config.SCAN_STEP_DELAY_MS);
      }
    },
  });
}

async function handleScanYaml(ws, msg, activeSessions, { dataStore }) {
  const yamlRegisters = config.getYamlRegisters();
  if (yamlRegisters.length === 0) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "error", id: msg.id, message: "No YAML registers loaded" }));
    }
    return;
  }

  await runScanSession({
    ws,
    msg,
    activeSessions,
    dataStore,
    scanType: "yaml_scan",
    iterate: async ({ client, session, send, recordReading }) => {
      const total = yamlRegisters.length;
      let done = 0;

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
          await recordReading(reading);
          done++;
          send({ type: "progress", done, total });
          await sleep(config.SCAN_STEP_DELAY_MS);
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
        await recordReading(reading);

        done++;
        send({ type: "progress", done, total });
        if (!session.cancelled) await sleep(config.SCAN_STEP_DELAY_MS);
      }
    },
  });
}

// Probes the full address space per register type. Does not persist
// readings (discovery is exploratory, not a recorded scan) so it manages
// its own client lifecycle rather than going through runScanSession.
async function handleDiscover(ws, msg, activeSessions) {
  const { id, ip, port, unitId } = msg;
  const session = { cancelled: false };
  activeSessions.set(id, session);
  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ ...obj, id }));
  };
  const client = new ModbusRTU();
  client.setTimeout(config.DISCOVER_TIMEOUT_MS);

  try {
    await connectWithRetry(client, ip, Number(port) || 502, Number(unitId) || 1, {
      retries: config.CONNECT_RETRIES,
      backoffMs: config.CONNECT_RETRY_BACKOFF_MS,
    });
  } catch (err) {
    send({ type: "error", message: `Connection failed for ${ip}: ${err.message}` });
    activeSessions.delete(id);
    return;
  }

  const totalSteps = config.DISCOVER_TYPES.length * config.DISCOVER_MAX;
  let doneSteps = 0;
  // A run of failures with no modbusCode (i.e. not a protocol-level
  // "illegal address", which is expected constantly during discovery)
  // means the connection itself is gone — stop grinding through the
  // rest of the address space instead of taking a 2s timeout per
  // register for tens of thousands of addresses.
  let consecutiveConnectionErrors = 0;
  let aborted = false;

  try {
    for (const regType of config.DISCOVER_TYPES) {
      if (aborted) break;
      let address = 0;
      while (address < config.DISCOVER_MAX && !session.cancelled) {
        const quantity = Math.min(config.DISCOVER_BATCH, config.DISCOVER_MAX - address);
        try {
          const data = await readRegisters(client, regType, address, quantity);
          consecutiveConnectionErrors = 0;
          data.forEach((value, index) =>
            send({
              type: "result",
              discover: true,
              regType,
              register: address + index,
              value,
              raw: value,
              dataType: regType,
              sanity: sanityCheck(value, regType),
            })
          );
        } catch (batchErr) {
          if (!isProtocolException(batchErr)) {
            consecutiveConnectionErrors++;
          }
          for (let index = 0; index < quantity && !session.cancelled; index++) {
            try {
              const data = await readRegisters(client, regType, address + index, 1);
              consecutiveConnectionErrors = 0;
              send({
                type: "result",
                discover: true,
                regType,
                register: address + index,
                value: data[0],
                raw: data[0],
                dataType: regType,
                sanity: sanityCheck(data[0], regType),
              });
            } catch (singleErr) {
              // Illegal addresses are expected during discovery; only
              // count genuine transport failures toward the breaker.
              if (!isProtocolException(singleErr)) {
                consecutiveConnectionErrors++;
                if (consecutiveConnectionErrors >= config.DISCOVER_MAX_CONSECUTIVE_CONNECTION_ERRORS) {
                  break;
                }
              }
            }
          }
        }

        if (consecutiveConnectionErrors >= config.DISCOVER_MAX_CONSECUTIVE_CONNECTION_ERRORS) {
          send({ type: "error", message: "Connection appears to be lost; stopping discovery early." });
          aborted = true;
          break;
        }

        doneSteps += quantity;
        send({ type: "progress", done: doneSteps, total: totalSteps, phase: regType });
        address += quantity;
        await sleep(config.DISCOVER_STEP_DELAY_MS);
      }
    }
  } finally {
    try {
      client.close();
    } catch (closeErr) {
      logger.error("Error closing Modbus client:", closeErr.message);
    }
    send({ type: "done" });
    activeSessions.delete(id);
  }
}

// Builds the (ws) => void handler passed to wss.on("connection", ...).
function createConnectionHandler({ dataStore }) {
  return function handleConnection(ws) {
    const activeSessions = new Map();

    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "config", registers: config.getYamlRegisters() }));
    }

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        logger.warn("Ignoring malformed WS message:", err.message);
        return;
      }

      const sendError = (message) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", id: msg.id, message }));
      };

      if (msg.type === "scan") {
        const error = validateScanMessage(msg, { requireRegType: true });
        if (error) return sendError(error);
        handleScan(ws, msg, activeSessions, { dataStore });
      } else if (msg.type === "scan_yaml") {
        const error = validateScanMessage(msg, { requireRegType: false });
        if (error) return sendError(error);
        handleScanYaml(ws, msg, activeSessions, { dataStore });
      } else if (msg.type === "scan_discover") {
        const error = validateScanMessage(msg, { requireRegType: false });
        if (error) return sendError(error);
        handleDiscover(ws, msg, activeSessions);
      } else if (msg.type === "get_config") {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "config", registers: config.getYamlRegisters() }));
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
  };
}

module.exports = { createConnectionHandler };

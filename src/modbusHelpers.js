"use strict";

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

// A Modbus *protocol* exception (illegal address, illegal function, ...)
// carries `modbusCode` (see modbus-serial's index.js, ~line 494). Anything
// without it is a real transport-level failure (timeout, reset, refused).
function isProtocolException(err) {
  return err && err.modbusCode !== undefined;
}

// `client.connectTCP` + `setID` in one retryable step. A single failed
// attempt used to abort the whole scan immediately; this gives transient
// connection issues a couple of short retries first.
async function connectWithRetry(client, ip, port, unitId, { retries = 2, backoffMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await client.connectTCP(ip, { port });
      client.setID(unitId);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

module.exports = {
  readRegisters,
  readHoldingWords,
  combineWords,
  applyScale,
  sanityCheck,
  sanityCheckYaml,
  sleep,
  isProtocolException,
  connectWithRetry,
};

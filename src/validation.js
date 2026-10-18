"use strict";

const net = require("net");

const VALID_REG_TYPES = new Set(["holding", "input", "coil", "discrete"]);

// Shared by the HTTP scan-targets endpoint and WS scan dispatch, so both
// paths reject the same malformed input the same way.
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

function isValidRegType(regType) {
  return VALID_REG_TYPES.has(regType);
}

// Returns an error message string, or null if the WS scan message is valid.
function validateScanMessage(msg, { requireRegType = false } = {}) {
  try {
    normalizeTarget(msg);
  } catch (err) {
    return err.message;
  }
  if (requireRegType && !isValidRegType(msg?.regType)) {
    return `Invalid register type: ${msg?.regType}`;
  }
  return null;
}

module.exports = { normalizeTarget, isValidRegType, validateScanMessage, VALID_REG_TYPES };

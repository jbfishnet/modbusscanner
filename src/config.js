"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const logger = require("./logger");

const HTTP_PORT = process.env.PORT || 8080;

// Modbus scanning
const MODBUS_CONNECT_TIMEOUT_MS = 3000;
const SCAN_STEP_DELAY_MS = 20;
const MAX_BATCH_SIZE = 125; // Modbus protocol maximum registers per request
const CONNECT_RETRIES = 2;
const CONNECT_RETRY_BACKOFF_MS = 500;

// Discovery (full address-space probe)
const DISCOVER_TYPES = ["holding", "input", "coil", "discrete"];
const DISCOVER_BATCH = 10;
const DISCOVER_MAX = 65536;
const DISCOVER_TIMEOUT_MS = 2000;
const DISCOVER_STEP_DELAY_MS = 10;
const DISCOVER_MAX_CONSECUTIVE_CONNECTION_ERRORS = 20;

// HTTP API
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SCAN_TARGETS = 64;
const TARGET_TEST_TIMEOUT_MS = 3000;

let yamlRegisters = [];

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

async function loadYamlConfig() {
  const yamlPath = path.join(__dirname, "..", "modbus.yaml");
  let raw;
  try {
    raw = await fs.promises.readFile(yamlPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      logger.warn("modbus.yaml not found – YAML scan mode unavailable");
      return yamlRegisters;
    }
    logger.error("Failed to read modbus.yaml:", err.message);
    return yamlRegisters;
  }

  try {
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

    logger.info(`Loaded ${yamlRegisters.length} register definitions`);
  } catch (err) {
    logger.error("Failed to parse modbus.yaml:", err.message);
  }

  return yamlRegisters;
}

function getYamlRegisters() {
  return yamlRegisters;
}

module.exports = {
  HTTP_PORT,
  MODBUS_CONNECT_TIMEOUT_MS,
  SCAN_STEP_DELAY_MS,
  MAX_BATCH_SIZE,
  CONNECT_RETRIES,
  CONNECT_RETRY_BACKOFF_MS,
  DISCOVER_TYPES,
  DISCOVER_BATCH,
  DISCOVER_MAX,
  DISCOVER_TIMEOUT_MS,
  DISCOVER_STEP_DELAY_MS,
  DISCOVER_MAX_CONSECUTIVE_CONNECTION_ERRORS,
  MAX_BODY_BYTES,
  MAX_SCAN_TARGETS,
  TARGET_TEST_TIMEOUT_MS,
  loadYamlConfig,
  getYamlRegisters,
};

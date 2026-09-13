"use strict";

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const ModbusRTU = require("modbus-serial");

const root = __dirname;
const databasePath = path.join(root, "modbus_readings.db");

function waitForOutput(child, text, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${JSON.stringify(text)}. Output: ${output}`));
    }, timeoutMs);

    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(text)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Process exited before ${JSON.stringify(text)}: code=${code}, signal=${signal}. Output: ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

function stopProcess(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", resolve);
    child.kill("SIGINT");
  });
}

function get(pathname, port, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: pathname, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
    });
    request.on("error", reject);
  });
}

function post(pathname, port, payload) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(payload));
  });
}

async function testHttpServer() {
  if (fs.existsSync(databasePath)) fs.rmSync(databasePath);
  const port = 18080;
  const server = spawn(process.execPath, ["server-with-persistence.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForOutput(server, `localhost:${port}`);
    const response = await get("/", port);
    assert.strictEqual(response.statusCode, 200);
    assert.match(response.body, /Modbus/);
    const stats = await get("/api/stats", port);
    assert.strictEqual(stats.statusCode, 200);
    assert.doesNotThrow(() => JSON.parse(stats.body));
    const emptyTargets = await get("/api/scan-targets", port);
    assert.strictEqual(emptyTargets.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(emptyTargets.body).targets, []);
    const savedTargets = await post("/api/scan-targets", port, {
      targets: [{ ip: "127.0.0.1", port: 1, unitId: 1 }],
    });
    assert.strictEqual(savedTargets.statusCode, 200);
    const target = JSON.parse(savedTargets.body).targets[0];
    assert.strictEqual(target.ip, "127.0.0.1");
    assert.strictEqual(target.lastStatus, "unreachable");

    // A request carrying another site's Origin must be rejected — this is
    // the app's only defense against a malicious page in another browser
    // tab reaching into it, since there's no auth and no other CORS policy.
    const crossOrigin = await get("/api/stats", port, { Origin: "http://evil.example" });
    assert.strictEqual(crossOrigin.statusCode, 403);
  } finally {
    await stopProcess(server);
    if (fs.existsSync(databasePath)) fs.rmSync(databasePath);
  }
}

async function testModbusServer() {
  const port = 15020;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(root, "testserver"),
    env: { ...process.env, MODBUS_PORT: String(port), UPDATE_INTERVAL: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const client = new ModbusRTU();

  try {
    await waitForOutput(server, "ready");
    await client.connectTCP("127.0.0.1", { port });
    client.setID(1);
    const holding = await client.readHoldingRegisters(0, 2);
    const input = await client.readInputRegisters(0, 2);
    const coils = await client.readCoils(0, 2);
    assert.strictEqual(holding.data.length, 2);
    assert.strictEqual(input.data.length, 2);
    assert(coils.data.length >= 2);
    assert.strictEqual(holding.data[0], 200);
  } finally {
    client.close(() => {});
    await stopProcess(server);
  }
}

(async () => {
  await testHttpServer();
  console.log("HTTP integration test passed");
  await testModbusServer();
  console.log("Modbus integration test passed");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
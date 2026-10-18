/**
 * Modbus TCP Scanner – server entrypoint
 *
 * Wires together the HTTP API (src/httpRoutes.js), the WebSocket scan
 * protocol (src/wsHandlers.js) and the SQLite persistence layer
 * (datastore.js). `start()` is exported so the Electron desktop wrapper can
 * run this in-process; `require.main === module` keeps `node
 * server-with-persistence.js` (npm start, Docker) working standalone.
 */

"use strict";

const http = require("http");
const { WebSocketServer } = require("ws");
const dataStore = require("./datastore");
const config = require("./src/config");
const logger = require("./src/logger");
const { createHttpHandler } = require("./src/httpRoutes");
const { createConnectionHandler } = require("./src/wsHandlers");
const { isTrustedOrigin } = require("./src/security");
const { createDashboardPoller } = require("./src/dashboardPoller");

let httpServer;
let poller;

async function initDataStore() {
  try {
    await dataStore.init();
    const stats = await dataStore.getStats();
    logger.info("[DataStore] Database ready. Stats:", stats);
  } catch (err) {
    logger.error("[DataStore] Initialization failed:", err.message);
    process.exit(1);
  }
}

async function start() {
  try {
    await config.loadYamlConfig();
    await initDataStore();

    poller = createDashboardPoller({ dataStore });
    httpServer = http.createServer(
      createHttpHandler({ dataStore, onDashboardSettingsChanged: () => poller.reschedule() })
    );
    const wss = new WebSocketServer({
      server: httpServer,
      verifyClient: (info) => isTrustedOrigin(info.req.headers),
    });
    wss.on("connection", createConnectionHandler({ dataStore }));
    poller.start();

    await new Promise((resolve) => {
      httpServer.listen(config.HTTP_PORT, config.BIND_HOST, () => {
        logger.info(`Modbus Scanner with persistence running → http://localhost:${config.HTTP_PORT}`);
        logger.info(`Bound to ${config.BIND_HOST} (set BIND_HOST to allow LAN access)`);
        logger.info(`Export CSV: GET /api/export/csv?all=true`);
        logger.info(`Export JSON: GET /api/export/json?tag=<tag_name>`);
        logger.info(`Statistics: GET /api/stats`);
        logger.info(`Unique Tags: GET /api/tags`);
        resolve();
      });
    });
  } catch (err) {
    logger.error("Failed to start server:", err);
    process.exit(1);
  }
}

async function stop() {
  if (poller) poller.stop();
  await dataStore.close();
  await new Promise((resolve) => (httpServer ? httpServer.close(resolve) : resolve()));
}

if (require.main === module) {
  start();

  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    await stop();
    logger.info("Server closed");
    process.exit(0);
  });
}

module.exports = { start, stop };

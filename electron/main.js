"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

// Point config.js at a writable per-user copy of modbus.yaml before it (or
// anything requiring it) ever reads the path — the packaged app's install
// directory is read-only-ish and gets replaced on update.
process.env.MODBUS_YAML_PATH =
  process.env.MODBUS_YAML_PATH || path.join(app.getPath("userData"), "modbus.yaml");

const config = require("../src/config");
const server = require("../server-with-persistence");
const { setupAutoUpdate } = require("./updater");

function ensureUserYaml() {
  const yamlPath = config.getYamlPath();
  if (fs.existsSync(yamlPath)) return;
  const bundledYaml = path.join(__dirname, "..", "modbus.yaml");
  fs.mkdirSync(path.dirname(yamlPath), { recursive: true });
  fs.copyFileSync(bundledYaml, yamlPath);
}

let mainWindow;

async function createWindow() {
  await server.start();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, "..", "resources", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${config.HTTP_PORT}`);
  setupAutoUpdate();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    ensureUserYaml();
    createWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Covers window-close-triggered quits, Cmd+Q, and explicit app.quit():
  // stop the HTTP server and close the SQLite handle before the process
  // actually exits, then quit for real.
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    // The renderer's own WebSocket connection to the local server would
    // otherwise keep httpServer.close() (awaited inside stop()) from ever
    // firing its callback, hanging shutdown indefinitely.
    if (mainWindow) mainWindow.destroy();
    server.stop().finally(() => app.quit());
  });
}

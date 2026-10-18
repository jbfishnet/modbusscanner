"use strict";

const { app, dialog } = require("electron");
const log = require("electron-log");
const { autoUpdater } = require("electron-updater");

autoUpdater.logger = log;

function setupAutoUpdate() {
  // Dev runs (unpackaged) have no update feed configured and would just
  // log a noisy, expected error on every launch.
  if (!app.isPackaged) return;

  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      title: "Update ready",
      message: `A new version (${info.version}) has been downloaded.`,
      detail: "Restart the app to apply the update.",
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on("error", (err) => {
    log.error("Auto-update check failed:", err.message);
  });

  // A short delay avoids competing with app/server startup for network and
  // I/O; a failed check here (e.g. offline) is silently non-fatal.
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      log.error("checkForUpdatesAndNotify failed:", err.message);
    });
  }, 5000);
}

module.exports = { setupAutoUpdate };

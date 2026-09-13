"use strict";

// Minimal leveled logger. No external dependency: this app has no build
// step and the desktop (Electron) wrapper swaps this for electron-log,
// which needs no interface change here since call sites only ever use
// debug/info/warn/error.
function timestamp() {
  return new Date().toISOString();
}

module.exports = {
  debug: (...args) => console.debug(`[${timestamp()}] [DEBUG]`, ...args),
  info: (...args) => console.log(`[${timestamp()}] [INFO]`, ...args),
  warn: (...args) => console.warn(`[${timestamp()}] [WARN]`, ...args),
  error: (...args) => console.error(`[${timestamp()}] [ERROR]`, ...args),
};

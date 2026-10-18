"use strict";

// Nothing to expose: the renderer is the same index.html served by the
// local HTTP server and talks to it purely over fetch()/WebSocket, not
// through Node/Electron APIs. contextIsolation stays on and nodeIntegration
// stays off (Electron's defaults) — this file exists as the designated
// place to add a contextBridge API if a future feature ever needs one.

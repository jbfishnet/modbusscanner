"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const selfsigned = require("selfsigned");
const logger = require("./logger");

const VALID_DAYS = 825;
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;

// Names/IPs the certificate is valid for: loopback, this host's name and
// its LAN addresses (relevant when BIND_HOST opens the app to the LAN).
function subjectAltNames() {
  const names = new Set(["localhost"]);
  const ips = new Set(["127.0.0.1", "::1"]);
  names.add(os.hostname());
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) ips.add(a.address.split("%")[0]);
  }
  return [
    ...[...names].map((value) => ({ type: 2, value })),
    ...[...ips].map((ip) => ({ type: 7, ip })),
  ];
}

function isUsable(certPem) {
  try {
    const x = new crypto.X509Certificate(certPem);
    return new Date(x.validTo).getTime() - Date.now() > RENEW_BEFORE_MS;
  } catch {
    return false;
  }
}

/**
 * Loads the self-signed certificate from certDir, generating (and
 * persisting) a new one on first run or when it is about to expire.
 */
async function ensureCertificate(certDir) {
  const keyPath = path.join(certDir, "server.key");
  const certPath = path.join(certDir, "server.crt");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const cert = fs.readFileSync(certPath, "utf8");
    if (isUsable(cert)) return { key: fs.readFileSync(keyPath, "utf8"), cert, certPath };
  }

  logger.info(`[TLS] Generating self-signed certificate in ${certDir}`);
  const notBeforeDate = new Date(Date.now() - 3600 * 1000);
  const pems = await selfsigned.generate([{ name: "commonName", value: "Modbus Scanner" }], {
    keySize: 2048,
    algorithm: "sha256",
    notBeforeDate,
    notAfterDate: new Date(Date.now() + VALID_DAYS * 24 * 3600 * 1000),
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: subjectAltNames() },
    ],
  });
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert, certPath };
}

// Answers plain-HTTP requests with a redirect to the same host:port over HTTPS.
function redirectHandler(req, res) {
  const host = req.headers.host;
  if (!host) {
    res.writeHead(400);
    res.end("Missing Host header");
    return;
  }
  // 308 keeps the method and body, so a stray POST is not silently turned into a GET.
  res.writeHead(308, { Location: `https://${host}${req.url}` });
  res.end();
}

/**
 * One listening port serving both protocols: the first byte of a TLS
 * handshake is 0x16, anything else is treated as plain HTTP and redirected.
 * Returns { server, httpsServer } — attach WebSockets to httpsServer and
 * listen()/close() the returned net server.
 */
function createDualProtocolServer({ key, cert }, requestHandler) {
  const httpsServer = https.createServer({ key, cert }, requestHandler);
  const redirectServer = http.createServer(redirectHandler);

  const server = net.createServer((socket) => {
    socket.once("error", () => socket.destroy());
    socket.once("data", (chunk) => {
      socket.pause();
      socket.unshift(chunk);
      (chunk[0] === 0x16 ? httpsServer : redirectServer).emit("connection", socket);
      process.nextTick(() => socket.resume());
    });
  });

  const originalClose = server.close.bind(server);
  server.close = (cb) => {
    // Terminate keep-alive connections so shutdown is not held up by idle clients.
    httpsServer.closeAllConnections?.();
    redirectServer.closeAllConnections?.();
    return originalClose(cb);
  };

  return { server, httpsServer };
}

module.exports = { ensureCertificate, createDualProtocolServer, redirectHandler };

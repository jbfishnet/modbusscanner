"use strict";

// This app has no login/auth — its only real protection is being bound to
// loopback (see config.BIND_HOST). That still leaves one gap: with no CORS
// policy, any other page open in the same browser could fetch/POST to it,
// or open a WebSocket to it, and drive scans against the user's configured
// Modbus targets. Browsers always send Origin on cross-origin requests (and
// on same-origin ones too, for state-changing requests) but never fabricate
// it, so rejecting a mismatched Origin closes that off. Non-browser clients
// (curl, the test suite, modbus-serial) don't send an Origin header at all,
// so they're unaffected.
function isTrustedOrigin(headers) {
  const origin = headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}

module.exports = { isTrustedOrigin };

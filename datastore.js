/**
 * SQLite Data Store for Modbus Scanner
 *
 * Persists all Modbus register readings with timestamps.
 * Supports Excel export via CSV format.
 *
 * Database schema:
 *   - readings: timestamp, ip, port, unitId, register, name, section, dataType, unit,
 *              value (raw), scaledValue, raw_word, sanity_status, sanity_reason
 *   - scan_metadata: scan_id, timestamp, ip, port, unitId, scan_type, register_count
 */

"use strict";

const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

// Database file location
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "modbus_readings.db");
// Scan targets (the user's device IPs) are also mirrored to a small JSON file
// next to the database, so they survive a lost or replaced database file
// (app update, reinstall, accidental deletion).
const TARGETS_BACKUP_PATH = `${DB_PATH}.targets.json`;

class DataStore {
  constructor() {
    this.db = null;
    this.initialized = false;
  }

  /**
   * Initialize SQLite database and create tables if needed
   */
  init() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          console.error("Failed to open database:", err.message);
          reject(err);
          return;
        }

        console.log(`[DataStore] Connected to SQLite at ${DB_PATH}`);

        // Enable foreign keys
        this.db.run("PRAGMA foreign_keys = ON", (err) => {
          if (err) reject(err);
          else this.createTables().then(async () => {
            this.initialized = true;
            await this.restoreTargetsFromBackup();
            resolve();
          }).catch(reject);
        });
      });
    });
  }

  /**
   * Create tables if they don't exist
   */
  createTables() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        // Scan metadata table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS scan_metadata (
            scan_id TEXT PRIMARY KEY,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            ip TEXT NOT NULL,
            port INTEGER NOT NULL,
            unitId INTEGER NOT NULL,
            scan_type TEXT NOT NULL,
            register_count INTEGER,
            duration_ms INTEGER
          )
        `, (err) => {
          if (err) reject(err);
        });

        // Main readings table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_id TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            ip TEXT NOT NULL,
            port INTEGER NOT NULL,
            unitId INTEGER NOT NULL,
            register INTEGER NOT NULL,
            name TEXT,
            section TEXT,
            dataType TEXT NOT NULL,
            unit TEXT,
            value INTEGER,
            scaledValue REAL,
            raw_word INTEGER,
            sanity_status TEXT,
            sanity_reason TEXT,
            FOREIGN KEY (scan_id) REFERENCES scan_metadata(scan_id)
          )
        `, (err) => {
          if (err) reject(err);
        });

        // Create indexes for better query performance
        this.db.run(
          `CREATE INDEX IF NOT EXISTS idx_timestamp ON readings(timestamp)`,
          (err) => { if (err) reject(err); }
        );
        this.db.run(
          `CREATE INDEX IF NOT EXISTS idx_ip_port ON readings(ip, port)`,
          (err) => { if (err) reject(err); }
        );
        this.db.run(
          `CREATE INDEX IF NOT EXISTS idx_register ON readings(register)`,
          (err) => { if (err) reject(err); }
        );
        this.db.run(
          `CREATE INDEX IF NOT EXISTS idx_name ON readings(name)`,
          (err) => { if (err) reject(err); }
        );

        this.db.run(
          `CREATE INDEX IF NOT EXISTS idx_name_ts ON readings(name, timestamp)`,
          (err) => { if (err) reject(err); }
        );

        // Dashboards: one JSON config document per dashboard
        this.db.run(`
          CREATE TABLE IF NOT EXISTS dashboards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            config TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => { if (err) reject(err); });

        // Hourly rollups of readings older than the raw-retention window
        this.db.run(`
          CREATE TABLE IF NOT EXISTS readings_hourly (
            ip TEXT NOT NULL,
            name TEXT NOT NULL,
            hour INTEGER NOT NULL,
            avg REAL NOT NULL,
            min REAL NOT NULL,
            max REAL NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY (ip, name, hour)
          )
        `, (err) => { if (err) reject(err); });

        // Settings table for retention policy
        this.db.run(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
          )
        `, (err) => {
          if (err) {
            reject(err);
            return;
          }

          this.db.run(`
            CREATE TABLE IF NOT EXISTS scan_targets (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ip TEXT NOT NULL UNIQUE,
              port INTEGER NOT NULL,
              unitId INTEGER NOT NULL,
              last_status TEXT,
              last_error TEXT,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `, (targetErr) => {
            if (targetErr) reject(targetErr);
            else resolve();
          });
        });
      });
    });
  }

  /**
   * Get configured Modbus scan targets.
   */
  getScanTargets() {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }

      this.db.all(`
        SELECT id, ip, port, unitId, last_status AS lastStatus,
               last_error AS lastError, updated_at AS updatedAt
        FROM scan_targets
        ORDER BY id ASC
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Mirror the targets to <db>.targets.json (atomic write). Failures
   * are logged, not thrown: the database stays the source of truth.
   */
  writeTargetsBackup(targets) {
    try {
      const payload = {
        savedAt: new Date().toISOString(),
        targets: targets.map(({ ip, port, unitId }) => ({ ip, port, unitId })),
      };
      const tmp = `${TARGETS_BACKUP_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, TARGETS_BACKUP_PATH);
    } catch (err) {
      console.error("[DataStore] Could not write scan target backup:", err.message);
    }
  }

  /**
   * If the database has no scan targets but a backup exists (fresh or
   * replaced database after an update/reinstall), bring the IPs back.
   */
  async restoreTargetsFromBackup() {
    const existing = await this._all(`SELECT 1 FROM scan_targets LIMIT 1`);
    if (existing.length) {
      // Keep the backup current even if it predates this feature.
      if (!fs.existsSync(TARGETS_BACKUP_PATH)) this.writeTargetsBackup(await this.getScanTargets());
      return;
    }
    if (!fs.existsSync(TARGETS_BACKUP_PATH)) return;
    try {
      const { targets } = JSON.parse(fs.readFileSync(TARGETS_BACKUP_PATH, "utf8"));
      const valid = (Array.isArray(targets) ? targets : []).filter(
        (t) => t && typeof t.ip === "string" && Number.isInteger(t.port) && Number.isInteger(t.unitId)
      );
      for (const t of valid) {
        await this._run(`INSERT OR IGNORE INTO scan_targets (ip, port, unitId) VALUES (?, ?, ?)`, [t.ip, t.port, t.unitId]);
      }
      if (valid.length) console.log(`[DataStore] Restored ${valid.length} scan target(s) from ${TARGETS_BACKUP_PATH}`);
    } catch (err) {
      console.error("[DataStore] Could not restore scan targets from backup:", err.message);
    }
  }

  /**
   * Replace the configured Modbus scan targets.
   */
  saveScanTargets(targets) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }
      // Never wipe the configured device IPs by saving an empty list.
      if (!Array.isArray(targets) || targets.length === 0) {
        reject(new Error("At least one scan target is required"));
        return;
      }

      this.db.serialize(() => {
        this.db.run("BEGIN TRANSACTION");
        this.db.run("DELETE FROM scan_targets", (deleteErr) => {
          if (deleteErr) {
            this.db.run("ROLLBACK");
            reject(deleteErr);
            return;
          }

          const stmt = this.db.prepare(`
            INSERT INTO scan_targets (ip, port, unitId, last_status, last_error)
            VALUES (?, ?, ?, ?, ?)
          `);

          for (const target of targets) {
            stmt.run([
              target.ip,
              target.port,
              target.unitId,
              target.lastStatus || null,
              target.lastError || null,
            ]);
          }

          stmt.finalize((finalizeErr) => {
            if (finalizeErr) {
              this.db.run("ROLLBACK");
              reject(finalizeErr);
              return;
            }

            this.db.run("COMMIT", (commitErr) => {
              if (commitErr) {
                this.db.run("ROLLBACK");
                reject(commitErr);
              }
              else this.getScanTargets().then((saved) => {
                this.writeTargetsBackup(saved);
                resolve(saved);
              }).catch(reject);
            });
          });
        });
      });
    });
  }

  /**
   * Generic key/value settings accessors (settings table).
   */
  getSetting(key) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }
      this.db.get(`SELECT value FROM settings WHERE key = ?`, [key], (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.value : null);
      });
    });
  }

  setSetting(key, value) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }
      this.db.run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // ── Promise wrappers around sqlite3's callback API ──────────────────────
  _all(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) return reject(new Error("DataStore not initialized"));
      this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  }

  _run(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) return reject(new Error("DataStore not initialized"));
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  // ── Dashboards ──────────────────────────────────────────────────────────
  _rowToDashboard(row) {
    let config = {};
    try { config = JSON.parse(row.config); } catch { /* corrupt row -> empty config */ }
    return { id: row.id, name: row.name, config, updatedAt: row.updated_at };
  }

  /**
   * All dashboards. On first run, migrates the legacy `dashboard_tags`
   * setting (a flat list of tag names) into a first dashboard.
   */
  async listDashboards() {
    let rows = await this._all(`SELECT * FROM dashboards ORDER BY id ASC`);
    if (rows.length === 0) {
      const legacy = await this.getSetting("dashboard_tags");
      let tags = [];
      try { tags = JSON.parse(legacy || "[]").filter((t) => typeof t === "string"); } catch { /* ignore */ }
      const config = {
        panels: [{
          id: "p1", type: "timeseries", title: "Live Metrics", width: 12, height: 2,
          series: tags.map((name) => ({ name })), options: {},
        }],
        timeRangeSec: 3600,
        refreshSec: 10,
      };
      await this._run(`INSERT INTO dashboards (name, config) VALUES (?, ?)`, ["Plant Overview", JSON.stringify(config)]);
      rows = await this._all(`SELECT * FROM dashboards ORDER BY id ASC`);
    }
    return rows.map((r) => this._rowToDashboard(r));
  }

  async getDashboard(id) {
    const rows = await this._all(`SELECT * FROM dashboards WHERE id = ?`, [id]);
    return rows[0] ? this._rowToDashboard(rows[0]) : null;
  }

  /** Create (no id) or update a dashboard with an already-sanitized {name, config}. */
  async saveDashboard({ id, name, config }) {
    const json = JSON.stringify(config);
    if (id) {
      const res = await this._run(
        `UPDATE dashboards SET name = ?, config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [name, json, id]
      );
      if (!res.changes) throw new Error("Dashboard not found");
      return this.getDashboard(id);
    }
    const res = await this._run(`INSERT INTO dashboards (name, config) VALUES (?, ?)`, [name, json]);
    return this.getDashboard(res.lastID);
  }

  async deleteDashboard(id) {
    const rows = await this._all(`SELECT COUNT(*) AS n FROM dashboards`);
    if (rows[0].n <= 1) throw new Error("Cannot delete the last dashboard");
    const res = await this._run(`DELETE FROM dashboards WHERE id = ?`, [id]);
    return res.changes > 0;
  }

  /** Distinct tag names used by any dashboard panel (what the background poller samples). */
  async getDashboardTagNames() {
    const names = new Set();
    for (const d of await this.listDashboards()) {
      for (const p of d.config.panels || []) for (const s of p.series || []) names.add(s.name);
    }
    return [...names];
  }

  async getDashboardPollIntervalSec() {
    const v = Number(await this.getSetting("dashboard_poll_interval_sec"));
    return Number.isFinite(v) && v >= 2 ? v : 10;
  }

  async setDashboardPollIntervalSec(sec) {
    const v = Number(sec);
    if (!Number.isFinite(v) || v < 2 || v > 3600) throw new Error("Interval must be between 2 and 3600 seconds");
    await this.setSetting("dashboard_poll_interval_sec", String(Math.round(v)));
    return Math.round(v);
  }

  // ── Time-series queries & retention ─────────────────────────────────────
  /**
   * Downsampled history for one series. Recent data comes from `readings`,
   * data older than the raw window from `readings_hourly`. Returns
   * [[tMs, avg, min, max], …] with timestamps on a common bucket grid.
   */
  async querySeries({ name, ip = null, fromMs, toMs, maxPoints = 600, minBucketSec = 1 }) {
    const rangeSec = Math.max(1, (toMs - fromMs) / 1000);
    const bucketSec = Math.max(Math.ceil(minBucketSec), Math.ceil(rangeSec / Math.max(10, maxPoints)));
    const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const rawCutoffMs = Date.now() - (await this.getRawRetentionDays()) * 86400000;
    const points = new Map();

    if (fromMs < rawCutoffMs) {
      const hb = Math.max(3600, Math.ceil(bucketSec / 3600) * 3600);
      const rows = await this._all(
        `SELECT (hour / ?) * ? AS b, SUM(avg * count) / SUM(count) AS avg, MIN(min) AS min, MAX(max) AS max
         FROM readings_hourly
         WHERE name = ? AND (? IS NULL OR ip = ?) AND hour >= ? AND hour < ?
         GROUP BY b`,
        [hb, hb, name, ip, ip, Math.floor(fromMs / 1000), Math.floor(Math.min(toMs, rawCutoffMs) / 1000)]
      );
      for (const r of rows) points.set(r.b * 1000, [r.b * 1000, r.avg, r.min, r.max]);
    }

    const rawFrom = Math.max(fromMs, rawCutoffMs);
    if (rawFrom < toMs) {
      const rows = await this._all(
        `SELECT (CAST(strftime('%s', timestamp) AS INTEGER) / ?) * ? AS b,
                AVG(scaledValue) AS avg, MIN(scaledValue) AS min, MAX(scaledValue) AS max
         FROM readings
         WHERE name = ? AND (? IS NULL OR ip = ?) AND scaledValue IS NOT NULL
           AND timestamp >= ? AND timestamp <= ?
         GROUP BY b`,
        [bucketSec, bucketSec, name, ip, ip, fmt(rawFrom), fmt(toMs)]
      );
      for (const r of rows) points.set(r.b * 1000, [r.b * 1000, r.avg, r.min, r.max]);
    }
    return [...points.values()].sort((a, b) => a[0] - b[0]);
  }

  async getRawRetentionDays() {
    const v = Number(await this.getSetting("raw_retention_days"));
    return Number.isFinite(v) && v >= 1 ? v : 7;
  }

  /**
   * Roll raw readings older than the retention window up into hourly
   * avg/min/max rows, then delete them. Safe to run repeatedly.
   */
  async rollupAndPrune() {
    const days = await this.getRawRetentionDays();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace("T", " ");
    // Only whole hours below the cutoff, so a partial hour is never rolled up twice.
    await this._run(
      `INSERT INTO readings_hourly (ip, name, hour, avg, min, max, count)
       SELECT ip, name, (CAST(strftime('%s', timestamp) AS INTEGER) / 3600) * 3600 AS h,
              AVG(scaledValue), MIN(scaledValue), MAX(scaledValue), COUNT(*)
       FROM readings
       WHERE name IS NOT NULL AND scaledValue IS NOT NULL AND timestamp < ?
         AND h < (CAST(strftime('%s', ?) AS INTEGER) / 3600) * 3600
       GROUP BY ip, name, h
       ON CONFLICT(ip, name, hour) DO UPDATE SET
         avg = (avg * count + excluded.avg * excluded.count) / (count + excluded.count),
         min = MIN(min, excluded.min), max = MAX(max, excluded.max),
         count = count + excluded.count`,
      [cutoff, cutoff]
    );
    const del = await this._run(
      `DELETE FROM readings WHERE timestamp < ? AND name IS NOT NULL
         AND (CAST(strftime('%s', timestamp) AS INTEGER) / 3600) * 3600 < (CAST(strftime('%s', ?) AS INTEGER) / 3600) * 3600`,
      [cutoff, cutoff]
    );
    return { pruned: del.changes };
  }

  /**
   * Record a scan metadata entry
   */
  recordScanStart(scanId, ip, port, unitId, scanType) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }

      const stmt = this.db.prepare(`
        INSERT INTO scan_metadata (scan_id, ip, port, unitId, scan_type)
        VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run([scanId, ip, port, unitId, scanType], (err) => {
        stmt.finalize();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Record a single reading from Modbus
   */
  recordReading(scanId, ip, port, unitId, reading) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }

      const stmt = this.db.prepare(`
        INSERT INTO readings (
          scan_id, ip, port, unitId, register, name, section, dataType, unit,
          value, scaledValue, raw_word, sanity_status, sanity_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const sanity = reading.sanity || {};
      const params = [
        scanId,
        ip,
        port,
        unitId,
        reading.register !== undefined && reading.register !== null ? reading.register : null,
        reading.name !== undefined && reading.name !== null ? reading.name : null,
        reading.section !== undefined && reading.section !== null ? reading.section : null,
        reading.dataType !== undefined && reading.dataType !== null ? reading.dataType : null,
        reading.unit !== undefined && reading.unit !== null ? reading.unit : null,
        reading.value !== undefined ? reading.value : null,
        reading.scaledValue !== undefined ? reading.scaledValue : null,
        reading.raw !== undefined ? reading.raw : null,
        sanity.status !== undefined && sanity.status !== null ? sanity.status : null,
        sanity.reason !== undefined && sanity.reason !== null ? sanity.reason : null,
      ];

      stmt.run(params, (err) => {
        stmt.finalize();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Update scan duration
   */
  recordScanEnd(scanId, durationMs) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }

      const stmt = this.db.prepare(`
        UPDATE scan_metadata SET duration_ms = ? WHERE scan_id = ?
      `);

      stmt.run([durationMs, scanId], (err) => {
        stmt.finalize();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Get all readings for a time range
   */
  getReadings(startTime, endTime) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }

      const sql = `
        SELECT * FROM readings
        WHERE timestamp BETWEEN ? AND ?
        ORDER BY timestamp DESC, register ASC
      `;

      this.db.all(sql, [startTime, endTime], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Get all readings
   */
  getAllReadings() {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }

      const sql = `
        SELECT * FROM readings
        ORDER BY timestamp DESC, register ASC
      `;

      this.db.all(sql, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Get readings filtered by register/name
   */
  getReadingsByTag(name) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }

      const sql = `
        SELECT * FROM readings
        WHERE name = ? OR register = ?
        ORDER BY timestamp DESC
      `;

      // name could be the tag name or register number
      const param = isNaN(name) ? name : parseInt(name);

      this.db.all(sql, [param, param], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Get latest reading for each unique register
   */
  getLatestReadings() {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }

      // SQLite has no DISTINCT ON; this correlated subquery gets the same
      // "latest row per register" result.
      const sql = `
        SELECT * FROM readings r1
        WHERE timestamp = (SELECT MAX(timestamp) FROM readings r2 WHERE r2.register = r1.register)
        ORDER BY register
      `;

      this.db.all(sql, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Get unique tags/names
   */
  getUniqueTags() {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }

      const sql = `
        SELECT DISTINCT name, register, unit, dataType, section
        FROM readings
        WHERE name IS NOT NULL
        ORDER BY section, name
      `;

      this.db.all(sql, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Export readings to CSV (Excel format)
   * Returns CSV string
   */
  async exportToCSV(query = null) {
    if (!this.initialized) {
      throw new Error("DataStore not initialized");
    }

    let rows = [];
    if (query && query.name) {
      rows = await this.getReadingsByTag(query.name);
    } else if (query && query.all) {
      rows = await this.getAllReadings();
    } else {
      rows = await this.getLatestReadings();
    }

    if (rows.length === 0) {
      return "";
    }

    // CSV header
    const headers = [
      "Timestamp",
      "IP Address",
      "Port",
      "Unit ID",
      "Register Address",
      "Tag Name",
      "Section",
      "Data Type",
      "Unit",
      "Raw Value",
      "Scaled Value",
      "Sanity Status",
      "Sanity Reason",
    ];

    const csvLines = [headers.map((h) => `"${h}"`).join(",")];

    // CSV rows. `orEmpty` (not `||`) throughout: register/port/unitId can
    // legitimately be 0, and status/reason can legitimately be "" — `||`
    // would coerce those to "" and lose real data (the same bug class
    // fixed in recordReading()).
    const orEmpty = (v) => (v !== null && v !== undefined ? v : "");
    for (const row of rows) {
      const line = [
        orEmpty(row.timestamp),
        orEmpty(row.ip),
        orEmpty(row.port),
        orEmpty(row.unitId),
        orEmpty(row.register),
        orEmpty(row.name),
        orEmpty(row.section),
        orEmpty(row.dataType),
        orEmpty(row.unit),
        orEmpty(row.value),
        orEmpty(row.scaledValue),
        orEmpty(row.sanity_status),
        orEmpty(row.sanity_reason),
      ];
      csvLines.push(line.map((v) => `"${orEmpty(v).toString().replace(/"/g, '""')}"`).join(","));
    }

    return csvLines.join("\n");
  }

  /**
   * Export readings to JSON
   */
  async exportToJSON(query = null) {
    if (!this.initialized) {
      throw new Error("DataStore not initialized");
    }

    let rows = [];
    if (query && query.name) {
      rows = await this.getReadingsByTag(query.name);
    } else if (query && query.all) {
      rows = await this.getAllReadings();
    } else {
      rows = await this.getLatestReadings();
    }

    return rows;
  }

  /**
   * Delete readings older than N days
   */
  deleteOldReadings(daysOld) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }

      const sql = `
        DELETE FROM readings
        WHERE datetime(timestamp) < datetime('now', '-' || ? || ' days')
      `;

      this.db.run(sql, [daysOld], function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  }

  /**
   * Get database statistics
   */
  getStats() {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
        return;
      }

      this.db.serialize(() => {
        let stats = {};

        this.db.get(
          "SELECT COUNT(*) as count FROM readings",
          (err, row) => {
            if (err) reject(err);
            else stats.totalReadings = row.count;
          }
        );

        this.db.get(
          "SELECT COUNT(*) as count FROM scan_metadata",
          (err, row) => {
            if (err) reject(err);
            else stats.totalScans = row.count;
          }
        );

        this.db.get(
          `SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM readings`,
          (err, row) => {
            if (err) reject(err);
            else {
              stats.oldestReading = row.oldest;
              stats.newestReading = row.newest;
            }
          }
        );

        this.db.get(
          "SELECT COUNT(DISTINCT name) as count FROM readings WHERE name IS NOT NULL",
          (err, row) => {
            if (err) reject(err);
            else {
              stats.uniqueTags = row.count;
              resolve(stats);
            }
          }
        );
      });
    });
  }

  /**
   * Close database connection
   */
  close() {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve();
        return;
      }

      this.db.close((err) => {
        if (err) reject(err);
        else {
          console.log("[DataStore] Database connection closed");
          resolve();
        }
      });
    });
  }
}

module.exports = new DataStore();

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
          else this.createTables().then(() => {
            this.initialized = true;
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
   * Replace the configured Modbus scan targets.
   */
  saveScanTargets(targets) {
    return new Promise((resolve, reject) => {
      if (!this.initialized) {
        reject(new Error("DataStore not initialized"));
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
              else this.getScanTargets().then(resolve).catch(reject);
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

  /**
   * Dashboard chart config: just the list of tag names the user has added
   * (not their history — the readings table already retains that).
   */
  async getDashboardConfig() {
    const raw = await this.getSetting("dashboard_tags");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
    } catch {
      return [];
    }
  }

  async saveDashboardConfig(tagNames) {
    const clean = Array.isArray(tagNames) ? tagNames.filter((t) => typeof t === "string") : [];
    await this.setSetting("dashboard_tags", JSON.stringify(clean));
    return clean;
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

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const root = __dirname.replace(/tests$/, '');
const uiPort = 18081;
const modbusPort = 15021;
const dbPath = path.join(root, 'modbus_ui_test.db');

function waitForOutput(child, text, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let output = '';
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
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

function stopProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    child.kill('SIGINT');
  });
}

test('startup restores persisted scan targets from the SQLite database', async ({ browser }) => {
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);

  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS scan_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL UNIQUE,
        port INTEGER NOT NULL,
        unitId INTEGER NOT NULL,
        last_status TEXT,
        last_error TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) return reject(err);
        db.run(`INSERT INTO scan_targets (ip, port, unitId, last_status, last_error)
          VALUES (?, ?, ?, ?, ?)`, ['127.0.0.1', modbusPort, 1, 'reachable', null], (insertErr) => {
          if (insertErr) return reject(insertErr);
          db.close((closeErr) => closeErr ? reject(closeErr) : resolve());
        });
      });
    });
  });

  const uiServer = spawn(process.execPath, ['server-with-persistence.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(uiPort), DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForOutput(uiServer, `localhost:${uiPort}`);

    const response = await fetch(`http://127.0.0.1:${uiPort}/api/bootstrap`);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ ip: '127.0.0.1', port: modbusPort, unitId: 1 })
    ]));

    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${uiPort}`);
    await expect(page.locator('#targetList .target-row')).toContainText('127.0.0.1');
    await page.close();
  } finally {
    await stopProcess(uiServer);
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  }
});

test('_entering a target and starting a scan persists it automatically', async ({ browser }) => {
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);

  const uiServer = spawn(process.execPath, ['server-with-persistence.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(uiPort), DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const modbusServer = spawn(process.execPath, ['server.js'], {
    cwd: path.join(root, 'testserver'),
    env: { ...process.env, MODBUS_PORT: String(modbusPort), UPDATE_INTERVAL: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await Promise.all([
      waitForOutput(uiServer, `localhost:${uiPort}`),
      waitForOutput(modbusServer, 'ready'),
    ]);

    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${uiPort}`);

    await page.locator('#targetIp').fill('127.0.0.1');
    await page.locator('#targetPort').fill(String(modbusPort));
    await page.locator('#targetUnitId').fill('1');

    await expect(page.locator('#btnScan')).toBeEnabled();
    await page.locator('#regType').selectOption('holding');
    await page.locator('#startReg').fill('0');
    await page.locator('#count').fill('3');
    await page.locator('#batchSize').fill('3');
    await page.locator('#btnScan').click();

    await expect(page.locator('#targetList .target-row')).toContainText('127.0.0.1');
    await expect(page.locator('#rawBody tr')).toHaveCount(3, { timeout: 25000 });

    await page.close();
  } finally {
    await stopProcess(modbusServer);
    await stopProcess(uiServer);
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  }
});

test('startup YAML scan stays silent and dashboard add button sits in the sanity column', async ({ browser }) => {
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);

  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS scan_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL UNIQUE,
        port INTEGER NOT NULL,
        unitId INTEGER NOT NULL,
        last_status TEXT,
        last_error TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) return reject(err);
        db.run(`INSERT OR REPLACE INTO scan_targets (ip, port, unitId, last_status, last_error)
          VALUES (?, ?, ?, ?, ?)`, ['127.0.0.1', modbusPort, 1, 'reachable', null], (insertErr) => {
          if (insertErr) return reject(insertErr);
          db.close((closeErr) => closeErr ? reject(closeErr) : resolve());
        });
      });
    });
  });

  const uiServer = spawn(process.execPath, ['server-with-persistence.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(uiPort), DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const modbusServer = spawn(process.execPath, ['server.js'], {
    cwd: path.join(root, 'testserver'),
    env: { ...process.env, MODBUS_PORT: String(modbusPort), UPDATE_INTERVAL: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await Promise.all([
      waitForOutput(uiServer, `localhost:${uiPort}`),
      waitForOutput(modbusServer, 'ready'),
    ]);

    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${uiPort}`);

    await expect(page.locator('#yamlBody tr:not(.section-header)')).toHaveCount(1, { timeout: 30000 });
    await expect(page.locator('#progressCard')).not.toBeVisible();
    await expect(page.locator('#btnCancel')).toBeDisabled();

    const firstRow = page.locator('#yamlBody tr:not(.section-header)').first();
    await expect(firstRow.locator('td').nth(5)).toContainText(/OK/i);
    await expect(firstRow.locator('.dashboard-add-btn')).toHaveText('+');
    await expect(firstRow.locator('.dashboard-add-btn')).toHaveAttribute('title', /Add to dashboard/i);

    await page.close();
  } finally {
    await stopProcess(modbusServer);
    await stopProcess(uiServer);
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  }
});

test('UI flow works for target setup, raw scan, YAML scan, discovery, export, and clear', async ({ browser }) => {
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);

  const uiServer = spawn(process.execPath, ['server-with-persistence.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(uiPort), DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const modbusServer = spawn(process.execPath, ['server.js'], {
    cwd: path.join(root, 'testserver'),
    env: { ...process.env, MODBUS_PORT: String(modbusPort), UPDATE_INTERVAL: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await Promise.all([
      waitForOutput(uiServer, `localhost:${uiPort}`),
      waitForOutput(modbusServer, 'ready'),
    ]);

    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${uiPort}`);

    await expect(page.locator('h1')).toContainText('Modbus TCP Scanner');

    await page.locator('#targetIp').fill('127.0.0.1');
    await page.locator('#targetPort').fill(String(modbusPort));
    await page.locator('#targetUnitId').fill('1');
    await page.locator('#btnSaveTargets').click();

    await expect(page.locator('#targetList .target-row')).toContainText('127.0.0.1');
    await expect(page.locator('#targetList .target-row')).toContainText('reachable');

    await page.locator('#regType').selectOption('holding');
    await page.locator('#startReg').fill('0');
    await page.locator('#count').fill('3');
    await page.locator('#batchSize').fill('3');
    await page.locator('#btnScan').click();

    await expect(page.locator('#rawBody tr')).toHaveCount(3, { timeout: 25000 });
    await expect(page.locator('#rawTable')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#btnExport').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/modbus_scan_raw_.*\.csv/);

    await page.getByRole('button', { name: /Clear/i }).click();
    await expect(page.locator('#rawTable')).not.toBeVisible();

    await page.locator('#tabYaml').click();
    await page.locator('#btnScanYaml').click();
    await expect(page.locator('#yamlBody tr:not(.section-header)')).toHaveCount(1, { timeout: 40000 });
    await expect(page.locator('#btnScanDiscover')).toBeEnabled({ timeout: 20000 });

    await page.locator('#tabDiscover').click();
    await page.locator('#btnScanDiscover').click();
    await expect(page.locator('#progressCard')).toBeVisible();
    await page.locator('#btnCancel').click();
    await expect(page.locator('#btnCancel')).toBeDisabled();

    await page.close();
  } finally {
    await stopProcess(modbusServer);
    await stopProcess(uiServer);
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  }
});

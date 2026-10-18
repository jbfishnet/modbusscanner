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

test('dashboard persists dashboards, panels and history across reload', async ({ browser }) => {
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
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    page.on('dialog', (dialog) => dialog.accept(dialog.type() === 'prompt' ? 'Second board' : undefined));

    await page.goto(`http://127.0.0.1:${uiPort}`);

    // A fresh database gets a default dashboard with one empty panel.
    await page.locator('#tabDashboard').click();
    await expect(page.locator('#dashboardWrap')).toBeVisible();
    await expect(page.locator('#dashSelect option')).toHaveCount(1);
    await expect(page.locator('.dash-panel')).toHaveCount(1);
    expect(pageErrors).toEqual([]);

    await page.locator('#targetIp').fill('127.0.0.1');
    await page.locator('#targetPort').fill(String(modbusPort));
    await page.locator('#targetUnitId').fill('1');
    await page.locator('#btnSaveTargets').click();
    await expect(page.locator('#targetList .target-row')).toContainText('127.0.0.1');

    // Pin a tag from the YAML table: persists to the dashboard config.
    await page.locator('#tabYaml').click();
    await page.locator('#btnScanYaml').click();
    await expect(page.locator('#yamlBody tr:not(.section-header)')).toHaveCount(1, { timeout: 40000 });
    const [addSave] = await Promise.all([
      page.waitForResponse((res) => res.url().endsWith('/api/dashboards') && res.request().method() === 'POST'),
      page.locator('.dashboard-add-btn').first().click(),
    ]);
    expect(addSave.ok()).toBe(true);

    // The readings table already holds history, so the chart renders from the server.
    // (Tab switching is blocked while a scan is running.)
    await page.waitForFunction(() => scanning === false, null, { timeout: 30000 });
    await page.locator('#tabDashboard').click();
    await expect(page.locator('.dash-panel .uplot')).toBeVisible({ timeout: 15000 });

    // Create a second dashboard (name comes from the prompt dialog handler).
    await page.locator('#dashNew').click();
    await expect(page.locator('#dashSelect option')).toHaveCount(2);

    // Everything survives a reload, including the chart's history.
    await page.reload();
    await page.waitForFunction(() => startupYamlScanStarted && scanning === false, null, { timeout: 30000 });
    await page.locator('#tabDashboard').click();
    await expect(page.locator('#dashSelect option')).toHaveCount(2);
    await page.locator('#dashSelect').selectOption({ label: 'Plant Overview' });
    await expect(page.locator('.dash-panel .uplot')).toBeVisible({ timeout: 15000 });

    // Removing the panel persists too.
    const [rmSave] = await Promise.all([
      page.waitForResponse((res) => res.url().endsWith('/api/dashboards') && res.request().method() === 'POST'),
      page.locator('.dash-panel [data-act="remove"]').click(),
    ]);
    expect(rmSave.ok()).toBe(true);
    await expect(page.locator('.dash-empty')).toBeVisible();

    await page.reload();
    await page.waitForFunction(() => startupYamlScanStarted && scanning === false, null, { timeout: 30000 });
    await page.locator('#tabDashboard').click();
    await page.locator('#dashSelect').selectOption({ label: 'Plant Overview' });
    await expect(page.locator('.dash-empty')).toBeVisible();
    expect(pageErrors).toEqual([]);

    await page.close();
  } finally {
    await stopProcess(modbusServer);
    await stopProcess(uiServer);
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  }
});

test('background poller records dashboard tags without any browser open', async () => {
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
    const base = `http://127.0.0.1:${uiPort}`;
    const post = (p, body) => fetch(base + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    expect((await post('/api/scan-targets', { targets: [{ ip: '127.0.0.1', port: modbusPort, unitId: 1 }] })).ok).toBe(true);

    // Pick the first YAML register as the dashboard series.
    const yaml = require('js-yaml');
    const sensors = yaml.load(fs.readFileSync(path.join(root, 'modbus.yaml'), 'utf8'));
    const tag = (Array.isArray(sensors) ? sensors[0] : sensors).sensors[0].name;

    const { dashboards } = await (await fetch(base + '/api/dashboards')).json();
    const dash = dashboards[0];
    dash.config.panels[0].series = [{ name: tag }];
    expect((await post('/api/dashboards', { id: dash.id, name: dash.name, config: dash.config })).ok).toBe(true);
    expect((await post('/api/dashboard-settings', { pollIntervalSec: 2 })).ok).toBe(true);

    await expect.poll(async () => {
      const res = await post('/api/query', { series: [{ name: tag }], from: Date.now() - 60000, to: Date.now() });
      return (await res.json()).series[0].points.length;
    }, { timeout: 20000 }).toBeGreaterThan(0);

    const scanTypes = await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath);
      db.all(`SELECT DISTINCT scan_type FROM scan_metadata`, (err, rows) => {
        db.close();
        err ? reject(err) : resolve(rows.map((r) => r.scan_type));
      });
    });
    expect(scanTypes).toEqual(['dashboard_poll']);
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

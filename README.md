# Modbus TCP Scanner

A clean web-based Modbus TCP register scanner. Scan any Modbus TCP device from your browser — configure the IP, port, unit ID, and register range, then view live results with automatic sanity checks.

## Quick Start

```bash
# Install dependencies (Node.js ≥ 16 required)
npm install

# Start the server
npm start
```

Then open **https://localhost:8080** in your browser.

## Docker

Docker Desktop is supported on macOS and Windows. Build and start the persistent server with:

```bash
docker build -t modbusscanner:local .
docker volume create modbusscanner-data
docker run --rm --name modbusscanner \
	-p 8080:8080 \
	-v modbusscanner-data:/data \
	modbusscanner:local
```

Open **https://localhost:8080**. Stop the container with `Ctrl+C`; the SQLite database remains in the Docker volume. Docker Desktop must be allowed to reach the Modbus device's network, VPN, and firewall. On Windows PowerShell, use the same commands without changing the port mapping.

The published images are available as:

```bash
docker pull ghcr.io/OWNER/modbusscanner:latest
docker pull DOCKERHUB_USERNAME/modbusscanner:latest
```

Replace the placeholders with the GitHub owner and Docker Hub username.

## Desktop App (Electron)

The server also runs as a self-contained desktop app, with the same UI in a native window instead of a browser tab.

```bash
npm install
npm run electron:rebuild   # rebuild sqlite3 for Electron's Node ABI (once per Electron/Node version)
npm run electron           # launch it
```

On first launch it copies the bundled `modbus.yaml` into the app's user data directory so edits survive updates; set `MODBUS_YAML_PATH` to point it elsewhere.

Build installers with `npm run dist` (uses `electron-builder`; see the `build` key in `package.json` for per-platform icons and the GitHub Releases publish target).

Run the local checks with:

```bash
npm ci
npm run test:all
```

## SonarQube and IDE Integration

Install the **SonarQube for IDE** extension in VS Code (`SonarSource.sonarlint-vscode`). It provides local analysis while editing. For connected mode, configure the extension with the same SonarQube server used by CI and bind this workspace to the project key `fishbeef_modbusscanner`.

The GitHub Actions workflow runs the `sonarqube` job after the tests. Configure these repository Actions secrets before enabling the check:

- `SONAR_HOST_URL`: URL of the SonarQube Server, for example `https://sonarqube.example.com`
- `SONAR_TOKEN`: project analysis token with permission to execute analysis
- Repository variable `SONARQUBE_ENABLED=true`: enables the scan after a self-hosted runner with the labels `self-hosted`, `linux`, and `sonarqube` is registered.

The workflow uses the repository configuration in `sonar-project.properties`. Add the `sonarqube` check to the required status checks for `main` after its first successful run.

The SonarQube server is not required to be publicly reachable. The self-hosted runner must be able to reach it on the private network, while the runner only needs outbound HTTPS access to GitHub. Docker Hub publishing is optional and is skipped until `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` are configured.

## Protecting `main`

Configure the `main` branch in GitHub repository settings with these rules:

- Require a pull request before merging.
- Require at least one approving review and dismiss stale approvals.
- Require the `test` status check from the `CI` workflow.
- Require branches to be up to date before merging.
- Block force pushes and branch deletion.
- Enforce the rules for administrators.

GitHub rejected automatic activation for the current private repository because branch protection requires GitHub Pro or a public repository on the current plan.

## Features

- **Modbus TCP** — connects to one or more configured Modbus TCP devices
- **Persistent targets** — IP address, port, and unit ID are stored in SQLite and restored on the next start
- **All register types** — Holding Registers (4x), Input Registers (3x), Coils (0x), Discrete Inputs (1x)
- **Configurable** — multiple IP addresses with individual ports and unit IDs, plus register range and batch size
- **Live results** — register values shown as unsigned, signed, hex, and binary
- **Sanity checks** — automatic warnings for `0xFFFF`, extreme signed values, sensor overflow/underflow; optional user-defined min/max range
- **Filter & search** — filter by register number, value, or sanity status
- **CSV export** — download all results as a CSV file
- **Scan cancel** — cancel a running scan at any time

## Configuration

| Field | Default | Description |
|---|---|---|
| IP Address | *(required)* | One or more target Modbus TCP device IPs |
| Target access | checked when saved | Unreachable targets remain visible with an error and are skipped during scans |
| Port | `502` | Modbus TCP port |
| Unit ID | `1` | Modbus unit/slave ID |
| Start Register | `0` | First register address to scan |
| Count | `100` | Number of registers to read |
| Batch Size | `10` | Registers per Modbus request (max 125) |
| Min / Max Value | *(none)* | Optional sanity range for register values |

## Sanity Check Rules

| Status | Condition |
|---|---|
| ✓ OK | Value is within normal range |
| ⚠ Warning | `0xFFFF` (possible unconnected input), `0x7FFF`/`0x8000` (overflow/underflow), signed value outside ±30000, or outside user-defined range |
| ✕ Error | Register could not be read (communication error) |

## Server Port

Set the `PORT` environment variable to use a different HTTP port:

```bash
PORT=3000 npm start
```

## Scan Targets

The first start shows an empty target list, so no device is contacted implicitly. Add at least one IP address, port, and unit ID in the web UI. Targets are checked when saved and persisted in `modbus_readings.db`; all scan modes process the saved targets sequentially.

## Dashboard

The **Dashboard** tab is a Grafana-style panel grid. Everything is persisted in SQLite, so it survives reloads and restarts.

- **Dashboards & panels** are stored as JSON (`dashboards` table). Panel types: time series (line, smooth, step, area, points), stat, gauge and table. Use **+ Add panel**, or the **+** button in the YAML register table to pin a register.
- **History** is sampled by a background poller on the server (default every 10 s, configurable under *Sample every*), independent of any open browser. Panels query it through `POST /api/query` with server-side downsampling.
- **Retention:** raw readings are kept for 7 days (`raw_retention_days` setting), then rolled up to hourly avg/min/max (`readings_hourly`) and pruned.
- **Axes** auto-scale to round bounds with unit-aware labels: SI prefixes for `W`, `Wh`, `A`, `V`, `Pa`, … (`1.5 kW`), plain `°C` / `%`, and compact `K`/`M` for unit-less values. Series with different units get separate left/right axes. Min/max can be fixed per panel.
- Frontend code lives in `web/` (uPlot is vendored in `web/vendor/`, so it works offline).

## HTTPS

The server speaks HTTPS by default using an auto-generated self-signed certificate (valid for `localhost`, `127.0.0.1`, `::1`, the host name and its LAN IPs). The same port also accepts plain HTTP and redirects it to HTTPS, so `http://localhost:8080` takes you to `https://localhost:8080`.

- The certificate and key are created on first start in a `certs/` folder next to the database (override with `CERT_DIR`) and renewed automatically 30 days before expiry. In Docker they live in the `/data` volume.
- Browsers warn about self-signed certificates once; accept it (or add `certs/server.crt` to your trust store).
- `TLS=off` serves plain HTTP again, e.g. behind a TLS-terminating reverse proxy.
- The Electron app trusts the certificate for its own loopback address only.

## Your data and updates

Device IPs (scan targets), dashboards and history are user data and are never overwritten by a new version or update.

- **Desktop app:** the database lives in the per-user data folder (`~/Library/Application Support/modbusscanner` on macOS, `%APPDATA%\modbusscanner` on Windows), not in the install directory that updates replace. A database from an earlier version in the old location is copied over once on first start.
- **Backup of the IPs:** every save of the scan targets is mirrored to `<database>.targets.json` next to the database. If the database is ever missing or empty while that file exists, the targets are restored on start.
- **Guard:** the targets can't be replaced by an empty list, and `modbus.yaml` is only copied to the user folder if it doesn't exist yet.
- Docker: keep the `/data` volume; it holds the database, backup and certificate.

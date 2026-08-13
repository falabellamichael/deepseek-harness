// DeepSeek Harness — Electron desktop shell.
//
// Launches the local `dsh web` server and hosts its UI in an embedded Chromium
// window, so the harness runs as a native desktop application instead of a
// manually-started server plus a browser tab. The server process is a child of
// this process and is torn down with it.

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, shell } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3080;
const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
const HEALTH_POLL_MS = 2000;
const READY_TIMEOUT_MS = 180_000;
const ROOT_MARKER = '@deepseek-ai/dsh-root';

/**
 * True when `dir` holds the `@deepseek-ai/dsh-root` package manifest.
 */
async function hasRootMarker(dir) {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    return pkg.name === ROOT_MARKER;
  } catch {
    return false;
  }
}

/**
 * Walk up from a directory to the repository root, identified by the
 * `@deepseek-ai/dsh-root` package. Returns the absolute root path, or null.
 */
async function findRepositoryRoot(startDir) {
  let dir = startDir;
  for (let depth = 0; depth < 16; depth++) {
    if (await hasRootMarker(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const SCAN_MAX_DEPTH = 4;
const SCAN_DIR_BUDGET = 30_000;
const SCAN_PRUNE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'bin', 'obj', 'vendor',
  'AppData', 'Windows', '.cache', '.local', '.pnpm-store', '.yarn',
  'Program Files', 'Program Files (x86)', 'ProgramData', 'PerfLogs',
  'System Volume Information', '$Recycle.Bin', 'node_modules.old', 'temp',
]);

const repositoryConfigPath = () => path.join(app.getPath('userData'), 'repo-path.json');

async function readSavedRepositoryPath() {
  try {
    const parsed = JSON.parse(await readFile(repositoryConfigPath(), 'utf8'));
    return typeof parsed.path === 'string' ? parsed.path : null;
  } catch {
    return null;
  }
}

async function writeSavedRepositoryPath(dir) {
  await mkdir(path.dirname(repositoryConfigPath()), { recursive: true });
  await writeFile(repositoryConfigPath(), `${JSON.stringify({ path: dir }, null, 2)}\n`);
}

async function scanCandidateBases() {
  const bases = new Set();
  const home = os.homedir();
  if (home) bases.add(home);
  for (const letter of 'CDEFGH') {
    try {
      await readdir(`${letter}:\\`);
      bases.add(`${letter}:\\`);
    } catch {
      // Not a reachable drive; skip.
    }
  }
  return bases;
}

/**
 * Bounded depth-first scan of the user's home directory and drive roots for the
 * first `@deepseek-ai/dsh-root` marker, pruning heavyweight and build-output
 * directories so the scan stays fast even on large drives.
 */
async function findRepositoryRootInScan() {
  let visited = 0;
  for (const base of await scanCandidateBases()) {
    const stack = [{ dir: base, depth: 0 }];
    while (stack.length > 0 && visited < SCAN_DIR_BUDGET) {
      const { dir, depth } = stack.pop();
      visited += 1;
      if (await hasRootMarker(dir)) return dir;
      if (depth >= SCAN_MAX_DEPTH) continue;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !SCAN_PRUNE.has(entry.name)) {
          stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
      }
    }
  }
  return null;
}

async function pickRepository() {
  const host = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    const result = await dialog.showOpenDialog(host, {
      title: 'Select the DeepSeek Harness repository folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory'],
      defaultPath: os.homedir(),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const dir = result.filePaths[0];
    return (await hasRootMarker(dir)) ? dir : null;
  } finally {
    host.destroy();
  }
}

/**
 * Resolve the harness repository this shell will drive, per user. Order:
 * an explicit `DSH_REPO_ROOT`, the directory this app lives in (dev run and
 * repo-adjacent installs), the user's previously-confirmed path, a bounded scan
 * of the user's drives and home directory, and finally a one-time native picker
 * whose choice is remembered. The server/UI only need the repo to exist on this
 * machine — nothing is bundled with the app.
 */
async function resolveRepositoryRoot() {
  if (process.env.DSH_REPO_ROOT && (await hasRootMarker(process.env.DSH_REPO_ROOT))) {
    return path.resolve(process.env.DSH_REPO_ROOT);
  }
  const fromWalk = await findRepositoryRoot(__dirname);
  if (fromWalk) return fromWalk;
  const remembered = await readSavedRepositoryPath();
  if (remembered && (await hasRootMarker(remembered))) return remembered;
  const fromScan = await findRepositoryRootInScan();
  if (fromScan) {
    await writeSavedRepositoryPath(fromScan);
    return fromScan;
  }
  const fromDialog = await pickRepository();
  if (fromDialog) {
    await writeSavedRepositoryPath(fromDialog);
    return fromDialog;
  }
  return null;
}

/**
 * Poll a URL until it responds with HTTP 2xx or the timeout elapses.
 * Returns the URL on success, throws otherwise.
 */
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return url;
    } catch {
      // Server not up yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(`${url} never became ready within ${timeoutMs}ms`);
}

let serverProcess = null;

/**
 * Resolve how to launch the web server from a repository checkout. Prefers the
 * built CLI under plain `node` (no pnpm, no tsx); falls back to driving `dsh
 * web` through pnpm only when the built `lib/` is absent (e.g. a fresh source
 * checkout before `pnpm run build`).
 */
async function serverCommand(repoRoot) {
  const builtCli = path.join(repoRoot, 'apps', 'cli', 'lib', 'bin.js');
  try {
    await access(builtCli);
    return { bin: 'node', args: [builtCli, 'web'] };
  } catch {
    return { bin: 'pnpm', args: ['--dir', repoRoot, 'dsh', 'web'] };
  }
}

function startServer(repoRoot, port, command) {
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(command.bin, command.args, {
    cwd: repoRoot,
    env: { ...process.env },
    shell: process.platform === 'win32',
    // Own process group on POSIX so teardown can kill every descendant.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess = child;

  let log = '';
  const record = (chunk) => {
    log += chunk.toString();
    if (process.argv.includes('--dev')) {
      for (const line of log.split('\n').filter(Boolean)) {
        console.log(`[dsh-web] ${line}`);
      }
      log = '';
    }
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);

  child.on('exit', (code) => {
    console.error(`dsh web server exited with code ${String(code)}`);
  });

  return url;
}

/**
 * Tear the server process tree down. On Windows `pnpm` is a `.cmd` shim, so the
 * spawned child is a shell whose `node` descendant holds the port; kill the
 * whole tree with `taskkill /T`. On POSIX the server was detached into its own
 * process group, so killing that group reaches every descendant.
 */
async function teardownServer() {
  const child = serverProcess;
  if (!child) return;
  serverProcess = null;

  const pid = child.pid;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone; nothing to tear down.
    }
  }
}

function createWindow(url, iconPath) {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    show: false,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open external links in the default browser, never inside the harness window.
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  window.loadURL(url);
  return window;
}

async function run() {
  const smoke = process.argv.includes('--smoke');
  const dev = process.argv.includes('--dev');
  const port = Number(process.env.DSH_DESKTOP_PORT ?? DEFAULT_PORT);

  await app.whenReady();

  const iconPath = path.join(__dirname, '..', 'resources', 'icon.png');
  const repoRoot = await resolveRepositoryRoot();

  if (!repoRoot) {
    console.error('[dsh-desktop] could not locate a DeepSeek Harness repository');
    app.exit(1);
    return;
  }
  console.log(`[dsh-desktop] using repository at ${repoRoot}`);

  const command = await serverCommand(repoRoot);
  const url = startServer(repoRoot, port, command);
  try {
    await waitForServer(url, READY_TIMEOUT_MS);
  } catch (error) {
    console.error(`[dsh-desktop] ${String(error && error.message ? error.message : error)}`);
    await teardownServer();
    app.exit(1);
    return;
  }

  const window = createWindow(url, iconPath);

  if (smoke) {
    // Verification pass: load once, capture the page, then quit without
    // surfacing a window on screen.
    window.webContents.once('did-finish-load', async () => {
      try {
        const title = window.webContents.getTitle();
        const image = await window.webContents.capturePage();
        const outDir = app.isPackaged
          ? path.join(app.getPath('userData'), 'smoke')
          : path.join(__dirname, '..', 'smoke');
        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, 'smoke.png'), image.toPNG());
        console.log(`[dsh-desktop] smoke ok: ${title}`);
        await teardownServer();
        app.exit(0);
      } catch (error) {
        console.error(`[dsh-desktop] smoke failed: ${String(error)}`);
        await teardownServer();
        app.exit(1);
      }
    });
  } else {
    window.once('ready-to-show', () => {
      if (dev) window.webContents.openDevTools();
      window.show();
    });
  }
}

app.on('window-all-closed', () => {
  app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
  // Tear the server tree down before the app exits. `before-quit` needs a
  // prevent-default + re-quit so the async teardown gets a chance to run.
  if (serverProcess && !quitting) {
    event.preventDefault();
    quitting = true;
    teardownServer().finally(() => app.quit());
  }
});

run().catch((error) => {
  console.error(`[dsh-desktop] ${String(error)}`);
  app.exit(1);
});
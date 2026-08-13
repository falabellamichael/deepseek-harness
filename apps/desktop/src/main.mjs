// DeepSeek Harness — Electron desktop shell.
//
// Launches the local `dsh web` server and hosts its UI in an embedded Chromium
// window, so the harness runs as a native desktop application instead of a
// manually-started server plus a browser tab. The server process is a child of
// this process and is torn down with it.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, shell } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3080;
const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
const HEALTH_POLL_MS = 2000;
const READY_TIMEOUT_MS = 180_000;
const ROOT_MARKER = '@deepseek-ai/dsh-root';

/**
 * Walk up from a directory to the repository root, identified by the
 * `@deepseek-ai/dsh-root` package. Returns the absolute root path, or null.
 */
async function findRepositoryRoot(startDir) {
  let dir = startDir;
  for (let depth = 0; depth < 16; depth++) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      if (pkg.name === ROOT_MARKER) return dir;
    } catch {
      // Not the root; keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
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

function startServer(repoRoot, port) {
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('pnpm', ['--dir', repoRoot, 'dsh', 'web'], {
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
  const repoRoot = await findRepositoryRoot(__dirname);

  if (!repoRoot) {
    console.error('[dsh-desktop] could not locate the DeepSeek Harness repository root');
    app.exit(1);
    return;
  }

  const url = startServer(repoRoot, port);
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
        const outDir = path.join(__dirname, '..', 'smoke');
        const fs = await import('node:fs/promises');
        await fs.mkdir(outDir, { recursive: true });
        await fs.writeFile(path.join(outDir, 'smoke.png'), image.toPNG());
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
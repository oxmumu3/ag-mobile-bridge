import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';

export const LAUNCHER_APP =
  process.env.AG_ISOLATED_LAUNCHER_APP ||
  path.join(os.homedir(), 'Applications', 'Antigravity 日本出口.app');
export const MIHOMO_BIN = path.join(LAUNCHER_APP, 'Contents/Helpers/mihomo');
export const PROXY_CONFIG_SCRIPT = path.join(LAUNCHER_APP, 'Contents/Resources/ProxyConfig.rb');

function findRunningMihomoPids() {
  if (process.platform !== 'darwin') return [];
  const marker = `${path.basename(LAUNCHER_APP)}/Contents/Helpers/mihomo`;
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 2500 });
    const pids = [];
    for (const line of out.split('\n')) {
      if (!line.includes(marker)) continue;
      const m = line.trim().match(/^(\d+)\s+/);
      if (m) pids.push(m[1]);
    }
    return pids;
  } catch {
    return [];
  }
}

function getListeningLoopbackPort(pid) {
  try {
    const out = execFileSync(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'],
      { encoding: 'utf8', timeout: 2500 },
    );
    const m = out.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('Failed to allocate loopback port'));
      });
    });
  });
}

function isLocalHttpProxyUrl(val) {
  return typeof val === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(val.trim());
}

/**
 * Resolve the isolated loopback proxy for `agy acp` without altering SSRUN or macOS proxy settings.
 * Gracefully falls back to direct mode when the launcher helper is absent.
 */
export async function resolveIsolatedProxy({ allowEphemeral = true } = {}) {
  for (const pid of findRunningMihomoPids()) {
    const port = getListeningLoopbackPort(pid);
    if (port) {
      return {
        proxyUrl: `http://127.0.0.1:${port}`,
        mode: 'attached-launcher',
        pid: Number(pid),
        cleanup: async () => {},
      };
    }
  }

  const envCandidate = process.env.AG_MOBILE_UPSTREAM_PROXY
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy;

  if (isLocalHttpProxyUrl(envCandidate)) {
    return {
      proxyUrl: envCandidate.trim().replace(/\/+$/, ''),
      mode: 'env-local-proxy',
      pid: null,
      cleanup: async () => {},
    };
  }

  if (!allowEphemeral || !fs.existsSync(MIHOMO_BIN) || !fs.existsSync(PROXY_CONFIG_SCRIPT)) {
    return {
      proxyUrl: null,
      mode: 'direct',
      pid: null,
      cleanup: async () => {},
    };
  }

  const port = await allocateLoopbackPort();
  const configYaml = execFileSync('/usr/bin/ruby', [PROXY_CONFIG_SCRIPT, String(port)], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (!configYaml.trim()) {
    return { proxyUrl: null, mode: 'direct', pid: null, cleanup: async () => {} };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mobile-mihomo-'));
  fs.chmodSync(tmpDir, 0o700);
  const logPath = path.join(tmpDir, 'proxy.log');
  const logFd = fs.openSync(logPath, 'a', 0o600);

  const child = spawn(MIHOMO_BIN, ['-d', tmpDir, '-f', '/dev/stdin'], {
    stdio: ['pipe', logFd, logFd],
    detached: false,
  });
  fs.closeSync(logFd);
  child.stdin.write(configYaml);
  child.stdin.end();

  const cleanup = async () => {
    try {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 250));
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  const marker = `listening at: 127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await cleanup();
      return { proxyUrl: null, mode: 'direct', pid: null, cleanup: async () => {} };
    }
    try {
      if (fs.readFileSync(logPath, 'utf8').includes(marker)) {
        return {
          proxyUrl: `http://127.0.0.1:${port}`,
          mode: 'ephemeral-mihomo',
          pid: child.pid ?? null,
          cleanup,
        };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }

  await cleanup();
  return { proxyUrl: null, mode: 'direct', pid: null, cleanup: async () => {} };
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const DEFAULT_PORT = 58470;

function resolveLaunchAgentLabel() {
  if (process.env.AG_MOBILE_LAUNCH_LABEL) return process.env.AG_MOBILE_LAUNCH_LABEL.trim();
  try {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    if (fs.existsSync(dir)) {
      const existing = fs
        .readdirSync(dir)
        .find((name) => name === 'dev.agmobile.bridge.plist' || name.endsWith('.ag-mobile-bridge.plist'));
      if (existing) return existing.replace(/\.plist$/, '');
    }
  } catch {}
  return 'dev.agmobile.bridge';
}

export const LAUNCH_AGENT_LABEL = resolveLaunchAgentLabel();

/**
 * Resolve runtime state directory outside iCloud Drive to avoid LaunchAgent TCC prompts.
 */
export function resolveStateDir(overrideDir) {
  if (overrideDir) return path.resolve(overrideDir);
  if (process.env.AG_MOBILE_STATE_DIR) return path.resolve(process.env.AG_MOBILE_STATE_DIR);
  return path.join(os.homedir(), '.gemini', 'ag-mobile-bridge');
}

export function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {}
}

export function writeJsonAtomic(filePath, data, mode = 0o600) {
  ensurePrivateDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
}

export function generateSixDigitPin() {
  const num = crypto.randomInt(0, 1_000_000);
  return String(num).padStart(6, '0');
}

export function detectMacDisplayName() {
  if (process.env.AG_MOBILE_HOST_NAME) return process.env.AG_MOBILE_HOST_NAME.trim();
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], {
      encoding: 'utf8',
      timeout: 1500,
    }).trim();
    if (out) return out;
  } catch {}
  return os.hostname().replace(/\.local$/i, '');
}

/**
 * Load or initialize bridge config (bearerToken, hmacSecret, 6-digit PIN, port).
 */
export function loadOrCreateConfig({ stateDir, port, hostName } = {}) {
  const dir = resolveStateDir(stateDir);
  ensurePrivateDir(dir);
  const configPath = path.join(dir, 'config.json');

  let existing = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {}
  }

  let changed = false;
  const resolvedPort = Number.isInteger(port) && port > 0
    ? port
    : (Number.isInteger(existing.port) && existing.port > 0 ? existing.port : DEFAULT_PORT);

  const cfg = {
    instanceId: typeof existing.instanceId === 'string' && existing.instanceId
      ? existing.instanceId
      : crypto.randomUUID(),
    hostName: hostName || existing.hostName || detectMacDisplayName(),
    port: resolvedPort,
    bearerToken: typeof existing.bearerToken === 'string' && existing.bearerToken.length >= 32
      ? existing.bearerToken
      : crypto.randomBytes(32).toString('hex'),
    hmacSecret: typeof existing.hmacSecret === 'string' && existing.hmacSecret.length >= 32
      ? existing.hmacSecret
      : crypto.randomBytes(32).toString('hex'),
    pin6: typeof existing.pin6 === 'string' && /^\d{6}$/.test(existing.pin6)
      ? existing.pin6
      : generateSixDigitPin(),
    pinUpdatedAtMs: typeof existing.pinUpdatedAtMs === 'number' ? existing.pinUpdatedAtMs : Date.now(),
    funnelUrlOverride: typeof existing.funnelUrlOverride === 'string' ? existing.funnelUrlOverride : '',
    cloudflareTunnelToken: typeof existing.cloudflareTunnelToken === 'string' ? existing.cloudflareTunnelToken : '',
    desktopLauncherApp: typeof existing.desktopLauncherApp === 'string' ? existing.desktopLauncherApp : '',
  };

  for (const key of Object.keys(cfg)) {
    if (existing[key] !== cfg[key]) {
      changed = true;
      break;
    }
  }
  if (changed || !fs.existsSync(configPath)) {
    writeJsonAtomic(configPath, cfg, 0o600);
  }

  return { configPath, stateDir: dir, config: cfg };
}

export function rotatePin(stateDir) {
  const loaded = loadOrCreateConfig({ stateDir });
  loaded.config.pin6 = generateSixDigitPin();
  loaded.config.pinUpdatedAtMs = Date.now();
  writeJsonAtomic(loaded.configPath, loaded.config, 0o600);
  return loaded.config;
}

export function loadHandoffs(stateDir) {
  const dir = resolveStateDir(stateDir);
  const handoffsPath = path.join(dir, 'handoffs.json');
  const empty = { byDesktopId: {}, byMobileId: {} };
  if (!fs.existsSync(handoffsPath)) return { handoffsPath, data: empty };
  try {
    const parsed = JSON.parse(fs.readFileSync(handoffsPath, 'utf8'));
    return {
      handoffsPath,
      data: {
        byDesktopId: parsed?.byDesktopId && typeof parsed.byDesktopId === 'object' ? parsed.byDesktopId : {},
        byMobileId: parsed?.byMobileId && typeof parsed.byMobileId === 'object' ? parsed.byMobileId : {},
      },
    };
  } catch {
    return { handoffsPath, data: empty };
  }
}

export function saveHandoffs(stateDir, data) {
  const dir = resolveStateDir(stateDir);
  const handoffsPath = path.join(dir, 'handoffs.json');
  writeJsonAtomic(handoffsPath, data, 0o600);
  return handoffsPath;
}

let lanIpCache = { value: '', expiresAtMs: 0 };

/**
 * Pick the primary LAN IPv4 address, preferring Wi-Fi (en0) over other interfaces.
 */
export function detectPrimaryLanIPv4() {
  const now = Date.now();
  if (lanIpCache.value && now < lanIpCache.expiresAtMs) {
    return lanIpCache.value;
  }
  const nets = os.networkInterfaces();
  const preferredOrder = ['en0', 'en1', 'en2', 'en3', 'bridge0'];
  const orderedNames = [
    ...preferredOrder.filter((n) => nets[n]),
    ...Object.keys(nets).filter((n) => !preferredOrder.includes(n)),
  ];

  let resolved = '127.0.0.1';
  outer: for (const ifName of orderedNames) {
    if (/^(utun|tailscale|tun|tap)/i.test(ifName)) continue;
    for (const addr of nets[ifName] || []) {
      if (
        addr.family === 'IPv4' &&
        !addr.internal &&
        !addr.address.startsWith('169.254.') &&
        !addr.address.startsWith('198.18.') &&
        !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr.address)
      ) {
        resolved = addr.address;
        break outer;
      }
    }
  }
  lanIpCache = { value: resolved, expiresAtMs: now + 5_000 };
  return resolved;
}

function findTailscaleBinary() {
  const candidates = [
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/usr/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

let tailscaleIpCache = { value: null, expiresAtMs: 0 };

/**
 * Detect active Tailscale IPv4 (`100.64.0.0/10` CGNAT tailnet range) if Tailscale is running.
 */
export function detectTailscaleIPv4() {
  const now = Date.now();
  if (now < tailscaleIpCache.expiresAtMs) {
    return tailscaleIpCache.value;
  }

  let detected = null;
  const bin = findTailscaleBinary();
  if (bin) {
    try {
      const out = execFileSync(bin, ['ip', '-4'], { encoding: 'utf8', timeout: 1200 }).trim();
      const firstLine = out.split(/\r?\n/)[0]?.trim() || '';
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(firstLine)) {
        detected = firstLine;
      }
    } catch {}
  }

  if (!detected) {
    const nets = os.networkInterfaces();
    outer: for (const [ifName, addrs] of Object.entries(nets)) {
      if (!/^(utun|tailscale)/i.test(ifName)) continue;
      for (const addr of addrs || []) {
        if (
          addr.family === 'IPv4' &&
          !addr.internal &&
          /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(addr.address)
        ) {
          detected = addr.address;
          break outer;
        }
      }
    }
  }

  tailscaleIpCache = { value: detected, expiresAtMs: now + 10_000 };
  return detected;
}

/**
 * Verify that an existing PID belongs to an active `cloudflared` tunnel process
 * (optionally scoped to the expected local origin `targetUrl` so sibling bridges on other ports are never touched).
 */
export function isCloudflaredTunnelProcess(pid, expectedTargetUrl = '') {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err?.code === 'ESRCH' || err?.code !== 'EPERM') return false;
  }
  try {
    const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1500,
    }).trim();
    if (!cmd.includes('cloudflared')) return false;
    if (expectedTargetUrl && !cmd.includes(expectedTargetUrl)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a `cloudflared tunnel create` credentials JSON file (`AccountTag`, `TunnelID`, `TunnelSecret`)
 * into a standard base64 Cloudflare Tunnel connector token offline without requiring an API call.
 */
export function encodeCloudflareTunnelTokenFromCredFile(credFilePath) {
  const resolved = path.resolve(String(credFilePath || ''));
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const a = typeof parsed?.AccountTag === 'string' ? parsed.AccountTag.trim() : '';
  const t = typeof parsed?.TunnelID === 'string' ? parsed.TunnelID.trim() : '';
  const s = typeof parsed?.TunnelSecret === 'string' ? parsed.TunnelSecret.trim() : '';
  if (!a || !t || !s) {
    throw new Error(`Invalid cloudflared credentials JSON at ${resolved}: missing AccountTag, TunnelID, or TunnelSecret`);
  }
  return Buffer.from(JSON.stringify({ a, t, s }), 'utf8').toString('base64');
}

/**
 * Read active Quick Tunnel metadata if its backing PID is still alive.
 */
export function readActiveQuickTunnel(stateDir) {
  const dir = resolveStateDir(stateDir);
  const tunnelPath = path.join(dir, 'quick-tunnel.json');
  if (!fs.existsSync(tunnelPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(tunnelPath, 'utf8'));
    const url = typeof parsed?.url === 'string' ? parsed.url.trim().replace(/\/+$/, '') : '';
    const pid = parsed?.pid;
    if (!/^https:\/\/.+/.test(url)) return null;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err?.code === 'ESRCH' || err?.code !== 'EPERM') return null;
    }
    return url;
  } catch {
    return null;
  }
}

let tailscaleOnlyCache = { key: '', value: null, expiresAtMs: 0 };
const TAILSCALE_CACHE_TTL_MS = 10_000;

/**
 * Optionally inspect Tailscale Funnel or active Quick Tunnel when present on this Mac.
 */
export function detectTailscaleFunnelUrl(
  overrideUrl = '',
  stateDir = undefined,
  { includeQuickTunnel = true, managedQuickTunnelActive = false, liveQuickTunnelUrl = null } = {},
) {
  if (overrideUrl && /^https:\/\/.+/.test(overrideUrl.trim())) {
    return overrideUrl.trim().replace(/\/+$/, '');
  }
  if (process.env.AG_MOBILE_FUNNEL_URL && /^https:\/\/.+/.test(process.env.AG_MOBILE_FUNNEL_URL.trim())) {
    return process.env.AG_MOBILE_FUNNEL_URL.trim().replace(/\/+$/, '');
  }

  let tailscaleUrl = null;
  const bin = findTailscaleBinary();
  if (bin) {
    const now = Date.now();
    if (tailscaleOnlyCache.key === bin && now < tailscaleOnlyCache.expiresAtMs) {
      tailscaleUrl = tailscaleOnlyCache.value;
    } else {
      try {
        const out = execFileSync(bin, ['funnel', 'status', '--json'], {
          encoding: 'utf8',
          timeout: 1500,
        });
        const parsed = JSON.parse(out);
        const web = parsed?.Web || {};
        for (const hostKey of Object.keys(web)) {
          const host = hostKey.split(':')[0];
          if (host && host.includes('.ts.net')) {
            tailscaleUrl = `https://${host}`;
            break;
          }
        }
      } catch {}
      tailscaleOnlyCache = { key: bin, value: tailscaleUrl, expiresAtMs: now + TAILSCALE_CACHE_TTL_MS };
    }
  }
  if (tailscaleUrl) return tailscaleUrl;
  if (!includeQuickTunnel) return null;

  if (managedQuickTunnelActive) {
    if (typeof liveQuickTunnelUrl === 'string' && /^https:\/\/.+/.test(liveQuickTunnelUrl.trim())) {
      return liveQuickTunnelUrl.trim().replace(/\/+$/, '');
    }
    return null;
  }

  if (typeof liveQuickTunnelUrl === 'string' && /^https:\/\/.+/.test(liveQuickTunnelUrl.trim())) {
    return liveQuickTunnelUrl.trim().replace(/\/+$/, '');
  }
  return readActiveQuickTunnel(stateDir);
}

export function buildPairUri({ instanceId, hostName, lanUrl, tailscaleUrl, funnelUrl, token }) {
  const url = new URL('agmobile://pair');
  url.searchParams.set('v', '1');
  if (instanceId) url.searchParams.set('iid', instanceId);
  if (hostName) url.searchParams.set('name', hostName);
  if (lanUrl) url.searchParams.set('lan', lanUrl);
  if (tailscaleUrl) url.searchParams.set('ts', tailscaleUrl);
  if (funnelUrl) url.searchParams.set('funnel', funnelUrl);
  url.searchParams.set('token', token);
  return url.toString().replace(/\+/g, '%20');
}

export function signArtifactTicket(hmacSecret, scopePath, ttlMs = 24 * 60 * 60 * 1000, nowMs = Date.now()) {
  const bucketMs = 6 * 60 * 60 * 1000;
  const exp = ttlMs >= bucketMs
    ? Math.ceil((nowMs + ttlMs) / bucketMs) * bucketMs
    : nowMs + ttlMs;
  const scopeB64 = Buffer.from(String(scopePath), 'utf8').toString('base64url');
  const payload = `${exp}.${scopeB64}`;
  const sig = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyArtifactTicket(hmacSecret, ticket, nowMs = Date.now()) {
  if (typeof ticket !== 'string') return null;
  const parts = ticket.split('.');
  if (parts.length !== 3) return null;
  const [expStr, scopeB64, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < nowMs) return null;
  const expected = crypto.createHmac('sha256', hmacSecret).update(`${expStr}.${scopeB64}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return Buffer.from(scopeB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

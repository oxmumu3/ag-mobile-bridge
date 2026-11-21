import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {
  detectPrimaryLanIPv4,
  isCloudflaredTunnelProcess,
  readActiveQuickTunnel,
  resolveStateDir,
  writeJsonAtomic,
} from './config.mjs';
import { resolveIsolatedProxy } from './proxy.mjs';

export { readActiveQuickTunnel };

const EXCLUDED_TRYCLOUDFLARE_HOSTS = new Set(['api', 'www', 'update']);
const dohIpCache = new Map();
const DOH_CACHE_TTL_MS = 90_000;

/**
 * Locate Homebrew or system cloudflared binary without shelling out to PATH.
 */
export function findCloudflaredBinary() {
  const candidates = [
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    path.join(os.homedir(), '.local', 'bin', 'cloudflared'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function extractTryCloudflareUrl(text) {
  const matches = text.match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi) || [];
  for (const raw of matches) {
    const subMatch = raw.match(/^https:\/\/([a-z0-9-]+)\.trycloudflare\.com$/i);
    if (subMatch && !EXCLUDED_TRYCLOUDFLARE_HOSTS.has(subMatch[1].toLowerCase())) {
      return raw.toLowerCase();
    }
  }
  return null;
}

function httpsRequestOnce({
  ip,
  servername,
  hostHeader,
  path: reqPath,
  method = 'GET',
  headers = {},
  body = undefined,
  localAddress = undefined,
  timeoutMs = 5000,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    const bodyBuf = body === undefined || body === null
      ? null
      : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));

    const reqHeaders = {
      Host: hostHeader,
      ...headers,
      ...(bodyBuf ? { 'Content-Length': String(bodyBuf.length) } : {}),
    };

    const req = https.request(
      {
        host: ip,
        port: 443,
        path: reqPath,
        method,
        ...(localAddress ? { localAddress } : {}),
        ...(servername ? { servername } : {}),
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {}
          done(resolve, { status: res.statusCode || 0, headers: res.headers || {}, json, raw });
        });
        res.on('error', (err) => done(reject, err));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Direct HTTPS timeout (${timeoutMs}ms)`));
    });
    req.on('error', (err) => done(reject, err));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function httpsRequestBypassingVpn(opts) {
  const lanIp = detectPrimaryLanIPv4();
  if (lanIp) {
    try {
      return await httpsRequestOnce({ ...opts, localAddress: lanIp });
    } catch {
      // Fall through to default interface routing if physical LAN bind cannot reach target
    }
  }
  return httpsRequestOnce({ ...opts, localAddress: undefined });
}

function httpsGetJsonDirect(opts) {
  return httpsRequestBypassingVpn({ ...opts, method: 'GET' });
}

function extractIPv4Answers(dnsJson) {
  if (!dnsJson || dnsJson.Status !== 0 || !Array.isArray(dnsJson.Answer)) return [];
  const ips = [];
  for (const ans of dnsJson.Answer) {
    if (ans?.type === 1 && typeof ans?.data === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ans.data.trim())) {
      ips.push(ans.data.trim());
    }
  }
  return ips;
}

export async function resolveHostnameViaDoH(hostname) {
  const cleanHost = String(hostname || '').trim().toLowerCase();
  if (!cleanHost) return [];

  const cached = dohIpCache.get(cleanHost);
  if (cached && Date.now() - cached.atMs < DOH_CACHE_TTL_MS) {
    return cached.ips;
  }

  const providers = [
    {
      ip: '223.5.5.5',
      servername: 'dns.alidns.com',
      hostHeader: '223.5.5.5',
      path: `/resolve?name=${encodeURIComponent(cleanHost)}&type=A`,
      headers: { Accept: 'application/dns-json' },
    },
    {
      ip: '1.1.1.1',
      servername: 'cloudflare-dns.com',
      hostHeader: 'cloudflare-dns.com',
      path: `/dns-query?name=${encodeURIComponent(cleanHost)}&type=A`,
      headers: { Accept: 'application/dns-json' },
    },
  ];

  for (const p of providers) {
    try {
      const res = await httpsGetJsonDirect({ ...p, timeoutMs: 4000 });
      if (res.status === 200) {
        const ips = extractIPv4Answers(res.json);
        if (ips.length > 0) {
          dohIpCache.set(cleanHost, { ips, atMs: Date.now() });
          return ips;
        }
      }
    } catch {}
  }
  return [];
}

/**
 * Perform an HTTPS request binding to the physical LAN NIC (`localAddress`) + DoH IP first so split/corporate
 * TUN interfaces (e.g. SSRUN `utun4`) cannot blackhole `ntfy.sh` or `*.trycloudflare.com`, while preserving
 * native `fetch` for `http://127.0.0.1` loopback test servers and falling back cleanly if physical LAN fails.
 */
async function httpsRequestViaHttpConnectProxy({
  proxyUrl,
  targetUrl,
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = 6000,
}) {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  const targetPort = target.port ? Number(target.port) : 443;
  const authority = `${target.hostname}:${targetPort}`;
  const bodyBuf = body === undefined || body === null
    ? null
    : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));

  return new Promise((resolve, reject) => {
    let settled = false;
    let tlsSock = null;
    let rawSock = null;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    const connectReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: 'CONNECT',
      path: authority,
      timeout: timeoutMs,
    });

    connectReq.on('timeout', () => {
      connectReq.destroy();
      try { tlsSock?.destroy(); } catch {}
      try { rawSock?.destroy(); } catch {}
      done(reject, new Error(`Proxy CONNECT timeout (${timeoutMs}ms)`));
    });
    connectReq.on('error', (err) => done(reject, err));

    connectReq.on('connect', (connectRes, socket) => {
      rawSock = socket;
      if (connectRes.statusCode !== 200) {
        socket.destroy();
        return done(reject, new Error(`Proxy CONNECT failed (${connectRes.statusCode})`));
      }
      tlsSock = tls.connect({
        socket,
        servername: target.hostname,
        ALPNProtocols: ['http/1.1'],
      });
      tlsSock.on('error', (err) => done(reject, err));

      const reqHeaders = { ...headers };
      if (bodyBuf && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
        reqHeaders['Content-Length'] = String(bodyBuf.length);
      }
      const req = https.request({
        host: target.hostname,
        port: targetPort,
        path: `${target.pathname}${target.search}`,
        method,
        headers: reqHeaders,
        agent: false,
        createConnection: () => tlsSock,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          done(resolve, { status: res.statusCode || 0, headers: res.headers || {}, raw, json });
        });
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Proxied HTTPS timeout (${timeoutMs}ms)`));
      });
      req.on('error', (err) => done(reject, err));
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });

    connectReq.end();
  });
}

export async function fetchBypassingVpn(
  targetUrl,
  { method = 'GET', headers = {}, body = undefined, timeoutMs = 6000 } = {},
) {
  let u;
  try {
    u = new URL(targetUrl);
  } catch {
    return fetch(targetUrl, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  }

  const isLoopbackOrPlainIp = (
    u.protocol !== 'https:' ||
    u.hostname === '127.0.0.1' ||
    u.hostname === 'localhost' ||
    u.hostname === '::1' ||
    /^(\d+\.){3}\d+$/.test(u.hostname)
  );
  if (isLoopbackOrPlainIp) {
    return fetch(targetUrl, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  }

  const wrapDirectResponse = (r) => ({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: {
      get: (name) => {
        const val = r.headers?.[String(name || '').toLowerCase()];
        return Array.isArray(val) ? (val[0] ?? null) : (val ?? null);
      },
    },
    text: async () => r.raw,
    json: async () => (r.json !== null ? r.json : JSON.parse(r.raw)),
  });

  const ips = await resolveHostnameViaDoH(u.hostname);
  for (const ip of ips.slice(0, 2)) {
    try {
      const r = await httpsRequestBypassingVpn({
        ip,
        servername: u.hostname,
        hostHeader: u.host,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        body,
        timeoutMs,
      });
      return wrapDirectResponse(r);
    } catch {}
  }

  try {
    return await fetch(targetUrl, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (directErr) {
    const proxy = await resolveIsolatedProxy({ allowEphemeral: false });
    if (proxy?.proxyUrl) {
      const r = await httpsRequestViaHttpConnectProxy({
        proxyUrl: proxy.proxyUrl,
        targetUrl,
        method,
        headers,
        body,
        timeoutMs,
      });
      return wrapDirectResponse(r);
    }
    throw directErr;
  }
}

async function probeBridgeTunnelHealth(url, timeoutMs = 6000, expectedInstanceId = '') {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { healthy: false, status: 0, dnsReady: false };
  }

  const isValidHealthPayload = (json) => (
    json?.ok === true &&
    json?.service === 'ag-mobile-bridge' &&
    (!expectedInstanceId || json?.instanceId === expectedInstanceId)
  );

  const ips = await resolveHostnameViaDoH(parsed.hostname);
  if (ips.length > 0) {
    for (const ip of ips.slice(0, 2)) {
      try {
        const direct = await httpsGetJsonDirect({
          ip,
          servername: parsed.hostname,
          hostHeader: parsed.host,
          path: '/api/health',
          timeoutMs,
        });
        if (direct.status === 200 && isValidHealthPayload(direct.json)) {
          return { healthy: true, status: 200, dnsReady: true };
        }
        return { healthy: false, status: direct.status, dnsReady: true };
      } catch {}
    }
    return { healthy: false, status: 0, dnsReady: true };
  }

  // Never query system mDNSResponder for a freshly minted *.trycloudflare.com domain before DoH sees A records,
  // otherwise OS / router negative-cache NXDOMAIN will blackhole the hostname for 60s+.
  if (parsed.hostname.endsWith('.trycloudflare.com')) {
    return { healthy: false, status: 0, dnsReady: false };
  }

  const res = await fetch(`${url}/api/health`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) {
    return { healthy: false, status: res.status, dnsReady: true };
  }
  try {
    const json = await res.json();
    return { healthy: isValidHealthPayload(json), status: 200, dnsReady: true };
  } catch {
    return { healthy: false, status: 200, dnsReady: true };
  }
}

async function isLocalOriginHealthy(targetUrl, expectedInstanceId = '') {
  try {
    const base = String(targetUrl || '').replace(/\/+$/, '');
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (res.status !== 200) return false;
    const json = await res.json();
    return json?.ok === true &&
      json?.service === 'ag-mobile-bridge' &&
      (!expectedInstanceId || json?.instanceId === expectedInstanceId);
  } catch {
    return false;
  }
}

async function hasOutboundInternet() {
  try {
    const res = await httpsGetJsonDirect({
      ip: '1.1.1.1',
      servername: 'cloudflare-dns.com',
      hostHeader: 'cloudflare-dns.com',
      path: '/dns-query?name=cloudflare.com&type=A',
      headers: { Accept: 'application/dns-json' },
      timeoutMs: 3500,
    });
    if (res.status === 200) return true;
  } catch {}
  try {
    const res = await fetchBypassingVpn('https://ntfy.sh/v1/health', { timeoutMs: 4000 });
    if (res.ok) return true;
  } catch {}
  return false;
}

const MIN_RECYCLE_COOLDOWN_MS = 60_000;

/**
 * Supervise (or adopt) a user-space `cloudflared` HTTP/2 Quick Tunnel (or Named Tunnel) and persist its URL to quick-tunnel.json.
 */
export function startManagedQuickTunnel({
  targetUrl,
  stateDir,
  onUrl,
  tunnelToken,
  publicUrl,
  expectedInstanceId = '',
} = {}) {
  const resolvedToken = (
    typeof tunnelToken === 'string' && tunnelToken.trim()
      ? tunnelToken
      : (process.env.AG_MOBILE_CLOUDFLARE_TUNNEL_TOKEN || '')
  ).trim();
  const resolvedPublicUrl = (
    typeof publicUrl === 'string' && /^https:\/\/.+/.test(publicUrl.trim())
      ? publicUrl.trim().replace(/\/+$/, '')
      : ''
  );
  const useNamedTunnel = Boolean(resolvedToken && resolvedPublicUrl);

  const bin = findCloudflaredBinary();
  if (!bin) {
    return {
      getUrl: () => (useNamedTunnel ? resolvedPublicUrl : null),
      isVerified: () => false,
      stop: async () => {},
    };
  }

  const resolvedDir = resolveStateDir(stateDir);
  const tunnelPath = path.join(resolvedDir, 'quick-tunnel.json');

  let stopped = false;
  let generation = 0;
  let currentUrl = null;
  let isVerified = false;
  let urlActivatedAtMs = 0;
  let lastRecycleAtMs = 0;
  let consecutiveEdgeFailures = 0;
  let adoptedPid = null;
  let currentChild = null;
  let restartTimer = null;
  let monitorTimer = null;
  let watchdogTimer = null;
  let verifyTimer = null;
  let watchdogInFlight = false;

  const clearVerifyTimer = () => {
    if (verifyTimer) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
    }
  };

  const readTunnelRecord = () => {
    try {
      if (!fs.existsSync(tunnelPath)) return null;
      return JSON.parse(fs.readFileSync(tunnelPath, 'utf8'));
    } catch {
      return null;
    }
  };

  const clearTunnelFile = () => {
    try {
      if (fs.existsSync(tunnelPath)) fs.unlinkSync(tunnelPath);
    } catch {}
  };

  const scheduleEdgeVerification = (expectedUrl, child, expectedGen, attempt = 0) => {
    clearVerifyTimer();
    if (stopped || generation !== expectedGen || currentUrl !== expectedUrl || currentChild !== child || attempt >= 24) {
      return;
    }
    const delayMs = attempt === 0 ? 2500 : 2000;
    verifyTimer = setTimeout(async () => {
      verifyTimer = null;
      if (stopped || generation !== expectedGen || currentUrl !== expectedUrl || currentChild !== child) return;
      try {
        const probe = await probeBridgeTunnelHealth(expectedUrl, 5000, expectedInstanceId);
        if (stopped || generation !== expectedGen || currentUrl !== expectedUrl || currentChild !== child) return;
        if (probe.healthy) {
          clearVerifyTimer();
          verifyTimer = setTimeout(() => {
            verifyTimer = null;
            if (stopped || generation !== expectedGen || currentUrl !== expectedUrl || currentChild !== child) return;
            isVerified = true;
            consecutiveEdgeFailures = 0;
            try {
              onUrl?.(expectedUrl, { verified: true, generation: expectedGen });
            } catch {}
          }, 2500);
          verifyTimer.unref?.();
          return;
        }
      } catch {}
      scheduleEdgeVerification(expectedUrl, child, expectedGen, attempt + 1);
    }, delayMs);
    verifyTimer.unref?.();
  };

  const spawnChild = () => {
    if (stopped) return;
    generation += 1;
    const spawnGen = generation;
    clearVerifyTimer();
    clearTunnelFile();
    adoptedPid = null;
    isVerified = false;
    consecutiveEdgeFailures = 0;

    const baseArgs = [
      'tunnel',
      '--url',
      targetUrl,
      '--edge-ip-version',
      '4',
      '--protocol',
      'http2',
      '--no-prechecks',
      '--no-autoupdate',
    ];
    const args = useNamedTunnel ? [...baseArgs, 'run'] : baseArgs;

    const childEnv = { ...process.env };
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      delete childEnv[k];
    }
    if (useNamedTunnel) {
      childEnv.TUNNEL_TOKEN = resolvedToken;
    }

    const child = spawn(bin, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    currentChild = child;

    if (useNamedTunnel) {
      currentUrl = resolvedPublicUrl;
      urlActivatedAtMs = Date.now();
      writeJsonAtomic(
        tunnelPath,
        { url: resolvedPublicUrl, pid: child.pid, updatedAtMs: Date.now() },
        0o600,
      );
      try {
        onUrl?.(resolvedPublicUrl, { verified: false, generation: spawnGen });
      } catch {}
      scheduleEdgeVerification(resolvedPublicUrl, child, spawnGen, 0);
    }

    const inspectChunk = (chunk) => {
      if (stopped || generation !== spawnGen || currentChild !== child) return;
      const text = chunk.toString('utf8');
      if (useNamedTunnel) {
        if (!isVerified && text.includes('Registered tunnel connection')) {
          scheduleEdgeVerification(resolvedPublicUrl, child, spawnGen, 0);
        }
        return;
      }
      const found = extractTryCloudflareUrl(text);
      if (found && found !== currentUrl) {
        currentUrl = found;
        isVerified = false;
        urlActivatedAtMs = Date.now();
        consecutiveEdgeFailures = 0;
        writeJsonAtomic(
          tunnelPath,
          { url: found, pid: child.pid, updatedAtMs: Date.now() },
          0o600,
        );
        try {
          onUrl?.(found, { verified: false, generation: spawnGen });
        } catch {}
        scheduleEdgeVerification(found, child, spawnGen, 0);
      }
    };

    child.stdout?.on('data', inspectChunk);
    child.stderr?.on('data', inspectChunk);

    const scheduleRestart = () => {
      if (currentChild !== child) return;
      generation += 1;
      clearVerifyTimer();
      currentChild = null;
      currentUrl = null;
      isVerified = false;
      urlActivatedAtMs = 0;
      consecutiveEdgeFailures = 0;
      clearTunnelFile();
      if (!stopped && !restartTimer) {
        const restartDelayMs = 3000 + Math.floor(Math.random() * 1500);
        restartTimer = setTimeout(() => {
          restartTimer = null;
          spawnChild();
        }, restartDelayMs);
        restartTimer.unref?.();
      }
    };

    child.on('exit', scheduleRestart);
    child.on('error', scheduleRestart);
  };

  const triggerEdgeRecycle = () => {
    if (stopped) return;
    if (Date.now() - lastRecycleAtMs < MIN_RECYCLE_COOLDOWN_MS) return;
    lastRecycleAtMs = Date.now();
    generation += 1;
    clearVerifyTimer();
    consecutiveEdgeFailures = 0;
    isVerified = false;
    if (currentChild) {
      try {
        currentChild.kill('SIGTERM');
      } catch {}
      return;
    }
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
    if (Number.isInteger(adoptedPid) && isCloudflaredTunnelProcess(adoptedPid, targetUrl)) {
      try {
        process.kill(adoptedPid, 'SIGTERM');
      } catch {}
    }
    adoptedPid = null;
    currentUrl = null;
    urlActivatedAtMs = 0;
    spawnChild();
  };

  const checkEdgeHealth = async () => {
    if (stopped || watchdogInFlight || !currentUrl) return;
    if (Date.now() - urlActivatedAtMs <= 65_000) return;
    const checkGen = generation;
    const checkUrl = currentUrl;
    watchdogInFlight = true;
    try {
      const probe = await probeBridgeTunnelHealth(checkUrl, 6000, expectedInstanceId);
      if (stopped || generation !== checkGen || currentUrl !== checkUrl) return;
      if (probe.healthy) {
        consecutiveEdgeFailures = 0;
        isVerified = true;
        return;
      }
      const [originOk, internetOk] = await Promise.all([
        isLocalOriginHealthy(targetUrl, expectedInstanceId),
        hasOutboundInternet(),
      ]);
      if (stopped || generation !== checkGen || currentUrl !== checkUrl) return;
      if (originOk && internetOk) {
        consecutiveEdgeFailures += 1;
        if (consecutiveEdgeFailures >= 3) {
          triggerEdgeRecycle();
        }
      }
    } catch {
      if (stopped || generation !== checkGen || currentUrl !== checkUrl) return;
      const [originOk, internetOk] = await Promise.all([
        isLocalOriginHealthy(targetUrl, expectedInstanceId),
        hasOutboundInternet(),
      ]);
      if (stopped || generation !== checkGen || currentUrl !== checkUrl) return;
      if (originOk && internetOk) {
        consecutiveEdgeFailures += 1;
        if (consecutiveEdgeFailures >= 3) {
          triggerEdgeRecycle();
        }
      }
    } finally {
      watchdogInFlight = false;
    }
  };

  watchdogTimer = setInterval(() => {
    void checkEdgeHealth();
  }, 45_000);
  watchdogTimer.unref?.();

  const existingUrl = readActiveQuickTunnel(resolvedDir);
  const existingRec = readTunnelRecord();
  const matchesExpectedMode = useNamedTunnel
    ? existingUrl === resolvedPublicUrl
    : Boolean(existingUrl && existingUrl.endsWith('.trycloudflare.com'));
  const canAdopt = Boolean(
    existingUrl &&
    matchesExpectedMode &&
    isCloudflaredTunnelProcess(existingRec?.pid, targetUrl),
  );

  if (canAdopt) {
    generation += 1;
    const adoptGen = generation;
    currentUrl = existingUrl;
    adoptedPid = existingRec.pid;
    urlActivatedAtMs = typeof existingRec?.updatedAtMs === 'number' ? existingRec.updatedAtMs : Date.now();
    void probeBridgeTunnelHealth(existingUrl, 5000, expectedInstanceId)
      .then((probe) => {
        if (!stopped && generation === adoptGen && currentUrl === existingUrl && probe.healthy) {
          isVerified = true;
          try {
            onUrl?.(existingUrl, { verified: true, adopted: true, generation: adoptGen });
          } catch {}
        }
      })
      .catch(() => {});
    monitorTimer = setInterval(() => {
      if (stopped || generation !== adoptGen) return;
      const rec = readTunnelRecord();
      if (!readActiveQuickTunnel(resolvedDir) || !isCloudflaredTunnelProcess(rec?.pid, targetUrl)) {
        clearInterval(monitorTimer);
        monitorTimer = null;
        adoptedPid = null;
        currentUrl = null;
        isVerified = false;
        urlActivatedAtMs = 0;
        spawnChild();
      }
    }, 5000);
    monitorTimer.unref?.();
  } else {
    if (Number.isInteger(existingRec?.pid) && isCloudflaredTunnelProcess(existingRec.pid, targetUrl)) {
      try {
        process.kill(existingRec.pid, 'SIGTERM');
      } catch {}
    }
    spawnChild();
  }

  return {
    getUrl: () => currentUrl,
    isVerified: () => isVerified,
    stop: async ({ killTunnel = false } = {}) => {
      stopped = true;
      generation += 1;
      clearVerifyTimer();
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      if (!killTunnel) {
        currentUrl = null;
        isVerified = false;
        return;
      }

      clearTunnelFile();
      const child = currentChild;
      currentChild = null;
      currentUrl = null;
      isVerified = false;
      if (!child || child.exitCode !== null) return;

      await new Promise((resolve) => {
        const forceTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
          resolve();
        }, 1500);
        forceTimer.unref?.();

        child.once('exit', () => {
          clearTimeout(forceTimer);
          resolve();
        });
        try {
          child.kill('SIGTERM');
        } catch {
          clearTimeout(forceTimer);
          resolve();
        }
      });
    },
  };
}

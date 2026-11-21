import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { createAcpSessionManager, createHeadlessAcpSession, resolveAgyBinary, resolveAppDataDir } from './acp-hub.mjs';
import { startBonjourAdvertisement } from './bonjour.mjs';
import { startManagedQuickTunnel } from './tunnel.mjs';
import {
  detectPrimaryLanIPv4,
  detectTailscaleFunnelUrl,
  detectTailscaleIPv4,
  loadHandoffs,
  loadOrCreateConfig,
  saveHandoffs,
  signArtifactTicket,
  verifyArtifactTicket,
} from './config.mjs';
import { createDesktopSyncManager } from './desktop-sync.mjs';
import { showMacPinNotification } from './notify.mjs';
import {
  collectOverview,
  getDefaultGeminiDirs,
  getSessionDetail,
  inferArtifactKind,
  searchSessions,
  watchBrainRoots,
} from './sessions.mjs';
import { browseWorkspaceDir } from './workspaces.mjs';
import { acceptWebSocketUpgrade } from './ws-rfc6455.mjs';
import { startRendezvousPublisher } from './rendezvous.mjs';

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.swift': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/zip': '.zip',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

function sanitizeUploadFileName(rawName, mimeType = '') {
  const base = path.basename(String(rawName || '').trim())
    .replace(/[\x00-\x1f\x7f/\\:<>|?*"']/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  let safe = base || 'attachment';
  if (safe === '.' || safe === '..') safe = 'attachment';
  let ext = path.extname(safe);
  if (!ext && EXT_BY_MIME[normalizedMime]) {
    ext = EXT_BY_MIME[normalizedMime];
    safe += ext;
  }
  if (safe.length > 120) {
    const stem = safe.slice(0, Math.max(16, 120 - ext.length));
    safe = `${stem}${ext}`;
  }
  return safe;
}

function inferUploadKind(fileName, mimeType = '') {
  const m = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const ext = path.extname(fileName || '').toLowerCase();
  if (m.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.heic'].includes(ext)) return 'image';
  if (m.startsWith('video/') || ['.mp4', '.mov', '.m4v'].includes(ext)) return 'video';
  if (m === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.md' || ext === '.txt' || ext === '.log') return 'markdown';
  return 'file';
}

async function readBinaryBody(req, maxBytes = 50 * 1024 * 1024) {
  const declaredLen = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    req.resume();
    const err = new Error(`Upload exceeds maximum allowed size (${Math.round(maxBytes / (1024 * 1024))} MB).`);
    err.statusCode = 413;
    throw err;
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        const err = new Error(`Upload exceeds maximum allowed size (${Math.round(maxBytes / (1024 * 1024))} MB).`);
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJsonWithEtag(req, res, payload) {
  const body = JSON.stringify(payload);
  const etag = `"v1-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, {
      ETag: etag,
      'Cache-Control': 'private, no-cache',
    });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ETag: etag,
    'Cache-Control': 'private, no-cache',
  });
  res.end(body);
}

function detectLocalMDnsHost() {
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], {
        encoding: 'utf8',
        timeout: 1500,
      }).trim();
      const sanitized = raw.replace(/[^A-Za-z0-9-]/g, '');
      return sanitized ? `${sanitized}.local` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'linux') {
    const raw = os.hostname().replace(/\.local$/i, '').split('.')[0] || '';
    const sanitized = raw.replace(/[^A-Za-z0-9-]/g, '');
    if (sanitized && sanitized.toLowerCase() !== 'localhost') {
      return `${sanitized}.local`;
    }
  }
  return null;
}

const DENIED_FILE_PATH_SEGMENTS = [
  `${path.sep}.ssh${path.sep}`,
  `${path.sep}.gnupg${path.sep}`,
  `${path.sep}.aws${path.sep}`,
  `${path.sep}.kube${path.sep}`,
  `${path.sep}.appstoreconnect${path.sep}`,
  `${path.sep}.config${path.sep}gcloud${path.sep}`,
  `${path.sep}Library${path.sep}Keychains${path.sep}`,
];

const DENIED_FILE_NAMES = new Set([
  '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.env',
]);

const DENIED_FILE_EXTS = new Set(['.p8', '.pem', '.key', '.p12', '.mobileprovision', '.keystore']);

function resolveSafeReadableFile(rawPath, { homeDir, stateDir }) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return { error: 'Missing file path', status: 400 };
  let cleaned = rawPath.trim();
  if (cleaned.startsWith('file://')) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      return { error: 'Malformed file:// URL', status: 400 };
    }
  }
  // Strip optional #L10-L20 anchor if forwarded verbatim
  const hashIdx = cleaned.indexOf('#');
  if (hashIdx !== -1) cleaned = cleaned.slice(0, hashIdx);
  if (!path.isAbsolute(cleaned) || cleaned.includes('\0')) {
    return { error: 'Path must be an absolute file path', status: 400 };
  }
  if (!fs.existsSync(cleaned)) {
    return { error: 'File not found', status: 404 };
  }
  let realPath;
  let st;
  try {
    realPath = fs.realpathSync(cleaned);
    st = fs.statSync(realPath);
  } catch {
    return { error: 'Unable to access file', status: 404 };
  }
  if (!st.isFile()) {
    return { error: 'Target is not a regular file', status: 400 };
  }
  if (st.size > 50 * 1024 * 1024) {
    return { error: 'File exceeds 50 MB preview limit', status: 413 };
  }

  let allowed = false;
  const allowedRoots = [homeDir, stateDir].filter(Boolean);
  for (const root of allowedRoots) {
    try {
      const realRoot = fs.realpathSync(root);
      if (realPath === realRoot || realPath.startsWith(realRoot + path.sep)) {
        allowed = true;
        break;
      }
    } catch {}
  }
  if (!allowed) {
    return { error: 'File outside allowed home/state directory', status: 403 };
  }

  for (const seg of DENIED_FILE_PATH_SEGMENTS) {
    if (realPath.includes(seg)) {
      return { error: 'Sensitive directory access denied', status: 403 };
    }
  }
  const baseName = path.basename(realPath).toLowerCase();
  const ext = path.extname(baseName);
  if (DENIED_FILE_NAMES.has(baseName) || baseName.startsWith('.env.') || DENIED_FILE_EXTS.has(ext)) {
    return { error: 'Sensitive credential file access denied', status: 403 };
  }
  try {
    const bridgeCfg = fs.realpathSync(path.join(stateDir, 'config.json'));
    if (realPath === bridgeCfg) {
      return { error: 'Bridge configuration file access denied', status: 403 };
    }
  } catch {}

  return { realPath, stat: st };
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        const err = new Error('Request body too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Invalid JSON body');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function timingSafeMatch(aStr, bStr) {
  if (typeof aStr !== 'string' || typeof bStr !== 'string' || !aStr || !bStr) return false;
  const a = Buffer.from(aStr, 'utf8');
  const b = Buffer.from(bStr, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isDirectLanRequest(req) {
  const proxyHeaders = [
    'x-forwarded-for',
    'x-forwarded-host',
    'x-real-ip',
    'forwarded',
    'via',
    'tailscale-user-login',
    'tailscale-headers-info',
  ];
  for (const h of proxyHeaders) {
    if (req.headers[h]) return false;
  }

  let addr = req.socket?.remoteAddress || '';
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1' || addr === '127.0.0.1') return true;
  if (/^10\./.test(addr)) return true;
  if (/^192\.168\./.test(addr)) return true;
  if (/^169\.254\./.test(addr)) return true;
  const m172 = addr.match(/^172\.(\d+)\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (/^fd[0-9a-f]{2}:/i.test(addr) || /^fe80:/i.test(addr)) return true;
  return false;
}

function extractBearerToken(req, requestUrl) {
  const authHeader = req.headers.authorization || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const qToken = requestUrl?.searchParams?.get('token');
  return qToken ? qToken.trim() : '';
}

function parseByteRange(rangeHeader, totalSize) {
  if (!rangeHeader || typeof rangeHeader !== 'string') return null;
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) return 'invalid';
  const [, startStr, endStr] = m;
  if (!startStr && !endStr) return 'invalid';

  let start;
  let end;
  if (!startStr) {
    const suffixLen = Number(endStr);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return 'invalid';
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    end = endStr ? Number(endStr) : totalSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= totalSize || end < start) {
    return 'invalid';
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

function serveArtifactFile(req, res, filePath) {
  const st = fs.statSync(filePath);
  if (!st.isFile()) {
    sendJson(res, 404, { error: 'Artifact not found' });
    return;
  }
  const totalSize = st.size;
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
  const parsedRange = parseByteRange(req.headers.range, totalSize);

  if (parsedRange === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
    res.end();
    return;
  }

  if (parsedRange) {
    const { start, end } = parsedRange;
    const chunkLen = end - start + 1;
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': chunkLen,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=60',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': totalSize,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
  });
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Create and start the unified HTTP + WebSocket + SSE + Bonjour bridge server.
 */
export async function startBridgeServer({
  stateDir,
  port,
  host = '0.0.0.0',
  homeDir = os.homedir(),
  brainRoots,
  dbPaths,
  agyBin,
  enableBonjour = true,
  enableWatch = true,
  enableQuickTunnel = false,
  enableRendezvous = false,
  rendezvousBaseUrl = 'https://ntfy.sh',
  funnelUrlOverride,
  maxUploadBytes = 50 * 1024 * 1024,
} = {}) {
  const loaded = loadOrCreateConfig({ stateDir, port });
  const config = loaded.config;
  const resolvedStateDir = loaded.stateDir;
  const resolvedAgyBin = resolveAgyBinary(agyBin);
  const defaults = getDefaultGeminiDirs(homeDir);
  const resolvedBrainRoots = brainRoots || defaults.brainRoots;
  const resolvedDbPaths = dbPaths || defaults.dbPaths;

  let handoffs = loadHandoffs(resolvedStateDir).data;
  const sseClients = new Set();
  const wsCleanups = new Set();
  const pinFailuresByIp = new Map();

  const handoffStore = {
    getAll: () => handoffs,
    recordHandoff: ({ desktopSessionId, mobileSessionId, title, workspacePath, lastPrompt, seedContext, seedSummary }) => {
      const now = Date.now();
      const shortId = desktopSessionId.slice(0, 8);
      handoffs.byDesktopId[desktopSessionId] = {
        mobileSessionId,
        handedOffAtMs: now,
        workspacePath,
        title,
      };
      handoffs.byMobileId[mobileSessionId] = {
        sourceDesktopId: desktopSessionId,
        sourceShortId: shortId,
        handedOffAtMs: now,
        workspacePath,
        title,
        lastPrompt,
        seedContext,
        seedSummary,
        seeded: false,
      };
      saveHandoffs(resolvedStateDir, handoffs);
    },
    consumeSeedForPrompt: (mobileSessionId) => {
      const rec = handoffs.byMobileId[mobileSessionId];
      if (!rec || rec.seeded) return null;
      rec.seeded = true;
      rec.seededAtMs = Date.now();
      saveHandoffs(resolvedStateDir, handoffs);
      return rec;
    },
  };

  const signArtifactPath = (absFilePath, fileName) => {
    const scopeDir = path.dirname(absFilePath);
    const ticket = signArtifactTicket(config.hmacSecret, scopeDir);
    return `/api/artifacts/file/${encodeURIComponent(ticket)}/${encodeURIComponent(fileName || path.basename(absFilePath))}`;
  };

  const broadcastEvent = (eventName, payload) => {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const clientRes of sseClients) {
      try {
        clientRes.write(frame);
      } catch {
        sseClients.delete(clientRes);
      }
    }
  };

  let desktopSync = null;

  const acpManager = createAcpSessionManager({
    agyBin: resolvedAgyBin,
    stateDir: resolvedStateDir,
    handoffStore,
    onStateChange: (reason, meta = {}) => broadcastEvent('overview_changed', { ts: Date.now(), reason, ...meta }),
    onActivity: () => broadcastEvent('acp_activity', { ts: Date.now() }),
    onMobileTurnCompleted: ({ sessionId, workspacePath, prompt }) => {
      desktopSync?.recordMobileTurn(sessionId, { workspacePath, prompt });
    },
    onWorkerSessionExit: ({ sessionId }) => {
      desktopSync?.promoteDetachedSessionIfTracked(sessionId);
    },
  });

  desktopSync = createDesktopSyncManager({
    stateDir: resolvedStateDir,
    homeDir,
    getConfig: () => loadOrCreateConfig({ stateDir: resolvedStateDir }).config,
    getActiveWorkerSessionIds: () => acpManager.getActiveWorkerSessionIds(),
    terminateIdleWorkers: () => acpManager.terminateIdleWorkers(),
    getRunningSessions: () => {
      const ov = collectOverview({
        homeDir,
        brainRoots: resolvedBrainRoots,
        dbPaths: resolvedDbPaths,
        handoffs,
        acpStates: acpManager.getSessionStates(),
        limit: 40,
      });
      return (ov.sessions || []).filter((s) => s.status === 'running');
    },
    onChanged: (reason) => broadcastEvent('overview_changed', { ts: Date.now(), reason }),
  });

  let stopWatch = () => {};
  if (enableWatch) {
    stopWatch = watchBrainRoots(resolvedBrainRoots, () => {
      broadcastEvent('overview_changed', { ts: Date.now() });
    });
  }

  let actualPort = Number.isInteger(port) && port >= 0 ? port : config.port;
  const mDnsHostName = detectLocalMDnsHost();
  let cachedFunnelOverride = { value: config.funnelUrlOverride || '', expiresAtMs: 0 };
  let managedQuickTunnelActive = false;
  let quickTunnel = { getUrl: () => null, isVerified: () => false, stop: async () => {} };
  let rendezvous = {
    notifyChanged: () => {},
    getStatus: () => ({
      lastPublishedUrl: null,
      lastPublishedAtMs: 0,
      lastAccepted: false,
      lastReadbackVerifiedUrl: null,
      lastVerifiedSync: false,
    }),
    stop: () => {},
  };

  const hostUrls = () => {
    const lanIp = detectPrimaryLanIPv4();
    const lanUrl = `http://${lanIp}:${actualPort}`;
    const lanWsUrl = `ws://${lanIp}:${actualPort}/acp/ws`;
    const mDnsLanUrl = mDnsHostName ? `http://${mDnsHostName}:${actualPort}` : null;
    const tsIp = detectTailscaleIPv4();
    const tailscaleUrl = tsIp ? `http://${tsIp}:${actualPort}` : null;
    let latestOverride = funnelUrlOverride;
    if (latestOverride === undefined) {
      const now = Date.now();
      if (now >= cachedFunnelOverride.expiresAtMs) {
        try {
          cachedFunnelOverride = {
            value: loadOrCreateConfig({ stateDir: resolvedStateDir }).config.funnelUrlOverride || '',
            expiresAtMs: now + 5_000,
          };
        } catch {
          cachedFunnelOverride.expiresAtMs = now + 5_000;
        }
      }
      latestOverride = cachedFunnelOverride.value;
    }
    const funnelUrl = detectTailscaleFunnelUrl(latestOverride, resolvedStateDir, {
      managedQuickTunnelActive,
      liveQuickTunnelUrl: quickTunnel.getUrl?.() || null,
    });
    const funnelWsUrl = funnelUrl ? funnelUrl.replace(/^https:/, 'wss:') + '/acp/ws' : null;
    return { lanIp, lanUrl, lanWsUrl, mDnsLanUrl, tailscaleUrl, funnelUrl, funnelWsUrl };
  };

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = requestUrl.pathname;

    try {
      // 1. Public health / capability route (+ optional HMAC proof-of-possession challenge)
      if (req.method === 'GET' && (pathname === '/' || pathname === '/api/health')) {
        const urls = hostUrls();
        const rStatus = rendezvous.getStatus?.() || {};
        const normFunnel = urls.funnelUrl ? urls.funnelUrl.trim().replace(/\/+$/, '') : '';
        const tunnelVerified = Boolean(urls.funnelUrl && quickTunnel.isVerified?.());
        const rendezvousAccepted = Boolean(normFunnel && rStatus.lastAccepted && rStatus.lastPublishedUrl === normFunnel);
        const rendezvousSynced = Boolean(normFunnel && rStatus.lastVerifiedSync && rStatus.lastReadbackVerifiedUrl === normFunnel);
        const challenge = (requestUrl.searchParams.get('challenge') || '').trim();
        let authProof;
        if (/^[0-9a-fA-F]{16,64}$/.test(challenge)) {
          authProof = crypto
            .createHmac('sha256', Buffer.from(config.bearerToken, 'utf8'))
            .update(`ag-health-v1:${challenge}:${config.instanceId}`)
            .digest('hex');
        }
        return sendJson(res, 200, {
          ok: true,
          service: 'ag-mobile-bridge',
          version: '0.3.0',
          platform: process.platform,
          instanceId: config.instanceId,
          hostName: config.hostName,
          port: actualPort,
          lanUrl: urls.lanUrl,
          lanWsUrl: urls.lanWsUrl,
          mDnsLanUrl: urls.mDnsLanUrl,
          tailscaleUrl: urls.tailscaleUrl,
          funnelUrl: urls.funnelUrl,
          funnelWsUrl: urls.funnelWsUrl,
          tunnelVerified,
          rendezvousAccepted,
          rendezvousSynced,
          ...(authProof ? { authProof } : {}),
          acpReady: fs.existsSync(resolvedAgyBin) || resolvedAgyBin === 'agy',
          ...acpManager.getRuntimeStats(),
        });
      }

      // 2. Same Wi-Fi LAN-only PIN notification request
      if (req.method === 'POST' && pathname === '/api/pair/request-pin') {
        if (!isDirectLanRequest(req)) {
          return sendJson(res, 403, { error: 'LAN_PAIR_ONLY', message: '6-digit PIN pairing is restricted to direct local Wi-Fi connections.' });
        }
        showMacPinNotification(config.pin6, config.hostName);
        return sendJson(res, 200, { ok: true, hostName: config.hostName });
      }

      // 3. Same Wi-Fi LAN-only 6-digit PIN verification
      if (req.method === 'POST' && pathname === '/api/pair/pin') {
        if (!isDirectLanRequest(req)) {
          return sendJson(res, 403, { error: 'LAN_PAIR_ONLY', message: '6-digit PIN pairing is restricted to direct local Wi-Fi connections.' });
        }
        const ip = req.socket?.remoteAddress || 'unknown';
        const now = Date.now();
        const failure = pinFailuresByIp.get(ip);
        if (failure && failure.resetAtMs > now && failure.count >= 5) {
          return sendJson(res, 429, { error: 'TOO_MANY_ATTEMPTS', message: 'Too many incorrect PIN attempts. Wait 60 seconds or scan Terminal QR code.' });
        }

        const body = await readJsonBody(req);
        const submitted = String(body?.pin ?? '').trim();
        if (!/^\d{6}$/.test(submitted) || !timingSafeMatch(submitted, config.pin6)) {
          const nextCount = (!failure || failure.resetAtMs <= now) ? 1 : failure.count + 1;
          pinFailuresByIp.set(ip, { count: nextCount, resetAtMs: now + 60_000 });
          return sendJson(res, 401, { error: 'INVALID_PIN', message: 'Incorrect 6-digit pairing PIN.' });
        }

        pinFailuresByIp.delete(ip);
        const urls = hostUrls();
        return sendJson(res, 200, {
          ok: true,
          instanceId: config.instanceId,
          hostName: config.hostName,
          lanUrl: urls.lanUrl,
          lanWsUrl: urls.lanWsUrl,
          mDnsLanUrl: urls.mDnsLanUrl,
          tailscaleUrl: urls.tailscaleUrl,
          funnelUrl: urls.funnelUrl,
          funnelWsUrl: urls.funnelWsUrl,
          token: config.bearerToken,
        });
      }

      // 4. Signed HMAC artifact streaming (supports byte Range for AVPlayer & relative assets for WKWebView)
      if (req.method === 'GET' && pathname.startsWith('/api/artifacts/file/')) {
        const rest = pathname.slice('/api/artifacts/file/'.length);
        const slashIdx = rest.indexOf('/');
        if (slashIdx === -1) {
          return sendJson(res, 400, { error: 'Malformed artifact path' });
        }
        const ticket = decodeURIComponent(rest.slice(0, slashIdx));
        const relPath = decodeURIComponent(rest.slice(slashIdx + 1));
        if (!relPath || relPath.includes('\0')) {
          return sendJson(res, 400, { error: 'Invalid artifact filename' });
        }

        const scopeDir = verifyArtifactTicket(config.hmacSecret, ticket);
        if (!scopeDir || !fs.existsSync(scopeDir)) {
          return sendJson(res, 403, { error: 'Artifact ticket invalid or expired' });
        }

        const realScope = fs.realpathSync(scopeDir);
        const candidate = path.resolve(realScope, relPath);
        if (!fs.existsSync(candidate)) {
          return sendJson(res, 404, { error: 'Artifact file not found' });
        }
        const realCandidate = fs.realpathSync(candidate);
        if (realCandidate !== realScope && !realCandidate.startsWith(realScope + path.sep)) {
          return sendJson(res, 403, { error: 'Path traversal forbidden' });
        }
        return serveArtifactFile(req, res, realCandidate);
      }

      // All remaining endpoints require Bearer authentication
      const bearer = extractBearerToken(req, requestUrl);
      if (!timingSafeMatch(bearer, config.bearerToken)) {
        return sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Missing or invalid Bearer token.' });
      }

      // 4b. Mobile file & image upload (POST /api/uploads?filename=...&mimeType=...&sessionId=...)
      if (req.method === 'POST' && pathname === '/api/uploads') {
        const rawName = requestUrl.searchParams.get('filename') || 'attachment';
        const rawMime = requestUrl.searchParams.get('mimeType') || req.headers['x-upload-mime-type'] || '';
        const rawSessionId = (requestUrl.searchParams.get('sessionId') || '').trim();
        const safeScope = /^[A-Za-z0-9_-]{1,80}$/.test(rawSessionId) ? rawSessionId : 'shared';

        const data = await readBinaryBody(req, maxUploadBytes);
        if (!data || data.length === 0) {
          return sendJson(res, 400, { error: 'EMPTY_UPLOAD', message: 'Uploaded file cannot be empty.' });
        }

        const displayName = sanitizeUploadFileName(rawName, String(rawMime));
        const ext = path.extname(displayName).toLowerCase();
        const resolvedMime = String(rawMime || MIME_BY_EXT[ext] || 'application/octet-stream')
          .split(';')[0]
          .trim()
          .toLowerCase();
        const uploadDir = path.join(resolvedStateDir, 'uploads', safeScope);
        fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });

        const randHex = crypto.randomBytes(3).toString('hex');
        const diskFileName = `${Date.now()}_${randHex}_${displayName}`;
        const absFilePath = path.join(uploadDir, diskFileName);
        fs.writeFileSync(absFilePath, data, { mode: 0o600 });

        const fileUri = pathToFileURL(absFilePath).href;
        const previewPath = signArtifactPath(absFilePath, diskFileName);

        return sendJson(res, 200, {
          ok: true,
          upload: {
            name: displayName,
            kind: inferUploadKind(displayName, resolvedMime),
            mimeType: resolvedMime,
            sizeBytes: data.length,
            macPath: absFilePath,
            fileUri,
            previewPath,
          },
        });
      }

      // 4c. Sign a readable workspace/home file for iOS inline `file://` preview (POST /api/files/sign)
      if (req.method === 'POST' && pathname === '/api/files/sign') {
        const body = await readJsonBody(req);
        const resolved = resolveSafeReadableFile(body?.path || '', { homeDir, stateDir: resolvedStateDir });
        if (resolved.error) {
          return sendJson(res, resolved.status, { error: 'FILE_PREVIEW_DENIED', message: resolved.error });
        }
        const fileName = path.basename(resolved.realPath);
        const previewPath = signArtifactPath(resolved.realPath, fileName);
        return sendJson(res, 200, {
          ok: true,
          artifact: {
            name: fileName,
            kind: inferArtifactKind(fileName),
            sizeBytes: resolved.stat.size,
            mtimeMs: Math.round(resolved.stat.mtimeMs),
            previewPath,
          },
        });
      }

      // 4d. Full-text search across recent sessions (GET /api/sessions/search?q=...&limit=20)
      if (req.method === 'GET' && pathname === '/api/sessions/search') {
        const q = requestUrl.searchParams.get('q') || '';
        const limit = Number(requestUrl.searchParams.get('limit') || 20);
        const hits = searchSessions({
          homeDir,
          brainRoots: resolvedBrainRoots,
          dbPaths: resolvedDbPaths,
          query: q,
          limit: Number.isFinite(limit) ? limit : 20,
        });
        return sendJson(res, 200, { ok: true, query: q, hits });
      }

      // 4e. Desktop Sync & Safe Reload (GET /api/desktop/status, POST /api/desktop/reload, /restore, /settings)
      if (req.method === 'GET' && pathname === '/api/desktop/status') {
        return sendJson(res, 200, { ok: true, desktopSync: desktopSync.evaluateSyncStatus() });
      }
      if (req.method === 'POST' && pathname === '/api/desktop/reload') {
        const body = await readJsonBody(req);
        const result = await desktopSync.reloadDesktopSafely({ force: Boolean(body?.force) });
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && pathname === '/api/desktop/restore') {
        const body = await readJsonBody(req);
        const result = desktopSync.restoreBackupToDesktop(body?.sessionId || '');
        return sendJson(res, result.ok ? 200 : 404, result);
      }
      if (req.method === 'POST' && pathname === '/api/desktop/settings') {
        const body = await readJsonBody(req);
        const result = desktopSync.setAutoReloadWhenLocked(Boolean(body?.autoReloadWhenLocked));
        return sendJson(res, 200, result);
      }

      // 5. Overview (hosts + workspaces + unified desktop/mobile sessions)
      if (req.method === 'GET' && pathname === '/api/overview') {
        const urls = hostUrls();
        const limit = Number(requestUrl.searchParams.get('limit') || 60);
        const rawOverview = collectOverview({
          homeDir,
          brainRoots: resolvedBrainRoots,
          dbPaths: resolvedDbPaths,
          handoffs,
          acpStates: acpManager.getSessionStates(),
          signArtifactPath,
          limit: Number.isFinite(limit) ? limit : 60,
        });
        const overview = desktopSync.annotateOverview(rawOverview);
        return sendJsonWithEtag(req, res, {
          host: {
            instanceId: config.instanceId,
            hostName: config.hostName,
            port: actualPort,
            platform: process.platform,
            lanUrl: urls.lanUrl,
            mDnsLanUrl: urls.mDnsLanUrl,
            tailscaleUrl: urls.tailscaleUrl,
            funnelUrl: urls.funnelUrl,
          },
          workspaces: overview.workspaces,
          sessions: overview.sessions,
          totalCount: overview.totalCount,
          desktopSync: overview.desktopSync,
        });
      }

      // 6. Browse Mac directories for Workspace Picker
      if (req.method === 'GET' && pathname === '/api/workspaces/browse') {
        const target = requestUrl.searchParams.get('path') || '';
        const listing = browseWorkspaceDir(target, { homeDir });
        return sendJson(res, 200, listing);
      }

      // 7. Live SSE event stream
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);
        sseClients.add(res);
        res.on('error', () => {
          sseClients.delete(res);
        });
        req.socket?.on('error', () => {});
        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      // 8. Session detail (GET /api/sessions/:id)
      const sessionDetailMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === 'GET' && sessionDetailMatch) {
        const sessionId = decodeURIComponent(sessionDetailMatch[1]);
        const detail = getSessionDetail(sessionId, {
          homeDir,
          brainRoots: resolvedBrainRoots,
          dbPaths: resolvedDbPaths,
          handoffs,
          acpStates: acpManager.getSessionStates(),
          signArtifactPath,
        });
        if (!detail) {
          return sendJson(res, 404, { error: 'SESSION_NOT_FOUND', message: `Session ${sessionId} not found.` });
        }
        return sendJsonWithEtag(req, res, desktopSync.annotateSessionDetail(detail));
      }

      // 9. Desktop -> Mobile Handoff (POST /api/sessions/:id/handoff)
      const handoffMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/handoff$/);
      if (req.method === 'POST' && handoffMatch) {
        const desktopSessionId = decodeURIComponent(handoffMatch[1]);
        const existingHandoff = handoffs.byDesktopId[desktopSessionId];
        if (existingHandoff?.mobileSessionId) {
          const existingDetail = getSessionDetail(existingHandoff.mobileSessionId, {
            homeDir,
            brainRoots: resolvedBrainRoots,
            dbPaths: resolvedDbPaths,
            handoffs,
            acpStates: acpManager.getSessionStates(),
            signArtifactPath,
          });
          return sendJson(res, 200, {
            ok: true,
            reused: true,
            mobileSessionId: existingHandoff.mobileSessionId,
            workspacePath: existingHandoff.workspacePath,
            session: existingDetail,
          });
        }

        const desktopDetail = getSessionDetail(desktopSessionId, {
          homeDir,
          brainRoots: resolvedBrainRoots,
          dbPaths: resolvedDbPaths,
          handoffs,
          acpStates: acpManager.getSessionStates(),
          signArtifactPath,
        });
        if (!desktopDetail) {
          return sendJson(res, 404, { error: 'SESSION_NOT_FOUND', message: `Desktop session ${desktopSessionId} not found.` });
        }

        const targetCwd = desktopDetail.workspacePath || homeDir;
        const created = await createHeadlessAcpSession({
          cwd: targetCwd,
          agyBin: resolvedAgyBin,
        });

        const seedContext = (desktopDetail.lastReplyRaw || desktopDetail.summary || '').slice(0, 1800);
        const seedSummary = desktopDetail.summary || '';
        handoffStore.recordHandoff({
          desktopSessionId,
          mobileSessionId: created.sessionId,
          title: desktopDetail.title,
          workspacePath: targetCwd,
          lastPrompt: desktopDetail.lastPrompt || desktopDetail.firstPrompt,
          seedContext,
          seedSummary,
        });

        const mobileSession = getSessionDetail(created.sessionId, {
          homeDir,
          brainRoots: resolvedBrainRoots,
          dbPaths: resolvedDbPaths,
          handoffs,
          acpStates: acpManager.getSessionStates(),
          signArtifactPath,
        });

        broadcastEvent('overview_changed', { ts: Date.now(), reason: 'handoff', mobileSessionId: created.sessionId });

        return sendJson(res, 200, {
          ok: true,
          reused: false,
          mobileSessionId: created.sessionId,
          workspacePath: targetCwd,
          handoffSource: {
            desktopId: desktopSessionId,
            shortId: desktopSessionId.slice(0, 8),
            title: desktopDetail.title,
          },
          session: mobileSession,
        });
      }

      // 10. Share session summary to WeChat via dsh-wechat (POST /api/sessions/:id/share-wechat)
      const wechatMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/share-wechat$/);
      if (req.method === 'POST' && wechatMatch) {
        const sessionId = decodeURIComponent(wechatMatch[1]);
        const detail = getSessionDetail(sessionId, {
          homeDir,
          brainRoots: resolvedBrainRoots,
          dbPaths: resolvedDbPaths,
          handoffs,
          acpStates: acpManager.getSessionStates(),
          signArtifactPath,
        });
        if (!detail) {
          return sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });
        }
        const dshWechatBin = path.join(os.homedir(), '.local', 'bin', 'dsh-wechat');
        if (!fs.existsSync(dshWechatBin)) {
          return sendJson(res, 501, { error: 'WECHAT_UNAVAILABLE', message: 'dsh-wechat binary not installed on this Mac.' });
        }
        const msgText = `[${detail.title}] (${detail.shortId})\n${detail.summary}`;
        await new Promise((resolve, reject) => {
          execFile(dshWechatBin, ['send', msgText], { timeout: 10000 }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      const code = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return sendJson(res, code, { error: err?.message || 'Internal Server Error' });
    }
  });

  // WebSocket upgrade for /acp/ws -> agy acp stdio hub
  server.on('upgrade', (req, socket, head) => {
    const swallowUpgradeErr = () => {};
    socket.on('error', swallowUpgradeErr);

    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (requestUrl.pathname !== '/acp/ws') {
      try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch {}
      socket.destroy();
      return;
    }

    const token = extractBearerToken(req, requestUrl);
    if (!timingSafeMatch(token, config.bearerToken)) {
      try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch {}
      socket.destroy();
      return;
    }

    const peer = acceptWebSocketUpgrade(req, socket, head);
    socket.removeListener('error', swallowUpgradeErr);
    if (!peer) return;

    const surface = requestUrl.searchParams.get('surface') || 'desktop';
    const appDataDir = resolveAppDataDir(surface);

    const detach = acpManager.attachPeer(peer, { appDataDir });
    const cleanup = () => {
      detach();
      if (!peer.closed) peer.close(1001, 'Server shutting down');
    };
    wsCleanups.add(cleanup);
    peer.on('close', () => wsCleanups.delete(cleanup));
  });

  const keepaliveTimer = setInterval(() => {
    for (const clientRes of sseClients) {
      try {
        clientRes.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        sseClients.delete(clientRes);
      }
    }
  }, 15_000);
  keepaliveTimer.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(actualPort, host, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        actualPort = addr.port;
      }
      resolve();
    });
  });

  let bonjour = enableBonjour
    ? startBonjourAdvertisement({
      hostName: config.hostName,
      port: actualPort,
      instanceId: config.instanceId,
    })
    : { stop: () => {} };

  if (enableRendezvous) {
    rendezvous = startRendezvousPublisher({
      bearerToken: config.bearerToken,
      baseUrl: rendezvousBaseUrl,
      getPayload: () => {
        const urls = hostUrls();
        if (!urls.funnelUrl) return null;
        return {
          funnelUrl: urls.funnelUrl,
          lanUrl: urls.lanUrl,
          ...(urls.tailscaleUrl ? { tailscaleUrl: urls.tailscaleUrl } : {}),
          hostName: config.hostName,
          instanceId: config.instanceId,
          updatedAtMs: Date.now(),
        };
      },
    });
  }

  let lastObservedLanUrl = hostUrls().lanUrl;
  const lanWatchTimer = setInterval(() => {
    const nextLanUrl = hostUrls().lanUrl;
    if (nextLanUrl && nextLanUrl !== lastObservedLanUrl) {
      lastObservedLanUrl = nextLanUrl;
      if (enableBonjour) {
        bonjour.stop();
        bonjour = startBonjourAdvertisement({
          hostName: config.hostName,
          port: actualPort,
          instanceId: config.instanceId,
        });
      }
      rendezvous.notifyChanged();
    }
  }, 15_000);
  lanWatchTimer.unref?.();

  let unverifiedPublishFallbackTimer = null;
  const clearUnverifiedFallback = () => {
    if (unverifiedPublishFallbackTimer) {
      clearTimeout(unverifiedPublishFallbackTimer);
      unverifiedPublishFallbackTimer = null;
    }
  };

  const handleTunnelUrlEvent = (url, meta = {}) => {
    const tunnelLabel = String(url || '').endsWith('.trycloudflare.com') ? 'Quick Tunnel' : 'Named Tunnel';
    if (meta?.verified) {
      clearUnverifiedFallback();
      console.log(`[ag-mobile-bridge] ${tunnelLabel} verified & live: ${url}`);
      broadcastEvent('overview_changed', { ts: Date.now(), reason: 'tunnel_ready' });
      rendezvous.notifyChanged();
      return;
    }
    console.log(`[ag-mobile-bridge] ${tunnelLabel} allocated (verifying DNS & edge): ${url}`);
    clearUnverifiedFallback();
    unverifiedPublishFallbackTimer = setTimeout(() => {
      unverifiedPublishFallbackTimer = null;
      if (quickTunnel.getUrl?.() === url) {
        rendezvous.notifyChanged();
      }
    }, 16_000);
    unverifiedPublishFallbackTimer.unref?.();
  };

  const effectivePublicUrl = funnelUrlOverride ?? config.funnelUrlOverride;
  if (
    enableQuickTunnel &&
    !detectTailscaleFunnelUrl(effectivePublicUrl, resolvedStateDir, {
      includeQuickTunnel: false,
    })
  ) {
    managedQuickTunnelActive = true;
    quickTunnel = startManagedQuickTunnel({
      targetUrl: `http://127.0.0.1:${actualPort}`,
      stateDir: resolvedStateDir,
      tunnelToken: config.cloudflareTunnelToken,
      publicUrl: effectivePublicUrl,
      expectedInstanceId: config.instanceId,
      onUrl: handleTunnelUrlEvent,
    });
  } else if (enableQuickTunnel && (config.cloudflareTunnelToken || process.env.AG_MOBILE_CLOUDFLARE_TUNNEL_TOKEN) && effectivePublicUrl) {
    managedQuickTunnelActive = true;
    quickTunnel = startManagedQuickTunnel({
      targetUrl: `http://127.0.0.1:${actualPort}`,
      stateDir: resolvedStateDir,
      tunnelToken: config.cloudflareTunnelToken,
      publicUrl: effectivePublicUrl,
      expectedInstanceId: config.instanceId,
      onUrl: handleTunnelUrlEvent,
    });
  }

  const initialFunnelUrl = hostUrls().funnelUrl;
  if (initialFunnelUrl && (!initialFunnelUrl.endsWith('.trycloudflare.com') || !enableQuickTunnel)) {
    rendezvous.notifyChanged();
  } else if (initialFunnelUrl) {
    unverifiedPublishFallbackTimer = setTimeout(() => {
      unverifiedPublishFallbackTimer = null;
      if (hostUrls().funnelUrl) {
        rendezvous.notifyChanged();
      }
    }, 10_000);
    unverifiedPublishFallbackTimer.unref?.();
  }

  const stop = async () => {
    clearInterval(keepaliveTimer);
    clearInterval(lanWatchTimer);
    clearUnverifiedFallback();
    stopWatch();
    bonjour.stop();
    rendezvous.stop();
    await quickTunnel.stop();
    for (const clientRes of sseClients) {
      try { clientRes.end(); } catch {}
    }
    sseClients.clear();
    for (const fn of Array.from(wsCleanups)) {
      await fn();
    }
    await acpManager.shutdown();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  };

  return {
    server,
    port: actualPort,
    stateDir: resolvedStateDir,
    config,
    hostUrls,
    stop,
  };
}

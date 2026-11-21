import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensurePrivateDir, resolveStateDir, writeJsonAtomic } from './config.mjs';
import { showMacNotification } from './notify.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISK_SAVER_KEY = Buffer.from('safeCodeiumworldKeYsecretBalloon', 'utf8');

function safeRealpath(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function decodeFileUriToPath(uri) {
  const raw = String(uri || '').trim();
  if (!raw || !raw.startsWith('file://')) return '';
  try {
    return fileURLToPath(raw);
  } catch {
    const stripped = raw.replace(/^file:\/\//i, '');
    try {
      return decodeURIComponent(stripped);
    } catch {
      return stripped;
    }
  }
}

function collectProjectResourceUris(projectObj) {
  const resources = projectObj?.projectResources?.resources;
  if (!Array.isArray(resources)) return [];
  const uris = [];
  for (const res of resources) {
    if (res?.folderUri) uris.push(res.folderUri);
    if (res?.gitFolder?.folderUri) uris.push(res.gitFolder.folderUri);
  }
  return uris;
}

/**
 * Match a workspace directory against Desktop's ~/.gemini/config/projects/*.json registry.
 */
export function resolveDesktopProjectForCwd(
  cwd,
  { homeDir = os.homedir(), projectsDir } = {},
) {
  if (!cwd) {
    return { matched: false, projectId: '', projectName: '' };
  }
  const resolvedProjectsDir = projectsDir || path.join(homeDir, '.gemini', 'config', 'projects');
  const normalizedCwd = safeRealpath(cwd);
  if (!fs.existsSync(resolvedProjectsDir)) {
    return { matched: false, projectId: '', projectName: path.basename(normalizedCwd) };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(resolvedProjectsDir, { withFileTypes: true });
  } catch {
    return { matched: false, projectId: '', projectName: path.basename(normalizedCwd) };
  }

  const matches = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const filePath = path.join(resolvedProjectsDir, ent.name);
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.id === 'default-cli-project' || parsed.sidecar) continue;

    const projectId = String(parsed.id || ent.name.replace(/\.json$/i, '')).trim();
    if (!projectId) continue;

    let fileTimeMs = 0;
    try {
      const st = fs.statSync(filePath);
      fileTimeMs = st.birthtimeMs || st.mtimeMs || 0;
    } catch {}

    const isDesktopNative =
      typeof parsed.isWorkspaceOnly === 'boolean' ||
      Boolean(parsed.permissionGrants?.v2Migrated);

    for (const uri of collectProjectResourceUris(parsed)) {
      const rawPath = decodeFileUriToPath(uri);
      if (!rawPath) continue;
      const resPath = safeRealpath(rawPath);
      const exact = normalizedCwd === resPath;
      const nested = normalizedCwd.startsWith(
        resPath.endsWith(path.sep) ? resPath : resPath + path.sep,
      );
      if (!exact && !nested) continue;
      matches.push({
        id: projectId,
        name: String(parsed.name || path.basename(resPath)),
        resPath,
        isDesktopNative,
        fileTimeMs,
      });
    }
  }

  if (matches.length === 0) {
    return { matched: false, projectId: '', projectName: path.basename(normalizedCwd) };
  }

  matches.sort((a, b) => {
    if (b.resPath.length !== a.resPath.length) return b.resPath.length - a.resPath.length;
    if (a.isDesktopNative !== b.isDesktopNative) return a.isDesktopNative ? -1 : 1;
    if (a.fileTimeMs !== b.fileTimeMs) return a.fileTimeMs - b.fileTimeMs;
    return a.id.localeCompare(b.id);
  });

  return {
    matched: true,
    projectId: matches[0].id,
    projectName: matches[0].name,
  };
}

/**
 * Resolve the preferred macOS launcher .app bundle for reopening Antigravity Desktop
 * (honoring isolated per-app proxy wrapper bundles in ~/Applications when present).
 */
export function resolveDesktopLauncherApp({ overrideApp = '', homeDir = os.homedir() } = {}) {
  if (process.platform !== 'darwin') {
    return { supported: false, appPath: '', appName: '', isCustomLauncher: false };
  }

  const candidates = [];
  if (typeof overrideApp === 'string' && overrideApp.trim()) {
    candidates.push(overrideApp.trim());
  }
  if (process.env.AG_ISOLATED_LAUNCHER_APP) {
    candidates.push(process.env.AG_ISOLATED_LAUNCHER_APP.trim());
  }

  const userAppsDir = path.join(homeDir, 'Applications');
  if (fs.existsSync(userAppsDir)) {
    try {
      const entries = fs.readdirSync(userAppsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || !ent.name.endsWith('.app')) continue;
        const fullPath = path.join(userAppsDir, ent.name);
        if (fs.existsSync(path.join(fullPath, 'Contents', 'Helpers', 'mihomo'))) {
          candidates.push(fullPath);
        }
      }
      for (const ent of entries) {
        if (!ent.isDirectory() || !ent.name.endsWith('.app')) continue;
        if (/^antigravity/i.test(ent.name) && ent.name !== 'Antigravity.app') {
          candidates.push(path.join(userAppsDir, ent.name));
        }
      }
    } catch {}
  }

  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) {
      const appName = path.basename(cand, '.app');
      return {
        supported: true,
        appPath: cand,
        appName,
        isCustomLauncher: cand !== '/Applications/Antigravity.app',
      };
    }
  }

  const standardApp = '/Applications/Antigravity.app';
  if (fs.existsSync(standardApp)) {
    return {
      supported: true,
      appPath: standardApp,
      appName: 'Antigravity',
      isCustomLauncher: false,
    };
  }

  return { supported: false, appPath: '', appName: '', isCustomLauncher: false };
}

let desktopProcCache = { atMs: 0, value: null };

/**
 * Inspect whether macOS Antigravity.app (and its hub language_server) is currently running
 * and when it started (`startedAtMs`).
 */
export function detectRunningDesktopApp({ forceFresh = false } = {}) {
  if (process.platform !== 'darwin') {
    return { supported: false, running: false, pid: null, hubPid: null, startedAtMs: 0 };
  }
  const now = Date.now();
  if (!forceFresh && desktopProcCache.value && now - desktopProcCache.atMs < 2_000) {
    return desktopProcCache.value;
  }

  let mainPid = null;
  let hubPid = null;
  let startedAtMs = 0;

  try {
    const out = execFileSync('/bin/ps', ['-axo', 'pid=,lstart=,command='], {
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: 2500,
    });
    const lineRe = /^(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/;
    for (const rawLine of out.split('\n')) {
      const m = rawLine.trim().match(lineRe);
      if (!m) continue;
      const pid = Number(m[1]);
      const lstart = m[2];
      const cmd = m[3];
      if (
        cmd.includes('/Antigravity.app/Contents/MacOS/Antigravity') &&
        !cmd.includes('--type=') &&
        !cmd.includes('Helper')
      ) {
        mainPid = pid;
        const parsed = Date.parse(lstart);
        if (Number.isFinite(parsed) && parsed > 0) {
          startedAtMs = startedAtMs ? Math.min(startedAtMs, parsed) : parsed;
        }
      } else if (
        cmd.includes('/Antigravity.app/Contents/Resources/bin/language_server') &&
        cmd.includes('--subclient_type hub')
      ) {
        hubPid = pid;
        const parsed = Date.parse(lstart);
        if (!startedAtMs && Number.isFinite(parsed) && parsed > 0) {
          startedAtMs = parsed;
        }
      }
    }
  } catch {}

  const value = {
    supported: true,
    running: Boolean(mainPid || hubPid),
    pid: mainPid,
    hubPid,
    startedAtMs,
  };
  desktopProcCache = { atMs: now, value };
  return value;
}

export function isMacScreenLocked() {
  if (process.platform !== 'darwin') return false;
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(out);
  } catch {
    return false;
  }
}

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
    if (shift > 63n) throw new Error('Protobuf varint overflow');
  }
  throw new Error('Truncated protobuf varint');
}

function encodeVarint(value) {
  let v = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function parseProtoFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const tagRes = readVarint(buf, offset);
    offset = tagRes.nextOffset;
    const fieldNumber = Number(tagRes.value >> 3n);
    const wireType = Number(tagRes.value & 7n);
    if (fieldNumber <= 0) throw new Error('Invalid field number');
    if (wireType === 0) {
      const valRes = readVarint(buf, offset);
      offset = valRes.nextOffset;
      fields.push({ fieldNumber, wireType, rawValue: valRes.value });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) throw new Error('Truncated 64-bit field');
      fields.push({ fieldNumber, wireType, rawBytes: buf.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, offset);
      offset = lenRes.nextOffset;
      const len = Number(lenRes.value);
      if (len < 0 || offset + len > buf.length) throw new Error('Invalid len field');
      fields.push({ fieldNumber, wireType, rawBytes: buf.subarray(offset, offset + len) });
      offset += len;
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) throw new Error('Truncated 32-bit field');
      fields.push({ fieldNumber, wireType, rawBytes: buf.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`Unsupported wireType: ${wireType}`);
    }
  }
  return fields;
}

function encodeProtoFields(fields) {
  const chunks = [];
  for (const field of fields) {
    const tag = (BigInt(field.fieldNumber) << 3n) | BigInt(field.wireType);
    chunks.push(encodeVarint(tag));
    if (field.wireType === 0) {
      chunks.push(encodeVarint(field.rawValue));
    } else if (field.wireType === 2) {
      chunks.push(encodeVarint(field.rawBytes.length));
      chunks.push(field.rawBytes);
    } else {
      chunks.push(field.rawBytes);
    }
  }
  return Buffer.concat(chunks);
}

function patchConversationMetadataProto(metaBuf, { projectId = '' } = {}) {
  const cleanProjectId = String(projectId || '').trim();
  if (!cleanProjectId) return { buffer: metaBuf, changed: false };
  const fields = metaBuf.length > 0 ? parseProtoFields(metaBuf) : [];
  let changed = false;
  const nextBytes = Buffer.from(cleanProjectId, 'utf8');
  let found = false;
  for (const field of fields) {
    if (field.fieldNumber === 18 && field.wireType === 2) {
      found = true;
      if (!field.rawBytes.equals(nextBytes)) {
        field.rawBytes = nextBytes;
        changed = true;
      }
    }
  }
  if (!found) {
    fields.push({ fieldNumber: 18, wireType: 2, rawBytes: nextBytes });
    changed = true;
  }
  return { buffer: changed ? encodeProtoFields(fields) : metaBuf, changed };
}

function patchPbTrajectoryBytes(rawPbBuf, { projectId = '' } = {}) {
  const buf = Buffer.isBuffer(rawPbBuf) ? rawPbBuf : Buffer.from(rawPbBuf);
  if (buf.length < 28) return { buffer: buf, patched: false };
  try {
    const nonce = buf.subarray(0, 12);
    const authTag = buf.subarray(buf.length - 16);
    const ciphertext = buf.subarray(12, buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', DISK_SAVER_KEY, nonce);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const fields = parseProtoFields(plaintext);
    let changed = false;
    let sawMetadata = false;
    for (const field of fields) {
      if (field.fieldNumber === 7 && field.wireType === 2) {
        sawMetadata = true;
        if (projectId) {
          const metaRes = patchConversationMetadataProto(field.rawBytes, { projectId });
          if (metaRes.changed) {
            field.rawBytes = metaRes.buffer;
            changed = true;
          }
        }
      } else if (field.fieldNumber === 8 && field.wireType === 0 && field.rawValue === 17n) {
        field.rawValue = 1n;
        changed = true;
      }
    }
    if (!sawMetadata && projectId) {
      const metaRes = patchConversationMetadataProto(Buffer.alloc(0), { projectId });
      fields.push({ fieldNumber: 7, wireType: 2, rawBytes: metaRes.buffer });
      changed = true;
    }
    if (!changed) return { buffer: buf, patched: false };
    const nextPlaintext = encodeProtoFields(fields);
    const nextNonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', DISK_SAVER_KEY, nextNonce);
    const nextCipher = Buffer.concat([cipher.update(nextPlaintext), cipher.final()]);
    return {
      buffer: Buffer.concat([nextNonce, nextCipher, cipher.getAuthTag()]),
      patched: true,
    };
  } catch {
    return { buffer: buf, patched: false };
  }
}

export function deriveShortTitle(prompt, maxLen = 36) {
  let text = String(prompt || '');
  const reqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (reqMatch) text = reqMatch[1];
  text = text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ')
    .replace(/<DESKTOP_HANDOFF_CONTEXT[\s\S]*?<\/DESKTOP_HANDOFF_CONTEXT>/gi, ' ')
    .replace(/\r\n/g, '\n')
    .trim();
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const sentence = (firstLine.split(/[。！？!?\n]/).find((s) => s.trim()) || firstLine).trim();
  if (!sentence) return '';
  return sentence.length > maxLen ? `${sentence.slice(0, maxLen - 1).trimEnd()}…` : sentence;
}

/**
 * Inspect step count and max step index of `conversations/<id>.db` read-only.
 */
export function inspectTrajectoryDbStats(convDbPath) {
  if (!convDbPath || !fs.existsSync(convDbPath)) {
    return { exists: false, stepCount: 0, maxIdx: -1, source: 0 };
  }
  let db = null;
  try {
    db = new DatabaseSync(convDbPath, { open: true, readOnly: true, timeout: 200 });
    const row = db.prepare('SELECT count(*) AS c, max(idx) AS m FROM steps').get();
    let source = 0;
    try {
      const mRow = db.prepare('SELECT source FROM trajectory_meta LIMIT 1').get();
      source = Number(mRow?.source || 0);
    } catch {}
    const stepCount = Number(row?.c || 0);
    const maxIdx = row?.m === null || row?.m === undefined ? -1 : Number(row.m);
    return { exists: true, stepCount, maxIdx, source };
  } catch {
    return { exists: true, stepCount: -1, maxIdx: -1, source: 0 };
  } finally {
    try { db?.close(); } catch {}
  }
}

function checkpointSqliteCopy(srcDbPath, destDbPath) {
  ensurePrivateDir(path.dirname(destDbPath));
  const tmpDb = `${destDbPath}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(srcDbPath, tmpDb);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${srcDbPath}${suffix}`)) {
      fs.copyFileSync(`${srcDbPath}${suffix}`, `${tmpDb}${suffix}`);
    }
  }
  const db = new DatabaseSync(tmpDb);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {} finally {
    try { db.close(); } catch {}
  }
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(`${tmpDb}${suffix}`, { force: true }); } catch {}
  }
  fs.renameSync(tmpDb, destDbPath);
}

/**
 * Patch a conversation's trajectory (.db / .pb), annotations title, and (when Desktop is closed)
 * `conversation_summaries.db` so Antigravity Desktop lists it cleanly under its real project.
 */
export function promoteConversationForDesktop(
  conversationId,
  {
    homeDir = os.homedir(),
    workspacePath = '',
    projectId = '',
    title = '',
    prompt = '',
    updateSummariesDb = false,
  } = {},
) {
  const cleanId = String(conversationId || '').trim();
  if (!UUID_RE.test(cleanId)) return { ok: false, reason: 'invalid_uuid' };

  const desktopDir = path.join(homeDir, '.gemini', 'antigravity');
  const stageDir = path.join(desktopDir, 'scratch');
  fs.mkdirSync(stageDir, { recursive: true });

  const resolvedProject = projectId
    || (workspacePath ? resolveDesktopProjectForCwd(workspacePath, { homeDir }).projectId : '');
  const effectiveTitle = String(title || deriveShortTitle(prompt) || '').trim();

  // 1. Ensure annotations/<id>.pbtxt has a readable title if missing
  if (effectiveTitle) {
    const annPath = path.join(desktopDir, 'annotations', `${cleanId}.pbtxt`);
    fs.mkdirSync(path.dirname(annPath), { recursive: true });
    let existing = '';
    if (fs.existsSync(annPath)) {
      try { existing = fs.readFileSync(annPath, 'utf8'); } catch {}
    }
    if (!/title:\s*"(?:[^"\\]|\\.)+"/.test(existing)) {
      const escaped = effectiveTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').trim();
      const quoted = `title:"${escaped}"`;
      const next = /title:\s*"(?:[^"\\]|\\.)*"/.test(existing)
        ? existing.replace(/title:\s*"(?:[^"\\]|\\.)*"/, quoted)
        : (existing.trim() ? `${quoted} ${existing.trimStart()}` : `${quoted}\n`);
      const stageAnn = path.join(stageDir, `.ann-${process.pid}-${Date.now()}`);
      fs.writeFileSync(stageAnn, next, 'utf8');
      fs.renameSync(stageAnn, annPath);
    }
  }

  let patchedDb = false;
  let patchedPb = false;

  // 2. Patch conversations/<id>.db (source 17 -> 1, metadata #18 = projectId)
  const convDbPath = path.join(desktopDir, 'conversations', `${cleanId}.db`);
  if (fs.existsSync(convDbPath)) {
    const stagedDb = path.join(stageDir, `.conv-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`);
    try {
      fs.copyFileSync(convDbPath, stagedDb);
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(`${convDbPath}${suffix}`)) {
          fs.copyFileSync(`${convDbPath}${suffix}`, `${stagedDb}${suffix}`);
        }
      }
      const db = new DatabaseSync(stagedDb);
      try {
        const tables = new Set(
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
        );
        if (tables.has('trajectory_meta')) {
          const res = db.prepare('UPDATE trajectory_meta SET source = 1 WHERE source = 17').run();
          if (Number(res?.changes || 0) > 0) patchedDb = true;
        }
        if (resolvedProject && tables.has('trajectory_metadata_blob')) {
          const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get();
          if (row?.data) {
            const metaRes = patchConversationMetadataProto(Buffer.from(row.data), { projectId: resolvedProject });
            if (metaRes.changed) {
              db.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'").run(metaRes.buffer);
              patchedDb = true;
            }
          }
        }
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } finally {
        db.close();
      }
      for (const suffix of ['-wal', '-shm']) {
        fs.rmSync(`${stagedDb}${suffix}`, { force: true });
      }
      if (patchedDb) {
        fs.renameSync(stagedDb, convDbPath);
        for (const suffix of ['-wal', '-shm']) {
          fs.rmSync(`${convDbPath}${suffix}`, { force: true });
        }
      } else {
        fs.rmSync(stagedDb, { force: true });
      }
    } catch {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(`${stagedDb}${suffix}`, { force: true }); } catch {}
      }
    }
  }

  // 3. Patch conversations/<id>.pb if present
  const convPbPath = path.join(desktopDir, 'conversations', `${cleanId}.pb`);
  if (fs.existsSync(convPbPath)) {
    try {
      const raw = fs.readFileSync(convPbPath);
      const patchRes = patchPbTrajectoryBytes(raw, { projectId: resolvedProject });
      if (patchRes.patched) {
        const stagePb = path.join(stageDir, `.pb-${process.pid}-${Date.now()}`);
        fs.writeFileSync(stagePb, patchRes.buffer);
        fs.renameSync(stagePb, convPbPath);
        patchedPb = true;
      }
    } catch {}
  }

  // 4. When Desktop is closed, also normalize conversation_summaries.db so project_id & workspace_uris are clean
  let updatedSummary = false;
  if (updateSummariesDb) {
    const sumDbPath = path.join(desktopDir, 'conversation_summaries.db');
    if (fs.existsSync(sumDbPath)) {
      let sdb = null;
      try {
        sdb = new DatabaseSync(sumDbPath, { timeout: 1500 });
        const row = sdb
          .prepare('SELECT title, project_id, source, workspace_uris FROM conversation_summaries WHERE conversation_id = ?')
          .get(cleanId);
        if (row) {
          let nextUris = row.workspace_uris;
          try {
            const parsedUris = JSON.parse(String(row.workspace_uris || '[]'));
            if (Array.isArray(parsedUris)) {
              const filtered = parsedUris.filter((u) => u && u !== 'file:///');
              if (filtered.length === 0 && workspacePath) {
                filtered.push(pathToFileURL(workspacePath).href);
              }
              if (filtered.length > 0) {
                nextUris = JSON.stringify(filtered);
              }
            }
          } catch {}
          const nextProj = resolvedProject || (row.project_id === 'default-cli-project' ? '' : row.project_id);
          const nextTitle = String(row.title || '').trim() || effectiveTitle;
          sdb
            .prepare(
              'UPDATE conversation_summaries SET project_id = ?, source = ?, workspace_uris = ?, title = ? WHERE conversation_id = ?',
            )
            .run(nextProj, '', nextUris, nextTitle, cleanId);
          updatedSummary = true;
        }
      } catch {} finally {
        try { sdb?.close(); } catch {}
      }
    }
  }

  return {
    ok: true,
    projectId: resolvedProject,
    patchedDb,
    patchedPb,
    updatedSummary,
  };
}

/**
 * Coordinate mobile -> Desktop synchronization, anti-overwrite backups, and 1-tap safe Desktop reload.
 */
export function createDesktopSyncManager({
  stateDir,
  homeDir = os.homedir(),
  getConfig,
  getActiveWorkerSessionIds = () => new Set(),
  terminateIdleWorkers = async () => {},
  getRunningSessions = () => [],
  onChanged = () => {},
} = {}) {
  const resolvedStateDir = resolveStateDir(stateDir);
  const stateFilePath = path.join(resolvedStateDir, 'desktop-sync.json');
  const backupsRoot = path.join(resolvedStateDir, 'mobile-backups');

  const loadState = () => {
    if (!fs.existsSync(stateFilePath)) {
      return { autoReloadWhenLocked: false, sessions: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      return {
        autoReloadWhenLocked: Boolean(parsed?.autoReloadWhenLocked),
        sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      };
    } catch {
      return { autoReloadWhenLocked: false, sessions: {} };
    }
  };

  let state = loadState();
  let reloadInFlightPromise = null;
  let autoReloadTimer = null;
  let lastMacRemindAtMs = 0;

  const saveState = () => {
    writeJsonAtomic(stateFilePath, state, 0o600);
  };

  const snapshotSessionFiles = (sessionId) => {
    const cleanId = String(sessionId || '').trim();
    if (!UUID_RE.test(cleanId)) return null;

    const desktopDir = path.join(homeDir, '.gemini', 'antigravity');
    const convDbPath = path.join(desktopDir, 'conversations', `${cleanId}.db`);
    const convPbPath = path.join(desktopDir, 'conversations', `${cleanId}.pb`);
    const annPath = path.join(desktopDir, 'annotations', `${cleanId}.pbtxt`);
    const logsDir = path.join(desktopDir, 'brain', cleanId, '.system_generated', 'logs');

    const destDir = path.join(backupsRoot, cleanId);
    ensurePrivateDir(destDir);

    const stats = inspectTrajectoryDbStats(convDbPath);
    if (stats.exists) {
      try {
        checkpointSqliteCopy(convDbPath, path.join(destDir, 'conversation.db'));
      } catch {}
    }
    if (fs.existsSync(convPbPath)) {
      try {
        fs.copyFileSync(convPbPath, path.join(destDir, 'conversation.pb'));
      } catch {}
    }
    if (fs.existsSync(annPath)) {
      try {
        fs.copyFileSync(annPath, path.join(destDir, 'annotation.pbtxt'));
      } catch {}
    }
    for (const logName of ['transcript.jsonl', 'transcript_full.jsonl']) {
      const srcLog = path.join(logsDir, logName);
      if (fs.existsSync(srcLog)) {
        try {
          fs.copyFileSync(srcLog, path.join(destDir, logName));
        } catch {}
      }
    }
    return stats;
  };

  const scheduleAutoReloadIfLocked = () => {
    if (!state.autoReloadWhenLocked || process.platform !== 'darwin') return;
    if (autoReloadTimer) clearTimeout(autoReloadTimer);
    autoReloadTimer = setTimeout(async () => {
      autoReloadTimer = null;
      if (!state.autoReloadWhenLocked || !isMacScreenLocked()) return;
      const app = detectRunningDesktopApp({ forceFresh: true });
      if (!app.running) return;
      try {
        await reloadDesktopSafely({ force: false });
      } catch {}
    }, 5_000);
    autoReloadTimer.unref?.();
  };

  const recordMobileTurn = (sessionId, { workspacePath = '', title = '', prompt = '' } = {}) => {
    const cleanId = String(sessionId || '').trim();
    if (!UUID_RE.test(cleanId)) return;

    const nowMs = Date.now();
    const prev = state.sessions[cleanId] || {};
    const effectiveWs = workspacePath || prev.workspacePath || '';
    const projectRes = effectiveWs ? resolveDesktopProjectForCwd(effectiveWs, { homeDir }) : { projectId: '' };
    const projectId = projectRes.projectId || prev.projectId || '';
    const effectiveTitle = title || prev.title || deriveShortTitle(prompt) || '';

    const dbStats = snapshotSessionFiles(cleanId);
    const maxStepIdx = dbStats && dbStats.maxIdx >= 0
      ? Math.max(prev.maxStepIdx ?? -1, dbStats.maxIdx)
      : (prev.maxStepIdx ?? -1);
    const stepCount = dbStats && dbStats.stepCount >= 0
      ? Math.max(prev.stepCount ?? 0, dbStats.stepCount)
      : (prev.stepCount ?? 0);

    state.sessions[cleanId] = {
      updatedAtMs: nowMs,
      maxStepIdx,
      stepCount,
      workspacePath: effectiveWs,
      projectId,
      title: effectiveTitle,
      prompt: prompt ? String(prompt).slice(0, 240) : (prev.prompt || ''),
      promotedAtMs: 0,
    };
    saveState();

    // If no active worker holds the DB open, promote metadata immediately
    const activeIds = getActiveWorkerSessionIds();
    if (!activeIds.has(cleanId)) {
      const desktop = detectRunningDesktopApp();
      promoteConversationForDesktop(cleanId, {
        homeDir,
        workspacePath: effectiveWs,
        projectId,
        title: effectiveTitle,
        prompt,
        updateSummariesDb: !desktop.running,
      });
      state.sessions[cleanId].promotedAtMs = Date.now();
      saveState();
    }

    const desktop = detectRunningDesktopApp();
    if (desktop.running) {
      if (state.autoReloadWhenLocked && isMacScreenLocked()) {
        scheduleAutoReloadIfLocked();
      } else if (nowMs - lastMacRemindAtMs > 10 * 60_000) {
        lastMacRemindAtMs = nowMs;
        showMacNotification({
          title: 'AG Mobile · 手机端有新进展',
          subtitle: effectiveTitle || `#${cleanId.slice(0, 8)}`,
          body: '回电脑继续操作前，请在手机点「同步到电脑桌面」防覆盖。',
        });
      }
    }

    onChanged('mobile_turn_recorded');
  };

  const promoteDetachedSessionIfTracked = (sessionId) => {
    const cleanId = String(sessionId || '').trim();
    const rec = state.sessions[cleanId];
    if (!rec) return;
    const dbStats = snapshotSessionFiles(cleanId);
    if (dbStats && dbStats.maxIdx > (rec.maxStepIdx ?? -1)) {
      rec.maxStepIdx = dbStats.maxIdx;
      rec.stepCount = Math.max(rec.stepCount || 0, dbStats.stepCount);
    }
    const desktop = detectRunningDesktopApp();
    promoteConversationForDesktop(cleanId, {
      homeDir,
      workspacePath: rec.workspacePath,
      projectId: rec.projectId,
      title: rec.title,
      prompt: rec.prompt,
      updateSummariesDb: !desktop.running,
    });
    rec.promotedAtMs = Date.now();
    saveState();
  };

  const evaluateSyncStatus = () => {
    const cfg = typeof getConfig === 'function' ? getConfig() : {};
    const launcher = resolveDesktopLauncherApp({
      overrideApp: cfg?.desktopLauncherApp || '',
      homeDir,
    });
    const desktop = detectRunningDesktopApp();
    const pendingSessionIds = [];
    const overwrittenSessionIds = [];
    const desktopDir = path.join(homeDir, '.gemini', 'antigravity');
    const nowMs = Date.now();
    let mutated = false;

    for (const [sid, rec] of Object.entries(state.sessions)) {
      if (!rec || typeof rec !== 'object') continue;
      const convDbPath = path.join(desktopDir, 'conversations', `${sid}.db`);
      const backupDbPath = path.join(backupsRoot, sid, 'conversation.db');
      const hasBackup = fs.existsSync(backupDbPath);

      if (hasBackup && (rec.maxStepIdx ?? -1) >= 0 && fs.existsSync(convDbPath)) {
        const liveStats = inspectTrajectoryDbStats(convDbPath);
        if (liveStats.exists && liveStats.stepCount >= 0 && liveStats.maxIdx >= 0 && liveStats.maxIdx < rec.maxStepIdx) {
          overwrittenSessionIds.push(sid);
          continue;
        }
      }

      if (desktop.running) {
        if ((rec.updatedAtMs || 0) > (desktop.startedAtMs || 0)) {
          pendingSessionIds.push(sid);
        } else if (nowMs - (rec.updatedAtMs || 0) > 7 * 86_400_000) {
          delete state.sessions[sid];
          mutated = true;
        }
      } else if (!rec.promotedAtMs) {
        const activeIds = getActiveWorkerSessionIds();
        if (!activeIds.has(sid)) {
          promoteConversationForDesktop(sid, {
            homeDir,
            workspacePath: rec.workspacePath,
            projectId: rec.projectId,
            title: rec.title,
            prompt: rec.prompt,
            updateSummariesDb: true,
          });
          rec.promotedAtMs = nowMs;
          mutated = true;
        }
      }
    }

    if (mutated) saveState();

    return {
      supported: launcher.supported,
      desktopRunning: desktop.running,
      desktopStartedAtMs: desktop.startedAtMs || 0,
      launcherName: launcher.appName || 'Antigravity',
      isCustomLauncher: launcher.isCustomLauncher,
      pendingCount: pendingSessionIds.length,
      pendingSessionIds,
      overwrittenCount: overwrittenSessionIds.length,
      overwrittenSessionIds,
      autoReloadWhenLocked: Boolean(state.autoReloadWhenLocked),
    };
  };

  const annotateOverview = (overview) => {
    const sync = evaluateSyncStatus();
    const pendingSet = new Set(sync.pendingSessionIds);
    const overwrittenSet = new Set(sync.overwrittenSessionIds);
    const sessions = (overview.sessions || []).map((s) => ({
      ...s,
      pendingDesktopReload: pendingSet.has(s.id),
      overwrittenByDesktop: overwrittenSet.has(s.id),
    }));
    return {
      ...overview,
      sessions,
      desktopSync: sync,
    };
  };

  const annotateSessionDetail = (detail) => {
    if (!detail) return detail;
    const sync = evaluateSyncStatus();
    return {
      ...detail,
      pendingDesktopReload: sync.pendingSessionIds.includes(detail.id),
      overwrittenByDesktop: sync.overwrittenSessionIds.includes(detail.id),
    };
  };

  const restoreBackupToDesktop = (sessionId) => {
    const cleanId = String(sessionId || '').trim();
    const srcDir = path.join(backupsRoot, cleanId);
    const backupDb = path.join(srcDir, 'conversation.db');
    const backupPb = path.join(srcDir, 'conversation.pb');
    if (!fs.existsSync(backupDb) && !fs.existsSync(backupPb)) {
      return { ok: false, error: 'No mobile backup found for this session.' };
    }
    const desktopDir = path.join(homeDir, '.gemini', 'antigravity');
    const convDbDest = path.join(desktopDir, 'conversations', `${cleanId}.db`);
    const convPbDest = path.join(desktopDir, 'conversations', `${cleanId}.pb`);
    const annSrc = path.join(srcDir, 'annotation.pbtxt');
    const annDest = path.join(desktopDir, 'annotations', `${cleanId}.pbtxt`);
    const logsDest = path.join(desktopDir, 'brain', cleanId, '.system_generated', 'logs');

    fs.mkdirSync(path.dirname(convDbDest), { recursive: true });
    if (fs.existsSync(backupDb)) {
      for (const suffix of ['-wal', '-shm']) {
        fs.rmSync(`${convDbDest}${suffix}`, { force: true });
      }
      fs.copyFileSync(backupDb, convDbDest);
    }
    if (fs.existsSync(backupPb)) {
      fs.copyFileSync(backupPb, convPbDest);
    }
    if (fs.existsSync(annSrc)) {
      fs.mkdirSync(path.dirname(annDest), { recursive: true });
      fs.copyFileSync(annSrc, annDest);
    }
    for (const logName of ['transcript.jsonl', 'transcript_full.jsonl']) {
      const srcLog = path.join(srcDir, logName);
      if (fs.existsSync(srcLog)) {
        fs.mkdirSync(logsDest, { recursive: true });
        fs.copyFileSync(srcLog, path.join(logsDest, logName));
      }
    }

    const rec = state.sessions[cleanId] || {};
    rec.updatedAtMs = Date.now();
    state.sessions[cleanId] = rec;
    saveState();
    onChanged('session_backup_restored');
    return { ok: true };
  };

  const reloadDesktopSafely = async ({ force = false } = {}) => {
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        reloaded: false,
        busy: false,
        runningTitles: [],
        message: 'Desktop app reload is only applicable on macOS.',
      };
    }
    if (reloadInFlightPromise) {
      return reloadInFlightPromise;
    }

    reloadInFlightPromise = (async () => {
      try {
        const cfg = typeof getConfig === 'function' ? getConfig() : {};
        const launcher = resolveDesktopLauncherApp({
          overrideApp: cfg?.desktopLauncherApp || '',
          homeDir,
        });
        if (!launcher.supported || !launcher.appPath) {
          return {
            ok: false,
            reloaded: false,
            busy: false,
            runningTitles: [],
            message: 'Antigravity.app not found on this Mac.',
          };
        }

        const runningList = getRunningSessions() || [];
        if (!force && runningList.length > 0) {
          const runningTitles = runningList.slice(0, 3).map((s) => s.title || s.shortId || s.id);
          return {
            ok: false,
            reloaded: false,
            busy: true,
            runningTitles,
            launcherName: launcher.appName,
            message: `电脑端当前有 ${runningList.length} 个任务正在执行（${runningTitles.join('、')}），请等执行完成后再安全刷新。`,
          };
        }

        // 1. Flush and close idle bridge ACP workers so SQLite WAL is cleanly closed
        await terminateIdleWorkers();

        // 2. Take fresh pre-quit snapshots of all tracked mobile sessions
        const syncBefore = evaluateSyncStatus();
        const targetIds = Array.from(new Set([
          ...syncBefore.pendingSessionIds,
          ...Object.keys(state.sessions),
        ]));
        for (const sid of targetIds) {
          const stats = snapshotSessionFiles(sid);
          if (stats && stats.maxIdx >= 0 && state.sessions[sid]) {
            state.sessions[sid].maxStepIdx = Math.max(state.sessions[sid].maxStepIdx ?? -1, stats.maxIdx);
            state.sessions[sid].stepCount = Math.max(state.sessions[sid].stepCount ?? 0, stats.stepCount);
          }
        }

        // 3. Gracefully quit running Antigravity.app and wait for hub language_server exit
        const beforeProc = detectRunningDesktopApp({ forceFresh: true });
        if (beforeProc.running) {
          try {
            execFileSync('/usr/bin/osascript', ['-e', 'tell application "Antigravity" to quit'], {
              timeout: 4000,
              stdio: 'ignore',
            });
          } catch {
            if (beforeProc.pid) {
              try { process.kill(beforeProc.pid, 'SIGTERM'); } catch {}
            }
          }

          const quitDeadline = Date.now() + 7_500;
          while (Date.now() < quitDeadline) {
            const cur = detectRunningDesktopApp({ forceFresh: true });
            if (!cur.running) break;
            await new Promise((r) => setTimeout(r, 250));
          }
        }

        // 4. Restore any session whose step index regressed on quit, then promote project_id & source=1
        const desktopDir = path.join(homeDir, '.gemini', 'antigravity');
        let syncedCount = 0;
        for (const sid of targetIds) {
          const rec = state.sessions[sid];
          if (!rec) continue;
          const convDbPath = path.join(desktopDir, 'conversations', `${sid}.db`);
          const backupDbPath = path.join(backupsRoot, sid, 'conversation.db');
          if (fs.existsSync(backupDbPath)) {
            const afterStats = inspectTrajectoryDbStats(convDbPath);
            if (!afterStats.exists || ((rec.maxStepIdx ?? -1) >= 0 && afterStats.maxIdx < rec.maxStepIdx)) {
              restoreBackupToDesktop(sid);
            }
          }
          promoteConversationForDesktop(sid, {
            homeDir,
            workspacePath: rec.workspacePath,
            projectId: rec.projectId,
            title: rec.title,
            prompt: rec.prompt,
            updateSummariesDb: true,
          });
          rec.promotedAtMs = Date.now();
          syncedCount += 1;
        }

        // 5. Re-open via custom Japan-exit launcher (or standard Antigravity.app)
        const openChild = spawn('/usr/bin/open', ['-a', launcher.appPath], {
          detached: true,
          stdio: 'ignore',
        });
        openChild.unref();

        let afterProc = detectRunningDesktopApp({ forceFresh: true });
        const launchDeadline = Date.now() + 5_000;
        while (Date.now() < launchDeadline) {
          await new Promise((r) => setTimeout(r, 300));
          afterProc = detectRunningDesktopApp({ forceFresh: true });
          if (afterProc.running && (!beforeProc.pid || afterProc.pid !== beforeProc.pid)) {
            break;
          }
        }

        // Ensure timestamps older than the freshly started process clear pending state cleanly
        const clearedCeilingMs = (afterProc.startedAtMs || Date.now()) - 1000;
        for (const sid of targetIds) {
          if (state.sessions[sid] && state.sessions[sid].updatedAtMs > clearedCeilingMs) {
            state.sessions[sid].updatedAtMs = clearedCeilingMs;
          }
        }
        saveState();
        onChanged('desktop_reloaded');

        return {
          ok: true,
          reloaded: true,
          busy: false,
          runningTitles: [],
          syncedCount: syncBefore.pendingCount || syncedCount,
          launcherName: launcher.appName,
          newPid: afterProc.pid || null,
          message: `已通过「${launcher.appName}」安全刷新电脑端`,
        };
      } finally {
        reloadInFlightPromise = null;
      }
    })();

    return reloadInFlightPromise;
  };

  const setAutoReloadWhenLocked = (enabled) => {
    state.autoReloadWhenLocked = Boolean(enabled);
    saveState();
    onChanged('desktop_sync_settings');
    return {
      ok: true,
      autoReloadWhenLocked: state.autoReloadWhenLocked,
    };
  };

  return {
    recordMobileTurn,
    promoteDetachedSessionIfTracked,
    evaluateSyncStatus,
    annotateOverview,
    annotateSessionDetail,
    reloadDesktopSafely,
    restoreBackupToDesktop,
    setAutoReloadWhenLocked,
  };
}

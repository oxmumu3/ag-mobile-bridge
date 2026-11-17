import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Decode file:// URIs or percent-encoded local filesystem paths returned by Antigravity / agy acp.
 */
export function decodeWorkspacePath(raw) {
  if (typeof raw !== 'string') return '';
  let candidate = raw.trim();
  if (!candidate) return '';

  if (candidate.startsWith('file://')) {
    try {
      const parsed = new URL(candidate);
      candidate = decodeURIComponent(parsed.pathname);
    } catch {
      candidate = candidate.replace(/^file:\/\//, '');
    }
  } else if (/%[0-9a-fA-F]{2}/.test(candidate)) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {}
  }

  // Collapse duplicate slashes without stripping leading slash
  candidate = candidate.replace(/\/{2,}/g, '/');
  if (candidate.length > 1 && candidate.endsWith('/')) {
    candidate = candidate.slice(0, -1);
  }
  return candidate;
}

export function parseWorkspaceUrisColumn(rawColumn) {
  if (typeof rawColumn !== 'string' || !rawColumn.trim()) return [];
  try {
    const parsed = JSON.parse(rawColumn);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(decodeWorkspacePath).filter(Boolean);
  } catch {
    const single = decodeWorkspacePath(rawColumn);
    return single ? [single] : [];
  }
}

export function formatDisplayPath(absPath, homeDir = os.homedir()) {
  if (!absPath) return '';
  const icloudRoot = path.join(homeDir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  if (absPath === icloudRoot) return '~/iCloud';
  if (absPath.startsWith(icloudRoot + path.sep)) {
    return '~/iCloud/' + absPath.slice(icloudRoot.length + 1);
  }
  if (absPath === homeDir) return '~';
  if (absPath.startsWith(homeDir + path.sep)) {
    return '~/' + absPath.slice(homeDir.length + 1);
  }
  return absPath;
}

export function makeWorkspaceId(absPath) {
  return 'ws-' + crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 10);
}

const lastGoodRowsByDbPath = new Map();

/**
 * Query conversation_summaries.db strictly read-only (`open: true, readOnly: true`).
 * Never writes or alters WAL locks owned by running desktop Antigravity.
 */
export function readConversationDbMetadata(dbPaths) {
  const byId = new Map();
  for (const entry of dbPaths) {
    const dbPath = typeof entry === 'string' ? entry : entry?.path;
    const defaultSurface = typeof entry === 'string' ? 'desktop' : (entry?.surface || 'desktop');
    if (!dbPath || !fs.existsSync(dbPath)) continue;
    let db;
    let rows = [];
    try {
      db = new DatabaseSync(dbPath, { open: true, readOnly: true, timeout: 3000 });
      rows = db.prepare(`
        SELECT conversation_id, title, workspace_uris, status, source,
               parent_conversation_id, nesting_depth, not_fully_idle, killed, last_modified_time
        FROM conversation_summaries
      `).all();
      lastGoodRowsByDbPath.set(dbPath, rows);
    } catch {
      // Gracefully tolerate transiently locked/missing SQLite DBs using last-known rows
      rows = lastGoodRowsByDbPath.get(dbPath) || [];
    } finally {
      try { db?.close(); } catch {}
    }
    for (const row of rows) {
      const workspacePaths = parseWorkspaceUrisColumn(row.workspace_uris);
      const existing = byId.get(row.conversation_id);
      const lastModifiedMs = row.last_modified_time ? Date.parse(row.last_modified_time) : 0;
      if (!existing || lastModifiedMs >= (existing.lastModifiedMs || 0)) {
        byId.set(row.conversation_id, {
          conversationId: row.conversation_id,
          title: typeof row.title === 'string' ? row.title : '',
          workspacePaths,
          workspacePath: workspacePaths[0] || '',
          dbStatus: typeof row.status === 'string' ? row.status : '',
          source: typeof row.source === 'string' ? row.source : '',
          parentConversationId: typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id : '',
          nestingDepth: Number(row.nesting_depth || 0),
          notFullyIdle: Boolean(row.not_fully_idle),
          killed: Boolean(row.killed),
          lastModifiedMs: Number.isFinite(lastModifiedMs) ? lastModifiedMs : 0,
          surface: defaultSurface,
        });
      }
    }
  }
  return byId;
}

export function isEphemeralTmpWorkspace(absPath) {
  return typeof absPath === 'string' && (
    absPath.startsWith('/private/tmp/') ||
    absPath.startsWith('/tmp/') ||
    absPath.startsWith('/var/folders/')
  );
}

/**
 * Aggregate known workspaces from discovered sessions + default fallbacks (e.g. ~/Repos, ~/iCloud/Agent).
 */
export function buildWorkspaceSummaries(sessions, { homeDir = os.homedir(), extraPaths = [] } = {}) {
  const map = new Map();

  const ensureWs = (rawPath) => {
    const absPath = decodeWorkspacePath(rawPath);
    if (!absPath) return null;
    if (!map.has(absPath)) {
      const exists = fs.existsSync(absPath);
      const hasAgentsMd = exists && (
        fs.existsSync(path.join(absPath, 'AGENTS.md')) ||
        fs.existsSync(path.join(absPath, '.agent', 'policy.md'))
      );
      map.set(absPath, {
        id: makeWorkspaceId(absPath),
        name: path.basename(absPath) || absPath,
        path: absPath,
        displayPath: formatDisplayPath(absPath, homeDir),
        hasAgentsMd,
        exists,
        sessionCount: 0,
        activeCount: 0,
        lastModifiedMs: 0,
      });
    }
    return map.get(absPath);
  };

  for (const s of sessions) {
    if (!s.workspacePath) continue;
    if (isEphemeralTmpWorkspace(s.workspacePath) && s.status !== 'running' && s.status !== 'question') {
      continue;
    }
    const ws = ensureWs(s.workspacePath);
    if (!ws) continue;
    ws.sessionCount += 1;
    if (s.status === 'running' || s.status === 'question') {
      ws.activeCount += 1;
    }
    if ((s.updatedAtMs || 0) > ws.lastModifiedMs) {
      ws.lastModifiedMs = s.updatedAtMs || 0;
    }
  }

  for (const p of extraPaths) {
    if (p && fs.existsSync(p)) ensureWs(p);
  }

  const list = Array.from(map.values()).filter((w) => w.sessionCount > 0 || w.exists);
  list.sort((a, b) => {
    if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount;
    return a.name.localeCompare(b.name);
  });
  return list;
}

/**
 * Safely browse child directories within `homeDir` for the remote Workspace Picker sheet.
 */
export function browseWorkspaceDir(requestedPath, { homeDir = os.homedir() } = {}) {
  const realHome = fs.realpathSync(homeDir);
  const candidate = requestedPath ? decodeWorkspacePath(requestedPath) : realHome;
  const targetAbs = path.resolve(candidate);

  if (!fs.existsSync(targetAbs)) {
    const err = new Error('Directory does not exist');
    err.statusCode = 404;
    throw err;
  }

  const realTarget = fs.realpathSync(targetAbs);
  if (realTarget !== realHome && !realTarget.startsWith(realHome + path.sep)) {
    const err = new Error('Access outside home directory is forbidden');
    err.statusCode = 403;
    throw err;
  }

  const stat = fs.statSync(realTarget);
  if (!stat.isDirectory()) {
    const err = new Error('Path is not a directory');
    err.statusCode = 400;
    throw err;
  }

  const shortcuts = [];
  const candidates = [
    { name: 'Home', path: realHome },
    { name: 'Repos', path: path.join(realHome, 'Repos') },
    { name: 'Agent', path: path.join(realHome, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Agent') },
    { name: 'iCloud Drive', path: path.join(realHome, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') },
  ];
  for (const sc of candidates) {
    if (fs.existsSync(sc.path)) {
      shortcuts.push({
        name: sc.name,
        path: sc.path,
        displayPath: formatDisplayPath(sc.path, realHome),
      });
    }
  }

  let entries = [];
  try {
    const dirents = fs.readdirSync(realTarget, { withFileTypes: true });
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      if (d.name.startsWith('.') || d.name === 'node_modules' || d.name === 'DerivedData') continue;
      const full = path.join(realTarget, d.name);
      let hasAgentsMd = false;
      let isGitRepo = false;
      try {
        hasAgentsMd = fs.existsSync(path.join(full, 'AGENTS.md')) || fs.existsSync(path.join(full, '.agent', 'policy.md'));
        isGitRepo = fs.existsSync(path.join(full, '.git'));
      } catch {}
      entries.push({
        name: d.name,
        path: full,
        displayPath: formatDisplayPath(full, realHome),
        hasAgentsMd,
        isGitRepo,
      });
    }
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      const err = new Error('Permission denied reading directory');
      err.statusCode = 403;
      throw err;
    }
    throw e;
  }

  entries.sort((a, b) => {
    if (a.hasAgentsMd !== b.hasAgentsMd) return a.hasAgentsMd ? -1 : 1;
    if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parentPath = realTarget === realHome ? null : path.dirname(realTarget);

  return {
    currentPath: realTarget,
    displayPath: formatDisplayPath(realTarget, realHome),
    parentPath,
    hasAgentsMd: fs.existsSync(path.join(realTarget, 'AGENTS.md')),
    shortcuts,
    directories: entries.slice(0, 120),
  };
}

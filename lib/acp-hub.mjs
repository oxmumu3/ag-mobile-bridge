import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIsolatedProxy } from './proxy.mjs';
import { decodeWorkspacePath } from './workspaces.mjs';

const INLINE_ACP_IMAGE_MIMES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);
const ALLOWED_INLINE_IMAGE_MIME_SET = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const MAX_INLINE_ACP_IMAGE_BYTES = 15 * 1024 * 1024;
export const ATTACHMENT_FALLBACK_PROMPT = 'Please inspect the attached file(s).';

const MAX_AUDIT_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PARTIAL_ASSISTANT_CHARS = 32 * 1024;
const MAX_STDERR_TAIL_CHARS = 1200;

export function resolveAgyBinary(overrideBin) {
  if (overrideBin) return overrideBin;
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  const candidate = path.join(os.homedir(), '.local', 'bin', 'agy');
  return fs.existsSync(candidate) ? candidate : 'agy';
}

export function resolveAppDataDir(surface) {
  return surface === 'cli' ? 'antigravity-cli' : 'antigravity';
}

function surfaceFromAppDataDir(appDataDir) {
  return appDataDir === 'antigravity-cli' ? 'cli' : 'desktop';
}

function buildSeedPrefix(handoffRec) {
  const meta = handoffRec || {};
  const parts = [
    `<DESKTOP_HANDOFF_CONTEXT source="#${meta.sourceShortId || ''}" title="${(meta.title || '').replace(/"/g, "'")}" workspace="${meta.workspacePath || ''}">`,
  ];
  if (meta.lastPrompt) {
    parts.push(`Original user request: ${meta.lastPrompt}`);
  }
  if (meta.seedContext) {
    parts.push(`Recent desktop output:\n${meta.seedContext}`);
  }
  parts.push('Continue seamlessly from the context above for the following follow-up instruction:');
  parts.push('</DESKTOP_HANDOFF_CONTEXT>');
  return parts.join('\n') + '\n\n';
}

/**
 * Decode %-encoded cwd fields returned by `agy acp` inside `session/list` responses.
 */
export function normalizeAcpOutboundLine(line) {
  if (!line || !line.includes('"cwd"')) return line;
  try {
    const obj = JSON.parse(line);
    if (Array.isArray(obj?.result?.sessions)) {
      let mutated = false;
      for (const s of obj.result.sessions) {
        if (s && typeof s.cwd === 'string' && s.cwd.includes('%')) {
          s.cwd = decodeWorkspacePath(s.cwd);
          mutated = true;
        }
      }
      if (mutated) return JSON.stringify(obj);
    }
  } catch {}
  return line;
}

function resolveConfinedUploadImageBlock(block, uploadsRootReal) {
  if (!uploadsRootReal || !block || block.type !== 'resource_link' || typeof block.uri !== 'string') {
    return null;
  }
  if (!block.uri.startsWith('file://')) return null;

  let filePath;
  try {
    filePath = fileURLToPath(block.uri);
  } catch {
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  const declaredMime = typeof block.mimeType === 'string' ? block.mimeType.split(';')[0].trim().toLowerCase() : '';
  const resolvedMime = ALLOWED_INLINE_IMAGE_MIME_SET.has(declaredMime)
    ? declaredMime
    : (INLINE_ACP_IMAGE_MIMES.get(ext) || '');
  if (!resolvedMime) return null;

  try {
    if (!fs.existsSync(filePath)) return null;
    const realFile = fs.realpathSync(filePath);
    if (!realFile.startsWith(uploadsRootReal + path.sep)) {
      return null;
    }
    const st = fs.statSync(realFile);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_INLINE_ACP_IMAGE_BYTES) {
      return null;
    }
    const base64 = fs.readFileSync(realFile).toString('base64');
    return {
      type: 'image',
      mimeType: resolvedMime,
      data: base64,
    };
  } catch {
    return null;
  }
}

/**
 * Inspect outbound client JSON-RPC requests:
 *  - Normalize `cwd` in session/new, session/load, session/resume
 *  - Hydrate local uploaded image `resource_link` blocks (inside `<stateDir>/uploads/`) into native ACP `image` blocks
 *  - Ensure attachment-only prompts always include a non-empty `text` block so `agy acp` never stalls
 *  - On the first `session/prompt` of a `mobile_handoff` session, prepend desktop seed context once.
 */
export function rewriteInboundAcpMessage(rawText, { handoffStore, stateDir } = {}) {
  let obj;
  try {
    obj = JSON.parse(rawText);
  } catch {
    return rawText;
  }
  if (!obj || typeof obj !== 'object') return rawText;

  if (obj.params && typeof obj.params.cwd === 'string') {
    obj.params.cwd = decodeWorkspacePath(obj.params.cwd);
  }

  if (obj.method === 'session/prompt' && Array.isArray(obj.params?.prompt) && obj.params.prompt.length > 0) {
    let uploadsRootReal = null;
    if (stateDir) {
      try {
        const upDir = path.join(stateDir, 'uploads');
        if (fs.existsSync(upDir)) {
          uploadsRootReal = fs.realpathSync(upDir);
        }
      } catch {}
    }

    obj.params.prompt = obj.params.prompt.map((b) => {
      const hydrated = resolveConfinedUploadImageBlock(b, uploadsRootReal);
      return hydrated || b;
    });

    const hasNonEmptyText = obj.params.prompt.some(
      (b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0,
    );
    if (!hasNonEmptyText) {
      const emptyTextBlock = obj.params.prompt.find((b) => b && b.type === 'text');
      if (emptyTextBlock) {
        emptyTextBlock.text = ATTACHMENT_FALLBACK_PROMPT;
      } else {
        obj.params.prompt.unshift({ type: 'text', text: ATTACHMENT_FALLBACK_PROMPT });
      }
    }

    if (obj.params?.sessionId && typeof handoffStore?.consumeSeedForPrompt === 'function') {
      const rec = handoffStore.consumeSeedForPrompt(obj.params.sessionId);
      if (rec) {
        const prefix = buildSeedPrefix(rec);
        const firstTextBlock = obj.params.prompt.find((b) => b && b.type === 'text' && typeof b.text === 'string');
        if (firstTextBlock) {
          firstTextBlock.text = prefix + firstTextBlock.text;
        } else {
          obj.params.prompt.unshift({ type: 'text', text: prefix });
        }
      }
    }
  }

  return JSON.stringify(obj);
}

function createAuditLogger(stateDir) {
  if (!stateDir) return () => {};
  const logsDir = path.join(stateDir, 'logs');
  const logPath = path.join(logsDir, 'acp-audit.log');
  return (event, { surface = 'desktop', sessionId = null, pid = null, detail = '' } = {}) => {
    try {
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
      }
      if (fs.existsSync(logPath)) {
        const st = fs.statSync(logPath);
        if (st.size > MAX_AUDIT_LOG_BYTES) {
          fs.renameSync(logPath, `${logPath}.1`);
        }
      }
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        event,
        surface,
        sessionId: sessionId || null,
        pid: pid || null,
        detail: detail ? String(detail).slice(0, 800) : '',
      });
      fs.appendFileSync(logPath, `${line}\n`, { mode: 0o600 });
    } catch {}
  };
}

class AcpWorker {
  constructor({
    bin,
    appDataDir,
    idleTtlMs,
    onLog,
    onStateChange,
    onActivity,
    onWorkerExit,
  }) {
    this.bin = bin;
    this.appDataDir = appDataDir;
    this.surface = surfaceFromAppDataDir(appDataDir);
    this.idleTtlMs = idleTtlMs;
    this.onLog = onLog;
    this.onStateChange = onStateChange;
    this.onActivity = onActivity;
    this.onWorkerExit = onWorkerExit;

    this.child = null;
    this.pid = null;
    this.proxy = { proxyUrl: '', cleanup: async () => {} };
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.stderrTail = '';
    this.internalSeq = 0;
    this.pendingRpc = new Map();
    this.pendingServerRequests = new Map();
    this.pendingPermission = null;
    this.pendingElicitation = null;
    this.subscribers = new Set();
    this.loadedSessionId = null;
    this.lastLoadResult = null;
    this.initResult = null;
    this.initPromise = null;
    this.inFlightPrompt = null;
    this.activeTool = '';
    this.wasCancelled = false;
    this.exited = false;
    this.terminating = false;
    this.idleTimer = null;
    this.lastActivityEmitMs = 0;

    this.spawnPromise = this.#spawnProcess();
  }

  async #spawnProcess() {
    this.proxy = await resolveIsolatedProxy({ allowEphemeral: true });
    if (this.terminating || this.exited) {
      await this.proxy.cleanup();
      throw new Error('ACP worker cancelled during startup');
    }

    const env = { ...process.env, AG_MOBILE_BRIDGE_CHILD: '1' };
    if (this.proxy.proxyUrl) {
      env.HTTP_PROXY = this.proxy.proxyUrl;
      env.HTTPS_PROXY = this.proxy.proxyUrl;
    }

    const child = spawn(
      this.bin,
      ['acp', '--app-data-dir', this.appDataDir, '--dangerously-skip-permissions'],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    this.pid = child.pid || null;
    this.onLog('worker_spawn', {
      surface: this.surface,
      sessionId: this.loadedSessionId,
      pid: this.pid,
      detail: `appDataDir=${this.appDataDir}`,
    });

    child.stdout.on('data', (chunk) => {
      this.stdoutBuf += chunk.toString('utf8');
      let nlIdx;
      while ((nlIdx = this.stdoutBuf.indexOf('\n')) !== -1) {
        const rawLine = this.stdoutBuf.slice(0, nlIdx).trim();
        this.stdoutBuf = this.stdoutBuf.slice(nlIdx + 1);
        if (!rawLine) continue;
        this.#handleStdoutLine(rawLine);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.stderrTail = (this.stderrTail + text).slice(-MAX_STDERR_TAIL_CHARS);
      this.stderrBuf += text;
      let nlIdx;
      while ((nlIdx = this.stderrBuf.indexOf('\n')) !== -1) {
        const line = this.stderrBuf.slice(0, nlIdx).trim();
        this.stderrBuf = this.stderrBuf.slice(nlIdx + 1);
        if (line) {
          this.onLog('worker_stderr', {
            surface: this.surface,
            sessionId: this.loadedSessionId,
            pid: this.pid,
            detail: line,
          });
        }
      }
    });

    child.on('exit', (code, signal) => {
      this.#handleExit({ code, signal, errMsg: '' });
    });

    child.on('error', (err) => {
      this.#handleExit({ code: null, signal: null, errMsg: err?.message || 'spawn error' });
    });

    return child;
  }

  #emitActivityThrottled() {
    const now = Date.now();
    if (now - this.lastActivityEmitMs >= 1000) {
      this.lastActivityEmitMs = now;
      if (typeof this.onActivity === 'function') this.onActivity();
    }
  }

  #handleStdoutLine(rawLine) {
    const normalized = normalizeAcpOutboundLine(rawLine);
    let msg;
    try {
      msg = JSON.parse(normalized);
    } catch {
      return;
    }

    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const entry = this.pendingRpc.get(msg.id);
      if (entry) {
        this.pendingRpc.delete(msg.id);
        entry.resolve({ result: msg.result, error: msg.error });
      }
      this.#emitActivityThrottled();
      return;
    }

    if (msg.id !== undefined && msg.id !== null && typeof msg.method === 'string') {
      this.pendingServerRequests.set(String(msg.id), msg);
      if (msg.method === 'session/request_permission') {
        this.pendingPermission = msg;
        this.onLog('permission_request', {
          surface: this.surface,
          sessionId: this.loadedSessionId,
          pid: this.pid,
          detail: msg.params?.toolCall?.title || msg.params?.toolCall?.kind || '',
        });
        this.onStateChange?.('permission', { sessionId: this.loadedSessionId });
      } else if (msg.method === 'elicitation/create') {
        this.pendingElicitation = msg;
        this.onLog('elicitation_request', {
          surface: this.surface,
          sessionId: this.loadedSessionId,
          pid: this.pid,
          detail: String(msg.params?.message || '').slice(0, 120),
        });
        this.onStateChange?.('elicitation', { sessionId: this.loadedSessionId });
      }
      for (const peer of this.subscribers) {
        if (!peer.closed) peer.sendText(normalized);
      }
      this.#emitActivityThrottled();
      return;
    }

    if (typeof msg.method === 'string') {
      const now = Date.now();
      if (this.inFlightPrompt) {
        this.inFlightPrompt.updatedAtMs = now;
      }
      if (msg.method === 'session/update') {
        const upd = msg.params?.update;
        const kind = upd?.sessionUpdate;
        if (kind === 'tool_call' || kind === 'tool_call_update') {
          const toolName = String(upd.title || upd.kind || '');
          if (toolName) {
            this.activeTool = toolName;
          }
          if (kind === 'tool_call') {
            this.onStateChange?.('tool_call', { sessionId: this.loadedSessionId });
          }
        } else if (kind === 'agent_message_chunk' && this.inFlightPrompt) {
          const text = upd?.content?.text;
          if (typeof text === 'string' && text.length > 0) {
            const combined = this.inFlightPrompt.partialAssistantText + text;
            this.inFlightPrompt.partialAssistantText = combined.length > MAX_PARTIAL_ASSISTANT_CHARS
              ? combined.slice(-MAX_PARTIAL_ASSISTANT_CHARS)
              : combined;
          }
        }
      }
      for (const peer of this.subscribers) {
        if (!peer.closed) peer.sendText(normalized);
      }
      this.#emitActivityThrottled();
    }
  }

  #handleExit({ code, signal, errMsg }) {
    if (this.exited) return;
    this.exited = true;
    this.disarmIdleTimer();

    const rem = this.stderrBuf.trim();
    if (rem) {
      this.onLog('worker_stderr', {
        surface: this.surface,
        sessionId: this.loadedSessionId,
        pid: this.pid,
        detail: rem,
      });
      this.stderrBuf = '';
    }

    const hadInFlight = Boolean(this.inFlightPrompt);
    const wasCancelled = this.wasCancelled;
    const failureRecord = (hadInFlight && !wasCancelled && !this.terminating && this.loadedSessionId)
      ? {
          exitCode: code,
          signal: signal || null,
          stderrTail: this.stderrTail || errMsg || `ACP exited cleanly or with code ${code ?? signal ?? 'unknown'} before turn completed`,
          atMs: Date.now(),
        }
      : null;

    this.onLog('worker_exit', {
      surface: this.surface,
      sessionId: this.loadedSessionId,
      pid: this.pid,
      detail: `code=${code ?? 'null'} signal=${signal ?? 'null'} err=${errMsg || ''} hadInFlight=${hadInFlight}`,
    });

    this.inFlightPrompt = null;
    this.pendingPermission = null;
    this.pendingElicitation = null;
    this.activeTool = '';
    this.pendingServerRequests.clear();

    const exitErr = new Error(errMsg || `ACP worker exited (${code ?? signal ?? 'signal'})`);
    for (const entry of this.pendingRpc.values()) {
      entry.reject(exitErr);
    }
    this.pendingRpc.clear();

    this.proxy.cleanup().catch(() => {});
    this.onWorkerExit?.(this, { failureRecord });
  }

  subscribe(peer) {
    this.subscribers.add(peer);
    this.disarmIdleTimer();
  }

  unsubscribe(peer) {
    this.subscribers.delete(peer);
    this.armIdleTimer();
  }

  disarmIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  armIdleTimer() {
    if (this.exited || this.terminating || this.inFlightPrompt || this.subscribers.size > 0 || !this.idleTtlMs) {
      return;
    }
    this.disarmIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.inFlightPrompt && this.subscribers.size === 0 && !this.exited) {
        this.terminate('idle_ttl').catch(() => {});
      }
    }, this.idleTtlMs);
    this.idleTimer.unref?.();
  }

  async ensureInitialized(clientInitParams) {
    if (this.initResult) return this.initResult;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await this.spawnPromise;
      const baseCaps = (clientInitParams?.clientCapabilities && typeof clientInitParams.clientCapabilities === 'object')
        ? clientInitParams.clientCapabilities
        : {};
      const params = {
        protocolVersion: 1,
        ...(clientInitParams || {}),
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          ...baseCaps,
          elicitation: {
            form: {},
            ...(baseCaps.elicitation && typeof baseCaps.elicitation === 'object' ? baseCaps.elicitation : {}),
          },
        },
        clientInfo: clientInitParams?.clientInfo || { name: 'ag-mobile-bridge', version: '0.1.0' },
      };
      const { result, error } = await this.call('initialize', params);
      if (error) {
        throw new Error(error.message || 'ACP initialize failed');
      }
      this.initResult = result || {};
      return this.initResult;
    })();

    try {
      return await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      throw err;
    }
  }

  async call(method, params) {
    await this.spawnPromise;
    if (this.exited || !this.child || this.child.exitCode !== null || !this.child.stdin?.writable) {
      throw new Error('ACP worker process is not running');
    }

    const internalId = ++this.internalSeq;
    const payload = { jsonrpc: '2.0', id: internalId, method };
    if (params !== undefined) payload.params = params;

    return new Promise((resolve, reject) => {
      this.pendingRpc.set(internalId, { method, resolve, reject });
      try {
        this.child.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        this.pendingRpc.delete(internalId);
        reject(err);
      }
    });
  }

  sendRawNotification(method, params) {
    if (this.exited || !this.child || this.child.exitCode !== null || !this.child.stdin?.writable) {
      return false;
    }
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    try {
      this.child.stdin.write(JSON.stringify(payload) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  sendClientResponse(msg) {
    const key = String(msg.id);
    if (!this.pendingServerRequests.delete(key)) return false;
    let resolvedEvent = 'permission_resolved';
    if (this.pendingPermission && String(this.pendingPermission.id) === key) {
      this.pendingPermission = null;
    }
    if (this.pendingElicitation && String(this.pendingElicitation.id) === key) {
      this.pendingElicitation = null;
      resolvedEvent = 'elicitation_resolved';
    }
    if (this.exited || !this.child || this.child.exitCode !== null || !this.child.stdin?.writable) {
      return false;
    }
    try {
      this.child.stdin.write(JSON.stringify(msg) + '\n');
      this.onLog(resolvedEvent, {
        surface: this.surface,
        sessionId: this.loadedSessionId,
        pid: this.pid,
      });
      this.onStateChange?.(resolvedEvent, { sessionId: this.loadedSessionId });
      return true;
    } catch {
      return false;
    }
  }

  async terminate(reason = 'shutdown') {
    if (this.terminating) return;
    this.terminating = true;
    this.disarmIdleTimer();
    this.onLog('worker_terminate', {
      surface: this.surface,
      sessionId: this.loadedSessionId,
      pid: this.pid,
      detail: reason,
    });
    try {
      await this.spawnPromise.catch(() => {});
      if (this.child && this.child.exitCode === null && !this.child.killed) {
        this.child.kill('SIGTERM');
        const c = this.child;
        const killer = setTimeout(() => {
          try { if (c.exitCode === null) c.kill('SIGKILL'); } catch {}
        }, 400);
        killer.unref?.();
      }
    } catch {}
    await this.proxy.cleanup().catch(() => {});
  }
}

/**
 * Shared manager of detached `agy acp` workers across reconnecting mobile WebSockets.
 * Active prompts survive WebSocket disconnects and re-attach seamlessly on reconnect.
 */
export function createAcpSessionManager({
  agyBin,
  stateDir,
  handoffStore,
  idleTtlMs = 600_000,
  onStateChange,
  onActivity,
} = {}) {
  const bin = resolveAgyBinary(agyBin);
  const appendAudit = createAuditLogger(stateDir);
  const workersBySession = new Map();
  const idleWorkersByDir = new Map();
  const lastInitParamsByDir = new Map();
  const lastInitResultByDir = new Map();
  const recentFailures = new Map();
  const allWorkers = new Set();
  let isShuttingDown = false;

  const sessionKey = (appDataDir, sessionId) => `${appDataDir}:${sessionId}`;

  const removeFromIdle = (worker) => {
    const list = idleWorkersByDir.get(worker.appDataDir);
    if (!list) return;
    const idx = list.indexOf(worker);
    if (idx !== -1) list.splice(idx, 1);
  };

  const addToIdle = (worker) => {
    if (isShuttingDown || worker.exited || worker.loadedSessionId !== null) return;
    let list = idleWorkersByDir.get(worker.appDataDir);
    if (!list) {
      list = [];
      idleWorkersByDir.set(worker.appDataDir, list);
    }
    if (!list.includes(worker)) {
      list.push(worker);
    }
    worker.armIdleTimer();
  };

  const spawnWorker = (appDataDir) => {
    const worker = new AcpWorker({
      bin,
      appDataDir,
      idleTtlMs,
      onLog: appendAudit,
      onStateChange,
      onActivity,
      onWorkerExit: (w, { failureRecord }) => {
        allWorkers.delete(w);
        removeFromIdle(w);
        if (w.loadedSessionId) {
          const k = sessionKey(w.appDataDir, w.loadedSessionId);
          if (workersBySession.get(k) === w) {
            workersBySession.delete(k);
          }
          if (failureRecord) {
            recentFailures.set(w.loadedSessionId, failureRecord);
          }
          onStateChange?.('worker_exit', { sessionId: w.loadedSessionId });
        }
      },
    });
    allWorkers.add(worker);
    return worker;
  };

  const peekAliveIdleWorker = (appDataDir) => {
    const list = idleWorkersByDir.get(appDataDir);
    if (!list) return null;
    while (list.length > 0) {
      const candidate = list[list.length - 1];
      if (!candidate.exited && !candidate.terminating && candidate.loadedSessionId === null) {
        return candidate;
      }
      list.pop();
    }
    return null;
  };

  const popAliveIdleWorker = (appDataDir) => {
    const list = idleWorkersByDir.get(appDataDir);
    if (!list) return null;
    while (list.length > 0) {
      const candidate = list.pop();
      if (!candidate.exited && !candidate.terminating && candidate.loadedSessionId === null) {
        candidate.disarmIdleTimer();
        return candidate;
      }
    }
    return null;
  };

  const acquireInitializedWorker = async (appDataDir) => {
    let worker = popAliveIdleWorker(appDataDir);
    if (!worker) {
      worker = spawnWorker(appDataDir);
    }
    const initResult = await worker.ensureInitialized(lastInitParamsByDir.get(appDataDir));
    lastInitResultByDir.set(appDataDir, initResult);
    return worker;
  };

  const findAnyAliveWorkerForDir = (appDataDir) => {
    const idle = peekAliveIdleWorker(appDataDir);
    if (idle) return idle;
    for (const w of allWorkers) {
      if (w.appDataDir === appDataDir && !w.exited && !w.terminating) {
        return w;
      }
    }
    return null;
  };

  const replySuccess = (peer, id, result) => {
    if (id === undefined || id === null || peer.closed) return;
    peer.sendText(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };

  const replyError = (peer, id, code, message, rawError = null) => {
    if (id === undefined || id === null || peer.closed) return;
    peer.sendText(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: rawError || { code, message },
    }));
  };

  const attachPeer = (wsPeer, { appDataDir = 'antigravity' } = {}) => {
    wsPeer.on('error', () => {});
    const surface = surfaceFromAppDataDir(appDataDir);
    let currentWorker = null;
    let chain = Promise.resolve();

    const switchSubscriber = (nextWorker) => {
      if (currentWorker && currentWorker !== nextWorker) {
        currentWorker.unsubscribe(wsPeer);
      }
      currentWorker = nextWorker;
      if (nextWorker) {
        nextWorker.subscribe(wsPeer);
      }
    };

    const handleQueuedMessage = async (rawLine) => {
      const rewritten = rewriteInboundAcpMessage(rawLine, { handoffStore, stateDir });
      let msg;
      try {
        msg = JSON.parse(rewritten);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      const method = msg.method;
      if (!method) return;

      // Notification without id
      if (msg.id === undefined || msg.id === null) {
        if (currentWorker && !currentWorker.exited) {
          currentWorker.sendRawNotification(method, msg.params);
        }
        return;
      }

      if (method === 'initialize') {
        lastInitParamsByDir.set(appDataDir, msg.params);
        const cachedInit = lastInitResultByDir.get(appDataDir);
        if (cachedInit && findAnyAliveWorkerForDir(appDataDir)) {
          replySuccess(wsPeer, msg.id, cachedInit);
          return;
        }
        let worker = peekAliveIdleWorker(appDataDir);
        const createdNew = !worker;
        if (!worker) {
          worker = spawnWorker(appDataDir);
          addToIdle(worker);
        }
        try {
          const result = await worker.ensureInitialized(msg.params);
          lastInitResultByDir.set(appDataDir, result);
          replySuccess(wsPeer, msg.id, result);
        } catch (err) {
          if (createdNew) removeFromIdle(worker);
          replyError(wsPeer, msg.id, -32000, err.message || 'Initialize failed');
        }
        return;
      }

      if (method === 'session/new') {
        let worker;
        try {
          worker = await acquireInitializedWorker(appDataDir);
          const { result, error } = await worker.call('session/new', msg.params);
          if (error) {
            addToIdle(worker);
            replyError(wsPeer, msg.id, error.code || -32000, error.message || 'session/new failed', error);
            return;
          }
          if (result?.sessionId) {
            worker.loadedSessionId = result.sessionId;
            worker.lastLoadResult = result;
            workersBySession.set(sessionKey(appDataDir, result.sessionId), worker);
            switchSubscriber(worker);
            appendAudit('session_new', { surface, sessionId: result.sessionId, pid: worker.pid });
          } else {
            addToIdle(worker);
          }
          replySuccess(wsPeer, msg.id, result);
        } catch (err) {
          replyError(wsPeer, msg.id, -32000, err.message || 'session/new failed');
        }
        return;
      }

      if (method === 'session/load' || method === 'session/resume') {
        const sessionId = msg.params?.sessionId;
        if (!sessionId) {
          replyError(wsPeer, msg.id, -32602, 'Missing sessionId');
          return;
        }
        const key = sessionKey(appDataDir, sessionId);
        const existing = workersBySession.get(key);
        if (existing && !existing.exited && existing.loadedSessionId === sessionId) {
          switchSubscriber(existing);
          appendAudit('session_reattach', {
            surface,
            sessionId,
            pid: existing.pid,
            detail: existing.inFlightPrompt ? 'in_flight' : 'warm',
          });
          replySuccess(wsPeer, msg.id, existing.lastLoadResult || { sessionId });
          for (const pendingMsg of [existing.pendingPermission, existing.pendingElicitation]) {
            if (!pendingMsg) continue;
            const pendingFrame = JSON.stringify(pendingMsg);
            const resendTimer = setTimeout(() => {
              const stillPending = (
                (existing.pendingPermission && String(existing.pendingPermission.id) === String(pendingMsg.id)) ||
                (existing.pendingElicitation && String(existing.pendingElicitation.id) === String(pendingMsg.id))
              );
              if (!wsPeer.closed && stillPending) {
                wsPeer.sendText(pendingFrame);
              }
            }, 60);
            resendTimer.unref?.();
          }
          return;
        }

        try {
          const worker = await acquireInitializedWorker(appDataDir);
          const supportsResume = Boolean(
            worker.initResult?.agentCapabilities?.sessionCapabilities?.resume ||
            worker.initResult?.agentCapabilities?.session_capabilities?.resume,
          );
          let callMethod = (method === 'session/resume' && supportsResume) ? 'session/resume' : 'session/load';
          let rpcRes = await worker.call(callMethod, msg.params);
          if (rpcRes.error && callMethod === 'session/resume') {
            callMethod = 'session/load';
            rpcRes = await worker.call('session/load', msg.params);
          }
          const { result, error } = rpcRes;
          if (error) {
            addToIdle(worker);
            replyError(wsPeer, msg.id, error.code || -32000, error.message || `${callMethod} failed`, error);
            return;
          }
          worker.loadedSessionId = sessionId;
          worker.lastLoadResult = result || { sessionId };
          workersBySession.set(key, worker);
          switchSubscriber(worker);
          appendAudit(callMethod === 'session/resume' ? 'session_resume' : 'session_load', { surface, sessionId, pid: worker.pid });
          replySuccess(wsPeer, msg.id, result || { sessionId });
        } catch (err) {
          replyError(wsPeer, msg.id, -32000, err.message || `${method} failed`);
        }
        return;
      }

      if (method === 'session/prompt') {
        const sessionId = msg.params?.sessionId || currentWorker?.loadedSessionId;
        if (!sessionId) {
          replyError(wsPeer, msg.id, -32602, 'Missing sessionId');
          return;
        }
        const key = sessionKey(appDataDir, sessionId);
        let worker = workersBySession.get(key);
        if (!worker || worker.exited) {
          try {
            worker = await acquireInitializedWorker(appDataDir);
            worker.loadedSessionId = sessionId;
            workersBySession.set(key, worker);
          } catch (err) {
            replyError(wsPeer, msg.id, -32000, err.message || 'Failed to acquire worker for prompt');
            return;
          }
        }

        if (worker.inFlightPrompt) {
          replyError(wsPeer, msg.id, -32000, 'Another prompt is already running for this session');
          return;
        }

        switchSubscriber(worker);
        recentFailures.delete(sessionId);
        worker.wasCancelled = false;
        const startedAtMs = Date.now();
        worker.inFlightPrompt = {
          startedAtMs,
          updatedAtMs: startedAtMs,
          partialAssistantText: '',
        };
        worker.activeTool = '';
        worker.disarmIdleTimer();
        appendAudit('prompt_start', { surface, sessionId, pid: worker.pid });
        onStateChange?.('prompt_started', { sessionId });

        // Do NOT block the peer setup/control queue while prompt executes; cancel and permission replies must pass freely.
        worker.call('session/prompt', msg.params).then(
          ({ result, error }) => {
            worker.inFlightPrompt = null;
            worker.activeTool = '';
            worker.pendingPermission = null;
            worker.pendingElicitation = null;
            worker.armIdleTimer();
            appendAudit('prompt_done', {
              surface,
              sessionId,
              pid: worker.pid,
              detail: error ? (error.message || 'rpc_error') : (result?.stopReason || 'end_turn'),
            });
            if (error) {
              replyError(wsPeer, msg.id, error.code || -32000, error.message || 'Prompt failed', error);
            } else {
              replySuccess(wsPeer, msg.id, result);
            }
            onStateChange?.('prompt_completed', { sessionId });
          },
          (err) => {
            worker.inFlightPrompt = null;
            worker.activeTool = '';
            worker.pendingPermission = null;
            worker.pendingElicitation = null;
            appendAudit('prompt_crashed', {
              surface,
              sessionId,
              pid: worker.pid,
              detail: err?.message || 'worker_terminated',
            });
            replyError(wsPeer, msg.id, -32001, err?.message || 'ACP worker terminated unexpectedly');
            onStateChange?.('prompt_completed', { sessionId });
          },
        );
        return;
      }

      // session/list, session/set_mode, session/set_config_option, or other JSON-RPC requests
      const targetSid = msg.params?.sessionId;
      let targetWorker = targetSid ? workersBySession.get(sessionKey(appDataDir, targetSid)) : null;
      let borrowedIdle = false;
      if (!targetWorker || targetWorker.exited) {
        if (currentWorker && !currentWorker.exited) {
          targetWorker = currentWorker;
        } else {
          targetWorker = popAliveIdleWorker(appDataDir);
          if (!targetWorker) {
            try {
              targetWorker = await acquireInitializedWorker(appDataDir);
            } catch (err) {
              replyError(wsPeer, msg.id, -32000, err.message || 'ACP worker unavailable');
              return;
            }
          }
          borrowedIdle = true;
        }
      }

      try {
        const { result, error } = await targetWorker.call(method, msg.params);
        if (borrowedIdle && targetWorker.loadedSessionId === null) {
          addToIdle(targetWorker);
        }
        if (error) {
          replyError(wsPeer, msg.id, error.code || -32000, error.message || `${method} failed`, error);
        } else {
          replySuccess(wsPeer, msg.id, result);
        }
      } catch (err) {
        replyError(wsPeer, msg.id, -32000, err.message || `${method} failed`);
      }
    };

    wsPeer.on('error', () => {});
    wsPeer.on('text', (text) => {
      const lines = text.split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        // 1. Client JSON-RPC response (e.g. permission approval): route exclusively to the attached session worker.
        if (parsed && parsed.id !== undefined && parsed.id !== null && !parsed.method) {
          if (currentWorker && !currentWorker.exited) {
            currentWorker.sendClientResponse(parsed);
          }
          continue;
        }

        // 2. session/cancel: dispatch immediately so it can interrupt an in-flight turn.
        if (parsed && parsed.method === 'session/cancel') {
          const sid = parsed.params?.sessionId;
          const target = (sid && workersBySession.get(sessionKey(appDataDir, sid))) || currentWorker;
          if (target && !target.exited) {
            target.wasCancelled = true;
            appendAudit('session_cancel', { surface, sessionId: sid || target.loadedSessionId, pid: target.pid });
            target.call('session/cancel', parsed.params).then(
              ({ result, error }) => {
                if (parsed.id !== undefined && parsed.id !== null) {
                  if (error) replyError(wsPeer, parsed.id, error.code || -32000, error.message || 'Cancel failed', error);
                  else replySuccess(wsPeer, parsed.id, result ?? { cancelled: true });
                }
              },
              (err) => {
                if (parsed.id !== undefined && parsed.id !== null) {
                  replyError(wsPeer, parsed.id, -32000, err?.message || 'Cancel failed');
                }
              },
            );
          } else if (parsed.id !== undefined && parsed.id !== null) {
            replySuccess(wsPeer, parsed.id, { cancelled: false });
          }
          continue;
        }

        // 3. Serialize setup / load / prompt initiation strictly in arrival order per WebSocket.
        chain = chain
          .then(() => handleQueuedMessage(line))
          .catch(() => {});
      }
    });

    wsPeer.on('close', () => {
      if (currentWorker) {
        const sid = currentWorker.loadedSessionId;
        const pid = currentWorker.pid;
        const inFlight = Boolean(currentWorker.inFlightPrompt);
        currentWorker.unsubscribe(wsPeer);
        currentWorker = null;
        appendAudit('ws_close', {
          surface,
          sessionId: sid,
          pid,
          detail: inFlight ? 'detached_while_running' : 'detached_idle',
        });
      }
    });

    return () => {
      if (currentWorker) {
        currentWorker.unsubscribe(wsPeer);
        currentWorker = null;
      }
    };
  };

  const getSessionStates = () => {
    const out = {};
    for (const [sessionId, failure] of recentFailures.entries()) {
      out[sessionId] = {
        inFlight: false,
        status: 'error',
        activeTool: '',
        startedAtMs: failure.atMs,
        updatedAtMs: failure.atMs,
        partialAssistantText: '',
        lastFailure: failure,
      };
    }
    for (const worker of allWorkers) {
      if (worker.exited || !worker.loadedSessionId) continue;
      const inFlight = worker.inFlightPrompt;
      out[worker.loadedSessionId] = {
        inFlight: Boolean(inFlight),
        status: (worker.pendingPermission || worker.pendingElicitation) ? 'question' : (inFlight ? 'running' : 'warm'),
        activeTool: worker.activeTool || '',
        startedAtMs: inFlight?.startedAtMs || 0,
        updatedAtMs: inFlight?.updatedAtMs || 0,
        partialAssistantText: inFlight?.partialAssistantText || '',
        pendingPermission: worker.pendingPermission || null,
        pendingElicitation: worker.pendingElicitation || null,
        lastFailure: recentFailures.get(worker.loadedSessionId) || null,
      };
    }
    return out;
  };

  const getRuntimeStats = () => {
    let activeWorkers = 0;
    const inFlightSessionIds = [];
    for (const worker of allWorkers) {
      if (worker.exited || worker.terminating) continue;
      activeWorkers += 1;
      if (worker.inFlightPrompt) {
        inFlightSessionIds.push(worker.loadedSessionId || 'pending');
      }
    }
    return {
      activeWorkers,
      inFlightCount: inFlightSessionIds.length,
      inFlightSessionIds,
    };
  };

  const shutdown = async () => {
    isShuttingDown = true;
    const workers = Array.from(allWorkers);
    await Promise.all(workers.map((w) => w.terminate('manager_shutdown')));
    allWorkers.clear();
    workersBySession.clear();
    idleWorkersByDir.clear();
  };

  return {
    attachPeer,
    getSessionStates,
    getRuntimeStats,
    shutdown,
  };
}

/**
 * Compatibility helper for standalone WebSocket-to-ACP bridging outside shared server manager.
 */
export async function bridgeWebSocketToAcp(wsPeer, { agyBin, appDataDir = 'antigravity', handoffStore, onActivity, stateDir } = {}) {
  const manager = createAcpSessionManager({ agyBin, stateDir, handoffStore, onActivity });
  const detach = manager.attachPeer(wsPeer, { appDataDir });
  return async () => {
    detach();
    await manager.shutdown();
  };
}

/**
 * Spawn a fast one-shot `agy acp` process to allocate a new persistent CLI session bound to `cwd`
 * (zero model tokens consumed).
 */
export async function createHeadlessAcpSession({ cwd, agyBin, appDataDir = 'antigravity', timeoutMs = 10000 } = {}) {
  const proxy = await resolveIsolatedProxy({ allowEphemeral: true });
  const env = { ...process.env };
  if (proxy.proxyUrl) {
    env.HTTP_PROXY = proxy.proxyUrl;
    env.HTTPS_PROXY = proxy.proxyUrl;
  }

  const bin = resolveAgyBinary(agyBin);
  const resolvedCwd = decodeWorkspacePath(cwd || os.homedir());

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['acp', '--app-data-dir', appDataDir, '--dangerously-skip-permissions'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    let finished = false;
    let timer = null;

    const finish = async (err, value) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try { if (child.exitCode === null) child.kill('SIGTERM'); } catch {}
      await proxy.cleanup();
      if (err) reject(err);
      else resolve(value);
    };

    timer = setTimeout(() => {
      finish(new Error(`Timed out creating ACP session (${stderr.slice(0, 200)})`));
    }, timeoutMs);

    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      if (!finished) {
        finish(new Error(`agy acp exited prematurely with code ${code}: ${stderr.slice(0, 200)}`));
      }
    });

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) {
            finish(new Error(msg.error.message || 'ACP initialize failed'));
            return;
          }
          child.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'session/new',
            params: { cwd: resolvedCwd, mcpServers: [] },
          }) + '\n');
        } else if (msg.id === 2) {
          if (msg.error) {
            finish(new Error(msg.error.message || 'ACP session/new failed'));
            return;
          }
          const result = msg.result || {};
          if (!result.sessionId) {
            finish(new Error('ACP session/new response missing sessionId'));
            return;
          }
          finish(null, {
            sessionId: result.sessionId,
            cwd: resolvedCwd,
            models: result.models || null,
            modes: result.modes || null,
            configOptions: result.configOptions || [],
          });
        }
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'ag-mobile-bridge', version: '0.1.0' },
      },
    }) + '\n');
  });
}

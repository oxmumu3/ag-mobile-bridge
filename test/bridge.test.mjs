import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildPairUri, detectTailscaleFunnelUrl, writeJsonAtomic } from '../lib/config.mjs';
import { generateQrMatrix, renderQrHalfBlocks } from '../lib/qr-terminal.mjs';
import {
  decryptRendezvousBeacon,
  deriveRendezvousTopic,
  encryptRendezvousBeacon,
  extractLatestRendezvousBeacon,
  startRendezvousPublisher,
} from '../lib/rendezvous.mjs';
import { startBridgeServer } from '../lib/server.mjs';
import { rewriteInboundAcpMessage } from '../lib/acp-hub.mjs';
import { cleanLineNoise, parseTranscriptConversation } from '../lib/sessions.mjs';
import { browseWorkspaceDir, decodeWorkspacePath } from '../lib/workspaces.mjs';

function makeTempFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mobile-test-'));
  const homeDir = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const desktopBrain = path.join(homeDir, '.gemini', 'antigravity', 'brain');
  const cliBrain = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain');
  const dbPath = path.join(homeDir, '.gemini', 'antigravity', 'conversation_summaries.db');

  const wsCN = path.join(homeDir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', '副业');
  const wsAgent = path.join(homeDir, 'Repos', 'demo-agent');
  fs.mkdirSync(wsCN, { recursive: true });
  fs.mkdirSync(wsAgent, { recursive: true });
  fs.writeFileSync(path.join(wsAgent, 'AGENTS.md'), '# Rules\n');

  const convDesktopId = '11111111-2222-3333-4444-555555555555';
  const convSubagentId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const convBrainDir = path.join(desktopBrain, convDesktopId);
  const convLogsDir = path.join(convBrainDir, '.system_generated', 'logs');
  fs.mkdirSync(convLogsDir, { recursive: true });

  const subLogsDir = path.join(desktopBrain, convSubagentId, '.system_generated', 'logs');
  fs.mkdirSync(subLogsDir, { recursive: true });
  fs.writeFileSync(
    path.join(subLogsDir, 'transcript.jsonl'),
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'subtask' }) + '\n',
  );

  // Sample transcript + artifacts (.html & .mp4)
  const steps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nReview Fimo billing flow and render preview\n</USER_REQUEST>',
      created_at: '2026-11-15T10:00:00Z',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      created_at: '2026-11-15T10:00:10Z',
    },
    {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      content: 'Billing preview **ready**: all 7 checks passed. SHA256 `abcdef0123456789abcdef0123456789`',
      tool_calls: [],
      created_at: '2026-11-15T10:00:25Z',
    },
  ];
  fs.writeFileSync(
    path.join(convLogsDir, 'transcript.jsonl'),
    steps.map((s) => JSON.stringify(s)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(convBrainDir, 'preview.html'), '<h1>Hello Mobile</h1>');
  // 4096-byte synthetic mp4 payload for HTTP 206 byte range verification
  const fakeMp4 = Buffer.alloc(4096);
  fakeMp4.write('ftypisom', 4, 'ascii');
  fakeMp4.fill(0x5a, 128, 256);
  fs.writeFileSync(path.join(convBrainDir, 'clip.mp4'), fakeMp4);

  // Read/write seed SQLite conversation_summaries DB using %-encoded file:// URI
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      workspace_uris TEXT NOT NULL DEFAULT "[]",
      status TEXT NOT NULL DEFAULT "",
      source TEXT NOT NULL DEFAULT "",
      parent_conversation_id TEXT NOT NULL DEFAULT "",
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      not_fully_idle NUMERIC NOT NULL DEFAULT 0,
      killed NUMERIC NOT NULL DEFAULT 0,
      last_modified_time DATETIME NOT NULL DEFAULT ""
    );
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, workspace_uris, status, source, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_modified_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    convDesktopId,
    'Fimo Billing Audit',
    JSON.stringify([`file://${encodeURI(wsCN)}`]),
    'CASCADE_RUN_STATUS_IDLE',
    'desktop',
    '',
    0,
    0,
    0,
    '2026-11-15T10:00:25Z',
  );
  insert.run(
    convSubagentId,
    'Hidden Subagent',
    JSON.stringify([`file://${encodeURI(wsAgent)}`]),
    'CASCADE_RUN_STATUS_IDLE',
    'subagent',
    convDesktopId,
    1,
    0,
    0,
    '2026-11-15T10:00:26Z',
  );
  db.close();

  // Deterministic mock `agy` ACP executable
  const mockAgyPath = path.join(root, 'mock-agy.mjs');
  fs.writeFileSync(
    mockAgyPath,
    `#!/usr/bin/env node
import readline from 'node:readline';
if (process.argv[2] !== 'acp') process.exit(2);
const rl = readline.createInterface({ input: process.stdin });
const fixedMobileId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'Mock AGY', version: '1.0', argv: process.argv.slice(2) } },
    }) + '\\n');
  } else if (req.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { sessionId: fixedMobileId, modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } },
    }) + '\\n');
  } else if (req.method === 'session/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { sessions: [{ sessionId: fixedMobileId, cwd: '/Users/alex/Library/Mobile%20Documents/com~apple~CloudDocs/%E5%89%AF%E4%B8%9A', title: 'Mocked' }] },
    }) + '\\n');
  } else if (req.method === 'session/load') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { sessionId: req.params.sessionId },
    }) + '\\n');
  } else if (req.method === 'session/prompt') {
    const promptText = req.params?.prompt?.[0]?.text || '';
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: req.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ECHO:' + promptText } },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { stopReason: 'end_turn' },
    }) + '\\n');
  }
});
`,
    { mode: 0o755 },
  );

  // Seed config with leading-zero 6-digit PIN `"042910"` to guarantee zero-preservation
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(path.join(stateDir, 'config.json'), {
    instanceId: 'test-instance-id',
    hostName: 'Test-Mac',
    port: 0,
    bearerToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    hmacSecret: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    pin6: '042910',
    pinUpdatedAtMs: Date.now(),
    funnelUrlOverride: '',
  });

  return {
    root,
    homeDir,
    stateDir,
    wsCN,
    wsAgent,
    convDesktopId,
    convSubagentId,
    mockAgyPath,
    brainRoots: [
      { surface: 'desktop', dir: desktopBrain },
      { surface: 'cli', dir: cliBrain },
    ],
    dbPaths: [
      { surface: 'desktop', path: dbPath },
    ],
  };
}

test('LAN 6-digit PIN pairing preserves leading zeros, rate-limits, and rejects proxied headers', async (t) => {
  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  process.env.AG_MOBILE_NO_NOTIFY = '1';

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: fx.mockAgyPath,
    enableBonjour: false,
    enableWatch: false,
  });
  t.after(() => srv.stop());

  const baseUrl = `http://127.0.0.1:${srv.port}`;

  // Reject forwarded traffic (e.g. Tailscale Funnel) from using 6-digit PIN
  const proxiedRes = await fetch(`${baseUrl}/api/pair/pin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.9',
    },
    body: JSON.stringify({ pin: '042910' }),
  });
  assert.equal(proxiedRes.status, 403);

  // Wrong PIN fails and triggers rate-limit after 5 failures
  for (let i = 0; i < 5; i += 1) {
    const bad = await fetch(`${baseUrl}/api/pair/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '999999' }),
    });
    assert.equal(bad.status, 401);
  }
  const throttled = await fetch(`${baseUrl}/api/pair/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '042910' }),
  });
  assert.equal(throttled.status, 429);

  // Verify leading-zero PIN "042910" succeeds cleanly from fresh rate-limit slot (request-pin first)
  const reqPinRes = await fetch(`${baseUrl}/api/pair/request-pin`, { method: 'POST' });
  assert.equal(reqPinRes.status, 200);
});

test('QR code PNG generation round-trips through Apple Vision VNDetectBarcodesRequest', async (t) => {
  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const uri = buildPairUri({
    hostName: 'Studio Mac',
    lanUrl: 'http://192.168.31.18:58470',
    funnelUrl: 'https://studio-mac.tailnet.ts.net',
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  });
  const qrPng = path.join(fx.root, 'pair-qr.png');
  const matrix = generateQrMatrix(uri, { pngOutputPath: qrPng });
  assert.ok(matrix.width >= 21);
  assert.equal(matrix.rows.length, matrix.height);

  const ascii = renderQrHalfBlocks(matrix);
  assert.ok(ascii.includes('█'));

  // Decode PNG using macOS Vision framework via Swift one-shot script
  const swiftSrc = path.join(fx.root, 'decode_qr.swift');
  fs.writeFileSync(
    swiftSrc,
    `import Foundation
import Vision
import AppKit
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let req = VNDetectBarcodesRequest()
req.usesCPUOnly = true
let handler = VNImageRequestHandler(url: url, options: [:])
try handler.perform([req])
let payload = req.results?.first?.payloadStringValue ?? ""
print(payload)
`,
  );
  const rawOut = execFileSync('/usr/bin/swift', [swiftSrc, qrPng], { encoding: 'utf8', timeout: 60000 }).trim();
  const decoded = rawOut.split(/\r?\n/).find((line) => line.startsWith('agmobile://')) || rawOut;
  assert.equal(decoded, uri);
});

test('SQLite read-only workspace decoding, directory confinement, artifact range 206, and desktop handoff ACP injection', async (t) => {
  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  assert.equal(
    decodeWorkspacePath('file:///Users/alex/Library/Mobile%20Documents/com~apple~CloudDocs/%E5%89%AF%E4%B8%9A'),
    '/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/副业',
  );

  assert.throws(() => browseWorkspaceDir('/etc', { homeDir: fx.homeDir }), (err) => err.statusCode === 403);
  const homeBrowse = browseWorkspaceDir(fx.homeDir, { homeDir: fx.homeDir });
  assert.ok(homeBrowse.directories.some((d) => d.name === 'Repos'));

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: fx.mockAgyPath,
    enableBonjour: false,
    enableWatch: false,
  });
  t.after(() => srv.stop());

  const baseUrl = `http://127.0.0.1:${srv.port}`;

  // Successful PIN auth (127.0.0.1 allowed directly)
  const pairRes = await fetch(`${baseUrl}/api/pair/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '042910' }),
  });
  assert.equal(pairRes.status, 200);
  const pairBody = await pairRes.json();
  const authHeaders = { Authorization: `Bearer ${pairBody.token}` };

  // Overview excludes subagent & decodes workspace path
  const overviewRes = await fetch(`${baseUrl}/api/overview`, { headers: authHeaders });
  assert.equal(overviewRes.status, 200);
  const overview = await overviewRes.json();
  assert.equal(overview.sessions.some((s) => s.id === fx.convSubagentId), false);
  const desktopSess = overview.sessions.find((s) => s.id === fx.convDesktopId);
  assert.ok(desktopSess);
  assert.equal(desktopSess.origin, 'desktop');
  assert.equal(desktopSess.workspacePath, fx.wsCN);
  assert.equal(desktopSess.workspaceName, '副业');
  assert.ok(!desktopSess.summary.includes('abcdef0123456789')); // hashes stripped

  // Artifact 206 byte-range streaming + traversal block
  const mp4Art = desktopSess.artifacts.find((a) => a.name === 'clip.mp4');
  assert.ok(mp4Art?.previewPath);
  const rangeRes = await fetch(`${baseUrl}${mp4Art.previewPath}`, {
    headers: { Range: 'bytes=128-255' },
  });
  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers.get('content-range'), 'bytes 128-255/4096');
  const chunk = Buffer.from(await rangeRes.arrayBuffer());
  assert.equal(chunk.length, 128);
  assert.equal(chunk[0], 0x5a);

  const traversalTicketPath = mp4Art.previewPath.replace('/clip.mp4', '/..%2F..%2Fetc%2Fpasswd');
  const traversalRes = await fetch(`${baseUrl}${traversalTicketPath}`);
  assert.ok(traversalRes.status === 403 || traversalRes.status === 404);

  // Desktop -> Mobile handoff marks original session as handed_off & creates mobile_handoff session
  const handoffRes = await fetch(`${baseUrl}/api/sessions/${fx.convDesktopId}/handoff`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(handoffRes.status, 200);
  const handoffBody = await handoffRes.json();
  assert.equal(handoffBody.ok, true);
  assert.equal(handoffBody.mobileSessionId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(handoffBody.workspacePath, fx.wsCN);

  const overviewAfter = await (await fetch(`${baseUrl}/api/overview`, { headers: authHeaders })).json();
  const superseded = overviewAfter.sessions.find((s) => s.id === fx.convDesktopId);
  const mobileChild = overviewAfter.sessions.find((s) => s.id === handoffBody.mobileSessionId);
  assert.equal(superseded.status, 'handed_off');
  assert.equal(superseded.handedOffTo, handoffBody.mobileSessionId);
  assert.equal(mobileChild.origin, 'mobile_handoff');
  assert.equal(mobileChild.handoffSource.desktopId, fx.convDesktopId);

  // WebSocket /acp/ws normalizes session/list cwd and injects <DESKTOP_HANDOFF_CONTEXT> on first prompt
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/acp/ws?token=${pairBody.token}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const received = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    const parsed = JSON.parse(ev.data);
    if (waiters.length > 0) waiters.shift()(parsed);
    else received.push(parsed);
  });
  const nextMessage = () => new Promise((resolve) => {
    if (received.length > 0) resolve(received.shift());
    else waiters.push(resolve);
  });

  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }));
  const initResp = await nextMessage();
  assert.equal(initResp.id, 1);
  assert.deepEqual(initResp.result.agentInfo.argv, ['acp', '--app-data-dir', 'antigravity', '--dangerously-skip-permissions']);

  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/list', params: {} }));
  const listResp = await nextMessage();
  assert.equal(listResp.result.sessions[0].cwd, '/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/副业');

  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: {
      sessionId: handoffBody.mobileSessionId,
      prompt: [{ type: 'text', text: 'Ship TestFlight build' }],
    },
  }));

  const chunkMsg = await nextMessage();
  const doneMsg = await nextMessage();
  assert.equal(doneMsg.id, 3);
  const echoed = chunkMsg.params.update.content.text;
  assert.ok(echoed.includes('<DESKTOP_HANDOFF_CONTEXT'));
  assert.ok(echoed.includes('Billing preview'));
  assert.ok(echoed.includes('Ship TestFlight build'));

  ws.close();

  // Verify ?surface=cli preserves backwards-compatibility with antigravity-cli store
  const wsCli = new WebSocket(`ws://127.0.0.1:${srv.port}/acp/ws?token=${pairBody.token}&surface=cli`);
  await new Promise((resolve, reject) => {
    wsCli.addEventListener('open', resolve, { once: true });
    wsCli.addEventListener('error', reject, { once: true });
  });
  const cliInit = await new Promise((resolve) => {
    wsCli.addEventListener('message', (ev) => resolve(JSON.parse(ev.data)), { once: true });
    wsCli.send(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: 1 } }));
  });
  assert.deepEqual(cliInit.result.agentInfo.argv, ['acp', '--app-data-dir', 'antigravity-cli', '--dangerously-skip-permissions']);
  wsCli.close();
});

test('cleanLineNoise strips Markdown block/inline markers while preserving identifiers', () => {
  assert.equal(cleanLineNoise('### **Build** & *Deploy* in `app_data_dir`'), 'Build & Deploy in app_data_dir');
  assert.equal(cleanLineNoise('> [!IMPORTANT] __Never__ expose ~~old~~ secrets'), 'Never expose old secrets');
  assert.equal(cleanLineNoise('- [x] _Verified_ snake_case_var cleanly'), 'Verified snake_case_var cleanly');
  assert.equal(cleanLineNoise('2. Updated *Tests* and `config.json`'), 'Updated Tests and config.json');
});

test('Rendezvous beacon derives deterministic topic, detects tampering, and publishes/polls NDJSON', async (t) => {
  const token = 'fixed-cross-lang-bearer-token-2026';
  const expectedTopic = 'agmb1-9e95df939aa7b6cfdb1295fee1aac067';
  assert.equal(deriveRendezvousTopic(token), expectedTopic);

  const wire = encryptRendezvousBeacon(token, {
    funnelUrl: 'https://test-tunnel.trycloudflare.com',
    lanUrl: 'http://192.168.31.181:58470',
    hostName: 'Test Mac',
    instanceId: 'inst-xyz',
    updatedAtMs: 1700000000100,
  });
  assert.ok(wire.startsWith('agbox1:'));

  const decoded = decryptRendezvousBeacon(token, wire);
  assert.equal(decoded.funnelUrl, 'https://test-tunnel.trycloudflare.com');
  assert.equal(decoded.lanUrl, 'http://192.168.31.181:58470');
  assert.equal(decoded.hostName, 'Test Mac');
  assert.equal(decoded.instanceId, 'inst-xyz');

  // Tamper detection (flip a character near end of ciphertext/tag)
  const rawBuf = Buffer.from(wire.slice('agbox1:'.length), 'base64');
  rawBuf[rawBuf.length - 2] ^= 0xff;
  const tamperedWire = `agbox1:${rawBuf.toString('base64')}`;
  assert.throws(() => decryptRendezvousBeacon(token, tamperedWire));
  assert.throws(() => decryptRendezvousBeacon('different-token', wire));

  // Mock ntfy server for publish + NDJSON poll round-trip
  const messagesByTopic = new Map();
  const mockServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const cleanPath = reqUrl.pathname.replace(/^\/+/, '');
    if (req.method === 'POST') {
      const topic = cleanPath;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const msg = Buffer.concat(chunks).toString('utf8');
        const list = messagesByTopic.get(topic) || [];
        list.push({ id: `m-${list.length + 1}`, event: 'message', topic, message: msg });
        messagesByTopic.set(topic, list);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    if (req.method === 'GET' && cleanPath.endsWith('/json')) {
      const topic = cleanPath.slice(0, -'/json'.length);
      const list = messagesByTopic.get(topic) || [];
      const ndjson = list.map((item) => JSON.stringify(item)).join('\n') + '\n';
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(ndjson);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  t.after(() => mockServer.close());
  const mockPort = mockServer.address().port;
  const mockBase = `http://127.0.0.1:${mockPort}`;

  let currentFunnel = 'https://first-url.trycloudflare.com';
  const publisher = startRendezvousPublisher({
    bearerToken: token,
    baseUrl: mockBase,
    refreshIntervalMs: 60_000,
    getPayload: () => ({
      funnelUrl: currentFunnel,
      lanUrl: 'http://192.168.31.181:58470',
      hostName: 'Test Mac',
      instanceId: 'inst-xyz',
      updatedAtMs: currentFunnel.includes('second') ? 2000 : 1000,
    }),
  });
  t.after(() => publisher.stop());

  assert.equal(await publisher.publishNow(), true);
  currentFunnel = 'https://second-url.trycloudflare.com';
  assert.equal(await publisher.publishNow(), true);

  const pollRes = await fetch(`${mockBase}/${expectedTopic}/json?poll=1&since=12h`);
  assert.equal(pollRes.status, 200);
  const ndjsonText = await pollRes.text();
  const latest = extractLatestRendezvousBeacon(token, ndjsonText);
  assert.equal(latest?.funnelUrl, 'https://second-url.trycloudflare.com');
});

test('Detached ACP worker survives mid-turn WebSocket disconnect, streams on re-attach, and reports honest running/interrupted/done status', async (t) => {
  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const desktopBrain = fx.brainRoots[0].dir;
  const interruptedId = '22222222-3333-4444-5555-666666666666';
  const interruptedLogsDir = path.join(desktopBrain, interruptedId, '.system_generated', 'logs');
  fs.mkdirSync(interruptedLogsDir, { recursive: true });
  const twoMinAgoIso = new Date(Date.now() - 120_000).toISOString();
  const threeMinAgoIso = new Date(Date.now() - 180_000).toISOString();
  fs.writeFileSync(
    path.join(interruptedLogsDir, 'transcript.jsonl'),
    [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nOld finished turn\n</USER_REQUEST>', created_at: threeMinAgoIso },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: 'STALE_TURN_1_SUMMARY_SHOULD_NOT_SHOW', tool_calls: [], created_at: threeMinAgoIso },
      { step_index: 2, type: 'USER_INPUT', content: '<USER_REQUEST>\nUpgrade Remotion workbench now\n</USER_REQUEST>', created_at: twoMinAgoIso },
      { step_index: 3, type: 'PLANNER_RESPONSE', content: '', tool_calls: [{ name: 'read_file' }], created_at: twoMinAgoIso },
    ].map((s) => JSON.stringify(s)).join('\n') + '\n',
  );

  // Slow mock agy that writes user step + chunk 1 immediately, sleeps 350ms, then writes chunk 2 + final reply to transcript.jsonl
  const slowMockAgy = path.join(fx.root, 'slow-mock-agy.mjs');
  const activeTranscriptPath = path.join(desktopBrain, fx.convDesktopId, '.system_generated', 'logs', 'transcript.jsonl');
  fs.writeFileSync(
    slowMockAgy,
    `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
process.stderr.write('mock stderr banner\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + '\\n');
  } else if (req.method === 'session/load') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { sessionId: req.params.sessionId } }) + '\\n');
  } else if (req.method === 'session/prompt') {
    const sid = req.params.sessionId;
    const text = req.params?.prompt?.[0]?.text || '';
    const nowIso = new Date().toISOString();
    fs.appendFileSync(${JSON.stringify(activeTranscriptPath)}, JSON.stringify({ step_index: 3, type: 'USER_INPUT', content: '<USER_REQUEST>\\n' + text + '\\n</USER_REQUEST>', created_at: nowIso }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'run_command', kind: 'execute', status: 'in_progress' } },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk-1: ' } } },
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk-2:done' } } },
      }) + '\\n');
      fs.appendFileSync(${JSON.stringify(activeTranscriptPath)}, JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', content: 'chunk-1: chunk-2:done', tool_calls: [], created_at: new Date().toISOString() }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } }) + '\\n');
    }, 350);
  }
});
`,
    { mode: 0o755 },
  );

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: slowMockAgy,
    enableBonjour: false,
    enableWatch: false,
  });
  t.after(() => srv.stop());

  const baseUrl = `http://127.0.0.1:${srv.port}`;
  const pairRes = await fetch(`${baseUrl}/api/pair/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '042910' }),
  });
  const pairBody = await pairRes.json();
  const authHeaders = { Authorization: `Bearer ${pairBody.token}` };

  // 1. Verify honest interrupted status & no stale Turn 1 summary
  const ovBefore = await (await fetch(`${baseUrl}/api/overview`, { headers: authHeaders })).json();
  const interruptedItem = ovBefore.sessions.find((s) => s.id === interruptedId);
  assert.ok(interruptedItem);
  assert.equal(interruptedItem.status, 'interrupted');
  assert.equal(interruptedItem.stepTotal, 0);
  assert.equal(interruptedItem.stepCurrent, 1);
  assert.ok(!interruptedItem.summary.includes('STALE_TURN_1_SUMMARY_SHOULD_NOT_SHOW'));
  assert.ok(interruptedItem.summary.includes('Upgrade Remotion workbench now'));

  const connectWs = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/acp/ws?token=${pairBody.token}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const received = [];
    const waiters = [];
    ws.addEventListener('message', (ev) => {
      const parsed = JSON.parse(ev.data);
      if (waiters.length > 0) waiters.shift()(parsed);
      else received.push(parsed);
    });
    const nextMessage = (timeoutMs = 5000) => new Promise((resolve, reject) => {
      if (received.length > 0) return resolve(received.shift());
      const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), timeoutMs);
      waiters.push((val) => { clearTimeout(timer); resolve(val); });
    });
    return { ws, nextMessage };
  };

  // 2. Connect WS1, start slow turn, verify chunk 1 arrives, then drop WS1 mid-turn
  const c1 = await connectWs();
  c1.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }));
  assert.equal((await c1.nextMessage()).id, 1);
  c1.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: fx.convDesktopId, cwd: fx.wsCN, mcpServers: [] } }));
  assert.equal((await c1.nextMessage()).id, 2);
  c1.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: fx.convDesktopId, prompt: [{ type: 'text', text: 'SLOW_TURN:persist' }] } }));

  const firstUpdate = await c1.nextMessage();
  assert.equal(firstUpdate.params?.update?.sessionUpdate, 'tool_call');
  const secondUpdate = await c1.nextMessage();
  assert.equal(secondUpdate.params?.update?.content?.text, 'chunk-1: ');

  c1.ws.close();
  await new Promise((r) => setTimeout(r, 60));

  // 3. While WS1 is closed, Mac bridge MUST report running + partial text + stepTotal=0
  const ovDuring = await (await fetch(`${baseUrl}/api/overview`, { headers: authHeaders })).json();
  const runningItem = ovDuring.sessions.find((s) => s.id === fx.convDesktopId);
  assert.equal(runningItem.status, 'running');
  assert.equal(runningItem.stepTotal, 0);
  assert.ok(runningItem.summary.includes('chunk-1:'));

  // 4. Reconnect WS2 mid-turn, call initialize -> session/load, and receive live chunk 2
  const c2 = await connectWs();
  c2.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }));
  assert.equal((await c2.nextMessage()).id, 1);
  c2.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: fx.convDesktopId, cwd: fx.wsCN, mcpServers: [] } }));

  let gotLoadResp = false;
  let gotChunk2 = false;
  for (let i = 0; i < 6 && (!gotLoadResp || !gotChunk2); i += 1) {
    const m = await c2.nextMessage(3000);
    if (m.id === 2) gotLoadResp = true;
    if (m.method === 'session/update' && m.params?.update?.content?.text === 'chunk-2:done') gotChunk2 = true;
  }
  assert.equal(gotLoadResp, true);
  assert.equal(gotChunk2, true);
  c2.ws.close();

  // 5. After turn finishes, overview reports done & final summary, and audit log recorded events
  await new Promise((r) => setTimeout(r, 80));
  const ovAfter = await (await fetch(`${baseUrl}/api/overview`, { headers: authHeaders })).json();
  const doneItem = ovAfter.sessions.find((s) => s.id === fx.convDesktopId);
  assert.equal(doneItem.status, 'done');
  assert.ok(doneItem.summary.includes('chunk-1: chunk-2:done'));

  const auditPath = path.join(fx.stateDir, 'logs', 'acp-audit.log');
  assert.equal(fs.existsSync(auditPath), true);
  const auditText = fs.readFileSync(auditPath, 'utf8');
  assert.ok(auditText.includes('prompt_start'));
  assert.ok(auditText.includes('detached_while_running'));
  assert.ok(auditText.includes('session_reattach'));
  assert.ok(auditText.includes('worker_stderr'));
  assert.ok(auditText.includes('prompt_done'));
});

test('parseTranscriptConversation compacts 60 consecutive pure-tool steps into one tool_group with readable details', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-compact-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'transcript.jsonl');

  const lines = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nRefactor chat scroll\n</USER_REQUEST>', created_at: '2026-11-16T00:00:00Z' }),
  ];
  for (let i = 1; i <= 60; i += 1) {
    lines.push(JSON.stringify({
      step_index: i,
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [
        { name: 'read_file', args: { Path: `/Users/alex/Repos/ag-ios-mobile/AntigravityMobile/File${i}.swift` } },
        { name: 'run_command', args: { toolSummary: 'Swift unit tests' } },
      ],
      created_at: '2026-11-16T00:00:10Z',
    }));
  }
  lines.push(JSON.stringify({
    step_index: 61,
    type: 'PLANNER_RESPONSE',
    content: 'All 60 steps refactored cleanly.',
    tool_calls: [],
    created_at: '2026-11-16T00:01:00Z',
  }));
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8');

  const parsed = parseTranscriptConversation(transcriptPath, {
    conversationId: 'compact-session-001',
    includeMessages: true,
  });

  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.messages[0].role, 'user');
  assert.equal(parsed.messages[1].role, 'tool_group');
  assert.equal(parsed.messages[1].stepCount, 60);
  assert.equal(parsed.messages[1].tools.length, 120);
  assert.ok(parsed.messages[1].toolDetails.includes('read_file · File1.swift'));
  assert.ok(parsed.messages[1].toolDetails.includes('run_command · Swift unit tests'));
  assert.equal(parsed.messages[2].role, 'assistant');
  assert.equal(parsed.messages[2].text, 'All 60 steps refactored cleanly.');
});

test('GET /api/health reports activeWorkers and inFlightCount during an ACP prompt', async (t) => {
  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const slowAgy = path.join(fx.root, 'mock-agy-health.mjs');
  fs.writeFileSync(
    slowAgy,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + '\\n');
  } else if (req.method === 'session/load') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { sessionId: req.params.sessionId } }) + '\\n');
  } else if (req.method === 'session/prompt') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } }) + '\\n');
    }, 300);
  }
});
`,
    { mode: 0o755 },
  );

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: slowAgy,
    enableBonjour: false,
    enableWatch: false,
  });
  t.after(() => srv.stop());

  const baseUrl = `http://127.0.0.1:${srv.port}`;
  const initialHealth = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(initialHealth.activeWorkers, 0);
  assert.equal(initialHealth.inFlightCount, 0);
  assert.deepEqual(initialHealth.inFlightSessionIds, []);

  const cfg = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'config.json'), 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/acp/ws?token=${cfg.bearerToken}`);
  t.after(() => ws.close());
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const nextMsg = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS timeout')), 4000);
    ws.addEventListener('message', (ev) => {
      clearTimeout(timer);
      resolve(JSON.parse(ev.data));
    }, { once: true });
  });

  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }));
  assert.equal((await nextMsg()).id, 1);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: fx.convDesktopId, cwd: fx.wsCN, mcpServers: [] } }));
  assert.equal((await nextMsg()).id, 2);

  const donePromise = nextMsg();
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: fx.convDesktopId, prompt: [{ type: 'text', text: 'check health' }] } }));
  await new Promise((r) => setTimeout(r, 60));

  const duringHealth = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(duringHealth.activeWorkers >= 1, true);
  assert.equal(duringHealth.inFlightCount, 1);
  assert.deepEqual(duringHealth.inFlightSessionIds, [fx.convDesktopId]);

  const promptReply = await donePromise;
  assert.equal(promptReply.id, 3);
  await new Promise((r) => setTimeout(r, 40));

  const afterHealth = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(afterHealth.inFlightCount, 0);
  assert.deepEqual(afterHealth.inFlightSessionIds, []);
});

test('overview keeps artifact previewPaths identical across polls and ignores intermediate tool churn in sort order', async (t) => {
  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const newerSessionId = '22222222-3333-4444-5555-666666666666';
  const olderSessionId = fx.convDesktopId;
  const newerLogsDir = path.join(fx.homeDir, '.gemini', 'antigravity', 'brain', newerSessionId, '.system_generated', 'logs');
  fs.mkdirSync(newerLogsDir, { recursive: true });
  fs.writeFileSync(
    path.join(newerLogsDir, 'transcript.jsonl'),
    [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nNewer prompt\n</USER_REQUEST>', created_at: '2026-11-15T10:05:00Z' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'Newer final reply.', tool_calls: [], created_at: '2026-11-15T10:05:10Z' }),
    ].join('\n') + '\n',
  );

  // Older session gets newer intermediate pure-tool calls and newer transcript mtime, while its USER_INPUT is earlier
  const olderTranscript = path.join(fx.homeDir, '.gemini', 'antigravity', 'brain', olderSessionId, '.system_generated', 'logs', 'transcript.jsonl');
  const olderLines = fs.readFileSync(olderTranscript, 'utf8').trimEnd().split('\n');
  olderLines.push(JSON.stringify({
    step_index: 3,
    type: 'USER_INPUT',
    content: '<USER_REQUEST>\nEarlier follow-up still running tools\n</USER_REQUEST>',
    created_at: '2026-11-15T10:02:00Z',
  }));
  olderLines.push(JSON.stringify({
    step_index: 4,
    type: 'PLANNER_RESPONSE',
    content: '',
    tool_calls: [{ name: 'read_file', args: { Path: '/tmp/foo.txt' } }],
    created_at: '2026-11-15T10:09:00Z',
  }));
  fs.writeFileSync(olderTranscript, olderLines.join('\n') + '\n');
  const nowSec = Date.now() / 1000;
  fs.utimesSync(olderTranscript, nowSec + 10, nowSec + 10);

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: fx.mockAgyPath,
    enableBonjour: false,
    enableWatch: false,
  });
  t.after(() => srv.stop());

  const cfg = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'config.json'), 'utf8'));
  const authHeaders = { Authorization: `Bearer ${cfg.bearerToken}` };
  const baseUrl = `http://127.0.0.1:${srv.port}`;

  const ov1 = await (await fetch(`${baseUrl}/api/overview`, { headers: authHeaders })).json();
  await new Promise((r) => setTimeout(r, 20));
  const ov2 = await (await fetch(`${baseUrl}/api/overview`, { headers: authHeaders })).json();

  const older1 = ov1.sessions.find((s) => s.id === olderSessionId);
  const older2 = ov2.sessions.find((s) => s.id === olderSessionId);
  assert.ok(older1 && older1.artifacts.length > 0);
  assert.deepEqual(older1.artifacts, older2.artifacts);

  const ids = ov1.sessions.map((s) => s.id);
  assert.equal(ids.indexOf(newerSessionId) < ids.indexOf(olderSessionId), true);
});

test('parseTranscriptConversation keeps active thinking/checkpoint/tool-error turns running and marks stale idle unanswered turns interrupted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-active-grace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const nowMs = Date.parse('2026-11-16T01:00:00Z');
  const isoAgo = (sec) => new Date(nowMs - sec * 1000).toISOString();

  // Case A: Unanswered turn with CHECKPOINT 90s ago + GENERIC tool result ERROR 30s ago -> MUST stay running
  const activeTranscript = path.join(dir, 'active.jsonl');
  fs.writeFileSync(
    activeTranscript,
    [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nAudit DSH\n</USER_REQUEST>', created_at: isoAgo(150) }),
      JSON.stringify({ step_index: 1, type: 'CHECKPOINT', content: '# Resuming from compaction', created_at: isoAgo(90) }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'ERROR', content: 'target not found, retrying with read_file', created_at: isoAgo(30) }),
    ].join('\n') + '\n',
  );
  const parsedActive = parseTranscriptConversation(activeTranscript, {
    conversationId: 'active-1',
    dbMeta: { dbStatus: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, killed: false, lastModifiedMs: nowMs - 30_000 },
    nowMs,
  });
  assert.equal(parsedActive.status, 'running');

  // Case B: Unanswered turn whose last step was 10 minutes (600s) ago with IDLE DB status -> interrupted
  const staleTranscript = path.join(dir, 'stale.jsonl');
  fs.writeFileSync(
    staleTranscript,
    [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nOld task\n</USER_REQUEST>', created_at: isoAgo(700) }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: '', tool_calls: [{ name: 'read_file', args: { Path: '/tmp/a' } }], created_at: isoAgo(600) }),
    ].join('\n') + '\n',
  );
  const parsedStale = parseTranscriptConversation(staleTranscript, {
    conversationId: 'stale-1',
    dbMeta: { dbStatus: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, killed: false, lastModifiedMs: nowMs - 600_000 },
    nowMs,
  });
  assert.equal(parsedStale.status, 'interrupted');
});

test('overview artifact cache returns fresh results immediately when a new artifact file is added and /api/health responds cleanly across repeated probes', async (t) => {
  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: fx.mockAgyPath,
    enableBonjour: false,
    enableWatch: false,
  });
  t.after(() => srv.stop());

  const cfg = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'config.json'), 'utf8'));
  const authHeaders = { Authorization: `Bearer ${cfg.bearerToken}` };
  const baseUrl = `http://127.0.0.1:${srv.port}`;

  const h1 = await fetch(`${baseUrl}/api/health`);
  assert.equal(h1.status, 200);
  const h2 = await fetch(`${baseUrl}/api/health`);
  assert.equal(h2.status, 200);
  assert.equal((await h2.json()).ok, true);

  const ov1 = await (await fetch(`${baseUrl}/api/overview`, { headers: authHeaders })).json();
  const s1 = ov1.sessions.find((s) => s.id === fx.convDesktopId);
  assert.ok(s1);
  const count1 = s1.artifacts.length;

  const desktopBrainDir = path.join(fx.homeDir, '.gemini', 'antigravity', 'brain', fx.convDesktopId);
  fs.writeFileSync(path.join(desktopBrainDir, 'summary-report.md'), '# New Artifact\n');

  const ov2 = await (await fetch(`${baseUrl}/api/overview`, { headers: authHeaders })).json();
  const s2 = ov2.sessions.find((s) => s.id === fx.convDesktopId);
  assert.ok(s2);
  assert.equal(s2.artifacts.length, count1 + 1);
  assert.equal(s2.artifacts.some((a) => a.name === 'summary-report.md'), true);
});

test('P0 regressions: buildPairUri uses %20, rotated quick-tunnel is visible at 0ms, and rendezvous auditAndHealNow repairs stale beacon', async (t) => {
  const uri = buildPairUri({
    hostName: 'MacBook Pro',
    lanUrl: 'http://192.168.31.181:58470',
    funnelUrl: 'https://demo.trycloudflare.com',
    token: 'tok123',
  });
  assert.equal(uri.includes('name=MacBook%20Pro'), true);
  assert.equal(uri.includes('+'), false);

  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const qtPath = path.join(fx.stateDir, 'quick-tunnel.json');
  writeJsonAtomic(qtPath, {
    url: 'https://old-tunnel-a.trycloudflare.com',
    pid: process.pid,
    updatedAtMs: Date.now() - 1000,
  });

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: fx.mockAgyPath,
    enableBonjour: false,
    enableWatch: false,
  });
  t.after(() => srv.stop());

  const h1 = await (await fetch(`http://127.0.0.1:${srv.port}/api/health`)).json();
  assert.equal(h1.funnelUrl, 'https://old-tunnel-a.trycloudflare.com');

  // Immediately rotate quick-tunnel.json within 50ms -> MUST NOT hit any stale cache
  writeJsonAtomic(qtPath, {
    url: 'https://fresh-tunnel-b.trycloudflare.com',
    pid: process.pid,
    updatedAtMs: Date.now(),
  });
  assert.equal(detectTailscaleFunnelUrl('', fx.stateDir), 'https://fresh-tunnel-b.trycloudflare.com');
  const h2 = await (await fetch(`http://127.0.0.1:${srv.port}/api/health`)).json();
  assert.equal(h2.funnelUrl, 'https://fresh-tunnel-b.trycloudflare.com');

  // Verify auditAndHealNow detects stale/mismatched beacon on mock ntfy and self-heals with higher monotonic updatedAtMs
  const token = 'audit-heal-bearer-token-2026';
  const topic = deriveRendezvousTopic(token);
  const stored = [
    {
      id: 'stale-1',
      event: 'message',
      topic,
      message: encryptRendezvousBeacon(token, {
        funnelUrl: 'https://dead-stale-edge.trycloudflare.com',
        lanUrl: 'http://192.168.31.181:58470',
        hostName: 'MacBook Pro',
        instanceId: 'inst-heal',
        updatedAtMs: Date.now() + 5000,
      }),
    },
  ];
  const mockNtfy = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const clean = reqUrl.pathname.replace(/^\/+/, '');
    if (req.method === 'GET' && clean === `${topic}/json`) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(stored.map((x) => JSON.stringify(x)).join('\n') + '\n');
      return;
    }
    if (req.method === 'POST' && clean === topic) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        stored.push({
          id: `msg-${stored.length + 1}`,
          event: 'message',
          topic,
          message: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => mockNtfy.listen(0, '127.0.0.1', r));
  t.after(() => mockNtfy.close());

  let activeUrl = 'https://fresh-live-edge.trycloudflare.com';
  const pub = startRendezvousPublisher({
    bearerToken: token,
    baseUrl: `http://127.0.0.1:${mockNtfy.address().port}`,
    getPayload: () => ({
      funnelUrl: activeUrl,
      lanUrl: 'http://192.168.31.181:58470',
      hostName: 'MacBook Pro',
      instanceId: 'inst-heal',
    }),
  });
  t.after(() => pub.stop());

  const healed = await pub.auditAndHealNow();
  assert.equal(healed, true);
  assert.equal(stored.length, 2);
  const latest = extractLatestRendezvousBeacon(token, stored.map((x) => JSON.stringify(x)).join('\n'));
  assert.equal(latest.funnelUrl, 'https://fresh-live-edge.trycloudflare.com');
  assert.ok(latest.updatedAtMs > Date.now());
});

test('Rendezvous R2 self-lock recovery across null, sync throw, and HTTP failure', async (t) => {
  const token = 'test-r2-token-lock-recovery';
  const topic = deriveRendezvousTopic(token);
  const stored = [];
  let postStatus = 200;

  const mockNtfy = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const clean = reqUrl.pathname.replace(/^\/+/, '');
    if (req.method === 'GET' && clean === `${topic}/json`) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(stored.map((x) => JSON.stringify(x)).join('\n') + '\n');
      return;
    }
    if (req.method === 'POST' && clean === topic) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (postStatus !== 200) {
          res.writeHead(postStatus);
          res.end('err');
          return;
        }
        stored.push({
          id: `m-${stored.length + 1}`,
          event: 'message',
          topic,
          message: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => mockNtfy.listen(0, '127.0.0.1', r));
  t.after(() => mockNtfy.close());

  let mode = 'null';
  const pub = startRendezvousPublisher({
    bearerToken: token,
    baseUrl: `http://127.0.0.1:${mockNtfy.address().port}`,
    followUpAuditDelayMs: 0,
    getPayload: () => {
      if (mode === 'null') return { funnelUrl: null, lanUrl: 'http://127.0.0.1:58470', hostName: 'Mac', instanceId: 'i-r2' };
      if (mode === 'throw') throw new Error('sync getPayload boom');
      return { funnelUrl: 'https://r2-recovered.trycloudflare.com', lanUrl: 'http://127.0.0.1:58470', hostName: 'Mac', instanceId: 'i-r2' };
    },
  });
  t.after(() => pub.stop());

  assert.equal(await pub.publishNow(), false);
  assert.equal(await pub.auditAndHealNow(), false);

  mode = 'throw';
  assert.equal(await pub.publishNow(), false);
  assert.equal(await pub.auditAndHealNow(), false);

  mode = 'valid';
  postStatus = 500;
  assert.equal(await pub.publishNow(), false);
  assert.equal(await pub.auditAndHealNow(), false);

  postStatus = 200;
  assert.equal(await pub.publishNow(), true);
  assert.equal(await pub.auditAndHealNow(), true);
  assert.equal(pub.getStatus().lastVerifiedSync, true);
  assert.equal(pub.getStatus().lastReadbackVerifiedUrl, 'https://r2-recovered.trycloudflare.com');
});

test('Rendezvous read-back distinguishes lastAccepted vs lastVerifiedSync and enforces HTTP 429 cooldown', async (t) => {
  const token = 'test-429-readback-token';
  const topic = deriveRendezvousTopic(token);
  const stored = [];
  let omitFromReadback = true;
  let force429 = false;
  let postHits = 0;
  let getHits = 0;

  const mockNtfy = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const clean = reqUrl.pathname.replace(/^\/+/, '');
    if (req.method === 'GET' && clean === `${topic}/json`) {
      getHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const rows = omitFromReadback ? [] : stored;
      res.end(rows.map((x) => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''));
      return;
    }
    if (req.method === 'POST' && clean === topic) {
      postHits += 1;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (force429) {
          res.writeHead(429, { 'Retry-After': '3' });
          res.end('rate limited');
          return;
        }
        stored.push({
          id: `m-${stored.length + 1}`,
          event: 'message',
          topic,
          message: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => mockNtfy.listen(0, '127.0.0.1', r));
  t.after(() => mockNtfy.close());

  let targetUrl = 'https://readback-one.trycloudflare.com';
  const pub = startRendezvousPublisher({
    bearerToken: token,
    baseUrl: `http://127.0.0.1:${mockNtfy.address().port}`,
    followUpAuditDelayMs: 0,
    getPayload: () => ({
      funnelUrl: targetUrl,
      lanUrl: 'http://192.168.1.10:58470',
      hostName: 'Mac',
      instanceId: 'inst-rb',
    }),
  });
  t.after(() => pub.stop());

  assert.equal(await pub.publishNow(), true);
  let st = pub.getStatus();
  assert.equal(st.lastAccepted, true);
  assert.equal(st.lastVerifiedSync, false);
  assert.equal(st.lastReadbackVerifiedUrl, null);

  omitFromReadback = false;
  assert.equal(await pub.auditAndHealNow(), true);
  st = pub.getStatus();
  assert.equal(st.lastAccepted, true);
  assert.equal(st.lastVerifiedSync, true);
  assert.equal(st.lastReadbackVerifiedUrl, targetUrl);

  // Trigger HTTP 429 and confirm subsequent bursts do not hammer POST or GET during Retry-After window
  targetUrl = 'https://readback-429.trycloudflare.com';
  force429 = true;
  const postsBefore = postHits;
  const getsBefore = getHits;
  assert.equal(await pub.publishNow(), false);
  pub.notifyChanged();
  pub.notifyChanged();
  await pub.auditAndHealNow();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(postHits - postsBefore, 1);
  assert.ok(getHits - getsBefore <= 1);
});

test('buildPairUri preserves + and iid, /api/health returns HMAC authProof, and upgrade RST on 404/401 is safe', async (t) => {
  const uri = buildPairUri({
    instanceId: 'inst-xyz',
    hostName: 'Studio+Mac',
    lanUrl: 'http://192.168.1.2:58470',
    funnelUrl: 'https://edge.trycloudflare.com',
    token: 'a+b',
  });
  assert.ok(uri.includes('iid=inst-xyz'));
  assert.ok(uri.includes('name=Studio%2BMac'));
  assert.ok(uri.includes('token=a%2Bb'));

  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  process.env.AG_MOBILE_NO_NOTIFY = '1';

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: fx.mockAgyPath,
    enableBonjour: false,
    enableWatch: false,
  });
  t.after(() => srv.stop());

  const cfg = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'config.json'), 'utf8'));
  const challenge = 'deadbeef12345678';
  const healthRes = await fetch(`http://127.0.0.1:${srv.port}/api/health?challenge=${challenge}`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  const expectedProof = crypto
    .createHmac('sha256', Buffer.from(cfg.bearerToken, 'utf8'))
    .update(`ag-health-v1:${challenge}:${cfg.instanceId}`)
    .digest('hex');
  assert.equal(health.instanceId, cfg.instanceId);
  assert.equal(health.authProof, expectedProof);

  // Send raw WS upgrade requests to /unknown-ws (404) and /acp/ws?token=wrong (401) and abruptly RST sockets
  for (const targetPath of ['/unknown-ws', '/acp/ws?token=wrong']) {
    await new Promise((resolve) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write(
          `GET ${targetPath} HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      sock.once('data', () => {
        if (typeof sock.resetAndDestroy === 'function') sock.resetAndDestroy();
        else sock.destroy();
        resolve();
      });
      sock.once('close', resolve);
      sock.once('error', resolve);
    });
  }
  await new Promise((r) => setTimeout(r, 50));
  const afterRst = await fetch(`http://127.0.0.1:${srv.port}/api/health`);
  assert.equal(afterRst.status, 200);
});

test('acp-hub routes client JSON-RPC responses strictly to currentWorker with no cross-worker leak', async (t) => {
  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  process.env.AG_MOBILE_NO_NOTIFY = '1';

  const stdinLog = path.join(fx.root, 'agy-stdin.ndjson');
  const sessionA = fx.convDesktopId;
  const sessionB = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const strictMockAgy = path.join(fx.root, 'mock-agy-strict');
  fs.writeFileSync(
    strictMockAgy,
    `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
let mySid = null;
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'session/load') mySid = msg.params?.sessionId || null;
  fs.appendFileSync(${JSON.stringify(stdinLog)}, JSON.stringify({ pid: process.pid, mySid, msg }) + '\\n');
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + '\\n');
  } else if (msg.method === 'session/load') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId } }) + '\\n');
  } else if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    const permId = sid === ${JSON.stringify(sessionA)} ? 777 : 778;
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: permId,
      method: 'session/request_permission',
      params: { sessionId: sid, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
    }) + '\\n');
  }
});
`,
    { mode: 0o755 },
  );

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: strictMockAgy,
    enableBonjour: false,
    enableWatch: false,
  });
  t.after(() => srv.stop());

  const cfg = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'config.json'), 'utf8'));
  const openWs = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/acp/ws?token=${cfg.bearerToken}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const q = [];
    const w = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (w.length > 0) w.shift()(m);
      else q.push(m);
    });
    const next = () => new Promise((resolve, reject) => {
      if (q.length > 0) return resolve(q.shift());
      const tm = setTimeout(() => reject(new Error('WS timeout')), 4000);
      w.push((v) => { clearTimeout(tm); resolve(v); });
    });
    return { ws, next };
  };

  const cA = await openWs();
  const cB = await openWs();
  const cUnattached = await openWs();
  t.after(() => { cA.ws.close(); cB.ws.close(); cUnattached.ws.close(); });

  cA.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }));
  assert.equal((await cA.next()).id, 1);
  cA.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: sessionA, cwd: fx.wsCN, mcpServers: [] } }));
  assert.equal((await cA.next()).id, 2);
  cA.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sessionA, prompt: [{ type: 'text', text: 'pA' }] } }));
  assert.equal((await cA.next()).id, 777);

  cB.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: 1 } }));
  assert.equal((await cB.next()).id, 10);
  cB.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'session/load', params: { sessionId: sessionB, cwd: fx.wsAgent, mcpServers: [] } }));
  assert.equal((await cB.next()).id, 11);
  cB.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'session/prompt', params: { sessionId: sessionB, prompt: [{ type: 'text', text: 'pB' }] } }));
  assert.equal((await cB.next()).id, 778);

  // Cross-worker / unattached response id:777 MUST NOT route into sessionA worker
  cUnattached.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 777, result: { outcome: { outcome: 'selected', optionId: 'leak' } } }));
  cB.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 777, result: { outcome: { outcome: 'selected', optionId: 'cross-leak' } } }));
  // Valid response id:778 on cB MUST route strictly to sessionB worker
  cB.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 778, result: { outcome: { outcome: 'selected', optionId: 'allow-b' } } }));

  await new Promise((r) => setTimeout(r, 120));
  const entries = fs.readFileSync(stdinLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  assert.equal(entries.some((e) => e.msg?.id === 777), false);
  const routed778 = entries.filter((e) => e.msg?.id === 778);
  assert.equal(routed778.length, 1);
  assert.equal(routed778[0].mySid, sessionB);
  assert.equal(entries.some((e) => e.mySid === sessionA && e.msg?.id === 778), false);
});

test('Rendezvous auditAndHealNow republishes when DHCP lanUrl changes even if funnelUrl is unchanged', async (t) => {
  const token = 'test-dhcp-lan-heal-token';
  const topic = deriveRendezvousTopic(token);
  const stored = [
    {
      id: 'm1',
      event: 'message',
      topic,
      message: encryptRendezvousBeacon(token, {
        funnelUrl: 'https://same-edge.trycloudflare.com',
        lanUrl: 'http://192.168.31.181:58470',
        hostName: 'MacBook Pro',
        instanceId: 'inst-dhcp',
        updatedAtMs: Date.now() - 1000,
      }),
    },
  ];

  const mockNtfy = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const clean = reqUrl.pathname.replace(/^\/+/, '');
    if (req.method === 'GET' && clean === `${topic}/json`) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(stored.map((x) => JSON.stringify(x)).join('\n') + '\n');
      return;
    }
    if (req.method === 'POST' && clean === topic) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        stored.push({
          id: `m${stored.length + 1}`,
          event: 'message',
          topic,
          message: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => mockNtfy.listen(0, '127.0.0.1', r));
  t.after(() => mockNtfy.close());

  const pub = startRendezvousPublisher({
    bearerToken: token,
    baseUrl: `http://127.0.0.1:${mockNtfy.address().port}`,
    followUpAuditDelayMs: 0,
    getPayload: () => ({
      funnelUrl: 'https://same-edge.trycloudflare.com',
      lanUrl: 'http://192.168.31.174:58470',
      hostName: 'MacBook Pro',
      instanceId: 'inst-dhcp',
    }),
  });
  t.after(() => pub.stop());

  assert.equal(await pub.auditAndHealNow(), true);
  assert.equal(stored.length, 2);
  const latest = extractLatestRendezvousBeacon(token, stored.map((x) => JSON.stringify(x)).join('\n'));
  assert.equal(latest.lanUrl, 'http://192.168.31.174:58470');
  assert.equal(pub.getStatus().lastVerifiedSync, true);
});

test('Bridge exposes pending ask_question, requestFeedback artifacts, clears on GENERIC A1 reply, and supports ETag 304', async (t) => {
  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  process.env.AG_MOBILE_NO_NOTIFY = '1';

  const nowMs = Date.now();
  const brainDir = path.join(fx.brainRoots[0].dir, fx.convDesktopId);
  const logsPath = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');

  // 1. Unanswered ask_question -> status = 'question' + pendingQuestion
  const qSteps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nHelp configure rollout\n</USER_REQUEST>',
      created_at: new Date(nowMs - 10_000).toISOString(),
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: 'Need your preference first.',
      tool_calls: [
        {
          name: 'ask_question',
          args: {
            questions: JSON.stringify([
              {
                question: 'Pick rollout channel?',
                options: ['(Recommended) TestFlight', 'App Store'],
                isMultiSelect: false,
              },
            ]),
          },
        },
      ],
      created_at: new Date(nowMs - 5_000).toISOString(),
    },
  ];
  fs.writeFileSync(logsPath, qSteps.map((s) => JSON.stringify(s)).join('\n') + '\n');

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: fx.mockAgyPath,
    enableBonjour: false,
    enableWatch: false,
  });
  t.after(() => srv.stop());

  const baseUrl = `http://127.0.0.1:${srv.port}`;
  const pairRes = await fetch(`${baseUrl}/api/pair/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '042910' }),
  });
  assert.equal(pairRes.status, 200);
  const pairBody = await pairRes.json();
  const authHeaders = { Authorization: `Bearer ${pairBody.token}` };

  const ov1 = await fetch(`${baseUrl}/api/overview`, { headers: authHeaders });
  assert.equal(ov1.status, 200);
  const ovEtag = ov1.headers.get('etag');
  assert.ok(ovEtag);
  const ovBody = await ov1.json();
  const qSess = ovBody.sessions.find((s) => s.id === fx.convDesktopId);
  assert.equal(qSess.status, 'question');
  assert.equal(qSess.pendingQuestion?.source, 'transcript');
  assert.equal(qSess.pendingQuestion?.questions.length, 1);
  assert.deepEqual(
    qSess.pendingQuestion?.questions[0].options.map((o) => o.value),
    ['(Recommended) TestFlight', 'App Store'],
  );

  // If-None-Match hits 304 on unchanged overview
  const ov304 = await fetch(`${baseUrl}/api/overview`, {
    headers: { ...authHeaders, 'If-None-Match': ovEtag },
  });
  assert.equal(ov304.status, 304);

  const det1 = await fetch(`${baseUrl}/api/sessions/${fx.convDesktopId}`, { headers: authHeaders });
  assert.equal(det1.status, 200);
  const detEtag = det1.headers.get('etag');
  assert.ok(detEtag);
  const det304 = await fetch(`${baseUrl}/api/sessions/${fx.convDesktopId}`, {
    headers: { ...authHeaders, 'If-None-Match': detEtag },
  });
  assert.equal(det304.status, 304);

  // 2. Append GENERIC A1 answer + final PLANNER_RESPONSE -> cleared to 'done'
  const answeredSteps = [
    ...qSteps,
    {
      step_index: 2,
      type: 'GENERIC',
      content: 'Created At: 2026-11-16\nCompleted At: 2026-11-16\nA1: (Recommended) TestFlight',
      created_at: new Date(nowMs - 2_000).toISOString(),
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      content: 'All set, deploying to TestFlight.',
      tool_calls: [],
      created_at: new Date(nowMs - 1_000).toISOString(),
    },
  ];
  fs.writeFileSync(logsPath, answeredSteps.map((s) => JSON.stringify(s)).join('\n') + '\n');

  const detAfter = await fetch(`${baseUrl}/api/sessions/${fx.convDesktopId}`, {
    headers: { ...authHeaders, 'If-None-Match': detEtag },
  });
  assert.equal(detAfter.status, 200);
  const detAfterBody = await detAfter.json();
  assert.equal(detAfterBody.status, 'done');
  assert.equal(detAfterBody.pendingQuestion, null);

  // 3. Plan feedback metadata (requestFeedback: true from current turn) -> 'question' + pendingFeedbackArtifact
  fs.writeFileSync(path.join(brainDir, 'implementation_plan.md'), '# Rollout Plan\nShip Build 14\n');
  fs.writeFileSync(
    path.join(brainDir, 'implementation_plan.md.metadata.json'),
    JSON.stringify({
      artifactType: 'ARTIFACT_TYPE_IMPLEMENTATION_PLAN',
      summary: 'TestFlight build 14 plan ready for approval.',
      updatedAt: new Date(nowMs - 500).toISOString(),
      requestFeedback: true,
    }),
  );

  const detPlan = await fetch(`${baseUrl}/api/sessions/${fx.convDesktopId}`, { headers: authHeaders });
  assert.equal(detPlan.status, 200);
  const detPlanBody = await detPlan.json();
  assert.equal(detPlanBody.status, 'question');
  assert.equal(detPlanBody.pendingFeedbackArtifact?.name, 'implementation_plan.md');
  assert.ok(detPlanBody.pendingFeedbackArtifact?.summary.includes('TestFlight'));
});

test('POST /api/uploads, ACP image hydration confinement, and transcript attachment rendering work end-to-end', async (t) => {
  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: fx.mockAgyPath,
    enableBonjour: false,
    enableWatch: false,
    maxUploadBytes: 4096,
  });
  t.after(() => srv.stop());

  const baseUrl = `http://127.0.0.1:${srv.port}`;
  const authHeaders = { Authorization: `Bearer ${srv.config.bearerToken}` };

  // 1. Rejects unauthenticated uploads (401) & oversized payloads (413)
  const unauthRes = await fetch(`${baseUrl}/api/uploads?filename=test.png`, {
    method: 'POST',
    body: Buffer.from([1, 2, 3]),
  });
  assert.equal(unauthRes.status, 401);

  const tooBigRes = await fetch(`${baseUrl}/api/uploads?filename=big.bin`, {
    method: 'POST',
    headers: authHeaders,
    body: Buffer.alloc(5000, 0x41),
  });
  assert.equal(tooBigRes.status, 413);

  // 2. Uploads UTF-8 image & PDF, serves back exact bytes via signed previewPath
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const upImgRes = await fetch(
    `${baseUrl}/api/uploads?filename=${encodeURIComponent('报错截图 1.png')}&mimeType=${encodeURIComponent('image/png')}&sessionId=${fx.convDesktopId}`,
    {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
      body: pngBytes,
    },
  );
  assert.equal(upImgRes.status, 200);
  const { upload: imgUpload } = await upImgRes.json();
  assert.equal(imgUpload.name, '报错截图 1.png');
  assert.equal(imgUpload.kind, 'image');
  assert.equal(imgUpload.mimeType, 'image/png');
  assert.equal(imgUpload.sizeBytes, pngBytes.length);
  assert.ok(imgUpload.fileUri.startsWith('file:///'));
  assert.ok(imgUpload.previewPath.startsWith('/api/artifacts/file/'));

  const dlImgRes = await fetch(`${baseUrl}${imgUpload.previewPath}`);
  assert.equal(dlImgRes.status, 200);
  assert.deepEqual(Buffer.from(await dlImgRes.arrayBuffer()), pngBytes);

  const pdfBytes = Buffer.from('%PDF-1.4 sample document\n', 'utf8');
  const upPdfRes = await fetch(
    `${baseUrl}/api/uploads?filename=${encodeURIComponent('季度报表.pdf')}&mimeType=${encodeURIComponent('application/pdf')}&sessionId=${fx.convDesktopId}`,
    {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
      body: pdfBytes,
    },
  );
  assert.equal(upPdfRes.status, 200);
  const { upload: pdfUpload } = await upPdfRes.json();
  assert.equal(pdfUpload.name, '季度报表.pdf');
  assert.equal(pdfUpload.kind, 'pdf');

  // 3. rewriteInboundAcpMessage hydrates confined upload images -> native `image`, keeps PDF as `resource_link`,
  //    refuses files outside `<stateDir>/uploads`, and injects fallback text when prompt text is empty.
  const outsideImgPath = path.join(fx.homeDir, 'secret-outside.png');
  fs.writeFileSync(outsideImgPath, pngBytes);
  const outsideUri = `file://${outsideImgPath}`;

  const rewrittenRaw = rewriteInboundAcpMessage(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/prompt',
      params: {
        sessionId: fx.convDesktopId,
        prompt: [
          { type: 'resource_link', uri: imgUpload.fileUri, name: imgUpload.name, mimeType: 'image/png', size: imgUpload.sizeBytes },
          { type: 'resource_link', uri: pdfUpload.fileUri, name: pdfUpload.name, mimeType: 'application/pdf', size: pdfUpload.sizeBytes },
          { type: 'resource_link', uri: outsideUri, name: 'secret-outside.png', mimeType: 'image/png', size: pngBytes.length },
        ],
      },
    }),
    { stateDir: fx.stateDir },
  );
  const rewritten = JSON.parse(rewrittenRaw);
  assert.equal(rewritten.params.prompt.length, 4);
  assert.equal(rewritten.params.prompt[0].type, 'text');
  assert.ok(rewritten.params.prompt[0].text.length > 0);
  assert.deepEqual(rewritten.params.prompt[1], {
    type: 'image',
    mimeType: 'image/png',
    data: pngBytes.toString('base64'),
  });
  assert.equal(rewritten.params.prompt[2].type, 'resource_link');
  assert.equal(rewritten.params.prompt[2].uri, pdfUpload.fileUri);
  // Outside path MUST remain un-hydrated (never read arbitrary host files)
  assert.equal(rewritten.params.prompt[3].type, 'resource_link');
  assert.equal(rewritten.params.prompt[3].uri, outsideUri);

  // 4. Session detail parses both `media` and `@[/.../uploads/...]` into clean `attachments` with previewPaths
  const logsPath = path.join(fx.brainRoots[0].dir, fx.convDesktopId, '.system_generated', 'logs', 'transcript.jsonl');
  const nowMs = Date.now();
  const mediaSteps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: `<USER_REQUEST>\nPlease inspect the attached file(s).@[${pdfUpload.macPath}]\n</USER_REQUEST>`,
      media: [{ mime_type: 'image/png', uri: imgUpload.macPath }],
      created_at: new Date(nowMs - 2000).toISOString(),
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: 'Parsed both screenshot and PDF report.',
      tool_calls: [],
      created_at: new Date(nowMs - 1000).toISOString(),
    },
  ];
  fs.writeFileSync(logsPath, mediaSteps.map((s) => JSON.stringify(s)).join('\n') + '\n');

  const detRes = await fetch(`${baseUrl}/api/sessions/${fx.convDesktopId}`, { headers: authHeaders });
  assert.equal(detRes.status, 200);
  const detBody = await detRes.json();
  const userMsg = detBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg);
  assert.equal(userMsg.text, ''); // synthetic fallback + @[path] cleanly stripped
  assert.equal(userMsg.attachments?.length, 2);
  assert.equal(userMsg.attachments[0].name, '报错截图 1.png');
  assert.equal(userMsg.attachments[0].kind, 'image');
  assert.ok(userMsg.attachments[0].previewPath?.startsWith('/api/artifacts/file/'));
  assert.equal(userMsg.attachments[1].name, '季度报表.pdf');
  assert.equal(userMsg.attachments[1].kind, 'pdf');
  assert.ok(detBody.lastPrompt.startsWith('📎 '));
});

test('Hydrates middle-truncated transcript_full.jsonl replies, signs safe workspace file:// links, and runs full-text search', async (t) => {
  const fx = makeTempFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const logsDir = path.join(fx.brainRoots[0].dir, fx.convDesktopId, '.system_generated', 'logs');
  const compactPath = path.join(logsDir, 'transcript.jsonl');
  const fullPath = path.join(logsDir, 'transcript_full.jsonl');
  const nowMs = Date.now();

  const hiddenMiddle = '关键中间段落_ALPHA_778899_绝对不能被吞掉_'.repeat(30);
  const fullReply = `开头说明。\n\n${hiddenMiddle}\n\n结尾总结。`;
  const compactReply = '开头说明。\n<truncated 990 bytes>\n结尾总结。';

  const compactSteps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\n帮我详细分析完整方案\n</USER_REQUEST>',
      created_at: new Date(nowMs - 5000).toISOString(),
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: compactReply,
      truncated_fields: ['content', 'thinking'],
      tool_calls: [],
      created_at: new Date(nowMs - 2000).toISOString(),
    },
  ];
  const fullSteps = [
    compactSteps[0],
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: fullReply,
      tool_calls: [],
      created_at: new Date(nowMs - 2000).toISOString(),
    },
  ];
  fs.writeFileSync(compactPath, compactSteps.map((s) => JSON.stringify(s)).join('\n') + '\n');
  fs.writeFileSync(fullPath, fullSteps.map((s) => JSON.stringify(s)).join('\n') + '\n');

  // Create a readable workspace file and a sensitive .ssh key file
  const codeFile = path.join(fx.wsAgent, 'sample.swift');
  fs.writeFileSync(codeFile, 'struct Hello {\n    let value = 42\n}\n');
  const sshDir = path.join(fx.homeDir, '.ssh');
  fs.mkdirSync(sshDir, { recursive: true });
  const sshKey = path.join(sshDir, 'id_ed25519');
  fs.writeFileSync(sshKey, 'SECRET-PRIVATE-KEY');
  const envFile = path.join(fx.wsAgent, '.env');
  fs.writeFileSync(envFile, 'API_KEY=supersecret');

  const srv = await startBridgeServer({
    stateDir: fx.stateDir,
    port: 0,
    host: '127.0.0.1',
    homeDir: fx.homeDir,
    brainRoots: fx.brainRoots,
    dbPaths: fx.dbPaths,
    agyBin: fx.mockAgyPath,
    enableBonjour: false,
    enableWatch: false,
  });
  t.after(() => srv.stop());

  const baseUrl = `http://127.0.0.1:${srv.port}`;
  const authHeaders = { Authorization: `Bearer ${srv.config.bearerToken}`, 'Content-Type': 'application/json' };

  // 1. Session detail MUST hydrate full content from transcript_full.jsonl with zero middle truncation
  const detRes = await fetch(`${baseUrl}/api/sessions/${fx.convDesktopId}`, { headers: authHeaders });
  assert.equal(detRes.status, 200);
  const detBody = await detRes.json();
  const assistantMsg = detBody.messages.find((m) => m.role === 'assistant');
  assert.ok(assistantMsg);
  assert.equal(assistantMsg.text, fullReply);
  assert.ok(assistantMsg.text.includes('关键中间段落_ALPHA_778899'));
  assert.equal(assistantMsg.text.includes('<truncated'), false);

  // 2. POST /api/files/sign signs readable workspace files and blocks sensitive credentials
  const okSign = await fetch(`${baseUrl}/api/files/sign`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ path: `file://${codeFile}#L1-L3` }),
  });
  assert.equal(okSign.status, 200);
  const okSignBody = await okSign.json();
  assert.equal(okSignBody.artifact.name, 'sample.swift');
  assert.equal(okSignBody.artifact.kind, 'code');
  const fileResp = await fetch(`${baseUrl}${okSignBody.artifact.previewPath}`);
  assert.equal(fileResp.status, 200);
  assert.equal(await fileResp.text(), 'struct Hello {\n    let value = 42\n}\n');

  const sshBlocked = await fetch(`${baseUrl}/api/files/sign`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ path: sshKey }),
  });
  assert.equal(sshBlocked.status, 403);

  const envBlocked = await fetch(`${baseUrl}/api/files/sign`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ path: envFile }),
  });
  assert.equal(envBlocked.status, 403);

  const cfgBlocked = await fetch(`${baseUrl}/api/files/sign`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ path: path.join(fx.stateDir, 'config.json') }),
  });
  assert.equal(cfgBlocked.status, 403);

  // 3. GET /api/sessions/search finds matches inside message bodies
  const searchRes = await fetch(`${baseUrl}/api/sessions/search?q=${encodeURIComponent('帮我详细分析')}`, {
    headers: authHeaders,
  });
  assert.equal(searchRes.status, 200);
  const searchBody = await searchRes.json();
  assert.equal(searchBody.ok, true);
  assert.ok(searchBody.hits.some((h) => h.sessionId === fx.convDesktopId));
});

test('Desktop live conversations/*.db running tool, compacting, waiting, and CASCADE_RUN_STATUS_BUSY never misreport interrupted', () => {
  const fx = makeTempFixture();
  try {
    const brainDir = path.join(fx.brainRoots[0].dir, fx.convDesktopId);
    const logsPath = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
    const convDir = path.join(path.dirname(fx.brainRoots[0].dir), 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    const convDbPath = path.join(convDir, `${fx.convDesktopId}.db`);

    const nowMs = Date.now();
    // Simulate a tool call emitted 3 minutes ago (beyond 60s!) with NO final reply yet
    const steps = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\nRun long build\n</USER_REQUEST>',
        created_at: new Date(nowMs - 200_000).toISOString(),
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        content: '',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'xcodebuild' } }],
        created_at: new Date(nowMs - 180_000).toISOString(),
      },
    ];
    fs.writeFileSync(logsPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n');

    // Case 1: conversations/<id>.db has compacting CHECKPOINT (step_type=23, status=2 RUNNING) even if dbMeta is IDLE
    const db = new DatabaseSync(convDbPath);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)');
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)').run(2, 23, 2, null);
    db.close();

    const compactingRes = parseTranscriptConversation(logsPath, {
      conversationId: fx.convDesktopId,
      surface: 'desktop',
      dbMeta: { dbStatus: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, killed: false, lastModifiedMs: nowMs - 180_000 },
      nowMs,
      includeMessages: true,
    });
    assert.equal(compactingRes.status, 'running');
    assert.equal(compactingRes.activeTool, 'compacting');
    assert.equal(compactingRes.inFlight, true);

    // Case 2: conversations/<id>.db has WAITING step (status=9) -> 'question' (never interrupted)
    const db2 = new DatabaseSync(convDbPath);
    db2.prepare('UPDATE steps SET step_type = 132, status = 9 WHERE idx = 2').run();
    db2.close();

    const waitingRes = parseTranscriptConversation(logsPath, {
      conversationId: fx.convDesktopId,
      surface: 'desktop',
      dbMeta: { dbStatus: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, killed: false, lastModifiedMs: nowMs - 180_000 },
      nowMs,
    });
    assert.equal(waitingRes.status, 'question');

    // Case 2b: conversations/<id>.db has live RUNNING tool step (step_type=132, status=2) 3 min old -> 'running'
    const dbTool = new DatabaseSync(convDbPath);
    dbTool.prepare('UPDATE steps SET step_type = 132, status = 2 WHERE idx = 2').run();
    dbTool.close();

    const liveToolRes = parseTranscriptConversation(logsPath, {
      conversationId: fx.convDesktopId,
      surface: 'desktop',
      dbMeta: { dbStatus: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, killed: false, lastModifiedMs: nowMs - 180_000 },
      nowMs,
    });
    assert.equal(liveToolRes.status, 'running');
    assert.equal(liveToolRes.activeTool, 'run_command');

    // Case 3: No live running step in .db, but dbMeta reports CASCADE_RUN_STATUS_BUSY -> 'running'
    fs.unlinkSync(convDbPath);
    const busyRes = parseTranscriptConversation(logsPath, {
      conversationId: fx.convDesktopId,
      surface: 'desktop',
      dbMeta: { dbStatus: 'CASCADE_RUN_STATUS_BUSY', notFullyIdle: false, killed: false, lastModifiedMs: nowMs - 180_000 },
      nowMs,
    });
    assert.equal(busyRes.status, 'running');

    // Case 4: Truly dead session (no live .db row, IDLE dbMeta, 3 min old) -> honestly 'interrupted'
    const deadRes = parseTranscriptConversation(logsPath, {
      conversationId: fx.convDesktopId,
      surface: 'desktop',
      dbMeta: { dbStatus: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, killed: false, lastModifiedMs: nowMs - 180_000 },
      nowMs,
    });
    assert.equal(deadRes.status, 'interrupted');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

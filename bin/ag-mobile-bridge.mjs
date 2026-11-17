#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgyBinary } from '../lib/acp-hub.mjs';
import {
  buildPairUri,
  DEFAULT_PORT,
  detectPrimaryLanIPv4,
  detectTailscaleFunnelUrl,
  ensurePrivateDir,
  LAUNCH_AGENT_LABEL,
  loadOrCreateConfig,
  resolveStateDir,
  rotatePin,
} from '../lib/config.mjs';
import { showMacPinNotification } from '../lib/notify.mjs';
import { resolveIsolatedProxy } from '../lib/proxy.mjs';
import { generateQrMatrix, renderQrHalfBlocks } from '../lib/qr-terminal.mjs';
import { deriveRendezvousTopic } from '../lib/rendezvous.mjs';
import { startBridgeServer } from '../lib/server.mjs';
import { readConversationDbMetadata } from '../lib/workspaces.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_ENTRY = path.resolve(__filename);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { cmd: positional[0] || 'status', args: positional.slice(1), flags };
}

function getPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

function getGuiDomain() {
  return `gui/${process.getuid()}`;
}

function buildLaunchAgentPlist({ nodeBin, entryScript, port, stateDir }) {
  const logsDir = path.join(stateDir, 'logs');
  ensurePrivateDir(logsDir);
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const pathEnv = `${localBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${entryScript}</string>
    <string>serve</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>AG_MOBILE_STATE_DIR</key>
    <string>${stateDir}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(logsDir, 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logsDir, 'stderr.log')}</string>
</dict>
</plist>
`;
}

async function probeLocalHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function cmdServe(flags) {
  process.on('uncaughtException', (err) => {
    console.error('[ag-mobile-bridge] uncaughtException:', err?.stack || err?.message || err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[ag-mobile-bridge] unhandledRejection:', err?.stack || err?.message || err);
  });

  const port = flags.port ? Number(flags.port) : undefined;
  const host = typeof flags.host === 'string' ? flags.host : '0.0.0.0';

  let caffeinateChild = null;
  if (process.platform === 'darwin' && !flags['allow-sleep'] && fs.existsSync('/usr/bin/caffeinate')) {
    try {
      caffeinateChild = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], {
        stdio: 'ignore',
      });
      caffeinateChild.unref?.();
    } catch {}
  }

  const instance = await startBridgeServer({
    port,
    host,
    enableQuickTunnel: !flags['no-tunnel'],
    enableRendezvous: !flags['no-rendezvous'],
  });
  const urls = instance.hostUrls();
  console.log(`[ag-mobile-bridge] listening on ${host}:${instance.port}`);
  console.log(`[ag-mobile-bridge] LAN URL: ${urls.lanUrl}`);
  if (urls.funnelUrl) console.log(`[ag-mobile-bridge] Remote HTTPS URL: ${urls.funnelUrl}`);

  const shutdown = async () => {
    if (caffeinateChild && caffeinateChild.exitCode === null) {
      try {
        caffeinateChild.kill('SIGTERM');
      } catch {}
    }
    await instance.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdPair(flags) {
  if (flags.rotate) {
    rotatePin();
  }
  const { config, stateDir } = loadOrCreateConfig();
  const health = await probeLocalHealth(config.port);
  const lanIp = detectPrimaryLanIPv4();
  const lanUrl = health?.lanUrl || `http://${lanIp}:${config.port}`;
  const funnelUrl = health?.funnelUrl || detectTailscaleFunnelUrl(config.funnelUrlOverride, stateDir);
  const pairUri = buildPairUri({
    instanceId: config.instanceId,
    hostName: config.hostName,
    lanUrl,
    funnelUrl,
    token: config.bearerToken,
  });

  if (flags.notify) {
    showMacPinNotification(config.pin6, config.hostName);
  }

  if (flags.json) {
    console.log(JSON.stringify({
      ok: true,
      daemonRunning: Boolean(health),
      hostName: config.hostName,
      port: config.port,
      pin6: config.pin6,
      lanUrl,
      funnelUrl,
      token: config.bearerToken,
      pairUri,
      stateDir,
    }, null, 2));
    return;
  }

  console.log('');
  console.log(`Antigravity Mac Unified Bridge · 配对信息 / Pairing (${config.hostName})`);
  console.log(`守护状态 / Daemon: ${health ? `🟢 运行中 (${lanUrl})` : '⚠️ 未检测到后台进程，请先运行 ag-mobile-bridge install-agent'}`);
  console.log('');
  console.log('1) 手机和 Mac 在同一 Wi-Fi（推荐直接输数字，不用扫码）：');
  console.log(`   6 位数字配对码 / Same Wi-Fi PIN:  \x1b[1;32m${config.pin6}\x1b[0m`);
  console.log('');
  console.log('2) 异地 / 跨网首次绑定（用 iPhone 扫描下方二维码 / Scan QR with iPhone）：');
  console.log('');

  try {
    const matrix = generateQrMatrix(pairUri);
    console.log(renderQrHalfBlocks(matrix, { quietZone: 2 }));
  } catch (err) {
    console.log(`(二维码渲染跳过: ${err.message})`);
  }

  console.log('');
  console.log('3) 备用配对链接 / Fallback Pair URI:');
  console.log(`   ${pairUri}`);
  console.log('');
  if (!funnelUrl) {
    console.log('💡 提示：如需出门 5G 远程直连（手机零 VPN），可运行 ag-mobile-bridge install-agent 自动启动 cloudflared 加密隧道，或安装 Tailscale 开启 tailscale funnel 58470');
  } else {
    console.log(`🌐 已就绪异地 5G 公网加密入口 (HTTPS/WSS)：${funnelUrl}`);
  }
  console.log('');
}

async function cmdPin(flags) {
  const cfg = flags.rotate ? rotatePin() : loadOrCreateConfig().config;
  if (flags.notify) {
    showMacPinNotification(cfg.pin6, cfg.hostName);
  }
  console.log(cfg.pin6);
}

async function cmdDoctor() {
  const { config, stateDir } = loadOrCreateConfig();
  const health = await probeLocalHealth(config.port);
  const agyBin = resolveAgyBinary();
  const agyExists = fs.existsSync(agyBin);
  const proxy = await resolveIsolatedProxy({ allowEphemeral: false });
  const dbPath = path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
  const dbMeta = readConversationDbMetadata([{ surface: 'desktop', path: dbPath }]);
  const funnelUrl = detectTailscaleFunnelUrl(config.funnelUrlOverride, stateDir);
  const lanIp = detectPrimaryLanIPv4();

  const report = {
    ok: Boolean(agyExists),
    daemonRunning: Boolean(health),
    launchAgentInstalled: fs.existsSync(getPlistPath()),
    stateDir,
    port: config.port,
    lanUrl: `http://${lanIp}:${config.port}`,
    funnelUrl,
    rendezvousTopicPrefix: `${deriveRendezvousTopic(config.bearerToken).slice(0, 14)}...`,
    agyBin,
    agyExists,
    proxyMode: proxy.mode,
    proxyUrl: proxy.proxyUrl,
    sqliteReadonlyCount: dbMeta.size,
  };
  console.log(JSON.stringify(report, null, 2));
}

async function reloadLaunchAgentNow(plistPath) {
  const domain = getGuiDomain();
  const target = `${domain}/${LAUNCH_AGENT_LABEL}`;
  try {
    execFileSync('/bin/launchctl', ['bootout', target], { stdio: 'ignore' });
  } catch {}

  let lastBootstrapErr = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      execFileSync('/bin/launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' });
      lastBootstrapErr = null;
      break;
    } catch (err) {
      lastBootstrapErr = err;
    }
  }
  if (lastBootstrapErr) {
    throw lastBootstrapErr;
  }

  execFileSync('/bin/launchctl', ['kickstart', '-k', target], { stdio: 'ignore' });
}

async function performDetachedReload({ stateDir, plistPath, port, waitForIdle, token }) {
  // Ignore termination signals from a retiring LaunchAgent process group between bootout & bootstrap.
  process.on('SIGTERM', () => {});
  process.on('SIGHUP', () => {});

  const pendingPath = path.join(stateDir, 'reload-pending.json');
  const maxWaitMs = 45 * 60 * 1000;
  const startedAt = Date.now();

  if (waitForIdle) {
    while (Date.now() - startedAt < maxWaitMs) {
      try {
        const cur = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        if (cur?.token && token && cur.token !== token) {
          return;
        }
      } catch {}

      const health = await probeLocalHealth(port);
      if (!health || Number(health.inFlightCount || 0) === 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  try {
    const cur = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    if (!token || cur?.token === token) {
      fs.unlinkSync(pendingPath);
    }
  } catch {}

  await reloadLaunchAgentNow(plistPath);
}

async function cmdInstallAgent(flags) {
  const stateDir = resolveStateDir();
  const { config } = loadOrCreateConfig({
    stateDir,
    port: flags.port ? Number(flags.port) : DEFAULT_PORT,
  });
  const plistPath = getPlistPath();
  ensurePrivateDir(path.dirname(plistPath));
  const logsDir = path.join(stateDir, 'logs');
  ensurePrivateDir(logsDir);

  if (flags['perform-reload-now'] || flags['perform-reload-when-idle'] || flags['perform-reload-daemon']) {
    await performDetachedReload({
      stateDir,
      plistPath,
      port: config.port,
      waitForIdle: Boolean(flags['perform-reload-when-idle']),
      token: typeof flags['reload-token'] === 'string' ? flags['reload-token'] : '',
    });
    return;
  }

  const plistXml = buildLaunchAgentPlist({
    nodeBin: process.execPath,
    entryScript: BRIDGE_ENTRY,
    port: config.port,
    stateDir,
  });
  fs.writeFileSync(plistPath, plistXml, { mode: 0o644 });

  const health = await probeLocalHealth(config.port);
  const insideChild = process.env.AG_MOBILE_BRIDGE_CHILD === '1';
  const hasInFlight = Boolean(health && Number(health.inFlightCount || 0) > 0);
  const deferUntilIdle = !flags.force && (insideChild || hasInFlight);

  const reloadToken = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const pendingPath = path.join(stateDir, 'reload-pending.json');
  fs.writeFileSync(pendingPath, JSON.stringify({ token: reloadToken, requestedAtMs: Date.now(), port: config.port }), { mode: 0o600 });

  const childArgs = [
    BRIDGE_ENTRY,
    'install-agent',
    deferUntilIdle ? '--perform-reload-when-idle' : '--perform-reload-now',
    '--port',
    String(config.port),
    '--reload-token',
    reloadToken,
  ];
  const reloadEnv = { ...process.env, AG_MOBILE_BRIDGE_CHILD: '0' };
  const logFd = fs.openSync(path.join(logsDir, 'reload.log'), 'a');
  try {
    const helper = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: reloadEnv,
    });
    helper.unref();
  } finally {
    fs.closeSync(logFd);
  }

  if (deferUntilIdle) {
    console.log(
      `[ag-mobile-bridge] LaunchAgent plist updated (${plistPath}); deferred restart until active ACP turns finish (inFlight=${health?.inFlightCount ?? 0}, childEnv=${insideChild}).`,
    );
    return;
  }

  const waitStart = Date.now();
  let ready = false;
  while (Date.now() - waitStart < 25_000) {
    await new Promise((r) => setTimeout(r, 250));
    const h = await probeLocalHealth(config.port);
    if (h?.ok) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    throw new Error(`Timed out waiting for ag-mobile-bridge to come online on port ${config.port}`);
  }
  console.log(`[ag-mobile-bridge] LaunchAgent installed and started: ${plistPath} (port ${config.port})`);
}

function cmdUninstallAgent() {
  const plistPath = getPlistPath();
  const domain = getGuiDomain();
  try {
    execFileSync('/bin/launchctl', ['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`], { stdio: 'ignore' });
  } catch {}
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
  }
  console.log('[ag-mobile-bridge] LaunchAgent removed.');
}

async function cmdPushWechat() {
  const dshWechatBin = path.join(os.homedir(), '.local', 'bin', 'dsh-wechat');
  if (!fs.existsSync(dshWechatBin)) {
    throw new Error(`dsh-wechat binary not found at ${dshWechatBin}`);
  }
  const { config, stateDir } = loadOrCreateConfig();
  const health = await probeLocalHealth(config.port);
  const lanIp = detectPrimaryLanIPv4();
  const lanUrl = health?.lanUrl || `http://${lanIp}:${config.port}`;
  const funnelUrl = health?.funnelUrl || detectTailscaleFunnelUrl(config.funnelUrlOverride, stateDir);
  const pairUri = buildPairUri({
    instanceId: config.instanceId,
    hostName: config.hostName,
    lanUrl,
    funnelUrl,
    token: config.bearerToken,
  });

  const statusLine = health ? `🟢 运行中 (${config.hostName})` : `⚠️ 守护进程未运行 (${config.hostName})`;
  const remoteLine = funnelUrl ? `公网加密隧道: ${funnelUrl}` : '公网加密隧道: 尚未就绪';
  const msgText = [
    `[Antigravity Mobile Bridge] ${statusLine}`,
    `局域网: ${lanUrl}`,
    remoteLine,
    '',
    '点击或复制下方配对链接，在 iPhone 上用 Antigravity 打开即可一键恢复/同步连接：',
    pairUri,
  ].join('\n');

  execFileSync(dshWechatBin, ['send', msgText], { stdio: 'inherit', timeout: 15_000 });
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h || cmd === 'help') {
    console.log(`Usage: ag-mobile-bridge <serve|pair|pin|doctor|push-wechat|install-agent|uninstall-agent>`);
    return;
  }
  if (cmd === 'serve') return cmdServe(flags);
  if (cmd === 'pair') return cmdPair(flags);
  if (cmd === 'pin') return cmdPin(flags);
  if (cmd === 'doctor' || cmd === 'status') return cmdDoctor();
  if (cmd === 'push-wechat') return cmdPushWechat();
  if (cmd === 'install-agent' || cmd === 'restart') return cmdInstallAgent(flags);
  if (cmd === 'uninstall-agent') return cmdUninstallAgent();

  console.log(`Usage: ag-mobile-bridge <serve|pair|pin|doctor|push-wechat|install-agent|uninstall-agent>`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

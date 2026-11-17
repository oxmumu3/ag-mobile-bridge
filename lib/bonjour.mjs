import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Advertise `_agmobile._tcp` over Bonjour using macOS native `/usr/bin/dns-sd`.
 */
export function startBonjourAdvertisement({ hostName, port, instanceId } = {}) {
  const dnsSdBin = '/usr/bin/dns-sd';
  if (!fs.existsSync(dnsSdBin) || !port) {
    return { stop: () => {} };
  }

  const serviceName = (hostName || 'Antigravity Mac').slice(0, 60);
  const args = [
    '-R',
    serviceName,
    '_agmobile._tcp',
    'local',
    String(port),
    'v=1',
    `host=${serviceName}`,
    ...(instanceId ? [`id=${instanceId.slice(0, 12)}`, `iid=${instanceId}`] : []),
  ];

  let child = null;
  try {
    child = spawn(dnsSdBin, args, { stdio: 'ignore' });
    child.on('error', () => {});
  } catch {
    return { stop: () => {} };
  }

  return {
    stop: () => {
      try {
        if (child && child.exitCode === null && !child.killed) {
          child.kill('SIGTERM');
        }
      } catch {}
    },
  };
}

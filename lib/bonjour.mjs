import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Advertise `_agmobile._tcp` over mDNS/Bonjour (macOS `dns-sd` or Linux `avahi-publish-service`).
 */
export function startBonjourAdvertisement({ hostName, port, instanceId } = {}) {
  if (!port) return { stop: () => {} };

  const serviceName = (hostName || 'Antigravity Host').slice(0, 60);
  const txtRecords = [
    'v=1',
    `host=${serviceName}`,
    ...(instanceId ? [`id=${instanceId.slice(0, 12)}`, `iid=${instanceId}`] : []),
  ];

  let bin = null;
  let args = null;
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/dns-sd')) {
    bin = '/usr/bin/dns-sd';
    args = ['-R', serviceName, '_agmobile._tcp', 'local', String(port), ...txtRecords];
  } else if (process.platform === 'linux') {
    const avahiCandidates = ['/usr/bin/avahi-publish-service', '/usr/bin/avahi-publish'];
    const avahiBin = avahiCandidates.find((p) => fs.existsSync(p));
    if (avahiBin) {
      bin = avahiBin;
      args = avahiBin.endsWith('avahi-publish-service')
        ? [serviceName, '_agmobile._tcp', String(port), ...txtRecords]
        : ['-s', serviceName, '_agmobile._tcp', String(port), ...txtRecords];
    }
  }

  if (!bin || !args) {
    return { stop: () => {} };
  }

  let child = null;
  try {
    child = spawn(bin, args, { stdio: 'ignore' });
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

import { execFile } from 'node:child_process';

/**
 * Display a non-blocking macOS Notification banner and visible modal dialog with the 6-digit LAN pairing PIN.
 */
export function showMacPinNotification(pin6, hostName = 'Mac') {
  if (process.env.AG_MOBILE_NO_NOTIFY === '1') return;
  const safeHost = String(hostName).replace(/["\\]/g, '');
  const safePin = String(pin6).replace(/[^0-9]/g, '');
  const title = 'Antigravity iOS 配对码 / Pairing PIN';
  const body = `在 iPhone 输入 6 位数字：${safePin} (${safeHost})`;
  const notifyScript = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  const dialogText = `请在 iPhone 输入以下 6 位配对码：\n\n${safePin}\n\n主机：${safeHost}（已同时包含在家 Wi-Fi 与出门 5G 通道）`;
  const dialogScript = `tell application "System Events"\nactivate\ndisplay dialog ${JSON.stringify(dialogText)} with title ${JSON.stringify(title)} buttons {"好"} default button "好" giving up after 60\nend tell`;
  try {
    execFile('/usr/bin/osascript', ['-e', notifyScript], { timeout: 2000 }, () => {});
    execFile('/usr/bin/osascript', ['-e', dialogScript], { timeout: 65000 }, () => {});
  } catch {}
}

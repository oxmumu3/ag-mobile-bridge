# ag-mobile-bridge

**AG Mobile Bridge** Mac 端本地统一守护桥 — 让你的 iPhone / iPad 原生 App 直连自己电脑上的 Antigravity 会话与工作区，**零第三方云端中转、零会话分叉**。

> **iOS / iPadOS App Store 下载**：
> [AG Mobile Bridge on the App Store](https://apps.apple.com/app/ag-mobile-bridge/id6835076436)

---

## 快速开始 / Quick Start

环境要求：**macOS** · **Node.js `>= 22`** · **Antigravity (`agy`)**

### 1. 在 Mac 上启动常驻守护桥并扫码配对

```bash
# 方式 A：通过 npm（发布到 npmjs 后直接生效）
npx ag-mobile-bridge install-agent
npx ag-mobile-bridge pair

# 方式 B：通过 GitHub 直跑（无需提前等 npm 缓存）
npx github:oxmumu3/ag-mobile-bridge install-agent
npx github:oxmumu3/ag-mobile-bridge pair
```

打开 iPhone 上的 **AG Mobile Bridge**，同 Wi-Fi 下可直接输入屏幕弹窗中的 **6 位配对码**，或用相机扫描终端 **二维码**（自动附带局域网 + 异地加密隧道双路径）。

---

## 核心特性 / Features

- **桌面原会话直续（零分叉副本）**：手机端发出的指令直接落入 Mac 原生会话，锁屏、后台挂机或切 5G 均由 Mac 本地后台续跑不断连。
- **「待确认」全交互卡片**：在手机端直接审阅并回复桌面提问（支持单选 / 多选 / 推荐标记 / 自定义补充）、放行关键工具授权，以及确认实施计划继续执行。
- **双路自愈直连（Wi-Fi mDNS + 5G 加密隧道）**：在家自动走毫秒级局域网 `.local` / Bonjour 寻址；外出切换 5G 时通过 Cloudflare Quick Tunnel / Tailscale Funnel 与 E2EE 端到端加密信标自动自愈连接。
- **ETag `304` 零重解码增量缓存**：列表与对话详情支持 `If-None-Match` 缓存，弱网与 5G 环境下极速响应、省电省流量。
- **隐私零上传**：代码、对话历史与配对凭据均只保存在你自己的 Mac 与 iPhone 钥匙串中，不经过任何自建云端服务器。

---

## 常用命令 / CLI Commands

```bash
ag-mobile-bridge install-agent     # 注册并启动 macOS LaunchAgent 常驻守护进程（默认端口 58470）
ag-mobile-bridge pair              # 在终端展示配对二维码与 6 位 PIN
ag-mobile-bridge doctor            # 自检守护桥在线状态、隧道连通性与 Antigravity 工作区读取情况
ag-mobile-bridge serve             # 前台直接运行守护服务（便于调试）
ag-mobile-bridge uninstall-agent   # 卸载并停止 macOS LaunchAgent
```

### 可选环境变量 / Optional Environment Variables

- `AG_MOBILE_STATE_DIR`：自定义运行状态与日志目录（默认 `~/.gemini/ag-mobile-bridge`）
- `AG_MOBILE_LAUNCH_LABEL`：自定义 macOS LaunchAgent Label（默认 `dev.agmobile.bridge`）
- `AG_MOBILE_UPSTREAM_PROXY` / `AG_ISOLATED_LAUNCHER_APP`：可选传给 `agy acp` 的本地隔离出口代理

---

## 测试 / Development

```bash
npm test
```

## 开源协议 / License

[MIT](./LICENSE) © 2026 TECHBOOKS LTD

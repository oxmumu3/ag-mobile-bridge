# ag-mobile-bridge

**AG Mobile Bridge** Mac 端本地统一守护桥 — 让你的 iPhone / iPad 原生 App 直连自己电脑上的 Antigravity 会话与工作区，**零第三方云端中转、零会话分叉**。

> **iOS / iPadOS App Store 下载**：
> [AG Mobile Bridge on the App Store](https://apps.apple.com/app/ag-mobile-bridge/id6835076436)

---

## 快速开始 / Quick Start

环境要求：**macOS** · **Node.js `>= 22`** · **Antigravity (`agy`)**

### 最简单：两步免命令行上手 / 2-Step Zero-CLI Setup（推荐）

1. **在电脑端安装并启动守护桥** —— 复制下面这句直接发给电脑上的 Antigravity（中文 / English 任选其一）：
   - **中文：** `请从 https://github.com/oxmumu3/ag-mobile-bridge 把 Mac 守护桥安装到 ~/.local/share/ag-mobile-bridge，运行 install-agent 启动后台常驻服务，再运行 pair 把 6 位配对码和二维码发给我。`
   - **English:** `Install the Mac companion daemon from https://github.com/oxmumu3/ag-mobile-bridge into ~/.local/share/ag-mobile-bridge, run install-agent to start the background service, then run pair and show me the 6-digit PIN and QR code.`
2. **在手机端按引导配对** —— 在 iPhone 上免费下载 [**AG Mobile Bridge**](https://apps.apple.com/app/ag-mobile-bridge/id6835076436)，打开后跟随引导操作：
   - **同 Wi-Fi**：直接输入 Mac 给出的 **6 位数字配对码**（App 会自动发现同一局域网下的 Mac）；
   - **异地 / 跨网**：扫一下 Mac 终端输出的**二维码**，即自动打通后续 Wi-Fi ↔ 5G 切换重连。

### 可选：手动终端命令 / Manual CLI

```bash
# 通过 GitHub 克隆后长期挂载 LaunchAgent（推荐手动安装方式，零额外依赖）
git clone https://github.com/oxmumu3/ag-mobile-bridge ~/.local/share/ag-mobile-bridge
cd ~/.local/share/ag-mobile-bridge
node ./bin/ag-mobile-bridge.mjs install-agent
node ./bin/ag-mobile-bridge.mjs pair

# 若已发布至 npmjs，也可直接使用 npx：
# npx ag-mobile-bridge install-agent && npx ag-mobile-bridge pair
```

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

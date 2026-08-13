# Agent Note: Electron 桌面外壳（Web UI）

Status: implemented

[English](2026-08-13-electron-desktop-shell.md) | 中文

## Problem

DeepSeek Harness 是一个内嵌于 `dsh` CLI 的 Web 应用：使用 UI 需要手动启动 `dsh web`，并把浏览器标签页停留在 `http://127.0.0.1:3080`。目前没有原生的桌面入口能自行启动服务、呈现 UI、并在退出时随自身关闭服务。仓库的应用层（`apps/*`）已有 CLI 与 Web 前端，但没有桌面组装体。

## Decision

新增 `apps/desktop`，一个以原生桌面应用形式承载现有 Web UI 的 Electron 外壳。Electron 主进程（`src/main.mjs`）按用户解析仓库根目录（显式 `DSH_REPO_ROOT`、应用所在目录、用户已记忆的路径、对用户的驱动器与主目录进行有界扫描以查找 `@deepseek-ai/dsh-root` 标记，或一次性文件夹选择器），以子进程方式启动 Web 服务（以纯 `node` 运行已构建的 CLI，未构建的检出则通过 pnpm 运行 `dsh web`），轮询默认 URL 直到返回 HTTP 2xx，然后在该 URL 上打开一个先隐藏后显示的 `BrowserWindow`。服务随应用一同拆除：Windows 上使用 `taskkill /T`，POSIX 上发送进程组信号（子进程被独立到自己的进程组）。窗口保持关闭 `nodeIntegration`、开启 `contextIsolation` 与 `sandbox`，并将外部链接交给系统浏览器处理。

`--smoke` 标志是一次确定性检查：它启动服务、不显示地加载一次窗口、捕获 `smoke/smoke.png`、打印页面标题、拆除服务，任何失败都以非零码退出。`DSH_DESKTOP_PORT` 可覆盖默认端口。`electron` 被列入工作区 `allowBuilds`，因为 pnpm 否则会阻止其下载二进制文件的 postinstall 脚本。`resources/icon.png` 由一个零依赖的 Node 脚本生成。

## Alternatives considered

**工作区之外的独立桌面目录。** 被否决，因为该外壳是一等应用，且 `apps/*` 即应用层；非工作区入口无法通过 pnpm 解析 Electron，无法与 `apps/cli` 和 `apps/web` 并列被发现，也会游离于仓库惯例之外。

**复用默认端口上已在运行的 `dsh web` 实例。** 被否决，因为外部服务的配置与工作目录并非我们所拥有，静默挂接会令应用行为取决于一个未知的外部进程。

**让渲染进程对 Node 拥有访问权。** 被否决，因为 Web UI 无需 Node 访问即可工作；严格的 `contextIsolation`/`sandbox` 默认值将可能接触远端的内容与外壳所拥有的进程树隔离开来。

## Consequences

Harness 现在可以以桌面应用形式运行：外壳拥有服务生命周期，因此服务随应用窗口启动、对外服务、并随之拆除。由于外壳自行启动服务，在另一个 `dsh web` 已占用默认端口时启动会产生响亮失败，而非静默挂接。外壳通过 `electron-builder` 交付 Windows 安装程序与便携式可执行文件；这些可执行文件会在机器上自动发现已安装的 harness 检出（自动检测或选择一次后按用户记忆），并运行其本地的 `dsh web` 服务——服务器与 Node 运行时并未打包。`main.mjs` 入口被 oxlint 忽略，且位于仓库 TypeScript 构建程序之外（它是纯 Electron 主进程 ESM），因此不会给既有包增加任何类型检查或静态检查面。
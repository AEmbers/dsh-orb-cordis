# dsh-orb 实施方案

> 每个阶段结束时，官方 dsh 上都能装上一个真能用的东西。官方仓库始终不改。
> 架构见 [02-architecture.md](02-architecture.md)。

## 0. 阶段

| 阶段 | 产出 | 此时用户能做什么 | 依赖 |
|---|---|---|---|
| 0 | 本仓库脚手架，对准本机官方 `0.1.7-rc.2` | 空 bundle 能装进官方 `dsh web` | 无 |
| 1 | Computer Use 工具进官方 dsh | 主窗口里选「Computer Use 模式」，能截图、点击、派后台会话 | 0 |
| 2 | 最小球 | 装上插件后右沿出现球，能对话，能操作屏幕 | 1 |
| 3 | 完整球 | 拖动、停靠、历史、权限、提问卡、模型、头像、设置页 | 2 |
| 4 | 划词、观察框、截图里没有球 | 划词三动作；操作时点击穿过球；截图不含球和边框 | 2 |
| 5 | 发布 | npm 上的 `dsh-orb`，桌面插件页和 CLI 都能装 | 3、4 |

阶段 1 可以单独交给会用主窗口的人。阶段 2 开始，用户安装的名字是 `dsh-orb`，一次安装包含 preset 和球。

## 1. 阶段 0：脚手架（约 1 天）

- pnpm workspace，ESM，`"type": "module"`，用官方各包那种 `tsdown.config.ts` 打包。
- 开发机已有官方桌面预览 `/Applications/DeepSeek Harness.app` `0.1.7-rc.2`。CLI 用同一版本的官方 `dsh`，不要用 fork 的 `dev:desktop` 当验收对象。
- 包名先用 `@dsh-orb/*`。发布前查 npm 占用。

验收：`dsh plugin add file:<空 bundle 的 tgz>` 在官方 `dsh web` 上成功，配置树里看得到插入行。

## 2. 阶段 1：Computer Use（约 3–5 天）

1. 把 `packages/experimental/tool-computer-use` 全部放进 `packages/computer-use`。去掉 `private`，依赖改为 npm 上的 `@deepseek-ai/dsh-*@0.1.7-rc.2`，保留 `./code-agent`。
2. 在官方 `0.1.7-rc.2` 上编译通过。fork 工作区比这个版本旧一个 rc，不能假设 workspace 协议的类型还能直接对上。
3. bundle patch 只插入一条 `@deepseek-ai/dsh-agent-preset`。`config.name` 写「Computer Use 模式」，`description` 和 `order` 来自 `presets/computer-use/preset.yml`。不要再插 `agent-presets` 的 `path`，也不要插 `computer-use-preset-root`。
4. macOS 截图和点击保持源包里的 `screencapture` 与 `osascript`。不要在 Host 里调用 ScreenCaptureKit dylib。

验收（官方 `dsh web`，以及官方桌面版的插件页各一次）：

- 新会话能选到「Computer Use 模式」。
- 「给屏幕截个图」真实执行。macOS 上若系统来问权限，授权对象是终端或 DeepSeek Harness。
- 「把桌面上的表汇总成一份文档」会调用 `code_agent`，主窗口侧栏出现后台会话，完成后摘要回到当前会话。

这一阶段的原生模块加载风险已经在官方 Mac 预览上关闭，见 [01-analysis.md](01-analysis.md) §5。Windows 仍要在阶段 1 或阶段 4 的 Windows 机器上跑一次 koffi 点击。

## 3. 阶段 2：最小球（约 1–2 周）

按这个顺序做，先证明窗口和会话，再搬完整 UI。

1. `@dsh-orb/host`：cordis 插件、`autoStart`、本次启动的 token、loopback socket。启动时打印 `ctx.webServer.port` 和 `ctx.connection.authenticatedUrl(...)`，确认第三方插件看得到这两个服务。
2. 下载并校验锁定版本的 Electron，用它打开 helper 入口，建出透明、置顶、可拖的窗口。`userData` 与官方应用分开。官方应用退出后，helper 进程消失。
3. helper 复刻 `preload.ts` 的最小子集：移动窗口和发一条消息所需的成员。
4. Host 注册会话路由，直接调 `ctx.sessionController`。球里能完成一轮对话和一次真实 GUI 操作。`dsh_orb` 目录里出现会话。
5. socket 断开时 helper 退出；插件 disposer 结束 helper。

验收：官方 `dsh web` 和官方桌面版各装一次 `dsh-orb`。球在屏幕右沿。球里说话能触发 Computer Use。`ps` 里在官方应用退出后没有残留 helper。

此阶段不把官方 SPA 嵌进球。输入框和一条简单转录即可。

## 4. 阶段 3：完整球（约 1–2 周）

- 搬完 `floating-window.ts`：拖动、边缘细条、悬停展开、单击固定、绕球折行的输入框。
- 历史、新建、Access 芯片、提问卡（`$events`）、两条轨的模型菜单、千分比开关。
- 右键菜单。打开主窗口走 `dsh://open`。「退出」改为停用悬浮球。
- 头像：Host 存文件并签发 URL，helper 显示。
- 设置页 client 插件改为 HTTP。官方主窗口「设置 → 悬浮球」能读写上述各项。
- 对话区在 helper 内做完整，仍然不占用官方页面的 `root` 槽。

验收：对照 fork 版 README「悬浮球」一节逐项操作。差别只保留 [01-analysis.md](01-analysis.md) §2 里已经写明的那些：没有独立退出、权限弹窗上的应用名、球跟着官方进程走。

## 5. 阶段 4：划词、观察框、采集排除（约 1 周）

- macOS 划词 napi 与 Swift helper 预编译进 `native-selection`，安装时不要求用户编译。Windows 划词用现成的 koffi。
- 划词监控跑在 Host。工具条和观察框是 helper 的窗口。
- 球、工具条、观察框调用 `setContentProtection(true)`。Host 执行一次 GUI 操作后，截图里没有这些窗口，操作期间点击穿过球。
- 若 content protection 挡不住 `screencapture`，把 ScreenCaptureKit 放进 helper 再截，由 Host 取回图片。不要在 Host 进程里调用那只 dylib。

验收：在任意应用划词，搜索、翻译、发给 Agent 都通。截图无球、无框、无工具条。

## 6. 阶段 5：发布（约 1 周）

- 中英 README、设置页文案、`icon.svg`。
- 读 plugin manager 的 `evaluatePluginCompatibility`，声明兼容的官方 dsh 版本。当前目标是 `0.1.7-rc.2`。官方发新版本时 bump 依赖并重跑阶段 1 和阶段 2 的验收。
- 发布 `dsh-orb` 以及它依赖的 `@dsh-orb/*`。安装说明只有两句：桌面版在插件页填包名；命令行是 `dsh plugin add dsh-orb`。
- 过一遍 §8 的安全清单。

## 7. 风险

| 风险 | 等级 | 处理 |
|---|---|---|
| 用官方已打包的可执行文件当 helper 运行时 | 已排除 | 不走这条路。helper 使用下载的通用 Electron |
| 官方 Mac 预览拦住 ad-hoc dylib / koffi | 已排除 | `0.1.7-rc.2` 上 `disable-library-validation` 为真，并且已经在官方二进制里加载成功 |
| Host 的 Node 模式里调用 ScreenCaptureKit 卡住 | 已知，避开 | 常规截图继续用 `screencapture`。排除窗口用 helper 的 content protection。SCK 若仍需要，只在 helper 里调用 |
| `setContentProtection` 不能从 `screencapture` 里去掉球 | 中 | 阶段 4 用真实截图确认。失败则改由 helper 做 ScreenCaptureKit |
| 第三方插件读不到 `ctx.webServer` / `ctx.connection` | 低 | 阶段 2 第一步打印。这两个是官方服务，web 插件一直在用 |
| 官方 API 相对 fork 的 `0.1.7-rc.1` 有差异 | 中 | 依赖范围 `>=0.1.7-rc.2 <0.3.0-0`（排除 0.3 预发布），阶段 1 以编译和真机工具调用为准 |
| 以后官方 Electron 或 dsh 升级 | 中 | helper 锁自己的 Electron 版本。dsh 依赖随官方版本 bump |
| 桌面插件页对「外部 npm 包 + client 插件 + 原生模块」一次装不全 | 中 | 阶段 0 用官方桌面插件页装空 bundle，阶段 2 装真包。CLI 路径不依赖这个页面 |
| macOS 权限弹窗写着 DeepSeek Harness 或终端 | 已接受 | 球里的引导文案写明要授权的应用名 |
| 下载的 Electron 首次被 Gatekeeper / SmartScreen 询问 | 低 | 使用 Electron 官方已签名的发布物。桌面版用户会多一次系统提示 |
| helper 变成孤儿进程 | 低 | socket 断开即退出 |
| token 泄露 | 低 | 每次启动随机、只走环境变量、只听 loopback |
| npm 包名被占 | 低 | 发布前查 |

## 8. 安全清单

- token 不进 argv、不写磁盘、不打进日志里的完整 URL。`authenticatedUrl` 含官方凭据，日志只记端口。
- helper 只连 `127.0.0.1`。
- 插件代码跑在 Host 信任边界内，与官方其它插件相同。README 写明安装即会在本机执行 Computer Use。
- 不收集遥测。

## 9. 顺序

先做阶段 0 和阶段 1。阶段 1 通过后再做球。阶段 2 的第一天只验证两件事：锁定版本的 Electron 能建出透明置顶窗，以及 Host 插件能读到官方 web 端口和鉴权 URL。

单人估计仍是 6–8 周。阶段 1 结束就可以给会用主窗口的人用。

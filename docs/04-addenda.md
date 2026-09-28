# 修订记录

> 2026-09-28 对照源码和本机官方预览之后，对原稿的修改。实施不要以本文的旧结论为准；规格在 [01-analysis.md](01-analysis.md)、[02-architecture.md](02-architecture.md)、[03-plan.md](03-plan.md)。
>
> 原稿的分析日期也是 2026-09-28。下面「保留」的条目已经写进新的三份规格。「改掉」的条目不要再实现。

## 1. 保留并写进规格的

这些和源码一致，新文档直接采用了。

- Host 以 `ELECTRON_RUN_AS_NODE=1` 启动，插件进程里没有 `electron` 模块。
- 用户安装单位是带 `dsh.bundle.patch` 的 bundle。`dsh plugin add` 有 registry、绝对路径、tarball、git 四种 spec。
- 官方 CLI 不能管理 `desktop` profile。桌面安装走应用内插件页，`desktopPnpm.runExternalMarketPluginInstall` 存在。
- `tool-computer-use` 是 `"private": true`，要改名再发布。13 个 GUI 工具、`code_agent` 的 `whenIdle` + `followup`、可选的 `orbCodeAgentModel` / `orbCoordinateMode` 都属实。
- `floating.js` 除了 fetch，还有 `window.dshDesktop`。preload 必须在 helper 里复刻，否则页面第一行就没有 API。
- `ui-settings-orb` 在官方主窗口拿不到 `dshDesktop.orb`，会静默隐藏。数据面改 HTTP。
- `orb-agent-models.ts` 和壳侧 `orb-permission.ts` 要搬进 Host，不能只搬 desktop-host 里那几个被动服务。
- 依赖必须钉死官方发布版本。原稿记录的 dist-tag 现象仍然有效：`latest` 偏旧，新版本在 `next`。当前钉的版本是 `0.1.7-rc.2`。
- Windows Computer Use 用 koffi 调系统 DLL，没有单独的预编译产物。划词的预编译工作主要在 macOS。
- 行数：`floating-window.ts` 961、`floating.js` 1448、`preload.ts` 88、`orb-agent-models.ts` 102，以及原稿列出的其它文件行数，在当前 fork HEAD 上仍然相符。`api.floating` 31 处、`api.backend` 2 处、`api.locale` 1 处，也相符。

## 2. 改掉的

### 2.1 helper 运行时

原稿把「spawn 官方 `process.execPath`，去掉 `ELECTRON_RUN_AS_NODE`，把我们的入口脚本喂进去」写成已经核实的主路径，下载 Electron 只是失败后的兜底。

源码只证明 Host 是用官方可执行文件以 Node 模式拉起的。已打包的 Electron 启动自己的 `app.asar`，额外参数不会换成另一份 main。官方 `single-instance.ts` 在拿不到锁时直接 `quit`。桌面版和 `dsh web` 的 helper 都使用下载的通用 Electron。`DSH_ORB_ELECTRON_PATH` 只给开发。

### 2.2 紧凑聊天

原稿打算原样 vendor `ui-overlay-chat`，并让球的 iframe 打开 `index.html?surface=overlay`。

官方 `ui-layout` 总会注册 `root`。fork 能让出这个槽，是因为它改了官方包 `packages/client/ui-layout`，并在 `packages/api/session-controller` 里新增了 `overlayClientSurface`。官方 `0.1.7-rc.2` 没有这个导出。再注册同一个 `root` 会抛错；若 client 包去 import 不存在的导出，还可能让整个 Web UI 加载失败。

对话 UI 做在 helper 里。不修改、不替换官方 `ui-layout`。

### 2.3 preset 的两条通道

原稿要求同时插入 `dsh-agent-preset` 行，以及 `agent-presets` + `computerUsePresetRoot` 目录。依据是 `apps/desktop-host/tests/overlay.spec.ts` 和 `apps/desktop-host/config/desktop.cordis.patch.yml`。

该 yml 不在当前 HEAD 里。官方 preset 注册表读的是声明行上的 `name`、`description`、`order`、`plugins`。旧的 `$DSH_HOME/.agent-presets/` 目录不再被读取。`preset-root.ts` 不进入发布物。显示名「Computer Use 模式」写在声明的 `config.name` 上。

### 2.4 `dsh-app://` 与 `listen: false`

原稿把自定义 scheme、`listen: false`、`desktop-fetch.ts` 说成 fork 独有，并说官方桌面只提供 loopback。

官方壳同样注册了 `dsh-app`，并用 `forwardWebRequest` 转到 Host 的 loopback。`desktop-fetch.ts` 在当前 fork 里只被自己的测试引用。官方和当前 fork 的桌面 Host 都在听 TCP，并发送 `ctx.connection.authenticatedUrl(...)`。规格采用这条官方基址。helper 可以自己再注册一个 `dsh-app` 做转发，那是为了少改 `floating.js`，不是因为官方没有 scheme。

### 2.5 打开主窗口

原稿写官方没有 URL scheme。官方 `main.ts` 在打包应用里调用 `setAsDefaultProtocolClient('dsh')`，`dsh://open` 会聚焦主窗口。macOS 用 `open dsh://open`。

### 2.6 原生模块被签名拦住

原稿把「官方 Desktop 的 library validation 可能拦住 koffi 和 dylib」列为低到中风险，并要求阶段 1 第一天在官方桌面上实测。

2026-09-28 已在 `/Applications/DeepSeek Harness.app` `0.1.7-rc.2` 上实测：

- `codesign` 显示 hardened runtime，且 `com.apple.security.cs.disable-library-validation` 为真。团队 ID `NAN929V4UM`。
- 该可执行文件在 `ELECTRON_RUN_AS_NODE=1` 下加载了 koffi、ad-hoc 的 `libmacos-sck-capture.dylib` 和 ad-hoc 的 `macos-sck-napi.node`。
- 同一进程执行 `screencapture` 得到 160×160 PNG；执行 `osascript` 读到前台应用名。
- 同一进程调用 ScreenCaptureKit napi 的 `capture()` 超过 30 秒无输出，进程已结束。这不是签名拒绝，是 Node 模式没有 Cocoa 主循环，而 dylib 在等主队列。

因此 Mac 上「装了插件却完全不能 Computer Use」不成立。规格改为：常规截图和点击继续走子进程；采集排除放在 helper 窗口上。

### 2.7 计数

原稿把 client 插件从 70 改成 71。按 `packages/` 里带 `dsh.client` 的包计算，官方 `master` 是 68 个，fork 另加 `ui-overlay-chat` 和 `ui-settings-orb`，合计 70。这个数字不参与实现。真实 bundle（去掉 `@local` 模板和测试 fixture）仍是 11 个，这一点保留。

## 3. 产品决定

这些是审核时一起定下来的，原稿里没有写清楚。

- 用户只安装 `dsh-orb` 一个插件，就同时得到 preset 和悬浮球。
- 球跟着官方 dsh 进程。菜单是「停用悬浮球」，不是退出整个官方应用。
- 权限弹窗上的名字用官方应用或终端，引导文案照实写。
- Linux 不建球。
- 不把「等官方合并一个建窗 API」放进计划。

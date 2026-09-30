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
- 依赖必须钉住官方发布版本。原稿记录的 dist-tag 现象仍然有效：`latest` 偏旧，新版本在 `next`。编译对照的版本是 `0.1.7-rc.2`。安装范围是 `>=0.1.7-rc.2 <0.3.0-0`，不包含 `0.3.0` 的预发布版。
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

## 4. 截图必须带鼠标(2026-09-30)

Agent 执行期间看不到光标:点偏了无法自查,会误判为「点了没反应」。规格补一条:鼠标在采集范围内就必须出现在截图里,范围外可不管。两条采集路径都改:

- 常规路径(生产唯一路径,排除表恒空):`screencapture -x` 加 `-C`,由 WindowServer 把系统光标原位烤进全屏图,sips 裁剪后光标随裁剪保留。本机 macOS 26 实测光标位置与真实指针一致。
- SCK helper 路径(CLI 与 dylib 共用):`SCScreenshotManager` 的 `showsCursor` 在各版本上表现不一且窗口滤镜根本不含光标层,改为 `showsCursor = false` + 捕获后手动合成:SkyLight `CGSCopyCursor`(macOS 26 已无此符号,回落 `NSCursor.currentSystem`)取真实光标位图,再画一圈红底白边的定位环,环心即指针精确位置——热点换算按返回 CGImage 的实际倍率(`representations.first` 可能低于实际返回的倍率,曾导致尖端偏 5pt)。指针在区域外(留 12pt 边距)则原图返回,光标隐藏时不画,避免幻影。

合成逻辑带 `-D DSH_SCK_COMPOSITE_TEST` 独立测试入口(合成 2x 位图实拍验证尖端与环心重合)。本机 SCK 的内容枚举拿不到 displays 且流启动失败(macOS 26 环境先在问题),region 路径端到端仍以实机为准;Windows 的 GDI `capturePng` 同样不含光标,留待后续。

## 5. Agent 执行期间遮蔽悬浮球(2026-09-30)

对齐原版 deepseek-harness 的 overlay guard 语义:悬浮球平时可被截图/录屏(用户手动截图照常含球),但 Agent 自己的采集里必须看不到自家 chrome——否则球进观察图,Agent 可能对着球点击。覆盖球、划词工具条、观察框三个窗口,Windows 与 macOS 一致生效。

- helper 侧(packages/helper/src/cloak.ts + overlays.ts):refcount 遮蔽,`capture`/`input` 两个计数,任一 >0 即对所有 chrome 窗口 `setContentProtection(true)`;计数归零恢复常开状态。input 区间额外把球设为点击穿透(`setIgnoreMouseEvents(true, {forward:false})` + `blur`),让 CGEvent/SendInput 落到下层应用。观察框在 Windows 保留静止态保护(原版 observation-frame-window 同款,它停在观察区外围整轮可见)。新增 `overlay-capture {id, active}` socket 消息,与 `overlay-input` 对称;helper 随 host 断连退出,计数不跨进程存活,无需 reset 管道。
- host 侧(packages/host/src/overlay-guard.ts):`withCapture` 从直通改为真握手——depth 0 且 helper 在线时发 `overlay-capture begin`,等 ack 后再等 50ms(保护开关到达 WindowServer/WDA 的裕量)才放行采集,finally 补发 end(失败吞掉,helper 重启自愈)。input 区间内的嵌套 capture 不再发消息:整个 HID burst 期间保护本来就由 input 计数持有,省两次往返和 settle。
- 平台差异说明:原版 macOS 靠 SCK 按 CGWindowID 排除、Windows 靠 WDA_EXCLUDEFROMCAPTURE;本 fork 的采集路径是 `screencapture -x -C`(无法按 id 排除),故 macOS 也走动态 NSWindowSharingNone——效果与原版一致(采集瞬间从截图中消失,物理屏幕始终可见),但用户录屏时球会在每次 Agent 采集的几百毫秒里短暂消失,Windows 原版本就如此。
- 球窗口创建时的两处常开 `setContentProtection` 与工具条的一处已删除:静止态必须可被截取,开关全权归遮蔽。
- 测试:helper/tests/cloak.test.ts(静止态/区间开关/穿透/refcount 嵌套/窗口销毁容错/reset),host/tests/selection.test.ts 改写 overlay guard 组(capture 握手、无 helper 直通、input 内嵌套不发、失败仍补 end)。

补丁(同日):实测点击仍会落在球上——`setIgnoreMouseEvents` 设置后 WindowServer 的命中测试要过几十毫秒才提交,而 helper 应用完立即回 ack,Agent 的 CGEvent/SendInput 与这个提交赛跑。原版 `floating-window.ts` 的 `OVERLAY_GUARD_INPUT_APPLY_MS = 80` 就是为此存在("Milliseconds Electron waits after click-through before acking input begin, so WindowServer hit-testing has committed"),fork 从未移植。现补上:cloak.ts 新增 `scheduleCloakAck`,input-begin 的 ack 延迟 80ms 再回(从应用点击穿透那一刻起算;helper 繁忙时 timer 晚触发则裕量自动拉长),ack 到达即 host 放行 HID 的信号——时序与原版 helper 侧延迟完全一致;capture 区间与 input-end 仍立即回 ack。这个裕量是平台无关的,Windows(SendInput)与 macOS(CGEventPost)同样生效。

## 6. 悬浮球文字可选中复制 + 消息复制按钮与 Token 用量(2026-09-30)

对齐主窗口 chat 语义:悬浮球展开框里的对话内容此前全局 `user-select: none`,一个字都选不中,也没有任何复制入口。

- 可选中:`floating.css` 保持 html/body 全局 none(球/工具条等 chrome 不受拖选干扰),`#transcript` 单独放开 `user-select: text`,`#transcript button` 再收回 none;helper 的 `context-menu` 在 `params.hasSelection` 时放行系统菜单(Copy),裸右键仍是球自身菜单,与 `isEditable` 同一处理。
- 消息动作行(官方 MessageIconActions 的极简版,无 Fork/点赞/点踩):用户气泡下方右对齐一个复制图标按钮,复制气泡原文;assistant 回复下方一个复制图标按钮(复制原始 markdown,经 WeakMap 随 upsert 更新)+ Token 用量 pill。流式期间动作行隐藏,落定后出现;折叠语义不破坏(动作行在 block 内,随 `data-response` 折叠)。
- Token 用量:官方 `assistant/message` 事件本就带 `usage?: TokenUsage`(dsh-session 事件表),host 在 `onAssistant` 落定时把 usage 挂到该消息最后一个 assistant 块上单独再广播一条(推理块不带);`block()` 合并语义为「带 usage 即替换、不带则保留前值」,消息降级(response 反标记)与 finishTurn settleBlock 都经同一合并,usage 不丢。渲染端 pill 文案 `{count} tok`、总计 = 未缓存输入 + 缓存读 + 缓存写 + 输出(官方 UsagePill 的 billed 口径,不信 provider total),缩放格式与官方 formatTokens 一致(999 → `999`,1234 → `1.2K`,≥1M → `1.2M`),悬停 title「本轮用量」/「Turn usage」。
- 复制实现抽出 `writeClipboard`(navigator.clipboard 优先,execCommand 回落),卡内代码块复制与消息复制共用;消息按钮复制成功后图标换勾 1.2s。
- 新增 COPY/CHECK 两个 16px current-color 图标(icons.js)。测试:transcript-model 组补 tokenUsageTotal/formatTokenCount/usageLabels 与页面接线断言,host runtime 组新增「usage 只落在收尾回复块」用例(含降级保留)。Electron 44 冒烟实测:气泡/正文 computed user-select=text,动作行与用量 pill 正常渲染。

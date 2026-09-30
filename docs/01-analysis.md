# dsh-orb 可行性与产品结论

> 修订日期：2026-09-28。实施以本文、[02-architecture.md](02-architecture.md)、[03-plan.md](03-plan.md) 为准。与初版分析的差异见 [04-addenda.md](04-addenda.md)。
>
> 源项目：fork `mini-yifan/deepseek-harness-orb`（`72f1d738`，基于官方 `0.1.7-rc.1`）。
> 对照的官方树：`deepseek-ai/deepseek-harness` `master` `21638c56`，版本 `0.1.7-rc.2`（2026-09-27）。
> 对照的官方预览：DeepSeek Harness 桌面版 `0.1.7-rc.2`，Developer ID `NAN929V4UM`。

## 1. 结论

可以做成官方 dsh 插件，官方仓库一行不改。用户安装这一个插件后，得到现在 Orb 的悬浮球能力：边缘停靠、对话、Computer Use、后台代码会话、划词、观察框、权限和模型设置。主窗口仍是官方 DeepSeek 的窗口。

球不画在官方壳里。插件在 Host 里拉起自己的 Electron 窗口进程，球、划词条、观察框都住在那里。

这个 Electron 使用从官方发布物下载的通用 Electron，接受我们自己的入口脚本。已安装的 `DeepSeek Harness.app` 可执行文件加载的是它自己的 `app.asar`，并有单实例锁，不能拿来当球的运行时。

## 2. 用户最终看到什么

安装方式和别的插件相同，入口按官方现有规则分成两个：

- 官方桌面版：在应用内的插件页填写包名。官方 CLI 会拒绝 `dsh plugin --profile desktop`，报错是 `profile "desktop" is managed exclusively by the Electron application`。
- `dsh web`：`dsh plugin add <包名>`。第一次出球前下载一份 Electron 运行时，之后不用再下。

装好并且插件加载完成后，球出现在主屏右沿，置顶。之后的手感对齐 fork 版 README「悬浮球」一节：

- 悬停展开，单击钉住，拖动，拖出左右边缘后收成细条。
- 在球里说话。看得见的操作当场执行；翻文件、写文档派给后台会话，完成后摘要回到球里。后台会话出现在主窗口侧栏的 `dsh_orb` 工作区。
- 面板里有历史、新建、Access 权限芯片、提问卡片、绕球折行的输入框。
- 右键可以打开官方主窗口、分别设置两条轨的模型和思考强度、开关划词、切换千分比或像素坐标、停用悬浮球。
- 任意应用划词后出现搜索、翻译、发给 Agent。
- 操作屏幕时，球、展开面板、划词条、观察框不进截图，点击能穿过球。被观察的窗口有一圈边框。
- 主窗口设置里可以更换球头像（GIF / PNG / WebP，2 MB 以内）。

展开后的对话画在球自己的页面里，读写的是官方会话。它不把官方主界面嵌进小球。官方 `ui-layout` 始终占据 `root` 槽，官方 SPA 上也不存在 fork 才有的 `?surface=overlay` 紧凑布局。

和独立 Orb 应用相比，有这些已经接受的产品差别：

- 没有单独的 Dock / 任务栏图标。球的生命周期跟着官方 dsh：官方应用退出，球退出。右键原来的「退出 DeepSeek Orb」变成「停用悬浮球」。
- macOS 上第一次操作屏幕前，系统权限弹窗写的是 **DeepSeek Harness**（桌面版）或当前终端（`dsh web`）。授权对象是那个进程，只重启球不会刷新权限。
- Linux 不建球。没有显示器的环境里，后台代码会话可以跑，点击和截图不行。

## 3. 源项目里什么已经是插件

fork 相对其 merge-base（`46a7f68`，`0.1.7-rc.1`）有 106 个自有提交；官方 `master` 在该点之后又有 501 个提交，版本为 `0.1.7-rc.2`。Orb 代码不在官方树上。vendor 时按已发布的 `0.1.7-rc.2` 编译，依赖钉死这个版本，不使用 npm `latest`（`latest` 仍停在更旧的 rc）。

| 层 | 位置 | 插件化方式 |
|---|---|---|
| GUI 工具 + `code_agent` | `packages/experimental/tool-computer-use` | 已是 cordis 插件，`"private": true`，必须改名后自己发布。`orbCodeAgentModel`、`orbCoordinateMode` 是可选的 `ctx.get` |
| 权限、坐标、后台模型 | `apps/desktop-host/src/computer-use-orb-*.ts` | 已是 cordis 插件，但今天编进 fork 的 desktop-host。抽成独立包，由 bundle patch 插入 |
| 球、划词条、观察框、preload | `apps/desktop/src/floating-window.ts` 等 | 不是插件。迁到 helper 进程 |
| 设置页 | `packages/client/ui-settings-orb` | 已是 client 插件。数据面从 `window.dshDesktop.orb` 改成 HTTP，否则在官方主窗口里会静默消失 |
| 紧凑聊天 | `packages/client/ui-overlay-chat` | 依赖 fork 对官方 `ui-layout` 和 `session-controller` 的修改，不能原样装进官方应用。对话 UI 留在 helper |

官方插件形态里，给用户安装的单位是 bundle：`dsh.bundle.patch` 里用 `- insert:` 挂配置行。`dsh plugin add` 接受 registry 名、绝对路径、tarball、git URL。client 插件靠同一棵配置树里的一行，加上包上的 `dsh.client`，由官方 `client-modules` 扫进 Web UI。

## 4. 为什么这条路成立

Host 由官方壳以 `ELECTRON_RUN_AS_NODE=1` 拉起（官方 `apps/desktop/src/node-environment.ts`）。插件在 Host 里没有 `electron` 模块，不能自己 `new BrowserWindow`。

Host 又是普通 Node 程序，可以起子进程、听 loopback、注册 `ctx.webServer` 路由。官方桌面 Host 启动后把带凭据的地址交给壳：

```ts
ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`)
```

球的页面通过这个基址访问官方会话 API 和 `$events`。官方浏览器走的是 WebSocket mux；球今天用的 HTTP NDJSON 由我们自己的路由接到官方 `typertGateway`。

macOS 上 Computer Use 的常规截图是子进程 `/usr/sbin/screencapture`，查看和点击前台走 `/usr/bin/osascript`。这两条都在官方二进制的 Node 模式下实测成功。进程内 ScreenCaptureKit 那条 dylib 是 fork 用来从同一进程的画面里抠掉球的；在 Host 的 Node 模式里调用会卡在主队列上。球改由 helper 自己把窗口标成不参与采集，Host 继续用 `screencapture`。

## 5. 已在官方预览上核实的事实

2026-09-28，对 `/Applications/DeepSeek Harness.app` `0.1.7-rc.2`：

- 签名为 Developer ID Application，hardened runtime。授权包含 `allow-jit`、`allow-unsigned-executable-memory`、`disable-library-validation = true`。
- 用该可执行文件、`ELECTRON_RUN_AS_NODE=1`，成功加载 koffi、ad-hoc 签名的 `libmacos-sck-capture.dylib`，以及 ad-hoc 的 `macos-sck-napi.node`。
- 同一进程拉起 `screencapture`，得到一张 160×160 的 PNG。拉起 `osascript`，读到了当时的前台应用名。
- 因此「官方 Mac 桌面版会拦住第三方原生模块，Computer Use 不能用」这一条，对这份预览不成立。权限弹窗仍会指向 DeepSeek Harness。
- 同一进程里调用 ScreenCaptureKit 的 napi `capture()` 超过 30 秒没有返回，也没有写出图片。该调用已停掉。原因是 dylib 在等 Cocoa 主队列，而 Host 的 Node 模式不跑 GUI 事件循环。

官方壳另外已经注册了 `dsh://`。打包应用里 `dsh://open` 会聚焦主窗口。打开主窗口用这个地址。

## 6. 明确不做的事

- 不改官方 `deepseek-harness` 的任何文件，也不把 Orb 继续做在 fork 的桌面壳上。
- 不向官方提「请给插件开一个建窗 API」作为前置条件。内部可以留一个 overlay 接口，将来官方若提供等价服务，只换 Provider。
- 不把 `ui-overlay-chat` 注册成官方页面的 `root`。官方 `ui-layout` 已经注册了这个 single 槽，再注册会抛错。
- 不恢复按目录扫描 `preset.yml` 的旧通道。官方 preset 是一条 `@deepseek-ai/dsh-agent-preset` 声明，`config` 自带 `id`、`name`、`description`、`order`、`plugins`。
- Linux 不建球。

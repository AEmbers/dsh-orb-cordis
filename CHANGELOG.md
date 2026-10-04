# Changelog

## 0.1.0 — dsh 0.2.1-alpha.1 兼容声明 + 让 git 源码安装真的可装

本仓库是 [`mini-yifan/dsh-orb-cordis`](https://github.com/mini-yifan/dsh-orb-cordis) 的 fork。

### 一、双代核心兼容声明

`packages/bundle/package.json`（= npm 上的 `dsh-orb` 包）：

- 新增 `engines.dsh` = `>=0.1.7-rc.2 <0.3.0-0`
- 新增 `dsh.compatibility`，`dshReleases` 里 `0.1.7-rc.2` / `0.2.0-rc.1` /
  `0.2.0-rc.2` / `0.2.1-alpha.1` 均标 `compatible`
- **放宽两个精确值 peer**（这两个是真正卡住安装的东西）：

  | peer | 改前 | 改后 | 为什么 |
  |---|---|---|---|
  | `@deepseek-ai/cordis` | `4.0.4`（精确值） | `>=4.0.4 <5` | 0.2.1-alpha.1 里 cordis 是 **4.0.5-alpha.1**，精确值 `4.0.4` 直接不匹配 |
  | `@deepseek-ai/schemastery` | `3.18.4`（精确值） | `>=3.18.4 <4` | 0.2.1-alpha.1 里是 **3.18.5-alpha.1**，同理 |

  注意 `@deepseek-ai/cordis` 和 `@deepseek-ai/schemastery` **不在**安装闸门的判定集合里
  （闸门只看 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`）。这里改它们是为了让 pnpm 的 peer
  解析干净、避免 `pnpm peers check` 噪声，不是在过闸门。

**为什么两代都声明**：当前 Desktop 宿主打包的核心仍是 **0.2.0-rc.2**，profile 无法单独升级核心。
只声明 `0.2.1-alpha.1` 会在过渡期被宿主整体拒绝（`dsh: installation rejected`，
一次 `add` 多个包会整批回滚），所以声明必须同时覆盖两代。

### 二、让 `github:AEmbers/dsh-orb-cordis` 成为可安装的

**修复的是上游的一个真实地雷**：`dsh plugin add github:<repo>` 走 git 依赖安装，
npm/pnpm 对 git 依赖**只跑 `prepare` 生命周期脚本**，不跑 `prepack`/`prepublishOnly`，
更不会跑工作区级的 `pnpm build`。而上游 `.gitignore` 里有：

```
dist/
packages/*/lib/
packages/bundle/lib/
packages/bundle/client.js
```

⇒ 上游 `packages/bundle/` 下**只入库了** `cordis.patch.yml` / `package.json` /
`scripts/` / `tests/`，**没有 `lib/`、没有 `client.js`**，`main`（`lib/index.js`）在装完的包里
根本不存在 —— 安装不报错、闸门也不拒绝，**启动时才炸**。

本次把**装配产物**提交入库，使源码树直接可装：

- `packages/bundle/lib/`、`packages/bundle/client.js`、`packages/bundle/dist/`
  —— 即 `node packages/bundle/scripts/assemble.mjs` 的全部输出
- `packages/helper/assets/vendor/` —— helper 在运行期惰性加载的高亮语法包
  （`highlight.js` 里 `import('./vendor/shiki.js')`）。`assemble.mjs` 只整目录拷
  `packages/helper/assets`，所以源码树缺这个目录时，装出来的 helper **高亮会静默失效**。

`.gitignore` 里对应的三行已删除，并加了说明性注释。
`packages/*/src` 仍是唯一真源；重建方式：

```bash
pnpm build                                   # 各 package 的 tsdown 产物
node packages/bundle/scripts/assemble.mjs    # 装配成单个可安装包
```

> 说明：`packages/{client-settings,host,computer-use,helper}/lib/` 这些**中间**产物仍是
> 被 ignore 的（它们的内容已经被装配进 `packages/bundle/`），仓库里不需要再存一份。

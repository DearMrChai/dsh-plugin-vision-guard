# dsh-vision-guard

DSH 视觉请求守卫。**本期（0.2.x）只做一件事**：按 `attachmentId`（= `sha256` 内容寻址引用）去重——同一张图在同一次 LLM 请求里只发一次。模型自己 `read_image` 重读同一张图时，重复的那次出现被登记为「已下车」，模型侧收到占位文本而不是图像字节。

## 为什么做

[进行中的`DSH图片重发去重插件`任务夹](../../进行中/DSH图片重发去重插件/00-为什么做.md) 钉死的病因：

1. `read_image` 每次都 `attachments.saveImage(...)` 提交**新的** image 块（dsh-tool-fs `lib/index.js:1015-1019`）
2. `dsh-llm-pi-ai` 请求组装时把**每个 image 块**都 push 进请求（`lib/index.js:1188-1208`），虽然 `requestImages` 在 Map 层按 attachmentId 去重，只是省了解码，**不省请求体里的张数**
3. 自托管 vLLM（142 的 27B 视觉臂）`--limit-mm-per-prompt image` 已调到 4，但"D + 1 次重读" = 2 张，白付一份视觉 token
4. 400 "At most N image(s)" 被归类 `INVALID_REQUEST` → 会话**钉死**，图永久留在历史里

**本插件治的** = "同一张图一次请求里只出现一次" ⇒ 不再白付视觉 token（472×582 的图 ≈ 285 token，1080p ≈ 2040）/ 不再撞 4 张墙 / 不再会话钉死。

## 怎么实现的（0.2.0 换的实现路径）

**不去改写请求体**——实测证明这条路在 DSH 0.2.0-rc.2 上走不通：

| 事实 | 出处 |
|---|---|
| `agent/pre-step` 的 `decision.messages` 只是「**本步新进入的批次**」，随后被 append 成新的 `user/message` | `dsh-agent-loop/lib/index.js:906,1061` |
| 请求体由 `buildRequest` 从**派生历史**组装，重读的那张图在历史（`tool/result`）里，pre-step 的 messages 看不到它 | `dsh-agent-loop/lib/index.js:1063,1202-1269` |
| 请求对象与消息是**全冻结**的（`Object.freeze(messages)` + 每条 `deepFreeze`） | `dsh-agent-loop/lib/index.js:1261-1269` |
| cordis 的 waterfall `next()` 用原始载荷转发，**不支持 `next(新载荷)`** | `cordis/lib/index.js:317-325` |

**改用 DSH 官方的一等机制**（基础组合已挂载 [`@deepseek-ai/dsh-compaction-image-offload`](../../进行中/DSH图片重发去重插件/01-做到哪.md)）：

1. 本插件在 `agent/pre-step` 里按表层顺序扫描 `session.surface.nodes`，用 `attachmentId` 找出重复出现位置
2. 向会话追加一条 `image/offload` 事件：`{ targets: [{ seq, imageIndexes }] }`（`seq` = 承载该出现的消息事件序号，`imageIndexes` = 该消息内 0-based 图片序号，含已下车位置、严格递增）
3. 官方包注册的 message projection 在派生消息时把选中位置投影成 `{ ...block, offloaded: true }`
4. `dsh-llm` 适配器对 `offloaded` 块发送占位文本（`offloadedImageText`，注明附件与只读路径）而不是图像字节

**收益与代价**：

- ✅ 会话日志**原样保留**图片块（只多一条 `image/offload` 选择事件）⇒ fork/resume/replay 仍可重建，客户端显示不变
- ✅ 只改尾部 ⇒ 前缀缓存命中基本不受影响（官方 README：缓存复用到第一张被修改的图之前）
- ⚠️ 下车是**永久的**：被下车的出现位置不会自动回来，恢复手段是占位文本里的只读路径（官方机制固有性质）
- ⚠️ 用户消息里连续两次贴同一张图时，重复那次会**多存活一个请求**（该消息尚未进表层，只能等下一次 pre-step 登记）

## 本期范围

| 开关 | 状态 | 说明 |
|---|---|---|
| `dedupe.enabled` | `true`（默认开） | 按 attachmentId 登记重复出现位置下车 |
| `cap.enabled` / `cap.keepRecent` | `false` / `4`（占位） | 将来"保留最新 N 张"兜底 |

「超额度」信号（provider 报 `IMAGE_OFFLOAD_REQUIRED`）由基础组合的官方 offload 包负责，本插件**不重复实现**。

**不改 DSH 任何代码**。纯 JS、零构建、零运行时依赖。

## 契约与安全性

- `agent/pre-step` 的 `next()` **恰好调用一次**，本插件原样返回基底 decision（不改写）
- 本插件只做「追加一条会话事件」：任何异常都吞掉并记日志，**绝不阻塞请求**
- 宿主没挂 offload 投影时，Session 会拒绝追加该事件（官方 README：「缺少处理器时拒绝追加和恢复」）⇒ 拒绝是安全的，插件记 `hook error` 后跳过
- 自测覆盖：40 条断言，含 next 恰好一次 / decision 原样返回 / append 抛错不阻塞 / 表层枚举抛错回落 / 日志通道抛错不炸 / 全关不注册

## 安装

### 方式一：本地 `link:`（当前桌面端在用）

与 `dsh-plugin-task-notify` / `dsh-plugin-host-monitor` 同模式，改源码后重启即生效（不触发 HMR）：

1. `profiles\<name>\package.json` 的 `dependencies` 加
   `"dsh-vision-guard": "link:D:/DSH-workspace/代码仓库/dsh-plugin-vision-guard"`
2. `dsh.profile.bundles` 里补 `"dsh-vision-guard"`（本包声明了 `dsh.bundle.patch`，进 bundles 是正常装载路径）
3. 在 profile 目录跑 `dsh plugin install`（或删掉 `node_modules\dsh-vision-guard` 后重跑），重启 DSH 桌面端

> ⚠️ `link:` 装载时 Node 按插件真实路径解析裸导入，走不到 profile 的 `node_modules` 回退目录
> ⇒ **运行时依赖必须自带**。本插件零运行时依赖，不受此限。

### 方式二：从 GitHub 装

```
& "<安装根>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:DearMrChai/dsh-plugin-vision-guard#v0.2.0
```

- pnpm 自动完成三件事：依赖写入 `profiles\<name>\package.json`、拉源码进 profile `node_modules`、**自动对账 `dsh.profile.bundles`**
- 装完**重启 DSH 桌面端**
- ref 可取 tag（`#v0.2.0`）或 commit；不锁也行（跟默认分支走）

**已知三个坑**（都是实测踩到的，别人第一次装同样会踩）：

1. **`github:` 形态会被 pnpm 解析成 `git+ssh://`**，本机没配 SSH 密钥就报
   `Host key verification failed`。两条出路：配 SSH 密钥；或加一条 git URL 重写
   `git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"`
   （实测有效，pnpm 内部调用 git 时吃这条规则）。
2. **`package.json` 的 `files` 白名单必须包含 `cordis.patch.yml`**。pnpm 拷包/打包都按白名单过滤，
   漏了它 ⇒ dsh 校验报 `failed to read overlay .../cordis.patch.yml`，安装被拒。已在 0.1.1 修复。
3. **GitHub 仓库名/账号**是 `DearMrChai/dsh-plugin-vision-guard`（注意 `plugin-`，且大小写敏感）。

### 验证

三条独立证据，任一条成立即说明插件在工作：

1. **DSH 日志**：`[dsh-vision-guard] active — dedupe=true, cap=false`；触发去重时
   `[dsh-vision-guard] offloaded 1 duplicate image occurrence(s): seq 29#0 (total 1)`
2. **会话日志**：`session.v4.jsonl.zstd` 里出现 `image/offload` 事件（`{"targets":[{"seq":29,"imageIndexes":[0]}]}`）
3. **推理侧**：vLLM 日志的 `MM cache hit rate`（口径 = 最近 1000 请求的 `hits/queries`，一次图片出现 = 一个 query）
   递增步长从「每请求 +2」变成「+1」。实测未装插件时序列为 `0% → 50% → 75% → 83.3% → 87.5%`（每请求 2 张），
   装好后应变成 `0% → 50% → 66.7% → 75% → 80%`

反对照：把 `cordis.patch.yml` 的 `dedupe.enabled` 改 `false`，重启，重做同一轮 → 步长回到 +2。

### 回滚

```
& "<安装根>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-vision-guard
```

零 DSH 代码修改，回滚后与未装完全等同（已追加的 `image/offload` 事件会留在历史里——如需彻底还原，
把 `dedupe.enabled` 改 `false` 只会停止新增下车选择，已下车的出现位置仍按官方机制保持下车）。

## 配置（本包 `cordis.patch.yml`）

```yaml
- insert:
  - id: dsh-vision-guard
    name: dsh-vision-guard
    config:
      dedupe:
        enabled: true
      cap:
        enabled: false
        keepRecent: 4
```

profile 层可用同 `id` 覆盖 `config`（patch 对 `config` 是**整体替换**语义，要覆盖就得写全）。

## 路线图

| 版本 | 内容 |
|---|---|
| 0.1.0 → 0.1.2 | 按请求体去重的首版 + 打包/钩子契约/日志修复（**实测无效**，见 0.2.0） |
| **0.2.0**（当前） | 改用官方 `image/offload` 事件与投影；配置去掉 `placeholder` / `offload` 两段 |
| 0.3.0（将来，需求触发） | `cap.enabled=true`：保留最新 N 张，老图登记下车（接 dsh-image-guard 的"最新 N 张"思路，**身份仍用 attachmentId**） |

## 自测（本地）

```
node scripts/selftest.mjs     # 40 条断言：case1-11 纯函数，case12-20 钩子契约
```

无 `prepare` 钩子（git 装不跑自测，避免给别的用户加安装门槛）；`prepack` 只在 `npm pack` / `pnpm pack` 时跑，
即打包前自动 `node --check` + 自测，保证发出去的包是绿的。

## 与 mafeis/dsh-image-guard 的分工

| 维度 | dsh-image-guard | dsh-vision-guard（本） |
|---|---|---|
| 截断范围 | **历史**所有图保留最近 N 张 | **重复出现**的同一张图 |
| 身份 | 字面"最新 N 张" | `attachmentId` (sha256) |
| 适用场景 | 长会话累积 50+ 张不同图 | 模型自己 read_image 重读同一张 |
| 前缀缓存 | 保住（不修历史） | 保住（官方选择事件只改尾部派生） |
| 关系 | 正交，可叠加 | 本期独立 |

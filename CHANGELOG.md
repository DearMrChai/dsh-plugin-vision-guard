# dsh-vision-guard 变更记录

## 0.1.1（2026-10-15）

修 0.1.0 装不上/会污染数据的三个问题（都是真机安装时暴露的）：

- **打包白名单**：`package.json` 的 `files` 从只含 `lib/**` 扩到含 `cordis.patch.yml` / `scripts/**` / `README.md` / `CHANGELOG.md`。
  漏 `cordis.patch.yml` 会导致 dsh 校验报 `failed to read overlay`，`dsh plugin add` 直接拒装。
- **钩子契约**：`agent/pre-step` 的 `next()` 改为**恰好调用一次**。0.1.0 在 catch 里二次调用 `next()`——
  若 `next()` 自身抛错会二次调用并把异常抛出，正好破坏"永不阻塞请求"的初衷。现在 `next()` 异常原样抛出
  （宿主故障），仅去重自身异常回落原始 decision。
- **写时复制**：占位文本追加不再就地改写原消息的 text 块。0.1.0 会把输入消息的
  `text` 改成 `"好的\n[dup #1]"`（实证），污染会话侧对象；现在替换为新对象。

自测：19 → **33 case**（新增 case9-12 覆盖 apply 级钩子契约：next 恰好一次 / 输入不被改写 / 宿主异常上抛 /
内部异常回落 / 全关不注册）。

## 0.1.0（2026-10-15）

- 首版：按 `attachmentId`（= `sha256:<64 位 hex>` 内容寻址）去重请求体里的重复 image 块
- 挂点：`agent/pre-step` waterfall（`dsh-agent-loop/lib/index.js:911`），改的是请求体副本，**不改会话日志**，**前缀缓存命中不受影响**
- 配置段：`dedupe.enabled`（默认开）/ `dedupe.placeholder`（占位文本模板）；`cap.*` 与 `offload.*` 预留，本期都关
- 工程：零运行时依赖纯 JS；`lib/index.js` + `lib/hooks/dedupe.js` + `lib/budget.js`；`scripts/selftest.mjs`
- 装载（桌面端）：`dsh plugin --profile desktop add github:DearMrChai/dsh-plugin-vision-guard#<ref>`，自动对账 bundles
- 已知问题（0.1.1 修）：`files` 漏 `cordis.patch.yml` 装不上；catch 二次 `next()`；占位文本就地改写原块

## 0.2.0（计划）

- `cap.enabled=true` + `keepRecent=N`：保留最新 N 张历史图，老图替换为占位（dsh-image-guard 同款"最新 N 张"思路，**按 attachmentId 做身份，不靠"最新 N"**）

## 0.3.0（计划）

- `offload.enabled=true`：把 vLLM 400 "At most N image(s)" 归成 DSH 的 `IMAGE_OFFLOAD_REQUIRED` 等价信号，触发官方 [dsh-compaction-image-offload](https://dshmarket.com) 的 offload 链
- 代价：图永久降级 + 前缀缓存碎。仅在 dedupe + cap 都救不了时启用

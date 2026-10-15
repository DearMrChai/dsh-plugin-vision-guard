# dsh-vision-guard 变更记录

## 0.1.0（2026-10-15）

- 首版：按 `attachmentId`（= `sha256:<64 位 hex>` 内容寻址）去重请求体里的重复 image 块
- 挂点：`agent/pre-step` waterfall（`dsh-agent-loop/lib/index.js:911`），改的是请求体副本，**不改会话日志**，**前缀缓存命中不受影响**
- 配置段：`dedupe.enabled`（默认开）/ `dedupe.placeholder`（占位文本模板）；`cap.*` 与 `offload.*` 预留，本期都关
- 工程：零运行时依赖纯 JS；`lib/index.js` + `lib/hooks/dedupe.js` + `lib/budget.js`；`scripts/selftest.mjs` 19 case
- 装载（桌面端）：`dsh plugin --profile desktop add github:DearMrChai/dsh-vision-guard#<sha>`，自动对账 bundles

## 0.2.0（计划）

- `cap.enabled=true` + `keepRecent=N`：保留最新 N 张历史图，老图替换为占位（dsh-image-guard 同款"最新 N 张"思路，**按 attachmentId 做身份，不靠"最新 N"**）

## 0.3.0（计划）

- `offload.enabled=true`：把 vLLM 400 "At most N image(s)" 归成 DSH 的 `IMAGE_OFFLOAD_REQUIRED` 等价信号，触发官方 [dsh-compaction-image-offload](https://dshmarket.com) 的 offload 链
- 代价：图永久降级 + 前缀缓存碎。仅在 dedupe + cap 都救不了时启用

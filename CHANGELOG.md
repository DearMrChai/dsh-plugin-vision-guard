# dsh-vision-guard 变更记录

## 0.2.2（2026-10-15）

- **版本号对齐**：v0.2.1 那次提交忘了 bump `package.json`（包里仍写 0.2.0），本次补上
- **自测修复**：0.2.1 的「两级过滤」改了事件读取形状，假会话没跟着改 ⇒ case13 起全挂。现在假会话镜像真实形状
  （`user/message` → `data.content`；`tool/result` → `data.message.content`），并新增 case21/22 覆盖
  「粗筛看**原始** content / `offloaded` 标记看**投影**消息」这条边界；**42 条断言全过**
- ⚠️ **别钉 `#v0.2.1`**：那一次的 `npm run prepack`（打包前自测门禁）会因上面的自测失败而红。
  插件功能本身没问题（`lib/` 与 0.2.2 一致），要钉就钉 `#v0.2.2` 或 `#v0.2.0`

## 0.2.1（2026-10-15）

- **表层扫描两级过滤（性能）**：`agent/pre-step` 每步都跑，原实现给表层**每个**节点都调一次
  `deriveEventMessage`。现改为先用 `eventAt` 的**原始** content 粗筛（绝大多数节点无图），
  只有含 image 的节点才投影——`offloaded` 标记仍必须从投影结果读（原始事件上没有该标记）

## 0.2.0（2026-10-15）

**换实现路径：0.1.x 的"改写请求体"在 DSH 0.2.0-rc.2 上根本不会生效。**

真机实测（用户会话 + 142 vLLM 日志）证明 0.1.2 装好后重读同一张图，请求里仍是 **2 张**：

- vLLM `MM cache hit rate` 口径 = 最近 1000 请求的 `hits/queries`（一次图片出现 = 一个 query）。
  实测序列 `0% → 50% → 75% → 83.3% → 87.5%`，恰好等于「第 1 个请求 1 张，之后每个请求 2 张」。
- 根因（读官方源码确认）：`agent/pre-step` 的 `decision.messages` 只是**本步新进入的批次**
  （`dsh-agent-loop/lib/index.js:906,1061`），请求体由 `buildRequest` 从**派生历史**组装；
  重读的图在历史（`tool/result`）里，pre-step 看不到它。且请求对象全冻结
  （`Object.freeze(messages)` + 每条 `deepFreeze`，`dsh-agent-loop/lib/index.js:1261-1269`），
  cordis waterfall 的 `next()` 也不支持换载荷（`cordis/lib/index.js:317-325`）——原地改与换载荷两条路都封死。

改为复用 DSH 官方一等机制（基础组合已挂载 `@deepseek-ai/dsh-compaction-image-offload`）：

- 在 `agent/pre-step` 扫描 `session.surface.nodes`，按 `attachmentId` 找出重复出现位置
- 追加 `image/offload` 事件 `{ targets: [{ seq, imageIndexes }] }`；官方 message projection 把选中位置
  投影成 `{ ...block, offloaded: true }`，`dsh-llm` 对它们发送占位文本而不是图像字节
- 会话日志**原样保留**图片块 ⇒ fork/resume/replay 仍可重建；前缀缓存只受尾部改动影响

其他变化：

- 配置段去掉 `dedupe.placeholder`（占位文本由 `dsh-llm` 的 `offloadedImageText` 生成）与 `offload.*`
  （「超额度」信号本就该由官方 offload 包处理，不重复实现）
- 日志改用宿主 `ctx.logger.info`（原 `ctx.emit('log')` 没有监听方，日志落不到任何地方）
- 自测重写为 **40 条断言**（case1-11 纯函数含幂等/已下车不误伤，case12-20 钩子契约）
- 验证口径升级：会话日志里的 `image/offload` 事件 + vLLM `MM cache hit rate` 步长 +2 变 +1

## 0.1.2（2026-10-15）

- **日志通道不可抛**：`apply` 里的日志统一走内部 `log()` 包装（try/catch）。原实现的 catch 分支在"上报错误"时
  直接调 `ctx.emit`——日志监听方一旦抛错，就把"插件的小毛病"升级成"阻塞请求"，正好违反本插件"永不阻塞请求"的承诺；
  apply 期同理（抛错会炸 DSH boot）。现在日志失败只丢日志，功能照跑。
- 自测 33 → **34 case**（case13：`ctx.emit` 抛错时 apply 不抛、hook 仍完成去重）

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

## 0.3.0（计划）

- `cap.enabled=true` + `keepRecent=N`：保留最新 N 张历史图，老图按 `attachmentId` 身份登记下车
- 代价：图永久降级（官方机制固有）。仅在 dedupe 救不了（不同图累积超额度）时启用

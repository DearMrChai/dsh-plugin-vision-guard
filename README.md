# dsh-vision-guard

DSH 视觉请求守卫。**本期（0.1.0）只做一件事**：在 LLM 请求组装前，按 `attachmentId`（= `sha256` 内容寻址引用）去重——同一张图一次请求体里只发一次，**第二次及以后**的相同 image 块改为占位文本。

## 为什么做

[进行中的`DSH图片重发去重插件`任务夹](../../进行中/DSH图片重发去重插件/00-为什么做.md) 钉死的病因：

1. `read_image` 每次都 `attachments.saveImage(...)` 提交**新的** image 块（dsh-tool-fs `lib/index.js:1015-1019`）
2. `dsh-llm-pi-ai` 请求组装时把**每个 image 块**都 push 进请求（`lib/index.js:1188-1208`），虽然 `requestImages` 在 Map 层按 attachmentId 去重，只是省了解码，**不省请求体里的张数**
3. 自托管 vLLM（142 的 27B 视觉臂）`--limit-mm-per-prompt image` 已调到 4，但"D + 1 次重读" = 2 张，模型"还是没有在 hilla 看到"
4. 400 "At most N image(s)" 被归类 `INVALID_REQUEST` → 会话**钉死**，图永久留在历史里

**本插件治的** = "同一张图一次请求里只出现一次" ⇒ 不再白付 ~2040 视觉 token（1080p）/ 不再撞 4 张墙 / 不再会话钉死。

## 本期范围（0.1.0）

| 开关 | 状态 | 说明 |
|---|---|---|
| `dedupe.enabled` | `true`（默认开） | 按 attachmentId 去重请求体 |
| `dedupe.placeholder` | 中/英文模板 | 占位文本，`{0}` = 首次出现序号，`{1}` = 附件名 |
| `cap.enabled` | `false`（占位） | 将来"保留最新 N 张"兜底 |
| `offload.enabled` | `false`（占位） | 将来"400 → offload 信号"兜底 |

**本期不动 DSH 任何代码**。纯 JS 零构建，插件探针通过 `agent/pre-step` waterfall hook 实现（见下表"挂点"）。

## 挂点（asar 0.2.0-rc.2 实证）

| 挂点 | 能改什么 | 选用理由 |
|---|---|---|
| `agent/pre-step` waterfall | `decision.messages`（请求体组装前的消息副本） | 在实际发送前改写；不改会话日志 ⇒ 前缀缓存命中 |
| ~~`agent/request-error`~~ | 错误分类 | 本期不需要（400 已在服务端 `limit-mm-per-prompt` 调到 4 后大幅减少） |
| ~~`tools/post-execute`~~ | `read_image` 工具返回值 | 备选挂点；但 pre-step 更早、覆盖所有 send 路径 |

## 安装（一键，`dsh plugin add`）

DSH 桌面端自带 `dsh` CLI（`<安装根>\resources\runtime\cli\bin\dsh.cmd`），走正规市场通道：

```
& "<安装根>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:DearMrChai/dsh-vision-guard#<sha>
```

- `<sha>` 从 GitHub [releases](https://github.com/DeepSeek-AI-Community/dsh-vision-guard/tags) 或 [CHANGELOG](CHANGELOG.md) 取（实际 owner 看下面推完后的真实 URL）；不锁 sha 也行（`github:<owner>/dsh-vision-guard` 跟 main 走）
- pnpm 自动完成三件事：依赖写入 `profiles\desktop\package.json`、拉源码到 profile `node_modules`、**自动对账 `dsh.profile.bundles`**
- 装完**重启 DSH 桌面端**（改 lib 不触发 HMR）

### 验证

1. 日志看到 `[dsh-vision-guard] active — dedupe=true, cap=false`
2. 真实场景：贴 1 张图 → 模型说一轮后说"回顾一下"（触发 `read_image` 重读）→ **下一次 LLM 请求体里只出现 1 张图**，期望省 ≈ 2,040 prompt_tokens（1080p）
3. 反对照：把 `cordis.patch.yml` 的 `dedupe.enabled` 改 `false`，重启，重做同一轮 → **2 张图**（确认本插件在起作用）

### 回滚

```
& "<安装根>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-vision-guard
```

零 DSH 代码修改，回滚后与未装完全等同。

## 配置（cordis.patch.yml config 段）

```yaml
- id: dsh-vision-guard
  name: dsh-vision-guard
  config:
    dedupe:
      enabled: true
      placeholder: "[同一张图已附在 #{0}，不再重复发送。需要时可按路径重新 read_image。]"
    cap:
      enabled: false
      keepRecent: 4
    offload:
      enabled: false
      on400: true
```

## 路线图

| 版本 | 内容 |
|---|---|
| **0.1.0**（本期） | dedupe 上线 |
| 0.2.0（将来，需求触发） | `cap.enabled=true`：保留最新 N 张，老图替换为占位（接 dsh-image-guard 的"最新 N 张"思路，但用 attachmentId 做身份，**不靠"最新 N"裁剪**） |
| 0.3.0（将来，需求触发） | `offload.enabled=true`：把 vLLM 400 "At most N image(s)" 归成 DSH 的 `IMAGE_OFFLOAD_REQUIRED`，触发官方 [dsh-compaction-image-offload](https://dshmarket.com) 的 offload 链（代价：图永久降级、前缀缓存碎——只在 dedupe + cap 都救不了时才开） |

## 自测（本地）

```
node scripts/selftest.mjs     # 19 case，mock 请求体跑 dedupe 断言
```

随安装自动跑：`pnpm install` 触发 `prepack` 钩子（package.json 的 `scripts.prepack`），保证装上去的就是绿色版本。

## 与 mafeis/dsh-image-guard 的分工

| 维度 | dsh-image-guard | dsh-vision-guard（本） |
|---|---|---|
| 截断范围 | **历史**所有图保留最近 N 张 | **本次请求体**里的重复块 |
| 身份 | 字面"最新 N 张" | `attachmentId` (sha256) |
| 适用场景 | 长会话累积 50+ 张不同图 | 模型自己 read_image 重读同一张 |
| 前缀缓存 | 保住（不修历史） | 保住（只修请求体副本） |
| 关系 | 正交，可叠加 | 本期独立 |

142 现状（`limit-mm-per-prompt: 4`）下，**本插件的 dedupe 已足够**：D + 1 重读 = 2 张，去重后 1 张。

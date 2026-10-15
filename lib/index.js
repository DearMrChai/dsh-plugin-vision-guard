// dsh-vision-guard · 主入口（register / apply）
//
// 角色：DSH Host-only 插件，零运行时依赖（纯 JS），type=module。
// 本期功能：在 agent/pre-step waterfall 里按 attachmentId 去重，使"模型自己 read_image
// 重读同一张图"不再追加到下一次请求体里占用视觉 token 与 4 张额度。
//
// 装载形态（沿用 dsh-plugin-task-notify / host-monitor 桌面端模式）：
// - profiles\<name>\package.json dependencies 加 link: 依赖 + junction 直连本目录
// - config 读自 cordis.patch.yml 的 config 段
// - 不进 dsh.profile.bundles（file:/link: 插件加进 bundles 会 boot 崩）
//
// 决策序列（本期）：
//   1. apply(ctx, config) 解析 config（lib/budget.js parseConfig）
//   2. ctx.on('agent/pre-step', listener) —— 在 LLM 请求组装前重写 decision.messages
//   3. listener 调用 lib/hooks/dedupe.js dedupeMessages 去重
//   4. 返回 { ...decision, messages }（保留 decision 的其他字段，如 startsRequestSeries）

import { dedupeMessages } from './hooks/dedupe.js';
import { parseConfig } from './budget.js';

/**
 * DSH 插件 apply 形式（cordis-plugin-development / host-plugin.md 规定的标准导出）。
 *
 * @param {Object} ctx - DSH Host 服务上下文（含 on / effect / emit / get / inject）
 * @param {Object} config - cordis.patch.yml config 段原始值
 * @returns {() => void} 清理函数（unregister 注册的所有 effect）
 */
export function apply(ctx, config) {
	const cfg = parseConfig(config);
	if (!cfg.dedupe.enabled && !cfg.cap.enabled) {
		ctx.emit?.('log', '[dsh-vision-guard] disabled: both dedupe and cap are off');
		return () => {};
	}

	ctx.emit?.('log', '[dsh-vision-guard] active — dedupe=' + cfg.dedupe.enabled + ', cap=' + cfg.cap.enabled);

	const stop = ctx.on('agent/pre-step', async (payload, next) => {
		try {
			const decision = await next();
			if (!decision || decision.kind === 'reject') return decision;

			const { messages: deduped, deduped: dedupedCount } = dedupeMessages(
				decision.messages ?? [],
				{ enabled: cfg.dedupe.enabled, placeholder: cfg.dedupe.placeholder }
			);

			if (dedupedCount > 0) {
				ctx.emit?.('log', '[dsh-vision-guard] deduped ' + dedupedCount + ' duplicate image block(s) in request');
			}

			return { ...decision, messages: deduped };
		} catch (err) {
			// 永不阻塞请求：异常时回落原始 decision，并打日志
			ctx.emit?.('log', '[dsh-vision-guard] hook error: ' + (err?.message ?? String(err)));
			const decision = await next();
			return decision;
		}
	});

	return () => {
		stop();
		ctx.emit?.('log', '[dsh-vision-guard] unloaded');
	};
}

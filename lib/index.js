// dsh-vision-guard · 主入口（apply）
//
// 角色：DSH Host-only 插件，零运行时依赖（纯 JS），type=module。
// 本期功能：同一张图（attachmentId = sha256）在同一次请求里只发一次 —— 模型自己
// read_image 重读同一张图时，把重复的那次出现登记下车，不再消耗视觉 token 与图片额度。
//
// 实现：在 agent/pre-step waterfall 里追加官方 `image/offload` 事件；由基础组合的
// @deepseek-ai/dsh-compaction-image-offload 注册的 message projection 把选中的出现位置
// 投影成 offloaded，dsh-llm 对它们发送占位文本而不是图像字节。
// 会话日志保持原样 ⇒ fork/resume/replay 仍然可重建；前缀缓存只受尾部改动影响。
//
// 装载形态（沿用 dsh-plugin-task-notify / host-monitor 桌面端模式）：
// - profiles\<name>\package.json dependencies 加 link: 依赖 + junction 直连本目录
// - 包内声明 dsh.bundle.patch → 登记进 dsh.profile.bundles（`dsh plugin add` 自动对账）
// - config 读自本包 cordis.patch.yml 的 config 段
//
// 钩子契约（dsh-agent-loop preStep + cordis waterfall）：
// - next() 必须恰好调用一次；它返回基底 decision，本插件不改写它（返回原值）
// - 本插件只做「向会话追加一条事件」这一件事，任何异常都吞掉并记日志，绝不阻塞请求

import { countOffloads, findDuplicateImages } from './hooks/dedupe.js';
import { parseConfig } from './budget.js';

/**
 * 取事件的**原始** content（未投影）。
 *
 * @param {Object} event - 会话事件
 * @returns {Array|undefined}
 */
function rawContent(event) {
	if (event?.type === 'user/message') return event.data?.content;
	if (event?.type === 'tool/result') return event.data?.message?.content;
	return undefined;
}

/** 原始 content 里有没有 image 块（粗筛用）。 */
function hasImageBlock(content) {
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (block && block.type === 'image') return true;
	}
	return false;
}

/**
 * 取会话当前表层里所有承载图片的消息节点（按表层顺序，content 用投影后的消息）。
 *
 * 两级过滤：先用原始 content 粗筛（绝大多数节点无图，省掉投影调用），
 * 再用投影后的消息读 `offloaded` 标记——标记只能从投影结果看，不能看原始事件。
 *
 * @param {Object} session - DSH Session（surface.nodes / eventAt / deriveEventMessage）
 * @returns {Array<{seq: number, content: Array}>}
 */
function surfaceImageNodes(session) {
	const nodes = [];
	const seqs = session?.surface?.nodes;
	if (!Array.isArray(seqs)) return nodes;

	for (const seq of seqs) {
		const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
		if (!hasImageBlock(rawContent(event))) continue;
		const message =
			typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : undefined;
		if (message && Array.isArray(message.content)) nodes.push({ seq, content: message.content });
	}
	return nodes;
}

/**
 * DSH 插件 apply 形式（cordis-plugin-development / host-plugin.md 规定的标准导出）。
 *
 * @param {Object} ctx - DSH Host 服务上下文（含 on / effect / emit / logger / get / inject）
 * @param {Object} config - cordis.patch.yml config 段原始值
 * @returns {() => void} 清理函数（注销所有 effect）
 */
export function apply(ctx, config) {
	// 日志永不抛：apply 期抛错会炸 DSH boot，hook 期抛错会阻塞请求。
	// 首选 ctx.logger（宿主日志通道）；老宿主没有 logger 时退回 emit('log')。
	const log = (message) => {
		const line = '[dsh-vision-guard] ' + message;
		try {
			if (typeof ctx.logger?.info === 'function') ctx.logger.info(line);
			else ctx.emit?.('log', line);
		} catch {
			// 日志通道本身失败不影响插件功能
		}
	};

	const cfg = parseConfig(config);
	if (!cfg.dedupe.enabled && !cfg.cap.enabled) {
		log('disabled: both dedupe and cap are off');
		return () => {};
	}

	let offloadedTotal = 0;
	log('active — dedupe=' + cfg.dedupe.enabled + ', cap=' + cfg.cap.enabled);

	const stop = ctx.on('agent/pre-step', async (payload, next) => {
		// 从这里往下是本插件自己的逻辑：任何异常都吞掉，请求照常继续。
		try {
			const session = payload?.agent?.session;
			if (session) {
				// 此刻本步要用的消息（含 read_image 重读刚写入的 tool/result）已在表层上，
				// 追加的 image/offload 对随后 buildRequest 派生出的请求体生效。
				const targets = findDuplicateImages(surfaceImageNodes(session));
				if (targets.length > 0) {
					session.append('image/offload', { targets });
					const n = countOffloads(targets);
					offloadedTotal += n;
					log(
						'offloaded ' + n + ' duplicate image occurrence(s): ' +
							targets.map((t) => 'seq ' + t.seq + '#' + t.imageIndexes.join('/')).join(', ') +
							' (total ' + offloadedTotal + ')'
					);
				}
			}
		} catch (err) {
			// 典型情况：宿主没挂 image-offload 投影时 Session 拒绝追加（官方 README：
			// 「缺少处理器时拒绝追加和恢复」）——拒绝是安全的，这里记一笔就放过。
			log('hook error: ' + (err?.message ?? String(err)));
		}

		// 契约：恰好调用一次 next()，并原样返回基底 decision。
		return next();
	});

	return () => {
		stop();
		log('unloaded');
	};
}

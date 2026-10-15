// dsh-vision-guard · 配置读取与决策序列（本期只用 dedupe；cap / offload 是占位）
//
// 设计原则（来自 cordis-plugin-development / practices.md）：
// - 把可调参数放 Config，用户改 cordis.patch.yml 的 config 段即可
// - 决策序列可以用一次性 effect 包装，本期只有 1 个 listener（agent/pre-step）
//
// 未来扩 cap.enabled=true / offload.enabled=true 时，本文件决定挂几个 hook：
// - dedupe  → agent/pre-step（本已挂载）
// - cap     → agent/pre-step（追加到同一个 listener，按顺序）
// - offload → agent/request-error waterfall（把 vLLM 400 "At most N image(s)" 归成 IMAGE_OFFLOAD_REQUIRED 的等价信号）

/**
 * 解析视觉守卫配置（结构校验 + 默认值兜底）。
 *
 * @param {Object} raw - 来自 cordis.patch.yml config 段的原始值
 * @returns {{dedupe: {enabled, placeholder}, cap: {enabled, keepRecent}, offload: {enabled, on400}}}
 */
export function parseConfig(raw) {
	const cfg = raw ?? {};
	return {
		dedupe: {
			enabled: cfg.dedupe?.enabled !== false,
			// 占位模板：{0} = 首次出现的 1-indexed 序号，{1} = 附件名
			placeholder: cfg.dedupe?.placeholder ?? '[同一张图已附在 #{0}，不再重复发送。需要时可按路径重新 read_image。]'
		},
		cap: {
			enabled: cfg.cap?.enabled === true, // 默认关
			keepRecent: Number.isInteger(cfg.cap?.keepRecent) && cfg.cap.keepRecent > 0
				? cfg.cap.keepRecent
				: 4
		},
		offload: {
			enabled: cfg.offload?.enabled === true, // 默认关
			on400: cfg.offload?.on400 !== false
		}
	};
}

/**
 * 评估单条消息里 image 块的"可去重数量"与"去重后总图数"。
 * 本期没有 cap，所以只做 dedupe 计数；cap 接入时这里会决定"保留最近的 N 张"。
 */
export function auditMessage(message, dedupeCfg) {
	if (!message || !Array.isArray(message.content)) return { total: 0, deduped: 0, kept: 0 };
	const seen = new Set();
	let total = 0;
	let deduped = 0;
	for (const block of message.content) {
		if (!(block && block.type === 'image' && block.attachment && block.attachment.attachmentId)) continue;
		total += 1;
		const id = block.attachment.attachmentId;
		if (dedupeCfg?.enabled !== false && seen.has(id)) deduped += 1;
		seen.add(id);
	}
	return { total, deduped, kept: total - deduped };
}

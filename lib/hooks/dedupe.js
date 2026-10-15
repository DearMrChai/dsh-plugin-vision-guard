// dsh-vision-guard · 本期钩子：把「同一张图的重复出现」登记为已下车（image/offload）
//
// 为什么不去改写请求体（0.1.x 的做法，已废弃）：
// - agent/pre-step 的 decision.messages 只是「本步新进入的批次」，随后被 append 成新的
//   user/message（dsh-agent-loop/lib/index.js:1061）；请求体由 buildRequest 从派生历史组装。
//   模型 read_image 重读的那张图在派生历史（tool/result）里，pre-step 的 messages 看不到它。
// - buildRequest 返回的请求是**全冻结**的（Object.freeze(messages) + deepFreeze(每条消息)，
//   dsh-agent-loop/lib/index.js:1261-1269）；llm/stream 的监听器既不能原地改，cordis 的
//   waterfall 也不支持用 next(新载荷) 换载荷（cordis/lib/index.js:317-325）。
//
// 现在的做法（DSH 一等机制，由基础组合的 @deepseek-ai/dsh-compaction-image-offload 提供）：
// - 本插件向会话追加一条 `image/offload` 事件：{ targets: [{ seq, imageIndexes }] }
//   seq = 承载该出现的 user/message 或 tool/result 事件序号；imageIndexes = 该消息内 0-based
//   的图片出现序号（含已下车的出现位置，严格递增）。
// - 该包注册的 message projection 在派生消息时把选中位置投影成 { ...block, offloaded: true }。
// - dsh-llm 适配器对 offloaded 块发送占位文本（offloadedImageText，含只读路径）而不是图像字节。
// ⇒ 会话日志原样保留图片块，只有发出去的请求体少一张图；前缀缓存只受尾部改动影响。
//
// 本文件只做纯计算，不碰会话对象（便于自测）。

/**
 * 列出消息内容里全部 image 出现位置（0-based，口径与官方投影 offloadMessageImages 一致：
 * 只遍历 message.content 一层，每遇到一个 image 块计数 +1，已下车的也计数）。
 *
 * @param {Array} content - 消息的 content 块数组
 * @returns {Array<{imageIndex: number, attachmentId: string|undefined, offloaded: boolean}>}
 */
export function imageOccurrences(content) {
	const out = [];
	if (!Array.isArray(content)) return out;
	let imageIndex = 0;
	for (const block of content) {
		if (!block || block.type !== 'image') continue;
		const attachmentId =
			block.attachment && typeof block.attachment.attachmentId === 'string'
				? block.attachment.attachmentId
				: undefined;
		out.push({ imageIndex, attachmentId, offloaded: block.offloaded === true });
		imageIndex += 1;
	}
	return out;
}

/**
 * 按表层顺序扫描，算出需要下车的重复图片出现位置。
 *
 * 规则：
 * - 同一 attachmentId（= sha256 内容寻址）只保留**最早**的那个未下车出现位置；
 * - 其后每次重复出现都登记下车；
 * - 已经下车的不计入「已保留」——若唯一那张已被官方预算机制下车，后来的重读仍照常发送。
 *
 * @param {Array<{seq: number, content: Array}>} nodes - 表层顺序的节点（content 取已投影的消息）
 * @returns {Array<{seq: number, imageIndexes: number[]}>} 可直接作为 image/offload 的 targets
 */
export function findDuplicateImages(nodes) {
	const seen = new Set();
	const targets = [];
	if (!Array.isArray(nodes)) return targets;

	for (const node of nodes) {
		if (!node) continue;
		const imageIndexes = [];
		for (const occ of imageOccurrences(node.content)) {
			if (!occ.attachmentId || occ.offloaded) continue;
			if (seen.has(occ.attachmentId)) imageIndexes.push(occ.imageIndex);
			else seen.add(occ.attachmentId);
		}
		if (imageIndexes.length > 0) targets.push({ seq: node.seq, imageIndexes });
	}
	return targets;
}

/** targets 里登记下车的出现位置总数（日志用）。 */
export function countOffloads(targets) {
	let n = 0;
	for (const target of Array.isArray(targets) ? targets : []) {
		n += Array.isArray(target?.imageIndexes) ? target.imageIndexes.length : 0;
	}
	return n;
}

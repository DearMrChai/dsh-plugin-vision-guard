// dsh-vision-guard · 本期钩子：按 attachmentId（= sha256）去重请求体
//
// 语义（A 方案）：
// - 遍历请求 messages 副本，按出现顺序追踪已见过的 attachmentId
// - 第二次及以后出现的同一 attachmentId 的 image 块 → 从挂载请求体里移除
// - 在同一条消息内追加占位文本（模型在历史里能看到"同一张图已在 #1 看过"的线索）
// - 返回重写后的 messages 副本，不触碰会话日志 ⇒ 前缀缓存命中不受影响
//
// attachmentId 形如 `sha256:<64 位 hex>`（dsh-attachment-local 内容寻址引用），
// 按 attachmentId 去重 ⟺ 按规范化后的归一化字节去重。
//
// 与 dsh-llm-pi-ai 自身在 requestImages Map 上按 attachmentId 去重正交：
// 它去掉的是"多次解码"，本钩子去掉的是"多次出现在请求体"。

/**
 * 在具有 content 的消息里，为重复的 image 块追加/更新一条占位 text。
 * 优先改写 newContent 里最后一个 text 块；没有 text 则插一条在结尾。
 *
 * 写时复制：newContent 里的块可能是原消息块的引用，直接改 text 会污染会话侧对象，
 * 所以替换成新对象而不是就地赋值。
 */
function appendPlaceholder(newContent, placeholder, originalIndex, refName) {
	const text = placeholder
		.replaceAll('{0}', String(originalIndex))
		.replaceAll('{1}', refName ?? '')
		.trim();
	let lastTextIndex = -1;
	for (let i = newContent.length - 1; i >= 0; i -= 1) {
		if (newContent[i] && newContent[i].type === 'text') {
			lastTextIndex = i;
			break;
		}
	}
	if (lastTextIndex >= 0) {
		const last = newContent[lastTextIndex];
		newContent[lastTextIndex] = {
			...last,
			text: last.text ? `${last.text}\n${text}` : text
		};
	} else {
		newContent.push({ type: 'text', text });
	}
}

/**
 * 核心去重（pure，不改入参）。
 *
 * @param {Array} messages - `agent/pre-step` waterfall 给的 messages 副本
 * @param {{enabled?: boolean, placeholder?: string}} cfg - 配置
 * @returns {{messages: Array, deduped: number}} 重写的 messages 与去掉的重复块数
 */
export function dedupeMessages(messages, cfg) {
	const enabled = cfg?.enabled !== false;
	const placeholder = cfg?.placeholder ?? '[同一张图已附在 #{0}，不再重复发送。]';
	const seen = new Map(); // attachmentId -> 首次出现的 1-indexed 序号
	const out = [];
	let deduped = 0;

	for (const message of messages) {
		if (!message || !Array.isArray(message.content)) {
			out.push(message);
			continue;
		}

		if (!enabled) {
			out.push(message);
			continue;
		}

		const newContent = [];
		for (const block of message.content) {
			const isImageBlock =
				block &&
				block.type === 'image' &&
				block.attachment &&
				typeof block.attachment.attachmentId === 'string' &&
				block.attachment.attachmentId.length > 0;

			if (isImageBlock) {
				const id = block.attachment.attachmentId;
				if (seen.has(id)) {
					// 重复：本次出现不发送 image 块，改为占位文本
					deduped += 1;
					appendPlaceholder(newContent, placeholder, seen.get(id), block.attachment.name);
					continue;
				}
				seen.set(id, seen.size + 1);
			}

			newContent.push(block);
		}

		out.push({
			...message,
			content: newContent
		});
	}

	return { messages: out, deduped };
}

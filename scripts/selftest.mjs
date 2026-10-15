// dsh-vision-guard · 自测：mock 请求体 → 跑 dedupe → 断言
// 用法：node scripts/selftest.mjs
import { dedupeMessages } from '../lib/hooks/dedupe.js';
import { parseConfig, auditMessage } from '../lib/budget.js';

let failed = 0;
function assert(cond, msg) {
	if (cond) console.log('  ✓ ' + msg);
	else { console.error('  ✗ ' + msg); failed += 1; }
}
function countImages(messages) {
	let n = 0;
	for (const m of messages) for (const b of m.content) if (b?.type === 'image') n += 1;
	return n;
}

const A = 'sha256:' + 'a'.repeat(64); // conform to ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const B = 'sha256:' + 'b'.repeat(64);

// ─ case 1: 单图，1 次出现 → 不动
{
	const msgs = [
		{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: { attachmentId: A, name: 'shot.png' } }] }
	];
	const { messages, deduped } = dedupeMessages(msgs, { enabled: true, placeholder: '[see #{0}]' });
	assert(deduped === 0, 'case1 deduped=0');
	assert(countImages(messages) === 1, 'case1 image count = 1');
}

// ─ case 2: 同一张图，2 次（1 原始 + 1 重读）→ 第 2 次变占位
{
	const msgs = [
		{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: { attachmentId: A, name: 'shot.png' } }] },
		{ role: 'tool', content: [{ type: 'text', text: '好的' }, { type: 'image', attachment: { attachmentId: A, name: 'shot.png' } }] }
	];
	const { messages, deduped } = dedupeMessages(msgs, { enabled: true, placeholder: '[see #{0} at #{1}]' });
	assert(deduped === 1, 'case2 deduped=1');
	assert(countImages(messages) === 1, 'case2 image count = 1');
	assert(messages[0].content.some((b) => b.type === 'image'), 'case2 image kept in msg 1');
	assert(!messages[1].content.some((b) => b.type === 'image'), 'case2 image removed in msg 2');
	assert(messages[1].content.some((b) => b.type === 'text' && b.text.includes('shot.png')), 'case2 placeholder text in msg 2');
}

// ─ case 3: 两张不同图，各 1 次 → 不动
{
	const msgs = [
		{ role: 'user', content: [
			{ type: 'text', text: '两张' },
			{ type: 'image', attachment: { attachmentId: A, name: 'a.png' } },
			{ type: 'image', attachment: { attachmentId: B, name: 'b.png' } }
		] }
	];
	const { deduped } = dedupeMessages(msgs, { enabled: true, placeholder: '[x]' });
	assert(deduped === 0, 'case3 deduped=0 (two distinct images)');
}

// ─ case 4: 同一张图，3 次 → 第 2、3 次都变占位
{
	const msgs = [
		{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: A } }] },
		{ role: 'tool', content: [{ type: 'image', attachment: { attachmentId: A } }] },
		{ role: 'tool', content: [{ type: 'image', attachment: { attachmentId: A } }] }
	];
	const { messages, deduped } = dedupeMessages(msgs, { enabled: true, placeholder: '[dup #{0}]' });
	assert(deduped === 2, 'case4 deduped=2');
	assert(countImages(messages) === 1, 'case4 image count = 1');
	// 第 2、3 条消息各自应该带一条占位 text
	assert(messages[1].content.length === 1 && messages[1].content[0].type === 'text', 'case4 msg2 only placeholder text');
	assert(messages[2].content.length === 1 && messages[2].content[0].type === 'text', 'case4 msg3 only placeholder text');
}

// ─ case 5: dedupe 关闭 → 原样
{
	const msgs = [
		{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: A } }] },
		{ role: 'tool', content: [{ type: 'image', attachment: { attachmentId: A } }] }
	];
	const { deduped } = dedupeMessages(msgs, { enabled: false });
	assert(deduped === 0, 'case5 disabled: deduped=0');
}

// ─ case 6: 纯文本消息 → 原样
{
	const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
	const { deduped } = dedupeMessages(msgs, { enabled: true });
	assert(deduped === 0, 'case6 text-only: deduped=0');
}

// ─ case 7: parseConfig 兜底
{
	const cfg = parseConfig(undefined);
	assert(cfg.dedupe.enabled === true, 'parseConfig: dedupe default on');
	assert(cfg.cap.enabled === false, 'parseConfig: cap default off');
	assert(cfg.offload.enabled === false, 'parseConfig: offload default off');

	const cfg2 = parseConfig({ dedupe: { enabled: false }, cap: { enabled: true, keepRecent: 8 } });
	assert(cfg2.dedupe.enabled === false, 'parseConfig: explicit dedupe off');
	assert(cfg2.cap.enabled === true && cfg2.cap.keepRecent === 8, 'parseConfig: cap on with keepRecent=8');
}

// ─ case 8: auditMessage 计数
{
	const m = { role: 'user', content: [
		{ type: 'image', attachment: { attachmentId: A } },
		{ type: 'image', attachment: { attachmentId: A } },
		{ type: 'image', attachment: { attachmentId: B } }
	] };
	const a = auditMessage(m, { enabled: true });
	assert(a.total === 3 && a.deduped === 1 && a.kept === 2, `auditMessage: ${JSON.stringify(a)}`);
}

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);

// dsh-vision-guard · 自测：mock 请求体 → 跑 dedupe → 断言
// case1-8 测纯函数（dedupeMessages / parseConfig / auditMessage）
// case9-12 测 apply 挂载的 agent/pre-step 钩子契约（next 恰好一次 / 异常回落 / 关闭即不注册）
// 用法：node scripts/selftest.mjs
import { dedupeMessages } from '../lib/hooks/dedupe.js';
import { parseConfig, auditMessage } from '../lib/budget.js';
import { apply } from '../lib/index.js';

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

// ─ case 9: apply 注册 agent/pre-step；listener 恰好调一次 next、完成去重、不改输入
{
	const handlers = new Map();
	const ctx = {
		on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
		emit() {}
	};
	apply(ctx, { dedupe: { enabled: true, placeholder: '[dup #{0}]' } });
	assert(handlers.has('agent/pre-step'), 'case9 apply registers agent/pre-step');

	const handler = handlers.get('agent/pre-step');
	const base = {
		kind: 'enter',
		messages: [
			{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: { attachmentId: A, name: 'shot.png' } }] },
			{ role: 'tool', content: [{ type: 'text', text: '好的' }, { type: 'image', attachment: { attachmentId: A, name: 'shot.png' } }] }
		]
	};
	let calls = 0;
	const out = await handler({}, async () => { calls += 1; return base; });
	assert(calls === 1, 'case9 listener calls next exactly once');
	assert(out.kind === 'enter', 'case9 preserves decision.kind');
	assert(countImages(out.messages) === 1, 'case9 request body has 1 image');
	assert(countImages(base.messages) === 2, 'case9 input decision not mutated (still 2 images)');
	assert(base.messages[1].content[0].text === '好的', 'case9 original text block not mutated');
	assert(out.messages[1].content.some((b) => b.type === 'text' && b.text.includes('dup #1')), 'case9 placeholder appended to copy');
}

// ─ case 10: next() 抛错 = 宿主故障 → 原样抛出，且不重试
{
	const handlers = new Map();
	const ctx = { on(name, fn) { handlers.set(name, fn); return () => {}; }, emit() {} };
	apply(ctx, { dedupe: { enabled: true } });
	let calls = 0;
	let propagated = false;
	try {
		await handlers.get('agent/pre-step')({}, async () => { calls += 1; throw new Error('host boom'); });
	} catch (err) {
		propagated = err.message === 'host boom';
	}
	assert(propagated, 'case10 host error propagates');
	assert(calls === 1, 'case10 next not retried after host error');
}

// ─ case 11: 去重自身出错 → 回落原始 decision，绝不阻塞请求
{
	const handlers = new Map();
	const logs = [];
	const ctx = {
		on(name, fn) { handlers.set(name, fn); return () => {}; },
		emit(name, msg) { if (name === 'log') logs.push(msg); }
	};
	apply(ctx, { dedupe: { enabled: true } });
	const badMessages = new Proxy([], {
		get(target, prop, recv) {
			if (prop === Symbol.iterator) throw new Error('dedupe boom');
			return Reflect.get(target, prop, recv);
		}
	});
	const base = { kind: 'enter', messages: badMessages };
	let calls = 0;
	const out = await handlers.get('agent/pre-step')({}, async () => { calls += 1; return base; });
	assert(calls === 1, 'case11 next called once on internal error');
	assert(out === base, 'case11 falls back to original decision');
	assert(logs.some((m) => m.includes('hook error')), 'case11 logs hook error');
}

// ─ case 12: dedupe 与 cap 全关 → 不注册任何 hook
{
	const handlers = new Map();
	const ctx = { on(name, fn) { handlers.set(name, fn); return () => {}; }, emit() {} };
	apply(ctx, { dedupe: { enabled: false }, cap: { enabled: false } });
	assert(handlers.size === 0, 'case12 disabled: no hook registered');
}

// ─ case 13: 日志通道抛错 → apply 不抛、hook 仍完成去重（日志永不阻塞）
{
	const handlers = new Map();
	const ctx = {
		on(name, fn) { handlers.set(name, fn); return () => {}; },
		emit() { throw new Error('log sink boom'); }
	};
	let applied = true;
	try {
		apply(ctx, { dedupe: { enabled: true, placeholder: '[dup #{0}]' } });
	} catch {
		applied = false;
	}
	assert(applied, 'case13 apply does not throw when emit throws');

	const base = {
		kind: 'enter',
		messages: [
			{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: A } }] },
			{ role: 'tool', content: [{ type: 'image', attachment: { attachmentId: A } }] }
		]
	};
	let calls = 0;
	const out = await handlers.get('agent/pre-step')({}, async () => { calls += 1; return base; });
	assert(calls === 1, 'case13 next still called once');
	assert(countImages(out.messages) === 1, 'case13 dedupe still applied despite log failure');
}

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);

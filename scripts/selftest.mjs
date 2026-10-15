// dsh-vision-guard · 自测
// case1-11 纯函数（imageOccurrences / findDuplicateImages / countOffloads / parseConfig）
// case12-21 apply 挂载的 agent/pre-step 钩子契约
// 用法：node scripts/selftest.mjs
import { countOffloads, findDuplicateImages, imageOccurrences } from '../lib/hooks/dedupe.js';
import { parseConfig } from '../lib/budget.js';
import { apply } from '../lib/index.js';

let failed = 0;
function assert(cond, msg) {
	if (cond) console.log('  ✓ ' + msg);
	else { console.error('  ✗ ' + msg); failed += 1; }
}

const A = 'sha256:' + 'a'.repeat(64); // 与 ID_PATTERN = /^sha256:([a-f0-9]{64})$/ 对齐
const B = 'sha256:' + 'b'.repeat(64);
const img = (id, extra) => ({ type: 'image', attachment: { attachmentId: id }, ...extra });
const txt = (text) => ({ type: 'text', text });

// 假会话：surface.nodes + eventAt + deriveEventMessage + append（记录调用）
// 事件形状镜像真实：user/message → data.content；tool/result → data.message.content。
// 节点可带 projected（投影后的 content），用来验证「粗筛看原始、标记看投影」。
function fakeSession(rawNodes, opts = {}) {
	const nodes = rawNodes.map((n) => ({ type: 'user/message', ...n }));
	const calls = [];
	return {
		calls,
		session: {
			surface: { nodes: nodes.map((n) => n.seq) },
			eventAt(seq) {
				if (opts.eventAtThrows) throw new Error('eventAt boom');
				const n = nodes.find((x) => x.seq === seq);
				if (!n) return undefined;
				return n.type === 'tool/result'
					? { type: n.type, seq: n.seq, data: { message: { role: 'tool', content: n.content } } }
					: { type: n.type, seq: n.seq, data: { content: n.content } };
			},
			deriveEventMessage(event) {
				const n = nodes.find((x) => x.seq === event.seq);
				return { role: 'user', content: n?.projected ?? n?.content };
			},
			append(type, data) { if (opts.appendThrows) throw new Error('no image/offload projection'); calls.push([type, data]); }
		}
	};
}
function fakeCtx(opts = {}) {
	const handlers = new Map();
	const logs = [];
	const ctx = {
		handlers,
		logs,
		on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
		emit(name, msg) { if (name === 'log') logs.push(msg); },
		logger: {
			info(msg) { if (opts.loggerThrows) throw new Error('log sink boom'); logs.push(msg); }
		}
	};
	return { handlers, logs, ctx };
}

// ─ case 1: imageOccurrences —— 序号只数 image 块，标记 offloaded，缺 attachmentId 不炸
{
	const occ = imageOccurrences([txt('看图'), img(A), txt('再读'), img(B, { offloaded: true }), { type: 'image' }]);
	assert(occ.length === 3, 'case1 三个 image 出现位置');
	assert(occ[0].imageIndex === 0 && occ[0].attachmentId === A && occ[0].offloaded === false, 'case1 #0 未下车 A');
	assert(occ[1].imageIndex === 1 && occ[1].offloaded === true, 'case1 #1 已下车');
	assert(occ[2].imageIndex === 2 && occ[2].attachmentId === undefined, 'case1 #2 缺 attachmentId');
}

// ─ case 2: imageOccurrences —— 非数组 content 返回空
{
	assert(imageOccurrences(undefined).length === 0 && imageOccurrences('x').length === 0, 'case2 非数组 content → 空');
}

// ─ case 3: 单图 1 次出现 → 不下车
{
	assert(findDuplicateImages([{ seq: 9, content: [txt('看图'), img(A)] }]).length === 0, 'case3 单次出现不下车');
}

// ─ case 4: 跨两条消息重复 → 后一条下车（保留最早）
{
	const targets = findDuplicateImages([
		{ seq: 9, content: [txt('看图'), img(A)] },
		{ seq: 29, content: [txt('重读结果'), img(A)] }
	]);
	assert(targets.length === 1 && targets[0].seq === 29, 'case4 只登记后一条消息 (seq 29)');
	assert(targets[0].imageIndexes.length === 1 && targets[0].imageIndexes[0] === 0, 'case4 下车其 #0');
}

// ─ case 5: 同一条消息内重复两次 → 第 2 个出现位置下车
{
	const targets = findDuplicateImages([{ seq: 5, content: [img(A), img(A)] }]);
	assert(targets.length === 1 && targets[0].imageIndexes.join() === '1', 'case5 下车同消息内 #1');
}

// ─ case 6: 同一张图 3 次（两条消息）→ 后两处全下车
{
	const targets = findDuplicateImages([
		{ seq: 1, content: [img(A)] },
		{ seq: 2, content: [img(A)] },
		{ seq: 3, content: [txt('x'), img(A)] }
	]);
	assert(targets.length === 2 && targets[0].seq === 2 && targets[0].imageIndexes.join() === '0', 'case6 seq2 下车 #0');
	assert(targets[1].seq === 3 && targets[1].imageIndexes.join() === '0', 'case6 seq3 下车 #0');
	assert(countOffloads(targets) === 2, 'case6 countOffloads=2');
}

// ─ case 7: 两张不同图 → 不下车
{
	const targets = findDuplicateImages([{ seq: 1, content: [img(A), img(B)] }]);
	assert(targets.length === 0, 'case7 不同图不下车');
}

// ─ case 8: 早先那张已被官方机制下车 → 后来的重读**照常发送**（模型得看到图）
{
	const targets = findDuplicateImages([
		{ seq: 1, content: [img(A, { offloaded: true })] },
		{ seq: 2, content: [img(A)] }
	]);
	assert(targets.length === 0, 'case8 唯一可见的那张不下车');
}

// ─ case 9: 重复那张已下车 → 幂等，不重复登记
{
	const targets = findDuplicateImages([
		{ seq: 1, content: [img(A)] },
		{ seq: 2, content: [img(A, { offloaded: true })] }
	]);
	assert(targets.length === 0, 'case9 幂等（已下车的重复不再登记）');
}

// ─ case 10: 已下车位置仍占序号 → 新出现位置算出 #2 而不是 #1
{
	const targets = findDuplicateImages([{ seq: 1, content: [img(A, { offloaded: true }), img(A), img(A)] }]);
	assert(targets.length === 1 && targets[0].imageIndexes.join() === '2', 'case10 序号含已下车位置（#2）');
}

// ─ case 11: parseConfig 兜底与显式值
{
	const cfg = parseConfig(undefined);
	assert(cfg.dedupe.enabled === true, 'case11 dedupe 默认开');
	assert(cfg.cap.enabled === false && cfg.cap.keepRecent === 4, 'case11 cap 默认关 / keepRecent=4');
	const cfg2 = parseConfig({ dedupe: { enabled: false }, cap: { enabled: true, keepRecent: 8 } });
	assert(cfg2.dedupe.enabled === false, 'case11 显式关 dedupe');
	assert(cfg2.cap.enabled === true && cfg2.cap.keepRecent === 8, 'case11 显式开 cap keepRecent=8');
	const cfg3 = parseConfig({ cap: { keepRecent: -1 } });
	assert(cfg3.cap.keepRecent === 4, 'case11 坏 keepRecent 兜底 4');
}

// ─ case 12: 无重复 → 不 append，next 恰好一次，decision 原样返回
{
	const { ctx } = fakeCtx();
	const { session, calls } = fakeSession([{ seq: 1, content: [txt('hello')] }]);
	apply(ctx, { dedupe: { enabled: true } });
	const handler = ctx.handlers.get('agent/pre-step');
	let calls2 = 0;
	const base = { kind: 'enter', messages: [] };
	const out = await handler({ agent: { session } }, async () => { calls2 += 1; return base; });
	assert(calls2 === 1, 'case12 next 恰好一次');
	assert(out === base, 'case12 decision 原样返回');
	assert(calls.length === 0, 'case12 无重复不 append');
}

// ─ case 13: 有重复 → 恰好 append 一条 image/offload，targets 正确
{
	const { ctx } = fakeCtx();
	const nodes = [
		{ seq: 9, content: [txt('你能看到信息吗'), img(A)] },
		{ seq: 29, content: [txt('read_image 结果'), img(A)] }
	];
	const { session, calls } = fakeSession(nodes);
	apply(ctx, { dedupe: { enabled: true } });
	const base = { kind: 'enter', messages: [] };
	await ctx.handlers.get('agent/pre-step')({ agent: { session } }, async () => base);
	assert(calls.length === 1, 'case13 append 恰好一次');
	assert(calls[0][0] === 'image/offload', 'case13 事件类型 = image/offload');
	assert(JSON.stringify(calls[0][1]) === JSON.stringify({ targets: [{ seq: 29, imageIndexes: [0] }] }), 'case13 targets 正确');
	assert(nodes[0].content.length === 2 && nodes[1].content.length === 2, 'case13 未改动表层事件对象');
	assert(countOffloads(calls[0][1].targets) === 1, 'case13 记 1 处下车');
}

// ─ case 14: 宿主没挂投影（append 抛错）→ 不阻塞请求，记 hook error，next 仍一次
{
	const { ctx, logs } = fakeCtx();
	const { session } = fakeSession([{ seq: 1, content: [img(A)] }, { seq: 2, content: [img(A)] }], { appendThrows: true });
	apply(ctx, { dedupe: { enabled: true } });
	const base = { kind: 'enter', messages: [] };
	let calls = 0;
	const out = await ctx.handlers.get('agent/pre-step')({ agent: { session } }, async () => { calls += 1; return base; });
	assert(calls === 1, 'case14 next 恰好一次');
	assert(out === base, 'case14 decision 原样返回');
	assert(logs.some((m) => m.includes('hook error')), 'case14 记 hook error');
}

// ─ case 15: 表层枚举抛错 → 回落，next 恰好一次
{
	const { ctx, logs } = fakeCtx();
	const { session } = fakeSession([{ seq: 1, content: [img(A)] }], { eventAtThrows: true });
	apply(ctx, { dedupe: { enabled: true } });
	const base = { kind: 'enter', messages: [] };
	let calls = 0;
	const out = await ctx.handlers.get('agent/pre-step')({ agent: { session } }, async () => { calls += 1; return base; });
	assert(calls === 1 && out === base, 'case15 枚举异常不阻塞请求');
	assert(logs.some((m) => m.includes('hook error')), 'case15 记 hook error');
}

// ─ case 16: 宿主 next() 抛错 = 宿主链路故障 → 原样抛出，不重试
{
	const { ctx } = fakeCtx();
	apply(ctx, { dedupe: { enabled: true } });
	let calls = 0;
	let propagated = false;
	try {
		await ctx.handlers.get('agent/pre-step')({}, async () => { calls += 1; throw new Error('host boom'); });
	} catch (err) {
		propagated = err.message === 'host boom';
	}
	assert(propagated, 'case16 宿主错误原样抛出');
	assert(calls === 1, 'case16 next 不重试');
}

// ─ case 17: dedupe 与 cap 全关 → 不注册任何 hook
{
	const { ctx } = fakeCtx();
	apply(ctx, { dedupe: { enabled: false }, cap: { enabled: false } });
	assert(ctx.handlers.size === 0, 'case17 全关时不注册 hook');
}

// ─ case 18: 日志通道抛错 → apply 不抛，去重仍完成
{
	const { ctx } = fakeCtx({ loggerThrows: true });
	const { session, calls } = fakeSession([
		{ seq: 1, content: [img(A)] },
		{ seq: 2, content: [img(A)] }
	]);
	let applied = true;
	try {
		apply(ctx, { dedupe: { enabled: true } });
	} catch {
		applied = false;
	}
	assert(applied, 'case18 apply 不因日志失败而抛');
	await ctx.handlers.get('agent/pre-step')({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }));
	assert(calls.length === 1, 'case18 日志失败仍完成下车登记');
}

// ─ case 19: 无 agent（非 agent 触发的 pre-step）→ 静默跳过
{
	const { ctx } = fakeCtx();
	apply(ctx, { dedupe: { enabled: true } });
	const base = { kind: 'enter', messages: [] };
	const out = await ctx.handlers.get('agent/pre-step')({}, async () => base);
	assert(out === base, 'case19 无 agent 时原样返回');
}

// ─ case 20: reject 决策 → 原样透传（本插件不干预拒绝）
{
	const { ctx } = fakeCtx();
	apply(ctx, { dedupe: { enabled: true } });
	const rejected = { kind: 'reject' };
	const out = await ctx.handlers.get('agent/pre-step')({}, async () => rejected);
	assert(out === rejected, 'case20 reject 透传');
}

// ─ case 21: tool/result 事件（data.message.content）也能被粗筛命中并下车
{
	const { ctx } = fakeCtx();
	const { session, calls } = fakeSession([
		{ seq: 9, content: [txt('你能看到信息吗'), img(A)] },
		{ seq: 29, type: 'tool/result', content: [txt('read_image 结果'), img(A)] }
	]);
	apply(ctx, { dedupe: { enabled: true } });
	await ctx.handlers.get('agent/pre-step')({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }));
	assert(calls.length === 1 && calls[0][0] === 'image/offload', 'case21 tool/result 路径能下车');
	assert(JSON.stringify(calls[0][1]) === JSON.stringify({ targets: [{ seq: 29, imageIndexes: [0] }] }), 'case21 targets 指向 tool/result 序号');
}

// ─ case 22: offloaded 标记只看投影结果 —— 原始含图、投影已下车时不应再登记
{
	const { ctx } = fakeCtx();
	const rawA = [img(A)];
	const { session, calls } = fakeSession([
		{ seq: 9, content: rawA },
		{ seq: 29, content: rawA, projected: [img(A, { offloaded: true })] }
	]);
	apply(ctx, { dedupe: { enabled: true } });
	await ctx.handlers.get('agent/pre-step')({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }));
	assert(calls.length === 0, 'case22 已下车（投影态）不重复登记');
}

console.log(failed === 0 ? '\nALL PASS (' + 42 + ' assertions)' : '\n' + failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);

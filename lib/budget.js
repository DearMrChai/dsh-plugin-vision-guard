// dsh-vision-guard · 配置读取
//
// 设计原则（cordis-plugin-development / practices.md）：
// - 可调参数一律放本文件解析，用户改 cordis.patch.yml 的 config 段即可生效
// - 结构校验 + 默认值兜底，坏配置永不抛（apply 期抛错会炸 DSH boot）
//
// 规划中的扩展位（本期只有 dedupe 已实现）：
// - cap.enabled=true → 在同一处 agent/pre-step 钩子里追加「只保留最近 keepRecent 张」的选择
// - 「超额度」信号（provider 报 IMAGE_OFFLOAD_REQUIRED）由基础组合的
//   @deepseek-ai/dsh-compaction-image-offload 负责，本插件不重复实现

/**
 * 解析视觉守卫配置。
 *
 * @param {Object} raw - 来自 cordis.patch.yml config 段的原始值
 * @returns {{dedupe: {enabled: boolean}, cap: {enabled: boolean, keepRecent: number}}}
 */
export function parseConfig(raw) {
	const cfg = raw ?? {};
	return {
		dedupe: {
			enabled: cfg.dedupe?.enabled !== false // 默认开：本插件的本体功能
		},
		cap: {
			enabled: cfg.cap?.enabled === true, // 默认关：尚未实现
			keepRecent:
				Number.isInteger(cfg.cap?.keepRecent) && cfg.cap.keepRecent > 0 ? cfg.cap.keepRecent : 4
		}
	};
}

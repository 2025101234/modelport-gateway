/**
 * 兜底模型目录。
 *
 * 数据逐条来自上游渠道包的 `CODEBUDDY_FALLBACK_MODELS` /
 * `WORKBUDDY_FALLBACK_MODELS`（vendor/channel-pack/src/buddy.ts，MIT），仅在
 * 远端 `/v3/config` 读不到时顶替。字段按本仓库运行时需要收敛为
 * `{ id, name, contextWindow, maxOutput, supportsImages, reasoningEfforts }`。
 *
 * 远端可用时**一律以远端下发为准**；这里不臆造远端没给的字段。
 *
 * @module app/channels/workbuddy-desktop/catalog
 */

/** 国内版 / CodeBuddy（copilot.tencent.com）。 */
export const CN_FALLBACK_MODELS = Object.freeze([
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1e6, maxOutput: 128e3, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'] },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1e6, maxOutput: 128e3, supportsImages: true, reasoningEfforts: ['low', 'high', 'xhigh'] },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1e6, maxOutput: 5e4, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'] },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1e6, maxOutput: 64e3, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'] },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1e6, maxOutput: 32e3, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'] },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1e6, maxOutput: 64e3, supportsImages: true, reasoningEfforts: ['high', 'xhigh'] },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 2e5, maxOutput: 48e3, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', contextWindow: 2e5, maxOutput: 64e3, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'hy3', name: 'Hy3', contextWindow: 192e3, maxOutput: 64e3, supportsImages: true, reasoningEfforts: ['low', 'high'] },
  { id: 'hy3-x', name: 'Hy3', contextWindow: 192e3, maxOutput: 64e3, supportsImages: true, reasoningEfforts: ['low', 'high'] },
  { id: 'kimi-k3-1', name: 'Kimi-K3-1', contextWindow: 1e6, maxOutput: 32e3, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1e6, maxOutput: 64e3, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'] },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7', contextWindow: 256e3, maxOutput: 32e3, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256e3, maxOutput: 32e3, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512e3, maxOutput: 64e3, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'default-model', name: 'Auto', contextWindow: 176e3, maxOutput: 24e3, supportsImages: true },
  { id: 'fast-model', name: 'Fast', contextWindow: 2e5, maxOutput: 32e3, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256e3, maxOutput: 32e3, supportsImages: true, reasoningEfforts: ['medium'] },
])

/** 国际版 / WorkBuddy AI（www.workbuddy.ai）。 */
export const GLOBAL_FALLBACK_MODELS = Object.freeze([
  { id: 'default-model', name: 'Auto', contextWindow: 176e3, maxOutput: 24e3, supportsImages: true },
  { id: 'fast-model', name: 'Fast', contextWindow: 2e5, maxOutput: 32e3, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256e3, maxOutput: 32e3, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'primary-model', name: 'Primary', contextWindow: 272e3, maxOutput: 72e3, supportsImages: true, reasoningEfforts: ['high'] },
  { id: 'deep-model', name: 'Deep', contextWindow: 176e3, maxOutput: 24e3, supportsImages: true },
  { id: 'hy4-preview-f', name: 'Hy4 preview', contextWindow: 1e6, maxOutput: 64e3, supportsImages: true, reasoningEfforts: ['high'] },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1e6, maxOutput: 64e3, supportsImages: true, reasoningEfforts: ['high'] },
  { id: 'hy3', name: 'Hy3', contextWindow: 192e3, maxOutput: 64e3, supportsImages: true, reasoningEfforts: ['low', 'high'] },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1e6, maxOutput: 128e3, supportsImages: true, reasoningEfforts: ['high'] },
  { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', contextWindow: 1e6, maxOutput: 128e3, supportsImages: true, reasoningEfforts: ['high'] },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1e6, maxOutput: 128e3, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1e6, maxOutput: 128e3, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1e6, maxOutput: 128e3, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1e6, maxOutput: 128e3, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1e6, maxOutput: 128e3, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272e3, maxOutput: 72e3, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272e3, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1e6, maxOutput: 65536, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1e6, maxOutput: 48e3, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'] },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1e6, maxOutput: 48e3, supportsImages: true, reasoningEfforts: ['high', 'xhigh'] },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1e6, maxOutput: 32e3, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1e6, maxOutput: 32e3, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'] },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256e3, maxOutput: 32e3, supportsImages: true, reasoningEfforts: ['medium'] },
])

export function fallbackModels(region) {
  return region === 'global' ? GLOBAL_FALLBACK_MODELS : CN_FALLBACK_MODELS
}

/** 解析上游 `/v3/config` 的一个模型条目；解析不出的字段留空，不虚构。 */
export function parseUpstreamModel(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id === '') return undefined
  const reasoning = raw.reasoning && typeof raw.reasoning === 'object' ? raw.reasoning : {}
  let reasoningEfforts
  if (Array.isArray(reasoning.supportedEfforts)) {
    reasoningEfforts = reasoning.supportedEfforts.filter(value => typeof value === 'string' && value !== '')
  } else if (typeof reasoning.effort === 'string' && reasoning.effort !== '') {
    // 单数 `effort` 形态只声明默认档；实测两网关接受全阶梯，故只记这一档。
    reasoningEfforts = [reasoning.effort]
  }
  const supportsImages = raw.disabledMultimodal === true ? false
    : typeof raw.supportsImages === 'boolean' ? raw.supportsImages : undefined
  return {
    id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
    ...typeof raw.maxInputTokens === 'number' ? { contextWindow: raw.maxInputTokens } : {},
    ...typeof raw.maxOutputTokens === 'number' ? { maxOutput: raw.maxOutputTokens } : {},
    ...supportsImages === undefined ? {} : { supportsImages },
    ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    ...parseCreditMultiplier(raw.credits) !== undefined ? { creditMultiplier: parseCreditMultiplier(raw.credits) } : {},
  }
}

/** 上游 `credits` 形如 `"x0.79 credits"`，解析成数字；不猜写法则返回 undefined。 */
export function parseCreditMultiplier(value) {
  if (typeof value !== 'string') return undefined
  const match = /\bx([0-9]+(?:\.[0-9]+)?)\b/i.exec(value)
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 路由型模型（auto / default-model 等）不作为可路由条目。 */
export function isRouterModelId(id) {
  return id === 'auto' || id === 'default-model' || id === 'auto-router'
}

/**
 * 从 `/v3/config` 文档里挑出 CLI 通道的模型。
 * `data.agents` 里名为 `cli` 的那条若带 `models`，按它的白名单取；否则全取。
 */
export function selectCliModels(data) {
  const byId = new Map()
  for (const raw of Array.isArray(data?.models) ? data.models : []) {
    const parsed = parseUpstreamModel(raw)
    if (parsed !== undefined) byId.set(parsed.id, parsed)
  }
  let cliIds
  for (const agent of Array.isArray(data?.agents) ? data.agents : []) {
    if (agent && typeof agent === 'object' && agent.name === 'cli' && Array.isArray(agent.models)) {
      cliIds = agent.models.filter(id => typeof id === 'string')
      break
    }
  }
  const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()]
  return ids.filter(id => !isRouterModelId(id)).map(id => byId.get(id)).filter(model => model !== undefined)
}

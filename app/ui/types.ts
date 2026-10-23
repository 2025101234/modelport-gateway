export type Page = 'overview' | 'models' | 'usage' | 'channels' | 'routing' | 'connection' | 'settings'
export interface Model {
  id: string
  name: string
  channel: string
  routable: boolean
  hiddenByUser?: boolean
  vision?: boolean
  reasoning?: boolean
  contextWindow?: number
  maxOutput?: number
  availability?: string
}
export interface ModelTestResult { ok: boolean; text: string; latencyMs: number; ttftMs?: number }
export interface ServiceSettings {
  enabled: boolean
  hiddenModelIds: string[]
  streamRecovery: boolean
  lanEnabled: boolean
  lanPort: number
  probeIntervalMinutes: number
  defaultMaxTokens: number
}
export interface Combo { id: string; name: string; models: string[]; strategy: string; stickyLimit: number; enabled: boolean }
export interface ComboEntry { id: string; name: string; models: string[]; contextWindow?: number; maxOutput?: number; vision?: boolean }
export interface TokenSaverSettings {
  enabled: boolean
  rtk: boolean
  prompts: { caveman: string; ponytail: string }
  cavemanLevels: string[]
  ponytailLevels: string[]
}
export interface LocalOptimizeSettings {
  enabled: boolean
  quota: boolean
  prefix: boolean
  title: boolean
  suggestion: boolean
  filepath: boolean
}
export interface LanState {
  enabled: boolean
  running: boolean
  host: string
  requestedPort: number
  port: number | null
  addresses: string[]
  baseUrls: string[]
  error: string | null
}
export interface Summary {
  version: string
  baseUrl: string
  dataDir: string
  networkMode: string
  automaticRefresh: boolean
  catalogSyncedAt: number
  settings: ServiceSettings
  combos: Combo[]
  tokenSaver: TokenSaverSettings
  localOptimize: LocalOptimizeSettings
  lan?: LanState
  channels?: { state: string; error?: string }
  channelProviders?: string[]
  catalog: Model[]
}
export interface Stats {
  requests: number
  requestFailures: number
  requestFailuresEstimated?: boolean
  logicalEstimated?: boolean
  turns: number
  failedTurns: number
  recoveredTurns: number
  days: { day: string; total: number }[]
  grand: { input: number; output: number; reasoning: number }
  models: UsageModel[]
  samples: { model?: string; ok?: boolean; error?: string; at?: number; ms?: number }[]
}
export interface UsageModel {
  model: string
  name: string
  calls: number
  turns: number
  input: number
  output: number
  reasoning: number
  failed: number
  failedTurns: number
  recoveredTurns: number
  avgTtftMs?: number | null
  tps?: number | null
}
export interface Snapshot { summary: Summary; stats: Stats }
export interface Host {
  navigate(page: Page): void
  refresh(): Promise<void>
  copy(value: string): Promise<void>
  getApiKey(): Promise<string>
  rotateKey(): Promise<string>
  logout(): Promise<void>
  error(error: Error): void
  notice(message: string): void
  testModel(model: string, signal: AbortSignal): Promise<ModelTestResult>
  refreshModels(probe: boolean, signal: AbortSignal): Promise<void>
  saveSettings(settings: Partial<ServiceSettings>): Promise<ServiceSettings>
}

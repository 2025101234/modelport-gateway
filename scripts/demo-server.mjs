/**
 * 本地演示 / 截图用的服务启动脚本（不是测试的一部分）。
 *
 *     node scripts/demo-server.mjs [--two-models]
 *
 * 起一个真实服务并注入替身渠道（`scripts/lib/fake-channels.mjs`），这样控制台的
 * 模型清单、渠道筛选和用量面板都有东西可看。界面上出现的模型全部来自替身，
 * 不访问外网、不消耗任何渠道额度，也不需要登录任何账号。
 *
 * 它曾经灌入的是匿名免费车道的模型 id；那些车道已经移除，所以演示数据改成渠道
 * 形状的 id（`<渠道>/<模型>`），与控制台现在真正会看到的东西一致。
 */
import fs from 'node:fs'
import path from 'node:path'

const scratch = process.env.MODELPORT_DEMO_HOME ?? path.resolve('.demo-data')
fs.mkdirSync(scratch, { recursive: true })

/** 演示清单：跨几个渠道，好让控制台的渠道筛选看得出区别。 */
const DEMO_MODELS = [
  { provider: 'workbuddy', id: 'workbuddy/fast-model', name: 'Fast', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192 },
  { provider: 'workbuddy', id: 'workbuddy/deep-model', name: 'Deep', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 16384 },
  { provider: 'buddy', id: 'buddy/glm-5.2', name: 'GLM-5.2', reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 16384 },
  { provider: 'buddy', id: 'buddy/hunyuan-4', name: 'Hunyuan 4', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192 },
  { provider: 'codearts', id: 'codearts/deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 8192 },
  { provider: 'trae', id: 'trae/seed-2.0', name: 'Seed 2.0', reasoning: false, input: ['text', 'image'], contextWindow: 256000, maxTokens: 16384 },
  { provider: 'qoder', id: 'qoder/qwen3-max', name: 'Qwen3 Max', reasoning: true, input: ['text'], contextWindow: 256000, maxTokens: 16384 },
  { provider: 'gemini', id: 'gemini/gemini-3-pro', name: 'Gemini 3 Pro', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 65536 },
]

process.env.MODELPORT_HOME = scratch
process.env.MODELPORT_TEST_UPSTREAM = '1'

const { startService } = await import('../app/service.mjs')
const { fakeChannelRuntime } = await import('./lib/fake-channels.mjs')

const models = process.argv.includes('--two-models') ? DEMO_MODELS.slice(0, 2) : DEMO_MODELS
const fake = fakeChannelRuntime({ reply: '这是来自替身渠道的演示答复。', models })

const service = await startService({
  port: Number(process.env.MODELPORT_DEMO_PORT ?? 18950), refresh: true,
  createChannels: options => { fake.attach(options.stats); return fake },
})
console.log('CONSOLE=' + service.managementUrl)
console.log('API=' + service.apiBase)
console.log('KEYFILE=' + service.keyFile)

const shutdown = async () => {
  await service.close()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
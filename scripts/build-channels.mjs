/**
 * 从渠道包生成独立业务产物；平台接口替换必须明确匹配。
 *
 *     node scripts/build-channels.mjs [--check]
 *
 * 输入是 `vendor/channel-pack/pack.js`（上游渠道包的打包产物），输出是
 * `app/channels/business.mjs`（去宿主化后的版本）。渠道包原本通过
 * `@deepseek-ai/*` 直接读宿主的 cordis / 凭据 / llm 服务，这里把那些 import
 * 换成同目录的 `contracts.mjs`，并把两处只有宿主才有的调用（设置表单 schema、
 * OpenAI 网关挂载）替换掉。
 *
 * 每一步替换都是「位置必须唯一」：渠道包一升级，任何一处对不上就立刻报错，
 * 而不是悄悄产出一个半改好的文件。
 */
import fs from 'node:fs'
import crypto from 'node:crypto'

const source = fs.readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')
let output = source

function replaceOnce(from, to) {
  if (output.split(from).length !== 2) {
    throw new Error(`渠道生成位置不唯一或已改变：${String(from).slice(0, 90)}`)
  }
  output = output.replace(from, to)
}

// 独立应用不注册宿主设置表单，删除两个仅供宿主使用的 schema。
output = output.replace(/^import Schema2? from "@deepseek-ai\/schemastery";\r?\n/gm, '')
replaceOnce(
  output.match(/var channelPackSchema = Schema\.object\(\{[\s\S]*?\n\}\);/)?.[0] ?? 'missing schema',
  'var channelPackSchema;')
replaceOnce(
  output.match(/var Config = Schema2\.object\(\{[\s\S]*?\n\}\);/)?.[0] ?? 'missing config',
  'var Config;')

// 宿主契约换成同目录的本地实现。
output = output.replace(/from "@deepseek-ai\/(?:cordis|dsh-credentials|dsh-llm)"/g, 'from "./contracts.mjs"')

replaceOnce(
  output.match(/function resolveChannelPackHome\(ctx\) \{[\s\S]*?\n\}/)?.[0] ?? 'missing home resolver',
  'function resolveChannelPackHome(ctx) {\n  if (typeof ctx.platform?.channelHome !== "string") throw new Error("渠道缺少数据目录");\n  return ctx.platform.channelHome;\n}')

// 外层服务已经提供统一网关；宿主 Agent 的自动续跑没有对应服务。
replaceOnce(
  '  mountOpenAiGateway(ctx, pool);\n  installLoopResume(ctx);',
  '  // 统一网关由外层提供；宿主 Agent 自动续跑没有对应服务。')

// WASM 从 app/channels/ 回到仓库根的 vendor 目录。
replaceOnce(
  'resolve(dirname(fileURLToPath(import.meta.url)), "qoder-auth-wasm.wasm")',
  'fileURLToPath(new URL("../../vendor/channel-pack/qoder-auth-wasm.wasm", import.meta.url))')

replaceOnce(
  '  const override = process.env.DSH_CODEARTS_CACHE_DIR;',
  '  const override = process.env.MODELPORT_CODEARTS_CACHE_DIR;')

// 独立端需要的额外导出。
replaceOnce('export {\n  Config,', `export {
  toGenerateOptions, toResponsesGenerateOptions, normalizeReasoningEffort,
  responsesReasoningEffort, normalizeMaxTokens, responsesMaxOutputTokens,
  markGatewayChannel,
  collectGatewayModels, collectGatewayEffortViews, toOpenAiModels,
  Config,`)

if (/@deepseek-ai\/.*["'];/.test(output)) throw new Error('渠道产物仍存在宿主 import')

const digest = crypto.createHash('sha256').update(source).digest('hex')
output = `// 由 scripts/build-channels.mjs 生成，请勿手改。
// 输入：vendor/channel-pack/pack.js  SHA256 ${digest}
${output}`

const file = new URL('../app/channels/business.mjs', import.meta.url)
if (process.argv.includes('--check')) {
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== output) {
    throw new Error('渠道产物需要重新生成：node scripts/build-channels.mjs')
  }
} else {
  fs.mkdirSync(new URL('../app/channels/', import.meta.url), { recursive: true })
  fs.writeFileSync(file, output)
}
console.log(`渠道产物校验通过（${(output.length / 1024 / 1024).toFixed(2)} MB）`)

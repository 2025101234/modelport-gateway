#!/usr/bin/env node
/**
 * 在本机（已安装 WorkBuddy 桌面 App 并登录）把登录态导出成可搬运的**明文**凭据文件。
 *
 *     node scripts/export-workbuddy-auth.mjs [--out <目录>]
 *
 * 为什么需要这一步：新版桌面端（5.6.0 起）把 auth 文件里的 token 加密成
 * AES-256-GCM 字段信封，密钥由 App 的原生绑定在运行时现取、不落盘。因此把加密的
 * *.info 文件直接拷到没有 App 的服务器上是解不开的。本脚本在**有 App 的本机**
 * 调用同一个解密链路，把结果写成未加密的 `workbuddy-auth.<region>.json`，
 * 服务器上的 scanCredentials() 会直接把它当作凭据源，且 refresh token 一并带过去，
 * 可以自动续期。
 *
 * 输出文件名里的 region 只决定存放位置；真正的区域分流靠文件里的 auth.domain，
 * 与 scanCredentials() 的行为一致。
 *
 * ⚠️ 导出物是**可直接使用的登录态**，等同于账号：
 *   - 只经加密通道（scp / 私网）传输，落到服务器后 chmod 600；
 *   - 不要放进任何会被 git 提交、打包或同步到网盘的目录；
 *   - 用完即删，不要长期留在中转机器上。
 *
 * 环境变量（与服务端一致，详见 README）：
 *   WORKBUDDY_AUTH_FILE        显式指定桌面 App 的 auth 文件
 *   WORKBUDDY_APP_EXECUTABLE   加密凭据解密时，指定 App 可执行文件
 *
 * @module scripts/export-workbuddy-auth
 */
import fs from 'node:fs'
import path from 'node:path'
import { scanCredentials, preferredAccountName } from '../app/channels/workbuddy-desktop/auth.mjs'
import { ownDocument } from '../app/channels/workbuddy-desktop/store.mjs'
import { createAppKeyProvider, ENCRYPTED_CREDENTIAL_CODE } from '../app/channels/workbuddy-desktop/at-rest.mjs'

function parseArgs(argv) {
  let out = path.resolve(process.cwd(), 'workbuddy-export')
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--out 需要一个目录参数')
      out = path.resolve(argv[++index])
    } else if (argv[index] === '--help') {
      process.stdout.write('用法：node scripts/export-workbuddy-auth.mjs [--out <目录>]\n')
      process.exit(0)
    } else throw new Error(`未知参数：${argv[index]}`)
  }
  return { out }
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2))
  const result = await scanCredentials({
    // 只读桌面 App 的登录态（以及 WORKBUDDY_AUTH_FILE 显式指向的文件），
    // 不把数据目录里可能存在的旧 store 混进导出结果。
    storeDir: '',
    keyProvider: createAppKeyProvider(),
  })

  if (result.accounts.length === 0) {
    process.stderr.write('没有检测到可用的 WorkBuddy 登录态。\n')
    if (result.diagnostics.explicitFileMissing) {
      process.stderr.write('WORKBUDDY_AUTH_FILE 指向的文件不存在，请检查路径。\n')
    }
    if (result.diagnostics.encryptedCredentialUnsupported) {
      process.stderr.write(`凭据已加密但取不到解密密钥（${ENCRYPTED_CREDENTIAL_CODE}）：\n`
        + '  请确认本机已安装 WorkBuddy 桌面 App，或用 WORKBUDDY_APP_EXECUTABLE 指定其可执行文件。\n')
    }
    if (result.diagnostics.unreadableEncryptedFiles.length > 0) {
      process.stderr.write(`无法解密的文件：${result.diagnostics.unreadableEncryptedFiles.join('、')}\n`)
    }
    if (!result.diagnostics.explicitFileMissing && !result.diagnostics.encryptedCredentialUnsupported) {
      process.stderr.write('请先在 WorkBuddy 桌面端登录，或用 WORKBUDDY_AUTH_FILE 指向 auth 文件。\n')
    }
    process.exitCode = 1
    return
  }

  fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  // 同区域多账号：留 expiresAt 最晚的那个（与服务端 scanCredentials 的选择口径一致）。
  const byRegion = new Map()
  for (const account of result.accounts) {
    const previous = byRegion.get(account.region)
    if (previous === undefined || (account.credential.expiresAtMs ?? 0) > (previous.credential.expiresAtMs ?? 0)) {
      byRegion.set(account.region, account)
    }
  }

  for (const [region, account] of byRegion) {
    const file = path.join(out, `workbuddy-auth.${region}.json`)
    fs.writeFileSync(file, JSON.stringify(ownDocument(account.credential), null, 2), { mode: 0o600 })
    process.stdout.write(`已导出 ${region === 'global' ? '国际版 (workbuddy)' : '国内版 (buddy)'}：`
      + `${preferredAccountName(account.credential)} · 来源 ${path.basename(account.filePath)}`
      + `${account.encrypted ? '（已从加密信封解密）' : ''}\n  -> ${file}\n`)
  }

  const dataDir = process.env.MODELPORT_HOME || '~/.modelport'
  process.stdout.write(`\n上传到服务器（把上面导出的文件放进它的数据目录）：\n`
    + `  scp ${path.join(out, 'workbuddy-auth.*.json')} user@server:${dataDir}/\n`
    + `  ssh user@server 'chmod 600 ${dataDir}/workbuddy-auth.*.json'\n`
    + `  # 然后启动：node app/cli.mjs --lan   （无需 WORKBUDDY_AUTH_FILE，也无需安装桌面 App）\n`)
  process.stdout.write('\n⚠️ 这些文件是明文登录态，等同账号：用加密通道传输、chmod 600、别提交到 git，用完即删。\n')
}

main().catch(error => {
  process.stderr.write(`导出失败：${error.message}\n`)
  process.exitCode = 1
})

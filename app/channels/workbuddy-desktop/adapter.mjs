/**
 * 本仓库自有的 WorkBuddy / CodeBuddy 适配器。
 *
 * 实现 `app/channels/contracts.mjs` 的 `LlmAdapter` 契约，取代渠道包里那两套
 * `BuddyAuth` + `registerBuddyLlm`。注册进 `ctx.llm` 后，`buddy/*` 与
 * `workbuddy/*` 就照常出现在 `/v1/models`、降级链与控制台里。
 *
 * 凭据来源与渠道包不同：桌面 App 的登录态文件只读；网页/扫码登录的账号写入
 * 本仓库自己的 vault；服务器上再叠加搬运来的 store 文件。三类来源合并成同一份
 * 清单，同区域多账号按「未过期优先、到期更晚优先」排序，一次失败可换下一个账号。
 * 不往 channel-credentials.json 写任何凭据。
 *
 * ⚠️ 这是非官方客户端接口的反代，上游改动可能使其失效。
 *
 * @module app/channels/workbuddy-desktop/adapter
 */
import { LlmAdapter, LlmError } from '../contracts.mjs'
import { scanCredentials, preferredAccountName, regionOf } from './auth.mjs'
import { fallbackModels } from './catalog.mjs'
import { writeOwnCredential, removeOwnCredential } from './store.mjs'
import { chatStream, fetchModels, refreshToken, classifyUpstreamError } from './upstream.mjs'
import { createAppKeyProvider, ENCRYPTED_CREDENTIAL_CODE } from './at-rest.mjs'
import { createOAuthSessions } from './oauth.mjs'
import { saveAccount, deleteAccount, exportVault, accountSummary, isAccountId } from './vault.mjs'

/** token 到期前 5 分钟就续期（与插件的按需刷新口径一致）。 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

function needsRefresh(credential, now = Date.now()) {
  return credential.expiresAtMs > 0 && credential.expiresAtMs - now < REFRESH_MARGIN_MS
}

/**
 * 把本模块的错误转成带 statusCode 的异常，让 worker 的 `send({type:'error'})`
 * 能带出正确的 HTTP 状态（而不是笼统 500）。
 */
function upstreamError(error) {
  if (error?.statusCode >= 400) return error
  return Object.assign(new Error(error?.message ?? 'WorkBuddy 上游调用失败'), {
    status: 502, statusCode: 502, code: 'EAC_UPSTREAM_FAILED',
  })
}

export class WorkBuddyDesktopAdapter extends LlmAdapter {
  /**
   * @param {object} options
   * @param {'cn'|'global'} options.region - 本实例服务的区域
   * @param {string} options.provider - 注册进 ctx.llm 的 provider id（buddy / workbuddy）
   * @param {string} options.storeDir - dataDir，刷新结果与搬运凭据的存放目录
   * @param {object} [options.logger]
   * @param {object} [options.env] - 注入环境变量（headless / 测试用）
   * @param {Function} [options.keyProvider] - 注入式 at-rest 密钥来源
   * @param {Function} [options.fetchImpl] - 注入式 fetch（离线测试用）
   */
  constructor({ region, provider, storeDir, logger = console, env, keyProvider, fetchImpl } = {}) {
    super()
    if (region !== 'cn' && region !== 'global') throw new TypeError('region must be cn or global')
    if (typeof provider !== 'string' || provider === '') throw new TypeError('provider is required')
    this.region = region
    this.provider = provider
    this.storeDir = storeDir
    this.logger = logger
    this.env = env
    this.keyProvider = keyProvider
    this.fetchImpl = fetchImpl
    this.accounts = []
    this.diagnostics = {}
    this.models = []
    this.modelCacheAt = 0
    this.credentialCacheAt = 0
    this.refreshInFlight = undefined
    this.scanning = undefined
    // 每 Worker 一份登录会话表；fetchImpl 注入后离线测试无需访问外网。
    this.oauth = createOAuthSessions({ ...(fetchImpl ? { fetchImpl } : {}) })
  }

  // ── 网页 / 扫码登录 ────────────────────────────────────────────────────────

  /** 起一次登录：返回 { loginId, loginUrl, expiresIn } 或 { error }。 */
  async startLogin({ base } = {}) {
    return this.oauth.start(this.region, { base })
  }

  /**
   * 轮询一次。成功即刻把凭据写入 vault（本仓库自己的库，不动桌面 App），
   * 并让账号/目录缓存失效，返回 { done, success, accountId? }。
   */
  async pollLogin(loginId) {
    const result = await this.oauth.poll(loginId, this.region)
    if (result.done !== true) return { done: false }
    if (result.error !== undefined) return { done: true, success: false, error: result.error }
    const { credential, account } = result.account
    const region = result.account.region === 'cn' || result.account.region === 'global'
      ? result.account.region : this.region
    if (region !== this.region) {
      return { done: true, success: false, error: `登录得到的账号属于${region === 'global' ? '国际版' : '国内版'}，请在对应的渠道页操作` }
    }
    const merged = { ...credential, ...account }
    const { accountId } = saveAccount(this.storeDir, this.region, merged)
    this.credentialCacheAt = 0
    this.modelCacheAt = 0
    this.logger.info?.(`${this.provider}: 网页登录成功，账号 ${preferredAccountName(merged)} 已写入 vault`)
    return { done: true, success: true, accountId, nickname: preferredAccountName(merged) }
  }

  /** 删除本仓库 vault 里的一个账号；桌面 App 登录不受影响。 */
  async removeAccount(accountId) {
    if (!isAccountId(accountId)) throw new LlmError('账号 id 非法', 'BAD_REQUEST')
    const removed = deleteAccount(this.storeDir, this.region, accountId)
    this.credentialCacheAt = 0
    this.modelCacheAt = 0
    return { removed }
  }

  /** 脱敏的 vault 账号摘要；绝不回显 token。 */
  vaultAccounts() {
    return accountSummary(this.storeDir).filter(row => row.region === this.region)
  }

  /** 导出本区域 vault 账号成服务器可用的文件名 + 内容（明文，调用方负责保管）。 */
  exportAccounts() {
    const all = exportVault(this.storeDir)
    return all[this.region] ?? null
  }

  /**
   * 重新扫描凭据文件；返回本区域的账号与诊断。
   *
   * 带 15 秒缓存：worker 的 `models()` 会为每个 provider 调 `listModels()`，
   * 周期刷新也会反复触发。每次都重读 auth 目录既浪费又要反复问 App 要密钥。
   * 控制台的「重新检测登录态」用 {@link rescanNow} 显式绕过缓存。
   */
  async rescan({ force = false } = {}) {
    if (!force && this.credentialCacheAt !== 0 && Date.now() - this.credentialCacheAt < 15_000) {
      return { accounts: this.accounts, diagnostics: this.diagnostics }
    }
    if (this.scanning !== undefined) return this.scanning
    this.scanning = (async () => {
      const keyProvider = this.keyProvider ?? createAppKeyProvider(this.env ? { env: this.env } : {})
      const result = await scanCredentials({
        ...(this.env ? { env: this.env } : {}),
        storeDir: this.storeDir,
        keyProvider,
      })
      this.accounts = result.accounts
        .filter(account => account.region === this.region)
        .sort((left, right) => (right.credential.expiresAtMs ?? 0) - (left.credential.expiresAtMs ?? 0))
      this.diagnostics = result.diagnostics
      this.credentialCacheAt = Date.now()
      return { accounts: this.accounts, diagnostics: this.diagnostics }
    })().finally(() => { this.scanning = undefined })
    return this.scanning
  }

  /** 控制台「重新检测登录态」：绕过缓存立刻重扫，并让目录随之刷新。 */
  async rescanNow() {
    const result = await this.rescan({ force: true })
    this.modelCacheAt = 0
    return result
  }

  /** 控制台展示的账号（脱敏，绝不含任何 token / 完整路径）。 */
  publicAccounts() {
    return this.accounts.map(account => ({
      id: account.id,
      provider: this.provider,
      nickname: preferredAccountName(account.credential),
      region: account.region,
      domain: account.credential.domain || (account.region === 'global' ? 'www.workbuddy.ai' : 'copilot.tencent.com'),
      expiresAt: account.credential.expiresAtMs || undefined,
      refreshable: account.refreshable,
      encrypted: account.encrypted === true,
      source: account.source,
      file: account.filePath.split(/[\\/]/).pop(),
      // 只有本仓库 vault 里的账号可以删除；桌面 App / 搬运文件永远只读。
      ...account.source === 'vault' && account.vaultAccountId
        ? { vaultAccountId: account.vaultAccountId, deletable: true } : {},
    }))
  }

  /** 诊断事实表：给控制台如实展示「为什么没账号」。 */
  publicDiagnostics() {
    return {
      region: this.region,
      provider: this.provider,
      accountCount: this.accounts.length,
      explicitFileMissing: this.diagnostics.explicitFileMissing === true,
      encryptedCredentialUnsupported: this.diagnostics.encryptedCredentialUnsupported === true,
      unreadableEncryptedFiles: [...(this.diagnostics.unreadableEncryptedFiles ?? [])],
      ...this.diagnostics.encryptedCredentialUnsupported === true
        ? { code: ENCRYPTED_CREDENTIAL_CODE } : {},
    }
  }

  /** 取一个可用账号，必要时先刷新；刷新结果写回本仓库 store。 */
  async credentialFor(model, { excluded = new Set() } = {}) {
    await this.rescan()
    let failure
    for (const account of this.accounts) {
      if (excluded.has(account.id)) continue
      let credential = account.credential
      try {
        if (needsRefresh(credential) && credential.refreshToken) {
          const refreshed = await this.refresh(account)
          credential = refreshed
          account.credential = refreshed
        }
        return { account, credential }
      } catch (error) {
        failure = upstreamError(error)
        this.logger.warn?.(`${this.provider}: 账号 ${account.id} 的凭据不可用：${failure.message}`)
      }
    }
    if (failure !== undefined) throw failure
    const diagnostic = this.publicDiagnostics()
    if (diagnostic.encryptedCredentialUnsupported) {
      throw new LlmError(
        'WorkBuddy 凭据已加密，但当前机器上取不到解开它的密钥：请安装 WorkBuddy 桌面 App，'
        + '或用 WORKBUDDY_APP_EXECUTABLE 指定其可执行文件；服务器部署请改搬运未加密的凭据文件。',
        ENCRYPTED_CREDENTIAL_CODE,
      )
    }
    throw new LlmError(
      `尚未检测到 WorkBuddy ${this.region === 'global' ? '国际版' : '国内版'}登录态：`
      + '请在本机登录 WorkBuddy 桌面端；服务器上部署请用 WORKBUDDY_AUTH_FILE 指向搬运来的凭据文件。',
      'NO_CREDENTIAL',
    )
  }

  /** 单飞刷新一个账号；成功后原子写入本仓库自有 store。 */
  async refresh(account) {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      const refreshed = await refreshToken(account.credential, {
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      })
      writeOwnCredential(this.storeDir, this.region, refreshed)
      return refreshed
    })().finally(() => { this.refreshInFlight = undefined })
    return this.refreshInFlight
  }

  /** 目录：远端为准，读不到用兜底表。无凭据时返回空（不贡献路由模型）。 */
  async catalog() {
    await this.rescan()
    if (this.accounts.length === 0) return []
    if (this.models.length > 0 && Date.now() - this.modelCacheAt < 60_000) return this.models
    const { credential } = await this.credentialFor('')
    const rows = await fetchModels(credential, { ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) })
      .catch(error => {
        this.logger.warn?.(`${this.provider}: 远端模型目录读取失败，使用兜底表：${error.message}`)
        return fallbackModels(this.region).map(row => ({ ...row, fallback: true }))
      })
    this.models = rows
    this.modelCacheAt = Date.now()
    return this.models
  }

  listProviders() { return [{ id: this.provider }] }

  /**
   * `listModels()` 返回渠道包 `collectGatewayModels()` 期望的目录行形状
   * （`provider` / `id` / `name` / `inputModalities`），`resolveModel()` 另给
   * `context` / `defaultMaxTokens` / `reasoning.efforts` 这类解析信息。
   * 两套形状不能混：前者决定 `/v1/models` 里的行，后者决定档位与上下文。
   */
  async listModels() {
    const rows = await this.catalog()
    return rows.map(row => ({
      provider: this.provider,
      id: row.id,
      name: row.name ?? row.id,
      inputModalities: row.supportsImages === true ? ['text', 'image'] : ['text'],
      ...row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow },
      ...row.maxOutput === undefined ? {} : { maxTokens: row.maxOutput },
    }))
  }

  /** 控制台的 model.list：没登录也给出兜底目录，页面才有东西可展示。 */
  async publicCatalog() {
    const rows = await this.catalog()
    return (rows.length > 0 ? rows : fallbackModels(this.region)).map(row => ({
      id: row.id,
      name: row.name ?? row.id,
      contextWindow: row.contextWindow,
      maxOutput: row.maxOutput,
      vision: row.supportsImages === true,
      reasoning: Array.isArray(row.reasoningEfforts) && row.reasoningEfforts.length > 0,
    }))
  }

  async resolveModel(provider, model) {
    const wanted = String(model ?? '').replace(new RegExp(`^${this.provider}/`), '').trim()
    const rows = await this.catalog()
    const row = rows.find(candidate => candidate.id === wanted) ?? fallbackModels(this.region)[0]
    const efforts = Array.isArray(row.reasoningEfforts) ? row.reasoningEfforts : []
    return {
      provider: this.provider,
      id: row.id,
      name: row.name ?? row.id,
      inputModalities: row.supportsImages === true ? ['text', 'image'] : ['text'],
      ...row.contextWindow === undefined ? {} : { context: { contextWindow: row.contextWindow } },
      ...row.maxOutput === undefined ? {} : { defaultMaxTokens: row.maxOutput },
      ...efforts.length > 0 ? {
        reasoning: {
          efforts: efforts.map(id => ({ id, name: id })),
          defaultEffort: efforts.includes('high') ? 'high' : efforts[0],
        },
      } : {},
    }
  }

  /**
   * ⚠️ 覆盖 prepareCall 必须自己带 `stream`：worker 里 `yield* call.stream(options)`
   * 拿到 undefined 会报一句与真实原因无关的 "is not async iterable"。
   */
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      signal,
      stream: options => this.stream({ ...options, model: resolved, signal }),
    }
  }

  /** 供 worker 的受限直通分支：直接消费 OpenAI body，产出归一化 chunk。 */
  async *streamBody(body, signal) {
    const excluded = new Set()
    let lastError
    for (;;) {
      const { account, credential } = await this.credentialFor(body?.model, { excluded })
      const wireBody = { ...body, model: String(body?.model ?? '').replace(new RegExp(`^${this.provider}/`), '') }
      try {
        for await (const chunk of chatStream(wireBody, {
          credential, signal, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        })) yield chunk
        return
      } catch (error) {
        const classified = upstreamError(error)
        lastError = classified
        // 凭据类失败（401/403/额度耗尽）换下一个账号；其余错误不必把整池走一遍。
        const rotate = classified.status === 401 || classified.status === 403 || classified.status === 402
        if (!rotate || signal?.aborted) throw classified
        excluded.add(account.id)
        if (excluded.size >= this.accounts.length) break
        this.logger.warn?.(`${this.provider}: 账号 ${account.id} 被上游拒绝，换下一个账号`)
      }
    }
    throw lastError ?? classifyUpstreamError(502, '')
  }

  /** LlmAdapter 契约的流式入口（当前网关走 streamBody，这里保留兜底）。 */
  async *stream(options) {
    const body = { ...options, model: `${this.provider}/${options.model?.id ?? options.model ?? ''}` }
    yield* this.streamBody(body, options.signal)
  }

  /** 凭据彻底失效、刷新也救不回来时清掉本仓库副本（不动桌面 App 文件）。 */
  forgetOwnCredential() {
    try { removeOwnCredential(this.storeDir, this.region) } catch (error) {
      this.logger.warn?.(`${this.provider}: 清理自有凭据副本失败：${error.message}`)
    }
  }
}

/** 区域 → provider id 的固定映射（本仓库既有端点口径）。 */
export function providerForRegion(region) {
  return region === 'global' ? 'workbuddy' : 'buddy'
}

export { regionOf }

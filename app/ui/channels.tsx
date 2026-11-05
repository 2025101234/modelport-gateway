import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, CircleAlert, CircleCheck, Clock, ExternalLink, KeyRound, LoaderCircle,
  Network, Plus, RefreshCw, Trash2, Users, Wallet,
} from 'lucide-react'
import { Badge, Button, Card, Input } from './components/ui'
import type { Host, Summary } from './types'
import './channels.css'

const API = '/api/management'
const messageOf = (reason: unknown) => reason instanceof Error
  ? reason.name === 'TimeoutError' ? '请求超时，请检查服务是否仍在运行。' : reason.message
  : '操作失败，请重试。'

/** 渠道展示名。键是渠道包内部的 provider id。 */
const CHANNEL_NAMES: Record<string, string> = {
  codearts: 'CodeArts', buddy: 'CodeBuddy', workbuddy: 'WorkBuddy', lobsterai: 'LobsterAI',
  qoder: 'Qoder', qodercn: 'Qoder 中国版', trae: 'TRAE', cline: 'Cline',
  loomy: 'Loomy', raccoon: 'Raccoon', minimax: 'MiniMax Code', zcode: 'ZCode', gemini: 'Gemini',
  grok: 'Grok',
}
/** 一句话说明每家是什么、从哪来。 */
const CHANNEL_NOTES: Record<string, string> = {
  codearts: '华为云 · DeepSeek / GLM / openPangu',
  buddy: 'CodeBuddy / WorkBuddy 国内版 · 读取本机桌面端登录态（copilot.tencent.com）',
  workbuddy: 'WorkBuddy 国际版 · 读取本机桌面端登录态（www.workbuddy.ai）',
  lobsterai: '网易有道 · 多模型聚合',
  qoder: '阿里系 · Qoder 国际版',
  qodercn: '阿里系 · Qoder 中国版',
  trae: '字节 · TRAE',
  cline: 'Cline 官方 API',
  loomy: '讯飞 · Loomy',
  raccoon: '商汤 · Raccoon Work',
  minimax: 'MiniMax Code',
  zcode: '智谱 · ZCode',
  gemini: 'Google Code Assist',
  // Grok 与上面 13 家不同：它不是官方开放接口，而是网页端的反向代理，且要
  // 自己粘贴 Cookie。说明里把这两点讲清楚，免得用户以为点一下就能登录。
  grok: 'xAI · grok.com 网页端（需粘贴 Cookie）',
}
/** 需要短信二次确认的渠道，登录面板要多两个输入框。 */
const SMS_PROVIDERS = new Set(['trae'])
/**
 * 需要粘贴 Cookie 而不是走 OAuth 弹窗的渠道。
 *
 * Grok 不在上游渠道包里，没有 account.create 那套登录流程（对它会答
 * unknown provider），所以它的凭据由用户直接从浏览器粘贴。这与其余 13 家的
 * 「点一下弹登录页」不同，界面必须区别对待，否则按钮点下去只会报错。
 */
const COOKIE_PROVIDERS = new Set(['grok'])
/**
 * 登录态由桌面 App 管理（或服务器上搬运来的凭据文件），不走 OAuth 弹窗。
 * 这两家在控制台里是「只读 + 重新检测」，没有添加/删除账号、短信验证、
 * 积分领取、逐模型开关这些操作。
 */
const DESKTOP_PROVIDERS = new Set(['buddy', 'workbuddy'])

type Account = { id: string; provider: string; nickname?: string; enabled?: boolean; expiresAt?: number; refreshable?: boolean; region?: string; domain?: string; source?: string; file?: string; encrypted?: boolean }
type ModelRow = { id: string; name?: string; disabled?: boolean; dead?: boolean }
type ChannelState = { state: string; error?: string }
type Diagnostics = {
  region?: string; provider?: string; accountCount?: number;
  explicitFileMissing?: boolean; encryptedCredentialUnsupported?: boolean;
  unreadableEncryptedFiles?: string[]; code?: string;
}

export function Channels({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const providers = summary.channelProviders ?? []
  const [selected, setSelected] = useState<string>(providers[0] ?? '')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [models, setModels] = useState<ModelRow[]>([])
  const [credits, setCredits] = useState<Record<string, unknown>[]>([])
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loginUrl, setLoginUrl] = useState('')
  const [pendingId, setPendingId] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [smsSent, setSmsSent] = useState(false)
  const [cookieText, setCookieText] = useState('')
  const [cookieSaved, setCookieSaved] = useState(false)
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({})
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  useEffect(() => { if (!active) { setMessage(''); setError('') } }, [active])
  useEffect(() => { if (providers.length > 0 && !providers.includes(selected)) setSelected(providers[0]) }, [providers, selected])
  const isDesktop = DESKTOP_PROVIDERS.has(selected)

  /** 一次渠道 RPC。所有渠道操作都走这一条通道。 */
  const rpc = useCallback(async <T = any>(method: string, payload: Record<string, unknown> = {}, timeoutMs = 60000): Promise<T> => {
    const response = await fetch(`${API}/channels/rpc`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const value = await response.json()
    if (!response.ok) throw Object.assign(new Error(value.error ?? `请求失败（${response.status}）`), { status: response.status })
    if (value.ok === false) throw new Error(value.error?.message ?? '渠道操作失败')
    return value.value as T
  }, [])

  const load = useCallback(async (provider: string) => {
    if (provider === '') return
    const emptyAccounts: { accounts: Account[]; diagnostics?: Diagnostics } = { accounts: [] }
    const emptyModels: { models: ModelRow[]; diagnostics?: Diagnostics } = { models: [] }
    const [accountResult, modelResult] = await Promise.all([
      rpc<{ accounts: Account[]; diagnostics?: Diagnostics }>('account.list', { provider }).catch(() => emptyAccounts),
      rpc<{ models: ModelRow[]; diagnostics?: Diagnostics }>('model.list', { provider }).catch(() => emptyModels),
    ])
    if (!mounted.current) return
    setAccounts(accountResult.accounts ?? [])
    setModels(modelResult.models ?? [])
    if (DESKTOP_PROVIDERS.has(provider)) {
      setDiagnostics(modelResult.diagnostics ?? accountResult.diagnostics ?? {})
      setCredits([])
      return
    }
    // 积分是真实计费查询，只在有账号时读。
    if ((accountResult.accounts ?? []).length > 0) {
      const balance = await rpc<{ accounts: Record<string, unknown>[] }>('credits.balances', { provider }).catch(() => ({ accounts: [] }))
      if (mounted.current) setCredits(balance.accounts ?? [])
    } else setCredits([])
  }, [rpc])

  useEffect(() => { if (active && selected) void load(selected).catch(reason => setError(messageOf(reason))) }, [active, selected, load])

  const run = async (key: string, action: () => Promise<void>, done = '') => {
    setBusy(key); setMessage(''); setError('')
    try { await action(); if (mounted.current && done) setMessage(done) }
    catch (reason) { if (mounted.current) setError(messageOf(reason)) }
    finally { if (mounted.current) setBusy('') }
  }

  const login = (provider: string) => run(`login:${provider}`, async () => {
    // 桌面登录态渠道没有 OAuth 弹窗：按钮改成「重新检测本机/搬运来的凭据文件」。
    if (DESKTOP_PROVIDERS.has(provider)) {
      const result = await rpc<{ accounts: number; diagnostics: Diagnostics }>('workbuddy.desktop.rescan', { provider }, 30000)
      if (!mounted.current) return
      if (result.diagnostics?.encryptedCredentialUnsupported === true) {
        setError('凭据已加密但取不到解密密钥：请在本机安装 WorkBuddy 桌面 App，或用 WORKBUDDY_APP_EXECUTABLE 指定它；'
          + '服务器部署请改搬运未加密的凭据文件。')
      } else {
        setMessage(result.accounts > 0
          ? `已检测到 ${result.accounts} 个登录态账号，模型已并入清单。`
          : '没有检测到登录态。请在本机登录 WorkBuddy 桌面端；服务器上部署请用 WORKBUDDY_AUTH_FILE 指向凭据文件。')
      }
      await load(provider)
      await host.refresh()
      return
    }
    // Cookie 类渠道没有 OAuth 弹窗可开，按钮的点法是「展开粘贴框」，不是去登录。
    if (COOKIE_PROVIDERS.has(provider)) {
      setMessage('把 grok.com 的 Cookie 粘贴到下面，保存后即可调用。')
      return
    }
    const created = await rpc<{ accountId: string; loginUrl: string }>('account.create', { provider }, 90000)
    if (!mounted.current) return
    setPendingId(created.accountId)
    setLoginUrl(created.loginUrl ?? '')
    if (created.loginUrl) window.open(created.loginUrl, '_blank', 'noopener,noreferrer')
    setSmsSent(false); setSmsCode('')
    setMessage('已打开登录页。完成授权后回到这里，会自动检测。')
    await host.refresh()
  })

  /** Grok 的凭据保存：校验在服务端做，这里只负责把结果说清楚。 */
  const saveCookie = (provider: string) => run(`cookie:${provider}`, async () => {
    const value = cookieText.trim()
    if (value === '') throw new Error('请先粘贴 Cookie')
    await rpc('grok.credential.set', { cookie: value }, 30000)
    if (!mounted.current) return
    setCookieSaved(true)
    setMessage('已保存。Grok 的模型现在可以调用了。')
    void load(selected); void host.refresh()
  })

  // 登录是后台异步完成的：轮询到账号出现为止，最多 5 分钟。
  useEffect(() => {
    if (pendingId === '' || !active) return
    let cancelled = false
    const timer = window.setInterval(() => {
      void rpc<{ done: boolean; success?: boolean }>('login.poll', { accountId: pendingId, provider: selected })
        .then(result => {
          if (cancelled || !mounted.current) return
          if (result.done === true) {
            window.clearInterval(timer)
            setPendingId(''); setLoginUrl('')
            if (result.success === false) setError('登录未完成，请重试。')
            else { setMessage('已接入。'); void load(selected); void host.refresh() }
          }
        })
        .catch(() => { /* 未完成时继续等 */ })
    }, 2500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [pendingId, active, selected, rpc, load, host])

  const sendSms = () => run('sms', async () => {
    await rpc('login.sendSms', { accountId: pendingId, provider: selected })
    setSmsSent(true); setMessage('验证码已发送。')
  })
  const submitSms = () => run('sms', async () => {
    await rpc('login.submitSms', { accountId: pendingId, provider: selected, code: smsCode })
    setMessage('验证码已提交。')
  })

  const claim = () => run('claim', async () => {
    const result = await rpc<{ claimed?: number; credits?: string }>('credits.claimAll', { provider: selected })
    await load(selected)
    setMessage(result.claimed ? `已领取 ${result.claimed} 个账号。` : '今天没有可领取的积分。')
  }, '')

  const toggleModel = (model: ModelRow) => run(`model:${model.id}`, async () => {
    await rpc('model.setDisabled', { provider: selected, modelId: model.id, disabled: !model.disabled })
    await load(selected); await host.refresh()
  })
  const toggleAll = (disabled: boolean) => run('modelAll', async () => {
    await rpc('model.setAllDisabled', { provider: selected, disabled })
    await load(selected); await host.refresh()
  })
  const removeAccount = (account: Account) => {
    if (!window.confirm(`移除账号 ${account.nickname ?? account.id}？该账号的凭据会一并删除。`)) return
    void run(`del:${account.id}`, async () => {
      await rpc('account.delete', { provider: selected, accountId: account.id })
      await load(selected); await host.refresh()
    }, '账号已移除。')
  }

  const enabledCount = useMemo(() => models.filter(model => !model.disabled && !model.dead).length, [models])
  if (!active) return null
  if (providers.length === 0) {
    return <div className="channels-browser"><header className="dashboard-heading"><div><div className="heading-eyebrow">CHANNELS / ACCOUNTS</div>
      <h1>账号渠道</h1><p>渠道模块没有就绪。</p></div></header>
      <Card className="channels-empty"><CircleAlert size={18} /><span>{summary.channels?.error || '渠道运行时未启动，请查看服务日志。'}</span></Card></div>
  }

  return <div className="channels-browser" data-testid="channels-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">CHANNELS / ACCOUNTS</div>
      <h1>账号渠道</h1><p>登录一次，这些渠道的模型就并入同一个清单。凭据只写进本机或只读桌面端登录态，页面永远拿不到明文。</p></div>
      <Network size={22} aria-hidden="true" /></header>
    {message && <p className="channels-feedback" role="status"><CircleCheck size={15} />{message}</p>}
    {error && <p className="channels-error" role="alert"><CircleAlert size={16} />{error}</p>}

    <div className="channels-layout">
      <Card className="channels-list"><div className="channels-list-head"><strong>渠道</strong><Badge>{providers.length}</Badge></div>
        {providers.map(provider => <button key={provider} className={`channel-item${provider === selected ? ' is-active' : ''}`}
          onClick={() => { setSelected(provider); setMessage(''); setError(''); setLoginUrl(''); setPendingId('') }}>
          <span className="channel-item-name">{CHANNEL_NAMES[provider] ?? provider}</span>
          <span className="channel-item-note">{CHANNEL_NOTES[provider] ?? provider}</span>
        </button>)}
      </Card>

      <div className="channels-detail">
        <Card className="channel-card">
          <div className="channel-card-head"><div><h2>{CHANNEL_NAMES[selected] ?? selected}</h2><p>{CHANNEL_NOTES[selected] ?? ''}</p></div>
            <div className="channel-card-actions">
              <Button variant="outline" onClick={() => login(selected)} disabled={busy !== '' || pendingId !== ''}>
                {busy === `login:${selected}` ? <LoaderCircle size={14} className="spinning" /> : <KeyRound size={14} />}
                {isDesktop ? '重新检测登录态' : '添加账号'}</Button>
              <Button variant="ghost" onClick={() => void load(selected)} disabled={busy !== ''}><RefreshCw size={14} />刷新</Button>
            </div>
          </div>
          <div className="channel-metrics">
            <div><Users size={15} /><span>账号</span><strong>{accounts.length}</strong></div>
            <div><Network size={15} /><span>模型</span><strong>{enabledCount} / {models.length}</strong></div>
            <div><Wallet size={15} /><span>余额</span><strong>{credits.length > 0 ? '已读取' : '—'}</strong></div>
          </div>
          {isDesktop && <div className="channel-login">
            <p><KeyRound size={14} />这一渠道复用本机 WorkBuddy 桌面端的登录态，不弹 OAuth 登录页。凭据文件只读，页面拿不到任何 token。</p>
            <p className="channel-hint">
              本机：登录 WorkBuddy 桌面 App 后点「重新检测登录态」即可。
              无桌面端的服务器：把已登录机器上的**未加密**凭据文件搬过来，用 <code>WORKBUDDY_AUTH_FILE</code>
              指向它（或放进数据目录的 <code>workbuddy-auth.cn.json</code> / <code>workbuddy-auth.global.json</code>），
              再用 <code>chmod 600</code> 收紧权限。
            </p>
            <p className="channel-hint">
              检测到的凭据：{accounts.length > 0
                ? accounts.map(account => `${account.nickname ?? account.id}（${account.region === 'global' ? '国际版' : '国内版'}${account.domain ? ` · ${account.domain}` : ''}${account.file ? ` · ${account.file}` : ''}${account.encrypted ? ' · 已加密' : ''}）`).join('；')
                : '无'}
              {diagnostics.explicitFileMissing === true && ' · WORKBUDDY_AUTH_FILE 指向的文件不存在'}
              {diagnostics.encryptedCredentialUnsupported === true && ' · 加密凭据取不到密钥（需本机安装桌面 App 或设置 WORKBUDDY_APP_EXECUTABLE）'}
              {Array.isArray(diagnostics.unreadableEncryptedFiles) && diagnostics.unreadableEncryptedFiles.length > 0
                && ` · 无法解密的文件：${diagnostics.unreadableEncryptedFiles.join('、')}`}
            </p>
          </div>}
          {COOKIE_PROVIDERS.has(selected) && <div className="channel-login">
            <p><KeyRound size={14} />Grok 走的是网页端反向代理，没有标准的登录回跳，所以凭据要你从浏览器里复制一次。</p>
            <ol className="channel-cookie-steps">
              <li>在浏览器打开 <a href="https://grok.com" target="_blank" rel="noreferrer noopener">grok.com <ExternalLink size={11} /></a> 并确认已登录</li>
              <li>按 F12 → <strong>应用 / Application</strong> → <strong>Cookie</strong> → <code>https://grok.com</code></li>
              <li>把整行复制成 <code>sso=…; x-userid=…</code> 的形式粘到下面</li>
            </ol>
            <textarea aria-label="Grok Cookie" className="channel-cookie-input" rows={3}
              placeholder="sso=...; x-userid=..." value={cookieText}
              onChange={event => setCookieText(event.target.value)} />
            <div className="channel-cookie-actions">
              <Button onClick={() => saveCookie(selected)} disabled={busy !== '' || cookieText.trim() === ''}>
                {busy === 'cookie:grok' ? <LoaderCircle size={14} className="spinning" /> : <KeyRound size={14} />}保存 Cookie</Button>
              {cookieSaved && <span className="channel-hint">已保存</span>}
            </div>
            <p className="channel-hint">凭据写入本机 channel-credentials.json（0600），页面拿不到明文。这是非官方接口，上游改动可能使其失效。</p>
          </div>}
          {(pendingId !== '' || loginUrl !== '') && <div className="channel-login">
            <p><Clock size={14} />正在等待授权完成…</p>
            {loginUrl && <a href={loginUrl} target="_blank" rel="noreferrer noopener">重新打开登录页 <ExternalLink size={12} /></a>}
            {SMS_PROVIDERS.has(selected) && <div className="channel-sms">
              <Input aria-label="短信验证码" placeholder="短信验证码" value={smsCode} onChange={event => setSmsCode(event.target.value)} />
              <Button variant="outline" onClick={sendSms} disabled={busy !== ''}>发送验证码</Button>
              <Button onClick={submitSms} disabled={busy !== '' || smsCode.trim() === ''}>提交</Button>
              {smsSent && <span className="channel-hint">已发送</span>}
            </div>}
          </div>}
          {accounts.length > 0 && <div className="channel-accounts">
            <div className="channel-accounts-head"><strong>账号</strong>
              {!isDesktop && <Button variant="ghost" onClick={claim} disabled={busy !== ''}>{busy === 'claim' ? <LoaderCircle size={14} className="spinning" /> : <Wallet size={14} />}一键领取</Button>}</div>
            {accounts.map(account => <div key={account.id} className="channel-account">
              <span className="channel-account-name">{account.nickname ?? account.id}</span>
              {account.expiresAt ? <span className="channel-account-exp">到期 {new Date(account.expiresAt).toLocaleDateString('zh-CN')}</span> : null}
              {account.refreshable ? <Badge tone="success">可续期</Badge> : <Badge tone="warning">需重登</Badge>}
              {!isDesktop && <Button variant="ghost" aria-label="移除账号" onClick={() => removeAccount(account)} disabled={busy !== ''}><Trash2 size={14} /></Button>}
            </div>)}
          </div>}
        </Card>

        <Card className="channel-card">
          <div className="channel-card-head"><div><h2>模型</h2><p>{isDesktop ? '目录来自上游 /v3/config，登录态有效时自动并入清单。' : <>关掉的模型不会出现在 <code>/v1/models</code> 与选择器里。</>}</p></div>
            {!isDesktop && <div className="channel-card-actions">
              <Button variant="ghost" onClick={() => toggleAll(false)} disabled={busy !== ''}>全部开启</Button>
              <Button variant="ghost" onClick={() => toggleAll(true)} disabled={busy !== ''}>全部关闭</Button>
            </div>}</div>
          {models.length === 0 ? <p className="channel-hint">该渠道尚未返回模型清单。</p> : <div className="channel-models">
            {models.map(model => <label key={model.id} className={`channel-model${model.dead ? ' is-dead' : ''}`}>
              <input type="checkbox" role="switch" checked={!model.disabled} disabled={busy !== '' || model.dead === true || isDesktop}
                onChange={() => toggleModel(model)} />
              <span className="channel-model-name">{model.name ?? model.id}</span>
              <code>{model.id}</code>
              {model.dead && <Badge tone="warning">已下架</Badge>}
            </label>)}
          </div>}
        </Card>
      </div>
    </div>
    <p className="footnote">其余渠道的凭据写入本机 <code>channel-credentials.json</code>（0600）；WorkBuddy / CodeBuddy 只读桌面端登录态文件，绝不回写。接口均非官方公开 API，上游改动可能使其失效。</p>
  </div>
}

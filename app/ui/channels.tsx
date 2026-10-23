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
}
/** 一句话说明每家是什么、从哪来。 */
const CHANNEL_NOTES: Record<string, string> = {
  codearts: '华为云 · DeepSeek / GLM / openPangu',
  buddy: '腾讯 CodeBuddy · 与 WorkBuddy 同端点',
  workbuddy: '腾讯 WorkBuddy 国际版 · www.workbuddy.ai',
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
}
/** 需要短信二次确认的渠道，登录面板要多两个输入框。 */
const SMS_PROVIDERS = new Set(['trae'])

type Account = { id: string; provider: string; nickname?: string; enabled?: boolean; expiresAt?: number; refreshable?: boolean }
type ModelRow = { id: string; name?: string; disabled?: boolean; dead?: boolean }
type ChannelState = { state: string; error?: string }

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
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  useEffect(() => { if (!active) { setMessage(''); setError('') } }, [active])
  useEffect(() => { if (providers.length > 0 && !providers.includes(selected)) setSelected(providers[0]) }, [providers, selected])

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
    const [accountResult, modelResult] = await Promise.all([
      rpc<{ accounts: Account[] }>('account.list', { provider }).catch(() => ({ accounts: [] })),
      rpc<{ models: ModelRow[] }>('model.list', { provider }).catch(() => ({ models: [] })),
    ])
    if (!mounted.current) return
    setAccounts(accountResult.accounts ?? [])
    setModels(modelResult.models ?? [])
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
    const created = await rpc<{ accountId: string; loginUrl: string }>('account.create', { provider }, 90000)
    if (!mounted.current) return
    setPendingId(created.accountId)
    setLoginUrl(created.loginUrl ?? '')
    if (created.loginUrl) window.open(created.loginUrl, '_blank', 'noopener,noreferrer')
    setSmsSent(false); setSmsCode('')
    setMessage('已打开登录页。完成授权后回到这里，会自动检测。')
    await host.refresh()
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
      <h1>账号渠道</h1><p>登录一次，这些渠道的模型就并入同一个清单。凭据只写进本机，页面永远拿不到明文。</p></div>
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
                {busy === `login:${selected}` ? <LoaderCircle size={14} className="spinning" /> : <KeyRound size={14} />}添加账号</Button>
              <Button variant="ghost" onClick={() => void load(selected)} disabled={busy !== ''}><RefreshCw size={14} />刷新</Button>
            </div>
          </div>
          <div className="channel-metrics">
            <div><Users size={15} /><span>账号</span><strong>{accounts.length}</strong></div>
            <div><Network size={15} /><span>模型</span><strong>{enabledCount} / {models.length}</strong></div>
            <div><Wallet size={15} /><span>余额</span><strong>{credits.length > 0 ? '已读取' : '—'}</strong></div>
          </div>
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
              <Button variant="ghost" onClick={claim} disabled={busy !== ''}>{busy === 'claim' ? <LoaderCircle size={14} className="spinning" /> : <Wallet size={14} />}一键领取</Button></div>
            {accounts.map(account => <div key={account.id} className="channel-account">
              <span className="channel-account-name">{account.nickname ?? account.id}</span>
              {account.expiresAt ? <span className="channel-account-exp">到期 {new Date(account.expiresAt).toLocaleDateString('zh-CN')}</span> : null}
              {account.refreshable ? <Badge tone="success">可续期</Badge> : <Badge tone="warning">需重登</Badge>}
              <Button variant="ghost" aria-label="移除账号" onClick={() => removeAccount(account)} disabled={busy !== ''}><Trash2 size={14} /></Button>
            </div>)}
          </div>}
        </Card>

        <Card className="channel-card">
          <div className="channel-card-head"><div><h2>模型</h2><p>关掉的模型不会出现在 <code>/v1/models</code> 与选择器里。</p></div>
            <div className="channel-card-actions">
              <Button variant="ghost" onClick={() => toggleAll(false)} disabled={busy !== ''}>全部开启</Button>
              <Button variant="ghost" onClick={() => toggleAll(true)} disabled={busy !== ''}>全部关闭</Button>
            </div></div>
          {models.length === 0 ? <p className="channel-hint">该渠道尚未返回模型清单。</p> : <div className="channel-models">
            {models.map(model => <label key={model.id} className={`channel-model${model.dead ? ' is-dead' : ''}`}>
              <input type="checkbox" role="switch" checked={!model.disabled} disabled={busy !== '' || model.dead === true}
                onChange={() => toggleModel(model)} />
              <span className="channel-model-name">{model.name ?? model.id}</span>
              <code>{model.id}</code>
              {model.dead && <Badge tone="warning">已下架</Badge>}
            </label>)}
          </div>}
        </Card>
      </div>
    </div>
    <p className="footnote">凭据写入本机 <code>channel-credentials.json</code>（0600）。渠道来自渠道包，接口非官方公开 API，上游改动可能使其失效。</p>
  </div>
}

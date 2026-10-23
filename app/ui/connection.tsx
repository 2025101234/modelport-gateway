import { useMemo, useState } from 'react'
import { Cable, Check, CircleCheck, Copy, Eye, EyeOff, KeyRound, Link2, LockKeyhole, Network, RotateCcw, ShieldAlert, Terminal } from 'lucide-react'
import { Badge, Button, Card } from './components/ui'
import type { Host, Summary } from './types'
import './connection.css'

type Recipe = { id: string; name: string; language: string; note: string; body: (context: Context) => string }
type Context = { base: string; key: string; model: string }

/**
 * One recipe per client this gateway can actually serve.
 *
 * Generated rather than stored: the port can move when the requested one is
 * taken, so a snippet baked into the page at mount time is a snippet that lies
 * after a restart. Everything here is derived from what the listener bound and
 * the key it demands.
 */
const recipes: Recipe[] = [
  {
    id: 'claude-code', name: 'Claude Code', language: 'bash', note: '网关原生说 Anthropic Messages，不需要任何翻译层。',
    body: ({ base, key, model }) => [
      `export ANTHROPIC_BASE_URL=${base}`,
      `export ANTHROPIC_AUTH_TOKEN=${key}`,
      `export ANTHROPIC_MODEL=${model}`,
    ].join('\n'),
  },
  {
    id: 'codex', name: 'Codex CLI', language: 'toml', note: '写入 ~/.codex/config.toml；Responses 协议由网关原生支持。',
    body: ({ base, key, model }) => [
      'model_provider = "modelport"',
      `model = "${model}"`,
      '',
      '[model_providers.modelport]',
      'name = "ModelPort"',
      `base_url = "${base}/v1"`,
      'wire_api = "responses"',
      'env_key = "MODELPORT_API_KEY"',
      '',
      `# export MODELPORT_API_KEY=${key}`,
    ].join('\n'),
  },
  {
    id: 'cursor', name: 'Cursor / Continue', language: 'json', note: 'OpenAI 兼容覆盖配置：Base URL 带 /v1。',
    body: ({ base, key, model }) => JSON.stringify({
      models: [{ title: model, provider: 'openai', model, apiBase: `${base}/v1`, apiKey: key }],
    }, null, 2),
  },
  {
    id: 'openai-sdk', name: 'OpenAI SDK', language: 'python', note: 'Chat Completions；base_url 指向网关的 /v1。',
    body: ({ base, key, model }) => [
      'from openai import OpenAI',
      `client = OpenAI(base_url="${base}/v1", api_key="${key}")`,
      `client.chat.completions.create(model="${model}", messages=[{"role": "user", "content": "hi"}])`,
    ].join('\n'),
  },
  {
    id: 'anthropic-sdk', name: 'Anthropic SDK', language: 'python', note: 'Messages 协议，含 thinking 与 tool_use 块。',
    body: ({ base, key, model }) => [
      'from anthropic import Anthropic',
      `client = Anthropic(base_url="${base}", api_key="${key}")`,
      `client.messages.create(model="${model}", max_tokens=1024, messages=[{"role": "user", "content": "hi"}])`,
    ].join('\n'),
  },
  {
    id: 'curl', name: 'curl', language: 'bash', note: '最小可验证请求：确认地址与 Key 都对。',
    body: ({ base, key, model }) => `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }] })}'`,
  },
]

const protocolRows: [string, string, string][] = [
  ['POST /v1/chat/completions', 'OpenAI Chat Completions', '流式与非流式，含 tool_calls'],
  ['POST /v1/responses', 'OpenAI Responses', 'Codex CLI 使用这一条'],
  ['POST /v1/messages', 'Anthropic Messages', 'Claude Code 使用这一条，含 thinking 块'],
  ['POST /v1/messages/count_tokens', 'Anthropic count_tokens', '本地估算，不产生上游请求'],
  ['GET /v1/models', '模型清单', '需 Bearer Key，含 x_mp_efforts 扩展字段'],
  ['GET /health', '存活探测', '无需 Key，不返回任何凭据'],
]

export function Connection({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const [apiKey, setApiKey] = useState('')
  const [lanKey, setLanKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const [recipeId, setRecipeId] = useState('claude-code')
  const [useLan, setUseLan] = useState(false)
  const [revealed, setRevealed] = useState(false)

  const base = summary.baseUrl
  const lan = summary.lan
  const lanBase = lan?.running && lan.baseUrls.length > 0 ? lan.baseUrls[0].replace(/\/v1$/, '') : ''
  const sampleModel = summary.catalog.find(row => row.routable)?.id ?? 'MODEL_ID'
  const recipe = recipes.find(row => row.id === recipeId) ?? recipes[0]
  const effective = useLan && lanBase !== '' ? lanBase : base
  // A LAN caller must use the LAN key; the loopback key is not served there.
  const snippet = useMemo(() => recipe.body({
    base: effective,
    key: useLan ? (lanKey || '<your-lan-key>') : (apiKey || '<your-api-key>'),
    model: sampleModel,
  }), [recipe, effective, useLan, lanKey, apiKey, sampleModel])

  if (!active) return null

  const run = async (action: () => Promise<void>, message = '') => {
    setBusy(true); setNotice(''); setError('')
    try { await action(); if (message) setNotice(message) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败，请重试。') }
    finally { setBusy(false) }
  }
  const copy = async (id: string, text: string, message: string) => run(async () => {
    await host.copy(text)
    setCopied(id)
    window.setTimeout(() => setCopied(current => current === id ? '' : current), 1600)
  }, message)
  const toggleKey = () => void run(async () => {
    if (apiKey) { setApiKey(''); setRevealed(false); return }
    setApiKey(await host.getApiKey()); setRevealed(true)
  })
  const toggleLanKey = () => void run(async () => {
    if (lanKey) { setLanKey(''); return }
    const response = await fetch('/api/management/lan/key', { credentials: 'same-origin', cache: 'no-store' })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error ?? '无法读取 LAN Key')
    setLanKey(value.key ?? '')
  })
  const rotate = () => {
    if (!window.confirm('轮换后旧 API Key 会立即失效，所有客户端都要更新。确认继续吗？')) return
    void run(async () => { setApiKey(await host.rotateKey()); setRevealed(true) }, '密钥已轮换，请更新所有客户端配置。')
  }

  return <div className="connection-browser" data-testid="connection-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">CONNECT YOUR TOOLS</div>
      <h1>API 接入</h1><p>一个本地地址、一把 Key，把任意 Agent 或 SDK 接到这些模型上。</p></div>
      <Cable size={22} aria-hidden="true" /></header>
    {notice && <p className="connection-feedback" role="status"><CircleCheck size={15} />{notice}</p>}
    {error && <p className="connection-error" role="alert"><ShieldAlert size={16} />{error}</p>}

    <Card className="connection-card"><div className="connection-card-heading"><span className="cx-icon"><KeyRound size={16} /></span><div><h2>连接凭据</h2><p>管理会话与推理密钥相互独立。</p></div></div>
      <label className="field-label" htmlFor="connection-endpoint">API Base URL（OpenAI 兼容）</label>
      <div className="copy-field"><div className="cx-field"><Link2 size={14} /><input id="connection-endpoint" readOnly value={`${base}/v1`} /></div>
        <Button variant="outline" className={copied === 'endpoint' ? 'cx-copied' : undefined} disabled={busy} onClick={() => void copy('endpoint', `${base}/v1`, '地址已复制。')}>{copied === 'endpoint' ? <Check size={14} /> : <Copy size={14} />}复制</Button></div>
      <label className="field-label" htmlFor="connection-anthropic">Anthropic Base URL（Claude Code 用这个）</label>
      <div className="copy-field"><div className="cx-field"><Link2 size={14} /><input id="connection-anthropic" readOnly value={base} /></div>
        <Button variant="outline" className={copied === 'anthropic' ? 'cx-copied' : undefined} disabled={busy} onClick={() => void copy('anthropic', base, '地址已复制。')}>{copied === 'anthropic' ? <Check size={14} /> : <Copy size={14} />}复制</Button></div>
      <label className="field-label" htmlFor="connection-key">API Key</label>
      <div className="copy-field"><div className={`cx-field${revealed ? ' cx-revealed' : ''}`}><LockKeyhole size={14} /><input id="connection-key" type={revealed ? 'text' : 'password'} readOnly value={apiKey} placeholder="点击查看后显示" /></div>
        <Button variant="outline" disabled={busy} onClick={toggleKey}>{apiKey ? <EyeOff size={14} /> : <Eye size={14} />}{apiKey ? '隐藏' : '查看'}</Button>
        <Button variant="outline" className={copied === 'key' ? 'cx-copied' : undefined} disabled={!apiKey || busy} onClick={() => void copy('key', apiKey, '密钥已复制。')}>{copied === 'key' ? <Check size={14} /> : <Copy size={14} />}复制</Button></div>
      <p className="footnote">密钥用于客户端调用，请妥善保管。轮换后旧密钥立即失效。</p>
    </Card>

    {lan && <Card className="connection-card"><div className="connection-card-heading"><span className="cx-icon"><Network size={16} /></span><div><h2>局域网访问</h2><p>{lan.running ? `中继运行在 0.0.0.0:${lan.port}，只转发 /v1/*。` : lan.enabled ? '已启用但未运行，请到服务设置检查端口。' : '未启用。同网段的其他设备目前无法访问这个网关。'}</p></div>
      <Badge tone={lan.running ? 'success' : 'warning'}>{lan.running ? '运行中' : '未运行'}</Badge></div>
      {lan.running && <>
        <label className="field-label" htmlFor="connection-lan">LAN Base URL</label>
        <div className="copy-field"><div className="cx-field"><Link2 size={14} /><input id="connection-lan" readOnly value={lanBase} /></div>
          <Button variant="outline" className={copied === 'lan' ? 'cx-copied' : undefined} disabled={busy} onClick={() => void copy('lan', lanBase, '地址已复制。')}>{copied === 'lan' ? <Check size={14} /> : <Copy size={14} />}复制</Button></div>
        <label className="field-label" htmlFor="connection-lankey">LAN Key（与本机 Key 不同）</label>
        <div className="copy-field"><div className={`cx-field${lanKey ? ' cx-revealed' : ''}`}><LockKeyhole size={14} /><input id="connection-lankey" type={lanKey ? 'text' : 'password'} readOnly value={lanKey} placeholder="点击查看后显示" /></div>
          <Button variant="outline" disabled={busy} onClick={() => void toggleLanKey()}>{lanKey ? <EyeOff size={14} /> : <Eye size={14} />}{lanKey ? '隐藏' : '查看'}</Button>
          <Button variant="outline" className={copied === 'lankey' ? 'cx-copied' : undefined} disabled={!lanKey || busy} onClick={() => void copy('lankey', lanKey, 'LAN Key 已复制。')}>{copied === 'lankey' ? <Check size={14} /> : <Copy size={14} />}复制</Button></div>
        {lan.addresses.length > 1 && <p className="footnote">其他网卡地址：{lan.addresses.slice(1).join(', ')}</p>}
        <p className="footnote">只把 LAN Key 交给可信客户端。开启期间，同网段任何拿到它的设备都能消耗这台机器的免费额度。</p>
      </>}
    </Card>}

    <Card className="connection-card"><div className="connection-card-heading"><span className="cx-icon"><Terminal size={16} /></span><div><h2>接入任意 Agent</h2><p>选一个客户端，复制配方即可用。把占位符换成上方密钥。</p></div>
      {lan?.running && <label className="connection-lan-switch"><input type="checkbox" checked={useLan} onChange={event => setUseLan(event.target.checked)} /> 使用局域网地址</label>}</div>
      <div className="connection-recipes" role="tablist" aria-label="客户端配方">
        {recipes.map(row => <button key={row.id} role="tab" aria-selected={recipeId === row.id} className={recipeId === row.id ? 'is-active' : undefined}
          onClick={() => setRecipeId(row.id)}>{row.name}</button>)}
      </div>
      <p className="connection-recipe-note">{recipe.note}</p>
      <div className="connection-example-wrap">
        <Button variant="ghost" className={copied === 'example' ? 'cx-copied' : undefined} disabled={busy} onClick={() => void copy('example', snippet, '配方已复制。')}>{copied === 'example' ? <Check size={14} /> : <Copy size={14} />}复制配方</Button>
        <pre className="connection-example cx-code" data-language={recipe.language}>{snippet}</pre>
      </div>
    </Card>

    <Card className="connection-card"><div className="connection-card-heading"><span className="cx-icon"><Cable size={16} /></span><div><h2>协议支持</h2><p>同一个端口同时说三种协议，客户端按自己的习惯选。</p></div></div>
      <div className="connection-protocol-table" role="table" aria-label="协议支持">
        <div role="row" className="connection-protocol-head"><span role="columnheader">端点</span><span role="columnheader">协议</span><span role="columnheader">说明</span></div>
        {protocolRows.map(([path, name, note]) => <div role="row" key={path}><code role="cell">{path}</code><span role="cell">{name}</span><span role="cell">{note}</span></div>)}
      </div>
    </Card>

    <Card className="connection-card connection-danger"><div className="connection-card-heading"><span className="cx-icon cx-icon-danger"><ShieldAlert size={16} /></span><div><h2>轮换 API Key</h2><p>轮换后旧密钥立即失效，需要更新所有客户端。</p></div></div>
      <Button variant="outline" className="cx-danger-btn" disabled={busy} onClick={rotate}><RotateCcw size={15} />轮换密钥</Button></Card>
  </div>
}

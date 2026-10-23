import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, LoaderCircle, Plus, Route, Save, Trash2, X } from 'lucide-react'
import { Badge, Button, Card, Input } from './components/ui'
import type { Combo, Host, Summary } from './types'
import './routing.css'

const API = '/api/management'
const messageOf = (reason: unknown) => reason instanceof Error
  ? reason.name === 'TimeoutError' ? '请求超时，请检查服务是否仍在运行。' : reason.message
  : '操作失败，请重试。'

const strategyNames: Record<string, string> = { fallback: '顺序降级', 'round-robin': '轮询' }
const channelNames: Record<string, string> = { anonymous: '匿名免费', kilo: 'Kilo', aggregate: '聚合', combo: '链路', free: '免费' }

type Request = <T = any>(path: string, body?: unknown, timeoutMs?: number) => Promise<T>
type Draft = { id: string; name: string; models: string[]; strategy: string; stickyLimit: string; enabled: boolean }

const blank = (): Draft => ({ id: '', name: '', models: [], strategy: 'fallback', stickyLimit: '1', enabled: true })
const toDraft = (combo: Combo): Draft => ({
  id: combo.id, name: combo.name, models: [...combo.models], strategy: combo.strategy,
  stickyLimit: String(combo.stickyLimit), enabled: combo.enabled !== false,
})

export function Routing({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const [combos, setCombos] = useState<Combo[]>(summary.combos)
  const [draft, setDraft] = useState<Draft>(blank)
  const [editing, setEditing] = useState(false)
  const [picker, setPicker] = useState(false)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  useEffect(() => { setCombos(summary.combos) }, [summary.combos])
  useEffect(() => { if (!active) { setMessage(''); setError(''); setPicker(false) } }, [active])

  const request: Request = useCallback(async (path, body, timeoutMs = 30000) => {
    const response = await fetch(API + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const value = await response.json()
    if (!response.ok) throw Object.assign(new Error(value.error ?? `请求失败（${response.status}）`), { status: response.status })
    return value
  }, [])

  const models = useMemo(() => summary.catalog
    .filter(model => model.channel !== 'combo')
    .map(model => ({ id: model.id, name: model.name, channel: model.channel, routable: model.routable, contextWindow: model.contextWindow, maxOutput: model.maxOutput }))
    .sort((left, right) => Number(right.routable) - Number(left.routable) || left.id.localeCompare(right.id)), [summary.catalog])
  const byId = useMemo(() => new Map(models.map(model => [model.id, model])), [models])
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return models
    return models.filter(model => `${model.id} ${model.name}`.toLowerCase().includes(needle))
  }, [models, search])

  /** The intersection the chain would advertise: the narrowest window wins. */
  const capacity = useMemo(() => {
    if (draft.models.length === 0) return null
    const rows = draft.models.map(id => byId.get(id)).filter(Boolean) as { contextWindow?: number; maxOutput?: number }[]
    if (rows.length === 0) return null
    const windows = rows.map(row => row.contextWindow).filter((value): value is number => typeof value === 'number' && value > 0)
    const outputs = rows.map(row => row.maxOutput).filter((value): value is number => typeof value === 'number' && value > 0)
    return {
      contextWindow: windows.length > 0 ? Math.min(...windows) : undefined,
      maxOutput: outputs.length > 0 ? Math.min(...outputs) : undefined,
      missing: draft.models.filter(id => !byId.has(id)),
    }
  }, [draft.models, byId])

  const run = async (action: () => Promise<void>, done = '') => {
    setBusy(true); setMessage(''); setError('')
    try { await action(); if (mounted.current && done) setMessage(done) }
    catch (reason) { if (mounted.current) setError(messageOf(reason)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const persist = (rows: Draft[]) => run(async () => {
    const value = await request<{ combos: Combo[] }>('/combos', {
      combos: rows.map(row => ({
        ...row.id === '' ? {} : { id: row.id },
        name: row.name.trim() === '' ? '未命名链路' : row.name.trim(),
        models: row.models,
        strategy: row.strategy,
        stickyLimit: Number(row.stickyLimit) || 1,
        enabled: row.enabled,
      })),
    })
    if (!mounted.current) return
    setCombos(value.combos); setEditing(false); setDraft(blank()); setPicker(false)
    await host.refresh()
  }, '链路已保存。')
  const save = () => {
    const row: Draft = { ...draft, name: draft.name.trim() || '未命名链路' }
    const rows = combos.map(combo => toDraft(combo))
    const index = rows.findIndex(combo => combo.id === row.id)
    if (index >= 0) rows[index] = row
    else rows.push(row)
    void persist(rows)
  }
  const remove = (combo: Combo) => {
    if (!window.confirm(`删除链路 ${combo.name}？这个模型 ID 会立即从清单消失，正在引用它的客户端会拿到 404。`)) return
    void persist(combos.filter(row => row.id !== combo.id).map(toDraft))
  }
  const move = (index: number, delta: number) => {
    const next = [...draft.models]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [row] = next.splice(index, 1)
    next.splice(target, 0, row)
    setDraft(previous => ({ ...previous, models: next }))
  }

  if (!active) return null
  return <div className="routing-browser" data-testid="routing-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">CHANNELS / ROUTING</div>
      <h1>路由链路</h1><p>把几个模型串成一条降级链：前一个失败就换下一个，调用方始终只看到一个模型 ID。</p></div>
      <Route size={22} aria-hidden="true" /></header>
    {message && <p className="routing-feedback" role="status"><CircleCheck size={15} />{message}</p>}
    {error && <p className="routing-error" role="alert"><CircleAlert size={16} />{error}</p>}

    <Card className="routing-panel"><div className="card-heading"><div><h2>已存链路</h2><p>链路按输入顺序保存；引用了当前不可用模型的链路原样保留，对应渠道登录后自己回来。</p></div>
      {!editing && <Button onClick={() => { setDraft(blank()); setEditing(true); setMessage(''); setError('') }}><Plus size={15} />新建链路</Button>}</div>
      {combos.length === 0 ? <p className="routing-empty" role="status">还没有降级链。一条链就是一个虚拟模型：在模型选择器里选它，请求按顺序尝试链上的每个真实模型。</p> : <div className="routing-list">
        {combos.map(combo => <div key={combo.id} className="routing-row" data-combo={combo.id}>
          <div className="routing-row-head"><div className="routing-identity"><strong>{combo.name}</strong><code>{combo.id}</code>
            <div className="routing-tags"><Badge>{strategyNames[combo.strategy] ?? combo.strategy}</Badge>
              <Badge tone={combo.enabled === false ? 'warning' : 'success'}>{combo.enabled === false ? '已停用' : '启用中'}</Badge>
              <Badge tone="blue">{combo.models.length} 个成员</Badge></div></div>
            <div className="routing-actions">
              <Button variant="outline" onClick={() => { setDraft(toDraft(combo)); setEditing(true); setMessage(''); setError('') }}>编辑</Button>
              <Button variant="ghost" onClick={() => remove(combo)} disabled={busy}><Trash2 size={14} />删除</Button></div></div>
          <ol className="routing-members">{combo.models.map(id => {
            const model = byId.get(id)
            return <li key={id}><span className="routing-order" aria-hidden="true" />{model ? <><strong>{model.name}</strong><code>{id}</code>
              <Badge tone={model.routable ? 'success' : 'warning'}>{model.routable ? '可用' : '当前不可用'}</Badge></> : <><strong>{id}</strong><Badge tone="warning">不在清单中</Badge></>}</li>
          })}</ol>
        </div>)}
      </div>}
    </Card>

    {editing && <Card className="routing-panel routing-editor">
      <div className="card-heading"><div><h2>{draft.id === '' ? '新建链路' : '编辑链路'}</h2><p>成员按顺序尝试；轮询策略下同一个模型连续用 stickyLimit 次再换下一个。</p></div>
        <Button variant="ghost" onClick={() => { setEditing(false); setDraft(blank()); setPicker(false) }}><X size={15} />取消</Button></div>
      <label htmlFor="combo-name">名称</label>
      <Input id="combo-name" placeholder="例如：先免费后聚合" value={draft.name} maxLength={80}
        onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} />
      <div className="routing-inline">
        <div><label htmlFor="combo-strategy">策略</label>
          <select id="combo-strategy" value={draft.strategy} onChange={event => setDraft(previous => ({ ...previous, strategy: event.target.value }))}>
            <option value="fallback">顺序降级</option><option value="round-robin">轮询</option></select></div>
        <div><label htmlFor="combo-sticky">轮询粘滞次数</label>
          <Input id="combo-sticky" type="number" min={1} max={100} value={draft.stickyLimit} disabled={draft.strategy !== 'round-robin'}
            onChange={event => setDraft(previous => ({ ...previous, stickyLimit: event.target.value }))} /></div>
        <div><label htmlFor="combo-enabled">启用</label>
          <input id="combo-enabled" type="checkbox" role="switch" checked={draft.enabled}
            onChange={event => setDraft(previous => ({ ...previous, enabled: event.target.checked }))} /></div>
      </div>
      <div className="routing-members-editor"><div className="routing-members-head"><strong>成员（按顺序）</strong>
        <Button variant="outline" onClick={() => setPicker(value => !value)}><Plus size={14} />添加成员</Button></div>
        {draft.models.length === 0 ? <p className="routing-hint" role="status">还没有成员——点「添加成员」从清单里挑一个。</p>
          : <ol className="routing-member-list">{draft.models.map((id, index) => {
            const model = byId.get(id)
            return <li key={id}><span className="routing-order">{index + 1}</span>
              <span className="routing-member-name"><strong>{model?.name ?? id}</strong><code>{id}</code></span>
              {model ? <Badge tone={model.routable ? 'success' : 'warning'}>{model.routable ? '可用' : '当前不可用'}</Badge> : <Badge tone="warning">不在清单中</Badge>}
              <span className="routing-member-actions">
                <Button variant="ghost" aria-label="上移" title="上移" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></Button>
                <Button variant="ghost" aria-label="下移" title="下移" disabled={index === draft.models.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></Button>
                <Button variant="ghost" aria-label="移除成员" title="移除成员" onClick={() => setDraft(previous => ({ ...previous, models: previous.models.filter(row => row !== id) }))}><X size={14} /></Button>
              </span></li>
          })}</ol>}
        {picker && <div className="routing-picker"><Input aria-label="搜索模型" placeholder="搜索模型 ID 或名称…" value={search} autoFocus
          onChange={event => setSearch(event.target.value)} />
          <div className="routing-picker-list" role="listbox" aria-label="可选模型">{shown.slice(0, 200).map(model => {
            const chosen = draft.models.includes(model.id)
            return <button key={model.id} role="option" aria-selected={chosen} disabled={chosen} className={chosen ? 'is-chosen' : undefined}
              onClick={() => setDraft(previous => ({ ...previous, models: [...previous.models, model.id] }))}>
              <span>{model.name}<code>{model.id}</code></span>
              <Badge tone={model.routable ? 'success' : 'warning'}>{channelNames[model.channel] ?? model.channel}</Badge></button>
          })}</div>
          {shown.length === 0 && <p className="routing-hint" role="status">没有匹配的模型。</p>}</div>}
      </div>
      {capacity && <p className="routing-capacity" role="note">链路能力交集：上下文 {capacity.contextWindow ? `${Math.round(capacity.contextWindow / 1000)}K` : '未知'} · 最大输出 {capacity.maxOutput ? Math.round(capacity.maxOutput / 1000) + 'K' : '未知'}
        {capacity.missing.length > 0 && ` · 不在清单中的成员：${capacity.missing.join(', ')}`}</p>}
      <div className="routing-footer"><Button onClick={save} disabled={busy || draft.models.length === 0}>
        {busy ? <LoaderCircle size={15} className="spinning" /> : <Save size={15} />}保存链路</Button></div>
    </Card>}
    <p className="footnote">链路以 <code>combo:&lt;名称&gt;</code> 出现在模型清单与 <code>/v1/models</code> 里，可直接作为任意客户端的模型 ID。</p>
  </div>
}

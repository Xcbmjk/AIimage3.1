import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Activity, ArrowRight, BarChart3, Brain, Check, Copy, Download, FileText, ImagePlus,
  Images, KeyRound, LogOut, Palette, Plus, RefreshCw, RotateCcw, Search, ShieldCheck,
  Trash2, UserRound, X,
} from 'lucide-react'

type Role = 'owner' | 'operator' | 'technical'
type User = { username: string; role: Role }
type View = 'overview' | 'gallery' | 'generations' | 'entitlements' | 'styles' | 'backgrounds' | 'models' | 'image-models' | 'redeem-codes' | 'health' | 'audit'
type MessageState = { text: string; error?: boolean }
const roleNames: Record<Role, string> = { owner: '老板', operator: '运营', technical: '技术' }
const nav: Array<{ id: View; label: string; icon: typeof Activity; roles?: Role[] }> = [
  { id: 'overview', label: '概览', icon: BarChart3 },
  { id: 'gallery', label: '作品库', icon: Images },
  { id: 'generations', label: '生图任务', icon: RotateCcw },
  { id: 'entitlements', label: '体验权益', icon: ShieldCheck },
  { id: 'styles', label: '风格管理', icon: Palette, roles: ['owner', 'operator'] },
  { id: 'backgrounds', label: 'Agent 背景', icon: Brain, roles: ['owner', 'operator'] },
  { id: 'models', label: '视觉模型', icon: Brain, roles: ['owner', 'operator'] },
  { id: 'image-models', label: '图片生成模型', icon: ImagePlus, roles: ['owner', 'operator'] },
  { id: 'redeem-codes', label: '兑换码', icon: KeyRound, roles: ['owner'] },
  { id: 'health', label: '系统监控', icon: Activity },
  { id: 'audit', label: '审计日志', icon: FileText, roles: ['owner', 'technical'] },
]

// 登录后直接保存 CSRF 令牌：cookie 读不到时（浏览器限制、代理丢 SameSite 等）写操作仍可用。
let csrfToken: string | null = null
function adminRequest(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase())) {
    const csrf = csrfToken ?? document.cookie.match(/(?:^|; )admin_csrf=([^;]+)/)?.[1]
    if (csrf) headers.set('X-CSRF-Token', decodeURIComponent(csrf))
  }
  return fetch(input, { ...init, credentials: 'same-origin', headers })
}
async function readPayload(response: Response) {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>
}
function payloadMessage(payload: Record<string, unknown>, fallback: string) {
  return typeof payload.message === 'string' ? payload.message : fallback
}
function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}
function useAdminData<T>(url: string, initial: T) {
  const [data, setData] = useState(initial)
  const [loading, setLoading] = useState(true)
  const initialRef = useRef(initial)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminRequest(url)
      if (!response.ok) throw new Error('加载失败')
      setData(await response.json() as T)
    } catch {
      setData(initialRef.current)
    } finally {
      setLoading(false)
    }
  }, [url])
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    const handler = () => void load()
    window.addEventListener('admin-refresh', handler)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('admin-refresh', handler)
    }
  }, [load])
  return { data, loading }
}

export function AdminApp() {
  const [user, setUser] = useState<User | null>(null)
  const [view, setView] = useState<View>('overview')
  const [error, setError] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  useEffect(() => {
    void adminRequest('/api/admin/auth/me')
      .then(async (response) => response.ok ? await response.json() as { user?: User } : null)
      .then((payload) => { if (payload?.user) setUser(payload.user) })
      .catch(() => undefined)
  }, [])
  const login = async (username: string, password: string) => {
    setLoginBusy(true); setError('')
    try {
      const response = await adminRequest('/api/admin/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const payload = await readPayload(response)
      if (!response.ok || !payload.user) throw new Error(payloadMessage(payload, '账号或密码错误'))
      if (typeof payload.csrf === 'string' && payload.csrf) csrfToken = payload.csrf
      setUser(payload.user as User)
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '登录失败')
    } finally { setLoginBusy(false) }
  }
  if (!user) return <Login busy={loginBusy} error={error} onSubmit={login} />
  const allowedNav = nav.filter((item) => !item.roles || item.roles.includes(user.role))
  const active = allowedNav.find((item) => item.id === view) ?? allowedNav[0]
  const logout = async () => {
    await adminRequest('/api/admin/auth/logout', { method: 'POST' }).catch(() => undefined)
    csrfToken = null
    setUser(null)
  }
  return <div className="admin-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">焕</span><span><strong>焕新造像</strong><small>OPERATIONS</small></span></div>
      <nav>{allowedNav.map((item) => { const Icon = item.icon; return <button key={item.id} className={active.id === item.id ? 'active' : ''} onClick={() => setView(item.id)}><Icon size={17} /><span>{item.label}</span>{active.id === item.id && <ArrowRight size={14} />}</button> })}</nav>
      <div className="sidebar-foot"><div className="user-chip"><span className="avatar"><UserRound size={16} /></span><span><b>{user.username}</b><small>{roleNames[user.role]}</small></span></div><button className="icon-btn" title="退出登录" onClick={() => void logout()}><LogOut size={16} /></button></div>
    </aside>
    <main className="content"><header className="content-head"><div><p className="kicker">PYTHON / ADMIN CONSOLE</p><h1>{active.label}</h1></div><div className="head-actions"><span className="live-dot"><i />服务在线</span><button className="icon-btn" title="刷新" onClick={() => window.dispatchEvent(new Event('admin-refresh'))}><RefreshCw size={16} /></button></div></header><ViewContent view={active.id} role={user.role} /></main>
  </div>
}

function Login({ busy, error, onSubmit }: { busy: boolean; error: string; onSubmit: (username: string, password: string) => void }) {
  const [username, setUsername] = useState('owner')
  const [password, setPassword] = useState('')
  return <main className="login-page"><div className="login-panel"><div className="login-brand"><span className="brand-mark">焕</span><div><strong>焕新造像</strong><small>OPERATIONS CONSOLE</small></div></div><h1>欢迎回来</h1><p>登录管理后台，查看和维护体验业务。</p><form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onSubmit(username, password) }}><label>账号<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label><label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>{error && <div className="form-error">{error}</div>}<button className="primary-btn" disabled={busy}>{busy ? '正在验证…' : '登录后台'}<ArrowRight size={17} /></button></form><small className="login-note">账号密码由数据库中的管理员账号校验</small></div></main>
}
function ViewContent({ view, role }: { view: View; role: Role }) {
  if (view === 'overview') return <Overview />
  if (view === 'gallery') return <Gallery role={role} />
  if (view === 'generations') return <Generations />
  if (view === 'entitlements') return <Entitlements />
  if (view === 'styles') return <Styles role={role} />
  if (view === 'backgrounds') return <Backgrounds role={role} />
  if (view === 'models') return <ModelConfigs role={role} modelType="vision_analysis" />
  if (view === 'image-models') return <ModelConfigs role={role} modelType="image_generation" />
  if (view === 'redeem-codes') return <RedeemCodes />
  if (view === 'health') return <Health />
  return <Audit />
}
function PanelTitle({ title, action }: { title: string; action?: string }) { return <div className="panel-title"><h2>{title}</h2>{action && <span className="muted">{action}</span>}</div> }
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div> }

type Generation = { id: string; sessionId: string; mode: string; status: string; errorCode?: string; attempts: number; createdAt: string; completedAt?: string | null }
function Overview() {
  const { data, loading } = useAdminData('/api/admin/summary', { provider: 'mock', totals: { entitlements: 0, activeEntitlements: 0, generationTotal: 0, generationSucceeded: 0, generationFailed: 0, stylesPublished: 0, backgroundsPublished: 0 }, recentGenerations: [] as Generation[] })
  const cards = [['体验权益', data.totals.entitlements, '累计生成的体验权益'], ['可用权益', data.totals.activeEntitlements, '当前可使用'], ['生图任务', data.totals.generationTotal, '全部任务记录'], ['生成成功', data.totals.generationSucceeded, '已完成任务'], ['异常任务', data.totals.generationFailed, '需要关注'], ['已发布风格', data.totals.stylesPublished, '当前版本']]
  return <><section className="metric-grid">{cards.map(([label, value, note]) => <div className="metric-card" key={label as string}><span>{label}</span><strong>{loading ? '—' : value}</strong><small>{note}</small></div>)}</section><section className="panel two-col"><div><PanelTitle title="最近生图任务" /><GenerationTable generations={data.recentGenerations} /></div><div className="status-panel"><PanelTitle title="运行状态" /><div className="runtime"><span className="runtime-icon"><Activity size={18} /></span><div><b>图像服务：{data.provider}</b><small>Python API 已连接</small></div><span className="status-pill success">在线</span></div><div className="runtime"><span className="runtime-icon sand"><Palette size={18} /></span><div><b>内容配置</b><small>{data.totals.stylesPublished} 个风格 · {data.totals.backgroundsPublished} 个背景</small></div><span className="status-pill neutral">MySQL</span></div></div></section></>
}
type GalleryItem = {
  assetId: string; url: string; styleId: string; mimeType: string; byteSize: number
  createdAt: string; expiresAt: string; generationId: string; mode: string
  status: string; sessionId: string; redeemCodePrefix?: string | null; redeemCodeStatus?: string | null
}
const emptyGallery = { items: [] as GalleryItem[], total: 0, totalBytes: 0 }
function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
const redeemStatus: Record<string, string> = { available: '未使用', reserved: '处理中', redeemed: '已兑换', disabled: '已禁用' }
function Gallery({ role }: { role: Role }) {
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [preview, setPreview] = useState<GalleryItem | null>(null)
  const [pending, setPending] = useState<{ item: GalleryItem; scope: 'asset' | 'generation'; total: number } | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<MessageState | null>(null)
  const query = submitted.trim() ? `&q=${encodeURIComponent(submitted.trim())}` : ''
  const { data, loading } = useAdminData<typeof emptyGallery>(`/api/admin/gallery?limit=120${query}`, emptyGallery)
  const canDelete = role === 'owner'
  useEffect(() => {
    if (!preview) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])
  const siblings = preview ? data.items.filter((item) => item.generationId === preview.generationId).length : 0
  // 触屏设备/部分浏览器不弹原生 confirm、prompt，因此改用页面内确认框。
  const askRemove = (item: GalleryItem, scope: 'asset' | 'generation') => {
    setMessage(null)
    setReason('')
    setPending({ item, scope, total: data.items.filter((entry) => entry.generationId === item.generationId).length })
  }
  const confirmRemove = async () => {
    if (!pending || busy) return
    setBusy(true)
    try {
      const response = await adminRequest(`/api/admin/gallery/${pending.item.assetId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || '后台手动删除', scope: pending.scope }),
      })
      const payload = await readPayload(response)
      setMessage({ text: response.ok ? `已删除 ${Number(payload.count ?? 1)} 张图片` : payloadMessage(payload, '删除失败'), error: !response.ok })
      if (response.ok) { setPreview(null); setPending(null); window.dispatchEvent(new Event('admin-refresh')) }
    } finally { setBusy(false) }
  }
  return <section className="panel gallery-panel">
    <div className="style-toolbar"><div><h2>作品库</h2><p>按兑换码前缀、会话 ID 或任务 ID 检索游客生成的图片。</p></div><span className="muted">{loading ? '加载中' : `${data.total} 张 · ${formatBytes(data.totalBytes)}`}</span></div>
    <form className="config-form inline gallery-search" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setSubmitted(keyword) }}>
      <label className="wide-field">检索关键词<input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="兑换码前缀 / 会话 ID / 任务 ID / 风格 ID" /></label>
      <div className="editor-actions"><button className="primary-btn" type="submit"><Search size={16} />搜索</button>{submitted && <button className="secondary-cta" type="button" onClick={() => { setKeyword(''); setSubmitted('') }}>清空</button>}</div>
    </form>
    {message && <div className={message.error ? 'form-error' : 'form-message'}>{message.text}</div>}
    {!loading && !data.items.length && <Empty text={submitted ? '没有匹配的图片' : '暂无生成图片'} />}
    <div className="gallery-grid">{data.items.map((item) => <div className="gallery-card" key={item.assetId}>
      <button className="gallery-open" title="查看大图" onClick={() => setPreview(item)}>
        <span className="gallery-thumb"><img src={item.url} alt="" loading="lazy" /></span>
        <span className="gallery-code">{item.redeemCodePrefix ? `${item.redeemCodePrefix}••••` : '无兑换码'}</span>
        <span className="gallery-meta">{item.styleId} · {item.mode === 'agent' ? 'Agent' : '经典风格'}</span>
        <span className="gallery-meta muted">{formatDate(item.createdAt)} · {formatBytes(item.byteSize)}</span>
      </button>
      {canDelete && <button className="gallery-delete" title="删除这张图片" aria-label="删除这张图片" onClick={(event) => { event.stopPropagation(); askRemove(item, 'asset') }}><Trash2 size={15} /></button>}
    </div>)}</div>
    <p className="muted gallery-note">兑换码明文不入库，这里只显示前 4 位前缀用于与票根核对；图片保留 30 天，到期后自动清理。{!canDelete && '删除作品仅限老板账号。'}</p>
    {preview && <div className="style-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null) }}>
      <div className="style-modal gallery-modal" role="dialog" aria-modal="true">
        <div className="style-modal-head"><div><h2>作品详情</h2><p className="mono">{preview.assetId}</p></div><button className="icon-btn" title="关闭" onClick={() => setPreview(null)}><X size={18} /></button></div>
        <div className="gallery-preview-body">
          <img className="gallery-preview-image" src={preview.url} alt="" />
          <dl className="gallery-detail">
            <div><dt>兑换码</dt><dd className="mono">{preview.redeemCodePrefix ? `${preview.redeemCodePrefix}••••` : '—'}{preview.redeemCodeStatus && <small className="table-subtitle">{redeemStatus[preview.redeemCodeStatus] ?? preview.redeemCodeStatus}</small>}</dd></div>
            <div><dt>风格</dt><dd>{preview.styleId}</dd></div>
            <div><dt>模式</dt><dd>{preview.mode === 'agent' ? 'Agent 背景合成' : '经典风格'}</dd></div>
            <div><dt>任务 ID</dt><dd className="mono">{preview.generationId}</dd></div>
            <div><dt>会话 ID</dt><dd className="mono">{preview.sessionId}</dd></div>
            <div><dt>生成时间</dt><dd>{formatDate(preview.createdAt)}</dd></div>
            <div><dt>过期时间</dt><dd>{formatDate(preview.expiresAt)}</dd></div>
            <div><dt>体积</dt><dd>{formatBytes(preview.byteSize)}</dd></div>
          </dl>
        </div>
        <div className="editor-actions gallery-preview-actions">
          {canDelete && <button className="text-btn danger-btn gallery-delete-action" onClick={() => askRemove(preview, 'asset')}><Trash2 size={15} />删除本张</button>}
          {canDelete && siblings > 1 && <button className="text-btn danger-btn gallery-delete-action" onClick={() => askRemove(preview, 'generation')}>删除本次全部 {siblings} 张</button>}
          <a className="secondary-cta" href={preview.url} target="_blank" rel="noreferrer">新窗口打开</a>
          <a className="primary-btn" href={preview.url} download={`${preview.redeemCodePrefix ?? 'artwork'}-${preview.styleId}.jpg`}><Download size={16} />下载原图</a>
        </div>
      </div>
    </div>}
    {pending && <div className="style-modal-backdrop confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setPending(null) }}>
      <div className="style-modal confirm-modal" role="dialog" aria-modal="true">
        <div className="style-modal-head"><div><h2>{pending.scope === 'generation' ? `删除本次 ${pending.total} 张图片` : '删除这张图片'}</h2><p className="mono">{pending.item.redeemCodePrefix ? `${pending.item.redeemCodePrefix}••••` : pending.item.assetId}</p></div></div>
        <div className="confirm-body">
          <p>删除后不可恢复，游客已保存的分享链接也会立即失效。</p>
          <label>删除原因（可选，记入审计日志）<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：游客要求删除 / 测试图" maxLength={200} /></label>
        </div>
        <div className="editor-actions confirm-actions">
          <button className="secondary-cta" type="button" disabled={busy} onClick={() => setPending(null)}>取消</button>
          <button className="primary-btn danger-solid" type="button" disabled={busy} onClick={() => void confirmRemove()}>{busy ? '删除中…' : '确认删除'}</button>
        </div>
      </div>
    </div>}
  </section>
}
function Generations() {
  const { data, loading } = useAdminData<{ generations: Generation[] }>('/api/admin/generations', { generations: [] })
  const [message, setMessage] = useState<MessageState | null>(null)
  const retry = async (id: string) => {
    const reason = window.prompt('请输入重试原因')?.trim()
    if (!reason) return
    const response = await adminRequest(`/api/admin/generations/${id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) })
    const payload = await readPayload(response)
    setMessage({ text: response.ok ? '已记录重试请求' : payloadMessage(payload, '重试失败'), error: !response.ok })
    if (response.ok) window.dispatchEvent(new Event('admin-refresh'))
  }
  return <section className="panel"><PanelTitle title="生图任务" action={loading ? '加载中' : `共 ${data.generations.length} 条`} /><GenerationTable generations={data.generations} onRetry={retry} />{message && <div className={message.error ? 'form-error' : 'form-message'}>{message.text}</div>}{!loading && !data.generations.length && <Empty text="暂无生图任务" />}</section>
}
function GenerationTable({ generations, onRetry }: { generations: Generation[]; onRetry?: (id: string) => void }) {
  const status: Record<string, string> = { succeeded: '成功', failed: '失败', uncertain: '待核查', processing: '处理中' }
  return <table><thead><tr><th>任务 ID</th><th>模式</th><th>状态</th><th>尝试</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{generations.map((job) => <tr key={job.id}><td className="mono">{job.id}</td><td>{job.mode === 'agent' ? 'Agent' : '经典风格'}</td><td><span className={`status-pill ${job.status === 'succeeded' ? 'success' : job.status === 'processing' ? 'pending' : job.status === 'failed' || job.status === 'uncertain' ? 'failed' : 'neutral'}`}>{status[job.status] ?? job.status}</span>{job.errorCode && <small className="table-subtitle">{job.errorCode}</small>}</td><td>{job.attempts}</td><td>{formatDate(job.createdAt)}</td><td>{onRetry && ['failed', 'uncertain'].includes(job.status) && job.attempts < 2 && <button className="text-btn" onClick={() => void onRetry(job.id)}>重试</button>}</td></tr>)}</tbody></table>
}
function Entitlements() {
  const { data, loading } = useAdminData<{ entitlements: Array<{ id: string; sessionId: string; status: string; maxStyles: number; generationId?: string; expiresAt: string; createdAt: string }> }>('/api/admin/entitlements', { entitlements: [] })
  return <section className="panel"><PanelTitle title="体验权益" action={loading ? '加载中' : `共 ${data.entitlements.length} 条`} /><table><thead><tr><th>权益 ID</th><th>会话</th><th>状态</th><th>风格上限</th><th>生图任务</th><th>过期时间</th><th>创建时间</th></tr></thead><tbody>{data.entitlements.map((item) => <tr key={item.id}><td className="mono">{item.id}</td><td className="mono">{item.sessionId}</td><td><span className={`status-pill ${item.status === 'active' ? 'success' : item.status === 'expired' ? 'failed' : 'neutral'}`}>{item.status}</span></td><td>{item.maxStyles}</td><td className="mono">{item.generationId ?? '—'}</td><td>{formatDate(item.expiresAt)}</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table>{!loading && !data.entitlements.length && <Empty text="暂无体验权益" />}</section>
}

type AdminStyle = { id?: number; styleId: string; version: number; name: string; subtitle: string; description: string; prompt: string; mode: string; enabled: boolean; sortOrder: number; status: string; motif?: string; paletteJson?: string; previewPath?: string; previewUrl?: string }
const blankStyle = { styleId: '', name: '', subtitle: '', description: '', prompt: '', mode: 'realistic', motif: '', palette: '#35574a,#c8a96b,#edf1e8', sortOrder: '0', previewPath: '', enabled: true }
function Styles({ role }: { role: Role }) {
  const { data, loading } = useAdminData<{ styles: AdminStyle[] }>('/api/admin/styles', { styles: [] })
  const [form, setForm] = useState(blankStyle); const [editing, setEditing] = useState<AdminStyle | null>(null); const [editorOpen, setEditorOpen] = useState(false); const [message, setMessage] = useState<MessageState | null>(null); const [uploading, setUploading] = useState(false); const [busy, setBusy] = useState(false)
  const update = (key: keyof typeof blankStyle, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }))
  const openEdit = (item: AdminStyle) => { let palette = blankStyle.palette; try { const parsed = JSON.parse(item.paletteJson ?? ''); if (Array.isArray(parsed) && parsed.length === 3) palette = parsed.join(',') } catch { /* legacy row */ } setEditing(item); setForm({ styleId: item.styleId, name: item.name, subtitle: item.subtitle, description: item.description, prompt: item.prompt, mode: item.mode, motif: item.motif ?? '', palette, sortOrder: String(item.sortOrder), previewPath: item.previewPath ?? '', enabled: Boolean(item.enabled) }); setMessage(null) }
  const save = async () => { setBusy(true); const body = { ...form, version: editing?.version, sortOrder: Number(form.sortOrder), palette: form.palette.split(',').map((item) => item.trim()) }; const response = await adminRequest(editing ? `/api/admin/styles/${editing.styleId}` : '/api/admin/styles', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const payload = await readPayload(response); setMessage({ text: response.ok ? '风格草稿已保存' : payloadMessage(payload, '保存失败'), error: !response.ok }); if (response.ok) { setEditing(null); setForm(blankStyle); setEditorOpen(false); window.dispatchEvent(new Event('admin-refresh')) } setBusy(false) }
  const upload = async (file: File) => { setUploading(true); const response = await adminRequest('/api/admin/style-assets', { method: 'POST', headers: { 'Content-Type': file.type }, body: file }); const payload = await readPayload(response); setMessage({ text: response.ok ? '图片已上传' : payloadMessage(payload, '上传失败'), error: !response.ok }); if (response.ok) update('previewPath', String(payload.path)); setUploading(false) }
  const publish = async (item: AdminStyle) => { const response = await adminRequest(`/api/admin/styles/${item.styleId}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: item.version }) }); const payload = await readPayload(response); setMessage({ text: response.ok ? '风格已发布' : payloadMessage(payload, '发布失败'), error: !response.ok }); if (response.ok) window.dispatchEvent(new Event('admin-refresh')) }
  const archive = async (item: AdminStyle) => { if (!window.confirm(`确认停用 ${item.name}？`)) return; const response = await adminRequest(`/api/admin/styles/${item.styleId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: '后台停用' }) }); if (!response.ok) setMessage({ text: '停用失败', error: true }); else window.dispatchEvent(new Event('admin-refresh')) }
  return <section className="panel styles-panel"><div className="style-toolbar"><div><h2>风格配置</h2><p>维护游客端可用的风格版本。</p></div><button className="primary-btn" onClick={() => { setEditing(null); setForm(blankStyle); setMessage(null); setEditorOpen(true) }}><Plus size={16} />新建风格</button></div><table><thead><tr><th>预览</th><th>ID</th><th>版本</th><th>名称</th><th>模式</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.styles.map((item) => <tr key={`${item.styleId}-${item.version}`}><td>{item.previewUrl ? <img className="style-thumb" src={item.previewUrl} alt="" /> : '—'}</td><td className="mono">{item.styleId}</td><td>v{item.version}</td><td><b>{item.name}</b><small className="table-subtitle">{item.subtitle}</small></td><td>{item.mode === 'artistic' ? '艺术' : '写实'}</td><td><span className={`status-pill ${item.status === 'published' ? 'success' : item.status === 'draft' ? 'pending' : 'neutral'}`}>{item.status === 'published' ? '已发布' : item.status === 'draft' ? '草稿' : '已停用'}</span></td><td className="row-actions"><button className="text-btn" onClick={() => { openEdit(item); setEditorOpen(true) }}>编辑</button>{role === 'owner' && item.status !== 'published' && <button className="text-btn" onClick={() => void publish(item)}>发布</button>}{role === 'owner' && item.status === 'published' && <button className="text-btn danger-btn" onClick={() => void archive(item)}>停用</button>}</td></tr>)}</tbody></table>{!loading && !data.styles.length && <Empty text="暂无风格版本" />}{editorOpen && <StyleEditor form={form} editing={editing} update={update} save={save} upload={upload} uploading={uploading} busy={busy} close={() => { setEditing(null); setForm(blankStyle); setEditorOpen(false) }} message={message} />}</section>
}
function StyleEditor({ form, editing, update, save, upload, uploading, busy, close, message }: { form: typeof blankStyle; editing: AdminStyle | null; update: (key: keyof typeof blankStyle, value: string | boolean) => void; save: () => Promise<void>; upload: (file: File) => Promise<void>; uploading: boolean; busy: boolean; close: () => void; message: MessageState | null }) {
  return <div className="style-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><div className="style-modal" role="dialog" aria-modal="true"><div className="style-modal-head"><div><h2>{editing ? '编辑风格草稿' : '新建风格草稿'}</h2><p>保存后由老板发布到游客端。</p></div><button className="icon-btn" title="关闭" onClick={close}><X size={18} /></button></div><div className="config-form style-editor"><label>风格 ID<input disabled={Boolean(editing)} value={form.styleId} onChange={(event) => update('styleId', event.target.value)} /></label><label>名称<input value={form.name} onChange={(event) => update('name', event.target.value)} /></label><label>副标题<input value={form.subtitle} onChange={(event) => update('subtitle', event.target.value)} /></label><label>模式<select value={form.mode} onChange={(event) => update('mode', event.target.value)}><option value="realistic">写实</option><option value="artistic">艺术</option></select></label><label>标识字符<input value={form.motif} onChange={(event) => update('motif', event.target.value)} /></label><label>排序<input type="number" min="0" value={form.sortOrder} onChange={(event) => update('sortOrder', event.target.value)} /></label><label className="wide-field">描述<textarea value={form.description} onChange={(event) => update('description', event.target.value)} /></label><label className="wide-field">生图提示词<textarea value={form.prompt} onChange={(event) => update('prompt', event.target.value)} /></label><label className="wide-field">调色板<input value={form.palette} onChange={(event) => update('palette', event.target.value)} /></label><label className="checkbox-label"><input type="checkbox" checked={form.enabled} onChange={(event) => update('enabled', event.target.checked)} />启用</label><div className="wide-field style-upload"><span className="style-upload-label"><ImagePlus size={15} />预览图片</span><input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = '' }} />{form.previewPath && <img className="style-upload-preview" src={form.previewPath.startsWith('data:') ? form.previewPath : `/api/admin/style-assets/${form.previewPath.split('/').pop()?.split('.')[0]}`} alt="" />}</div><div className="editor-actions"><button className="primary-btn" disabled={busy || uploading} onClick={() => void save()}>{busy ? '保存中…' : '保存草稿'}</button><button className="secondary-cta" onClick={close}>取消</button>{message && <span className={message.error ? 'form-error' : 'form-message'}>{message.text}</span>}</div></div></div></div>
}

type AdminBackground = { id?: number; backgroundId: string; version: number; name: string; subtitle: string; description: string; poseHint: string; imagePath: string; analysisPrompt?: string; analysisStatus: string; status: string; previewUrl?: string; sortOrder: number; enabled: boolean }
const blankBackground = { backgroundId: '', name: '', subtitle: '', description: '', poseHint: '', imagePath: '', sortOrder: '0', enabled: true }
function Backgrounds({ role }: { role: Role }) {
  const { data, loading } = useAdminData<{ backgrounds: AdminBackground[] }>('/api/admin/backgrounds', { backgrounds: [] })
  const [form, setForm] = useState(blankBackground); const [editing, setEditing] = useState<AdminBackground | null>(null); const [editorOpen, setEditorOpen] = useState(false); const [message, setMessage] = useState<MessageState | null>(null); const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false)
  const update = (key: keyof typeof blankBackground, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }))
  const openEdit = (item: AdminBackground) => { setEditing(item); setForm({ backgroundId: item.backgroundId, name: item.name, subtitle: item.subtitle, description: item.description, poseHint: item.poseHint, imagePath: item.imagePath, sortOrder: String(item.sortOrder), enabled: Boolean(item.enabled) }); setMessage(null); setEditorOpen(true) }
  const upload = async (file: File) => { setUploading(true); const response = await adminRequest('/api/admin/background-assets', { method: 'POST', headers: { 'Content-Type': file.type }, body: file }); const payload = await readPayload(response); setMessage({ text: response.ok ? '图片已上传' : payloadMessage(payload, '上传失败'), error: !response.ok }); if (response.ok) update('imagePath', String(payload.path)); setUploading(false) }
  const save = async () => { setBusy(true); const body = { ...form, version: editing?.version, sortOrder: Number(form.sortOrder) }; const response = await adminRequest(editing ? `/api/admin/backgrounds/${editing.backgroundId}` : '/api/admin/backgrounds', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const payload = await readPayload(response); setMessage({ text: response.ok ? '背景草稿已保存' : payloadMessage(payload, '保存失败'), error: !response.ok }); if (response.ok) { setEditing(null); setForm(blankBackground); setEditorOpen(false); window.dispatchEvent(new Event('admin-refresh')) } setBusy(false) }
  const analyze = async (item: AdminBackground) => { setBusy(true); const response = await adminRequest(`/api/admin/backgrounds/${item.backgroundId}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: item.version }) }); const payload = await readPayload(response); setMessage({ text: response.ok ? '视觉理解已完成' : payloadMessage(payload, '分析失败'), error: !response.ok }); if (response.ok) window.dispatchEvent(new Event('admin-refresh')); setBusy(false) }
  const publish = async (item: AdminBackground) => { const response = await adminRequest(`/api/admin/backgrounds/${item.backgroundId}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: item.version }) }); const payload = await readPayload(response); setMessage({ text: response.ok ? '背景已发布' : payloadMessage(payload, '发布失败'), error: !response.ok }); if (response.ok) window.dispatchEvent(new Event('admin-refresh')) }
  return <section className="panel styles-panel"><div className="style-toolbar"><div><h2>Agent 背景素材</h2><p>背景完成分析并发布后才会进入游客目录。</p></div><button className="primary-btn" onClick={() => { setEditing(null); setForm(blankBackground); setMessage(null); setEditorOpen(true) }}><Plus size={16} />新建背景</button></div><table><thead><tr><th>预览</th><th>ID</th><th>版本</th><th>名称</th><th>分析</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.backgrounds.map((item) => <tr key={`${item.backgroundId}-${item.version}`}><td>{item.previewUrl ? <img className="style-thumb" src={item.previewUrl} alt="" /> : '—'}</td><td className="mono">{item.backgroundId}</td><td>v{item.version}</td><td><b>{item.name}</b><small className="table-subtitle">{item.subtitle}</small></td><td><span className={`status-pill ${item.analysisStatus === 'ready' ? 'success' : item.analysisStatus === 'failed' ? 'failed' : 'pending'}`}>{item.analysisStatus === 'ready' ? '已完成' : item.analysisStatus === 'failed' ? '失败' : '待分析'}</span></td><td><span className={`status-pill ${item.status === 'published' ? 'success' : item.status === 'draft' ? 'pending' : 'neutral'}`}>{item.status === 'published' ? '已发布' : item.status === 'draft' ? '草稿' : '已停用'}</span></td><td className="row-actions"><button className="text-btn" onClick={() => openEdit(item)}>编辑</button>{item.status === 'draft' && <button className="text-btn" disabled={busy} onClick={() => void analyze(item)}>分析</button>}{role === 'owner' && item.status === 'draft' && item.analysisStatus === 'ready' && <button className="text-btn" onClick={() => void publish(item)}>发布</button>}</td></tr>)}</tbody></table>{!loading && !data.backgrounds.length && <Empty text="暂无背景素材" />}{editorOpen && <BackgroundEditor form={form} editing={editing} update={update} upload={upload} save={save} uploading={uploading} busy={busy} close={() => { setEditing(null); setForm(blankBackground); setEditorOpen(false) }} message={message} />}</section>
}
function BackgroundEditor({ form, editing, update, upload, save, uploading, busy, close, message }: { form: typeof blankBackground; editing: AdminBackground | null; update: (key: keyof typeof blankBackground, value: string | boolean) => void; upload: (file: File) => Promise<void>; save: () => Promise<void>; uploading: boolean; busy: boolean; close: () => void; message: MessageState | null }) {
  return <div className="style-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><div className="style-modal" role="dialog" aria-modal="true"><div className="style-modal-head"><div><h2>{editing ? '编辑背景草稿' : '新建背景草稿'}</h2><p>上传背景、填写动作提示并保存。</p></div><button className="icon-btn" title="关闭" onClick={close}><X size={18} /></button></div><div className="config-form style-editor"><label>背景 ID<input disabled={Boolean(editing)} value={form.backgroundId} onChange={(event) => update('backgroundId', event.target.value)} /></label><label>名称<input value={form.name} onChange={(event) => update('name', event.target.value)} /></label><label>副标题<input value={form.subtitle} onChange={(event) => update('subtitle', event.target.value)} /></label><label>排序<input type="number" min="0" value={form.sortOrder} onChange={(event) => update('sortOrder', event.target.value)} /></label><label className="wide-field">描述<textarea value={form.description} onChange={(event) => update('description', event.target.value)} /></label><label className="wide-field">动作提示<textarea value={form.poseHint} onChange={(event) => update('poseHint', event.target.value)} /></label><label className="checkbox-label"><input type="checkbox" checked={form.enabled} onChange={(event) => update('enabled', event.target.checked)} />启用</label><div className="wide-field style-upload"><span className="style-upload-label"><ImagePlus size={15} />背景图片</span><input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = '' }} />{form.imagePath && <img className="style-upload-preview" src={`/api/admin/background-assets/${form.imagePath.split('/').pop()?.split('.')[0]}`} alt="" />}</div><div className="editor-actions"><button className="primary-btn" disabled={busy || uploading} onClick={() => void save()}>{busy ? '保存中…' : '保存草稿'}</button><button className="secondary-cta" onClick={close}>取消</button>{message && <span className={message.error ? 'form-error' : 'form-message'}>{message.text}</span>}</div></div></div></div>
}

type ModelConfig = { id: string; name: string; provider: string; baseUrl: string; endpoint: string; modelName: string; apiKey: string; timeoutMs: number; maxAttempts?: number | null; failureThreshold?: number | null; cooldownSeconds?: number | null; extraConfig?: Record<string, unknown>; enabled: boolean; isDefault: boolean }
type ModelForm = { name: string; provider: string; baseUrl: string; endpoint: string; generationEndpoint: string; size: string; modelName: string; apiKey: string; timeoutMs: string; maxAttempts: string; failureThreshold: string; cooldownSeconds: string; enabled: boolean; isDefault: boolean }
const blankModel = (imageMode: boolean): ModelForm => ({ name: '', provider: 'gpt-image-2', baseUrl: '', endpoint: imageMode ? '/images/edits' : '/chat/completions', generationEndpoint: '/images/generations', size: '2K', modelName: '', apiKey: '', timeoutMs: imageMode ? '300000' : '60000', maxAttempts: '', failureThreshold: '', cooldownSeconds: '', enabled: true, isDefault: true })
// 供应商名即数据库里的 provider 列。当前产品只适配 gpt-image-2：填实现名会选中它，
// 填任意店名（deepcoding、NewAPI 等）同样按 OpenAI 兼容协议走 gpt-image-2。
// 其余实现仍留在代码里以备将来使用，但这里不提供，避免运维以为切换了厂商。
const PROVIDER_KEY_OPTIONS = [
  { value: 'gpt-image-2', label: 'OpenAI 兼容 · 经典模式走 /images/edits（当前唯一适配）' },
  { value: 'mock', label: 'Mock（仅本地调试）' },
]
// 留空即使用代码默认值。超时、重试与熔断共同决定一条线路的耗时上限：
// 单线路最坏耗时约为「重试次数 × 超时」，必须留在前端 660s 请求预算之内。
const RESILIENCE_DEFAULTS = { maxAttempts: 3, failureThreshold: 1, cooldownSeconds: 60 }
// 空输入表示「不写库、用代码默认值」，所以不能直接 Number('') = 0。
const optionalNumber = (value: string): number | null => value.trim() ? Number(value) : null
const optionalNumberText = (value: number | null | undefined): string => value == null ? '' : String(value)
function ModelConfigs({ role, modelType }: { role: Role; modelType: 'vision_analysis' | 'image_generation' }) {
  const imageMode = modelType === 'image_generation'
  const title = imageMode ? '图片生成模型' : '视觉分析模型'
  const { data, loading } = useAdminData<{ modelConfigs: ModelConfig[] }>(`/api/admin/model-configs?model_type=${modelType}`, { modelConfigs: [] })
  const [form, setForm] = useState(() => blankModel(imageMode))
  const [editing, setEditing] = useState<ModelConfig | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [message, setMessage] = useState<MessageState | null>(null)
  const [busy, setBusy] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const update = (key: keyof ModelForm, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }))
  const openCreate = () => { setEditing(null); setForm(blankModel(imageMode)); setModels([]); setMessage(null); setEditorOpen(true) }
  const closeEditor = () => { setEditing(null); setForm(blankModel(imageMode)); setModels([]); setMessage(null); setEditorOpen(false) }
  const discover = async () => {
    setBusy(true)
    const response = await adminRequest('/api/admin/model-configs/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelType, baseUrl: form.baseUrl, apiKey: form.apiKey, timeoutMs: Number(form.timeoutMs) }) })
    const payload = await readPayload(response)
    setMessage({ text: response.ok ? `获取到 ${(payload.models as string[]).length} 个可用模型` : payloadMessage(payload, '获取模型失败'), error: !response.ok })
    if (response.ok) setModels((payload.models as string[]) ?? [])
    setBusy(false)
  }
  const save = async () => {
    setBusy(true)
    const body = { name: form.name, modelType, provider: form.provider, baseUrl: form.baseUrl, endpoint: form.endpoint, modelName: form.modelName, apiKey: form.apiKey, timeoutMs: Number(form.timeoutMs), maxAttempts: imageMode ? optionalNumber(form.maxAttempts) : null, failureThreshold: imageMode ? optionalNumber(form.failureThreshold) : null, cooldownSeconds: imageMode ? optionalNumber(form.cooldownSeconds) : null, extraConfig: imageMode ? { generationEndpoint: form.generationEndpoint, size: form.size, responseFormat: 'b64_json' } : undefined, enabled: form.enabled, isDefault: form.isDefault }
    const response = await adminRequest(editing ? `/api/admin/model-configs/${editing.id}` : '/api/admin/model-configs', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const payload = await readPayload(response)
    setMessage({ text: response.ok ? `${title}配置已保存` : payloadMessage(payload, '保存失败'), error: !response.ok })
    if (response.ok) { closeEditor(); window.dispatchEvent(new Event('admin-refresh')) }
    setBusy(false)
  }
  const edit = (item: ModelConfig) => { const extra = item.extraConfig ?? {}; setEditing(item); setForm({ name: item.name, provider: item.provider, baseUrl: item.baseUrl, endpoint: item.endpoint, generationEndpoint: String(extra.generationEndpoint ?? '/images/generations'), size: String(extra.size ?? '2K'), modelName: item.modelName, apiKey: item.apiKey, timeoutMs: String(item.timeoutMs), maxAttempts: optionalNumberText(item.maxAttempts), failureThreshold: optionalNumberText(item.failureThreshold), cooldownSeconds: optionalNumberText(item.cooldownSeconds), enabled: item.enabled, isDefault: item.isDefault }); setModels([item.modelName]); setMessage(null); setEditorOpen(true) }
  const action = async (path: string, success: string, actionId?: string) => {
    setBusy(true)
    if (actionId) setTestingId(actionId)
    try {
      const response = await adminRequest(path, { method: 'POST' })
      const payload = await readPayload(response)
      const text = response.ok
        ? success
        : payloadMessage(payload, '操作失败')
      setMessage({ text, error: !response.ok })
      if (response.ok) window.dispatchEvent(new Event('admin-refresh'))
    } catch {
      setMessage({ text: '请求失败，请检查 API 服务是否正常', error: true })
    } finally {
      setBusy(false)
      if (actionId) setTestingId(null)
    }
  }
  return <section className="panel model-config-panel">
    <div className="style-toolbar"><div><h2>{title}</h2><p>{imageMode ? '经典风格生图和 Agent 背景合成共用此配置，结果固定使用 b64_json。' : '仅用于 Agent 背景视觉理解，配置保存到数据库。'}</p></div><button className="primary-btn" onClick={openCreate}><Plus size={16} />新增配置</button></div>
    {message && <div className={message.error ? 'form-error model-config-feedback' : 'form-message model-config-feedback'} role="status">{message.text}</div>}
    <table><thead><tr><th>名称</th><th>供应商</th><th>模型</th><th>地址</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.modelConfigs.map((item) => <tr key={item.id}><td><b>{item.name}</b>{item.isDefault && <small className="table-subtitle">默认配置</small>}</td><td>{item.provider}</td><td className="mono">{item.modelName}</td><td className="mono">{item.baseUrl}</td><td><span className={`status-pill ${item.enabled ? 'success' : 'neutral'}`}>{item.enabled ? '启用' : '停用'}</span></td><td className="row-actions"><button className="text-btn" onClick={() => edit(item)}>编辑</button><button className="text-btn" disabled={busy} onClick={() => void action(`/api/admin/model-configs/${item.id}/test`, '联通测试成功', item.id)}>{testingId === item.id ? '测试中…' : '测试联通'}</button>{item.enabled && !item.isDefault && <button className="text-btn" disabled={busy} onClick={() => void action(`/api/admin/model-configs/${item.id}/default`, '已设为默认')}>设为默认</button>}<button className="text-btn" disabled={busy} onClick={() => void action(`/api/admin/model-configs/${item.id}/toggle`, item.enabled ? '已停用' : '已启用')}>{item.enabled ? '停用' : '启用'}</button></td></tr>)}</tbody></table>{!loading && !data.modelConfigs.length && <Empty text={`暂无${title}配置`} />}{role !== 'owner' && <p className="muted">当前账号可以查看和测试配置，只有老板负责切换默认模型。</p>}{editorOpen && <ModelConfigEditor form={form} editing={editing} models={models} update={update} discover={discover} save={save} busy={busy} close={closeEditor} message={message} imageMode={imageMode} />}</section>
}

function ModelConfigEditor({ form, editing, models, update, discover, save, busy, close, message, imageMode }: { form: ModelForm; editing: ModelConfig | null; models: string[]; update: (key: keyof ModelForm, value: string | boolean) => void; discover: () => Promise<void>; save: () => Promise<void>; busy: boolean; close: () => void; message: MessageState | null; imageMode: boolean }) {
  const modelLabel = imageMode ? '图片生成' : '视觉分析'
  return <div className="style-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><div className="style-modal model-config-modal" role="dialog" aria-modal="true" aria-labelledby="model-config-title"><div className="style-modal-head"><div><h2 id="model-config-title">{editing ? `编辑${modelLabel}模型配置` : `新增${modelLabel}模型配置`}</h2><p>{imageMode ? '使用 OpenAI 兼容 Images API，测试只检查模型列表，不产生生图费用。当前只适配 gpt-image-2：供应商名填 gpt-image-2 或任意店名（deepcoding、NewAPI 等）走的都是它。超时、重试次数与熔断参数共同决定一条线路的耗时上限（约为「重试次数 × 超时」），必须留在前端 660 秒请求预算内，否则前端会先超时、备用线路根本轮不到。留空表示使用默认值。' : '使用 OpenAI 兼容接口获取模型并测试联通。'}</p></div><button className="icon-btn" title="关闭" onClick={close}><X size={18} /></button></div><div className="config-form style-editor model-config-form"><label>配置名称<input value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="例如：NewAPI 图片模型" autoFocus /></label><label>供应商<input list="model-provider-keys" value={form.provider} onChange={(event) => update('provider', event.target.value)} placeholder="例如：NewAPI" /><datalist id="model-provider-keys">{PROVIDER_KEY_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</datalist></label><label className="wide-field">接口地址<input value={form.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://example.com/v1" /></label>{imageMode ? <><label>编辑接口路径<input value={form.endpoint} onChange={(event) => update('endpoint', event.target.value)} placeholder="/images/edits" /></label><label>生成接口路径<input value={form.generationEndpoint} onChange={(event) => update('generationEndpoint', event.target.value)} placeholder="/images/generations" /></label><label>图片尺寸<select value={form.size} onChange={(event) => update('size', event.target.value)}><option value="1K">1K</option><option value="2K">2K</option><option value="4K">4K</option></select></label><label>响应格式<input value="b64_json" readOnly /></label></> : <label>接口路径<input value={form.endpoint} onChange={(event) => update('endpoint', event.target.value)} /></label>}<label>请求超时（毫秒）<input type="number" min="1" max="600000" value={form.timeoutMs} onChange={(event) => update('timeoutMs', event.target.value)} /></label>{imageMode && <><label>最大重试次数<input type="number" min="1" max="5" value={form.maxAttempts} onChange={(event) => update('maxAttempts', event.target.value)} placeholder={`默认 ${RESILIENCE_DEFAULTS.maxAttempts}`} /></label><label>熔断阈值<input type="number" min="1" max="20" value={form.failureThreshold} onChange={(event) => update('failureThreshold', event.target.value)} placeholder={`默认 ${RESILIENCE_DEFAULTS.failureThreshold}`} /></label><label>冷却时间（秒）<input type="number" min="1" max="3600" value={form.cooldownSeconds} onChange={(event) => update('cooldownSeconds', event.target.value)} placeholder={`默认 ${RESILIENCE_DEFAULTS.cooldownSeconds}`} /></label></>}<label className="wide-field">API Key<input value={form.apiKey} onChange={(event) => update('apiKey', event.target.value)} placeholder="输入中转站 API Key" /></label><label className="wide-field">模型名称<select value={form.modelName} onChange={(event) => update('modelName', event.target.value)}><option value="">先获取可用模型</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={form.enabled} onChange={(event) => update('enabled', event.target.checked)} />启用</label><label className="checkbox-label"><input type="checkbox" checked={form.isDefault} onChange={(event) => update('isDefault', event.target.checked)} />设为默认</label><div className="editor-actions wide-field"><button className="secondary-cta" disabled={busy} onClick={() => void discover()}><RefreshCw size={15} />获取可用模型</button><button className="primary-btn" disabled={busy} onClick={() => void save()}>{editing ? '更新配置' : '保存配置'}</button><button className="secondary-cta" disabled={busy} onClick={close}>取消</button>{message && <span className={message.error ? 'form-error' : 'form-message'}>{message.text}</span>}</div></div></div></div>
}

function RedeemCodes() {
  const { data, loading } = useAdminData<{ codes: Array<{ id: string; prefix: string; status: string; sessionId?: string; expiresAt?: string; redeemedAt?: string; createdAt: string }> }>('/api/admin/redeem-codes', { codes: [] })
  const [count, setCount] = useState('10'); const [expiry, setExpiry] = useState(''); const [generated, setGenerated] = useState<string[]>([]); const [message, setMessage] = useState<MessageState | null>(null); const [copied, setCopied] = useState(false)
  const generate = async () => { const amount = Number(count); if (!Number.isInteger(amount) || amount < 1 || amount > 500) { setMessage({ text: '生成数量需为 1 到 500', error: true }); return }; const response = await adminRequest('/api/admin/redeem-codes/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: amount, expiresAt: expiry || undefined }) }); const payload = await readPayload(response); setMessage({ text: response.ok ? '兑换码已生成，请立即复制保存' : payloadMessage(payload, '生成失败'), error: !response.ok }); if (response.ok) { setGenerated((payload.codes as Array<{ value: string }>).map((item) => item.value)); window.dispatchEvent(new Event('admin-refresh')) } }
  const copy = async () => { await navigator.clipboard.writeText(generated.join('\n')); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }
  const status: Record<string, string> = { available: '未使用', reserved: '处理中', redeemed: '已兑换', disabled: '已禁用' }
  return <section className="panel"><div className="style-toolbar"><div><h2>兑换码管理</h2><p>由管理员生成，游客在体验页兑换使用。</p></div></div><div className="config-form redeem-code-form"><label>生成数量<input type="number" min="1" max="500" value={count} onChange={(event) => setCount(event.target.value)} /></label><label>过期时间（可选）<input type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value ? new Date(event.target.value).toISOString() : '')} /></label><div className="editor-actions"><button className="primary-btn" onClick={() => void generate()}><KeyRound size={16} />生成兑换码</button>{message && <span className={message.error ? 'form-error' : 'form-message'}>{message.text}</span>}</div></div>{generated.length > 0 && <div className="generated-secrets"><div className="generated-secrets-head"><strong>本次生成结果</strong><button className="copy-btn" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制全部'}</button></div><textarea readOnly value={generated.join('\n')} onFocus={(event) => event.currentTarget.select()} /></div>}<table><thead><tr><th>前缀</th><th>状态</th><th>会话</th><th>过期时间</th><th>兑换时间</th><th>创建时间</th></tr></thead><tbody>{data.codes.map((item) => <tr key={item.id}><td className="mono">{item.prefix}••••</td><td><span className={`status-pill ${item.status === 'redeemed' ? 'success' : item.status === 'available' ? 'pending' : 'neutral'}`}>{status[item.status] ?? item.status}</span></td><td className="mono">{item.sessionId ?? '—'}</td><td>{formatDate(item.expiresAt)}</td><td>{formatDate(item.redeemedAt)}</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table>{!loading && !data.codes.length && <Empty text="暂无兑换码" />}</section>
}
function Health() {
  const { data } = useAdminData<{ checks: Record<string, { status?: string; message?: string; details?: Record<string, unknown> }> }>('/api/admin/health', { checks: {} })
  const labels: Record<string, string> = { api: 'API 服务', aiProvider: '图像生成模型', agentVision: '视觉理解模型', mysql: '数据库', storage: '文件存储', queue: '任务记录' }
  return <section className="health-grid">{Object.entries(labels).map(([key, label]) => { const item = data.checks[key]; const status = item?.status ?? '—'; return <div className="health-card" key={key}><div className="health-top"><span>{label}</span><i className={status === 'ok' ? 'ok' : ''} /></div><strong>{status}</strong><small>{item?.message ?? String(item?.details?.provider ?? '')}</small></div> })}</section>
}
function Audit() {
  const { data, loading } = useAdminData<{ logs: Array<{ id: number; actor: string; action: string; targetType: string; targetId?: string; reason?: string; createdAt: string }> }>('/api/admin/audit-logs', { logs: [] })
  return <section className="panel"><PanelTitle title="审计日志" action={loading ? '加载中' : `共 ${data.logs.length} 条`} /><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>原因</th></tr></thead><tbody>{data.logs.map((log) => <tr key={log.id}><td>{formatDate(log.createdAt)}</td><td>{log.actor}</td><td className="mono">{log.action}</td><td>{log.targetType} / {log.targetId ?? '—'}</td><td className="muted">{log.reason ?? '—'}</td></tr>)}</tbody></table>{!loading && !data.logs.length && <Empty text="暂无审计记录" />}</section>
}

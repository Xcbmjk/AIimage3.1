import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Bot, Camera, Check, ChevronLeft, Clock3, FileText, KeyRound, Maximize2, RefreshCw, ScanLine, ShieldCheck, Sparkles, Upload, Wand2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { brand } from '../../config/brand'
import { productConfig } from '../../config/product'
import { demoPhoto, stylePresets } from '../../mocks/fixtures/styles'
import { services } from '../../services'
import { createUuid } from '../../lib/uuid'
import type { BackgroundPreset, StylePreset } from '../../types'
import { useSession } from '../session/SessionProvider'

function BrandMark({ light = false }: { light?: boolean }) {
  return (
    <div className={`brand-mark ${light ? 'brand-mark--light' : ''}`}>
      <img src={brand.logoUrl} alt="杭州像素跃迁科技有限公司 Logo" className="brand-logo-img" />
      <div><strong>{brand.name}</strong><span>{brand.englishName}</span></div>
    </div>
  )
}

function ScenicBackdrop() {
  return (
    <div className="scenic-backdrop" aria-hidden="true">
      {brand.bgImageUrl && (
        <img
          src={brand.bgImageUrl}
          alt=""
          className="scenic-backdrop-img"
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
      )}
      <div className="sun-disc" />
      <div className="mountain mountain--far" />
      <div className="mountain mountain--near" />
      <div className="mist mist--one" />
      <div className="mist mist--two" />
      <div className="dust-particle" style={{ left: '20%', top: '65%', animationDelay: '0s' }} />
      <div className="dust-particle" style={{ left: '45%', top: '50%', animationDelay: '2s' }} />
      <div className="dust-particle" style={{ left: '75%', top: '70%', animationDelay: '4s' }} />
      <div className="dust-particle" style={{ left: '85%', top: '40%', animationDelay: '1.5s' }} />
      <div className="branch" />
    </div>
  )
}

function StepHeader({ step, title, back }: { step: string; title: string; back?: () => void }) {
  return (
    <header className="step-header">
      {back ? <button className="icon-button" onClick={back} aria-label="返回"><ChevronLeft /></button> : <div className="icon-spacer" />}
      <div><span>{step}</span><h2>{title}</h2></div>
      <BrandMark />
    </header>
  )
}

function WelcomePage() {
  const { dispatch } = useSession()
  return (
    <main className="screen welcome-screen">
      <ScenicBackdrop />
      <div className="welcome-top"><BrandMark light /></div>
      <section className="welcome-copy">
        <span className="eyebrow">AI SCENIC PORTRAIT EXPERIENCE</span>
        <h1><em>山水入梦</em><br />此刻入画</h1>
        <p>{brand.welcomeCopy}</p>
      </section>
      <section className="welcome-action">
        <button className="primary-cta primary-cta--light" onClick={() => dispatch({ type: 'GO', stage: 'redeem' })}>
          <span><KeyRound size={30} /> 输入兑换码开始</span><small>兑换成功后即可拍摄并生成作品</small>
        </button>
        <p className="redeem-note redeem-note--welcome">仅限后台生成的兑换码，每个兑换码只能使用一次</p>
        <div className="trust-row"><span><ShieldCheck /> 隐私保护</span><span><Clock3 /> 即拍即取</span><span><ScanLine /> 微信扫码保存</span></div>
      </section>
      <footer className="welcome-footer">{brand.tagline}<span>体验编号 · HX 2026</span></footer>
    </main>
  )
}

function RedeemPage() {
  const { state, dispatch } = useSession()
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = code.trim()
    if (!normalized) { setError('请输入兑换码'); return }
    setSubmitting(true)
    setError('')
    try {
      const result = await services.entitlement.consume(normalized, state.id)
      dispatch({ type: 'REDEEMED', entitlement: result.entitlement, token: result.accessToken })
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '兑换失败，请检查兑换码后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="screen paper-screen redeem-screen">
      <StepHeader step="01 / 05" title="兑换体验" back={() => dispatch({ type: 'GO', stage: 'welcome' })} />
      <section className="redeem-panel">
        <span className="eyebrow eyebrow--dark">UNLOCK YOUR EXPERIENCE</span>
        <h1>输入兑换码</h1>
        <p>兑换成功后即可拍摄并生成山水肖像。</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="redeem-code">兑换码</label>
          <input id="redeem-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="请输入兑换码" autoFocus autoComplete="off" spellCheck={false} aria-invalid={Boolean(error)} />
          {error && <div className="redeem-error" role="alert">{error}</div>}
          <button className="primary-cta redeem-submit" type="submit" disabled={submitting}>{submitting ? <><RefreshCw className="spin" /> 正在验证</> : <><KeyRound /> 兑换并开始</>}</button>
        </form>
        <small className="redeem-note">每个兑换码仅限使用一次，请妥善保管。</small>
      </section>
    </main>
  )
}

function CameraPage() {
  const { dispatch } = useSession()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [status, setStatus] = useState<'starting' | 'ready' | 'fallback'>('starting')
  const [cameraError, setCameraError] = useState('')
  const [countdown, setCountdown] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    void services.camera.start(video).then((stream) => {
      streamRef.current = stream
      setStatus('ready')
    }).catch((error) => { setCameraError(error instanceof Error ? error.message : '摄像头不可用，将使用示例照片'); setStatus('fallback') })
    return () => services.camera.stop(streamRef.current)
  }, [])

  const takePhoto = () => {
    if (status === 'fallback') {
      dispatch({ type: 'PHOTO_SET', photo: { url: demoPhoto, source: 'demo' } })
      return
    }
    setCountdown(3)
  }

  const uploadPhoto = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setCameraError('仅支持 JPG、PNG 或 WebP 图片'); return }
    if (file.size > 10 * 1024 * 1024) { setCameraError('图片不能超过 10 MB'); return }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') dispatch({ type: 'PHOTO_SET', photo: { url: reader.result, source: 'camera' } })
    }
    reader.readAsDataURL(file)
    event.target.value = ''
  }

  useEffect(() => {
    if (countdown === null) return
    if (countdown === 0) {
      const timer = window.setTimeout(() => {
        const video = videoRef.current
        if (video) dispatch({ type: 'PHOTO_SET', photo: services.camera.capture(video) })
      }, 180)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => setCountdown((value) => (value ?? 1) - 1), 700)
    return () => window.clearTimeout(timer)
  }, [countdown, dispatch])

  return (
    <main className="screen camera-screen">
      <div className="camera-top"><button className="icon-button icon-button--dark" onClick={() => dispatch({ type: 'GO', stage: 'welcome' })}><ChevronLeft /></button><BrandMark light /><span className="step-pill">02 / 05</span></div>
      <section className="camera-intro"><span className="eyebrow">LOOK INTO THE LENS</span><h1>请看向镜头</h1><p>兑换成功 · 现在可以开始拍摄</p></section>
      <div className="viewfinder">
        <video ref={videoRef} muted playsInline />
        {status !== 'ready' && <img src={demoPhoto} alt="演示取景画面" />}
        <div className="frame-corner frame-corner--tl" /><div className="frame-corner frame-corner--tr" /><div className="frame-corner frame-corner--bl" /><div className="frame-corner frame-corner--br" />
        <div className="face-guide" /><div className="camera-hint">{status === 'fallback' ? '演示模式 · 将使用示例照片' : status === 'starting' ? '正在唤醒摄像头…' : '人物居中 · 保持自然'}</div>
        {countdown !== null && <div className="countdown">{countdown || <Sparkles />}</div>}
      </div>
      {cameraError && <div className="camera-error" role="alert">{cameraError}</div>}
      <button className="shutter" onClick={takePhoto} disabled={status === 'starting'}><span><Camera /></span><b>{status === 'fallback' ? '使用示例照片' : '拍摄照片'}</b></button>
      <input ref={fileInputRef} className="photo-upload-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadPhoto} />
      <button className="upload-test-button" onClick={() => fileInputRef.current?.click()}><Upload /> 上传图片测试</button>
      <p className="privacy-line"><ShieldCheck /> {brand.privacy}</p>
    </main>
  )
}

function ReviewPage() {
  const { state, dispatch } = useSession()
  return (
    <main className="screen paper-screen">
      <StepHeader step="02 / 05" title="确认照片" back={() => dispatch({ type: 'GO', stage: 'camera' })} />
      <section className="review-layout">
        <div className="portrait-frame"><img src={state.photo?.url} alt="刚刚拍摄的照片" /><div className="portrait-label">此刻 · 山中</div></div>
        <div className="review-copy"><span className="eyebrow eyebrow--dark">YOUR PORTRAIT</span><h1>这一张，可以吗？</h1><p>接下来选择创作方式：经典风格或 Agent 智能生图。</p></div>
        <div className="dual-actions"><button className="secondary-cta" onClick={() => dispatch({ type: 'GO', stage: 'camera' })}><RefreshCw /> 重新拍摄</button><button className="primary-cta" onClick={() => dispatch({ type: 'GO', stage: 'mode' })}><Check /> 使用这张</button></div>
      </section>
    </main>
  )
}

function ModePage({ agentEnabled }: { agentEnabled: boolean }) {
  const { dispatch } = useSession()
  return (
    <main className="screen paper-screen mode-screen">
      <StepHeader step="03 / 05" title="选择创作方式" back={() => dispatch({ type: 'GO', stage: 'review' })} />
      <section className="styles-intro"><span className="eyebrow eyebrow--dark">CHOOSE A CREATION MODE</span><h1>想用哪种方式入画？</h1><p>经典风格沿用固定山水模板；Agent 模式由视觉模型分析背景动作并实时生成融合提示词。</p></section>
      <div className="mode-grid">
        <button className="mode-card" onClick={() => dispatch({ type: 'SELECT_MODE', mode: 'classic' })}>
          <span className="mode-card__icon"><Wand2 /></span>
          <div className="mode-card__body"><small>CLASSIC</small><h3>经典风格</h3><p>从预设山水风格中选择，保留原始背景与构图，最多生成 4 张作品。</p><b className="mode-card__cta">去选择风格 <ArrowRight size={16} /></b></div>
        </button>
        {agentEnabled && (
          <button className="mode-card mode-card--agent" onClick={() => dispatch({ type: 'SELECT_MODE', mode: 'agent' })}>
            <span className="mode-card__icon"><Bot /></span>
            <div className="mode-card__body"><small>AGENT · 测试</small><h3>Agent 智能生图</h3><p>挑选一张含人物动作的背景，AI 分析动作并实时生成融合提示词，合成单张作品。</p><b className="mode-card__cta">开始智能创作 <ArrowRight size={16} /></b></div>
          </button>
        )}
      </div>
    </main>
  )
}

function StyleCard({ style, selected, onClick }: { style: StylePreset; selected: boolean; onClick: () => void }) {
  return (
    <button className={`style-card ${selected ? 'style-card--selected' : ''}`} onClick={onClick}>
      <img src={style.resultImage} alt={`${style.name}效果预览`} />
      <div className="style-wash" />
      <span className="style-motif">{style.motif}</span>
      <div className="style-info"><small>{style.subtitle}</small><h3>{style.name}</h3><p>{style.description}</p><div className="palette">{style.palette.map((color) => <i key={color} style={{ background: color }} />)}</div></div>
      <span className="selection-mark">{selected ? <Check size={26} /> : '+'}</span>
    </button>
  )
}

function StylesPage({ styles }: { styles: StylePreset[] }) {
  const { state, dispatch } = useSession()
  const maxStyles = state.entitlement?.maxStyles ?? productConfig.maxStylesDefault
  const generatingRef = useRef(false)

  const generate = () => {
    if (generatingRef.current || !state.photo || !state.selectedStyleIds.length) return
    generatingRef.current = true
    const selectedStyles = styles.filter((style) => state.selectedStyleIds.includes(style.id))
    if (!state.entitlementToken) return
    const generationId = state.generationId ?? createUuid()
    dispatch({ type: 'GENERATION_STARTED', generationId })
    void services.generation.generate(state.id, state.entitlementToken, generationId, state.photo, selectedStyles, (jobs) => dispatch({ type: 'JOBS_UPDATED', jobs })).then((assets) => {
      dispatch({ type: 'GENERATED', assets })
    }).catch((generationError) => {
      const message = generationError instanceof Error ? generationError.message : '生成失败'
      dispatch({ type: 'ERROR', message })
    })
  }

  return (
    <main className="screen paper-screen styles-screen">
      <StepHeader step="03 / 05" title="选择人物风格" back={() => dispatch({ type: 'GO', stage: 'mode' })} />
      <section className="styles-intro"><span className="eyebrow eyebrow--dark">CHOOSE YOUR PORTRAIT STYLE</span><h1>这一张，想成为什么？</h1><p>选择 1–{maxStyles} 种风格，只改变人物的画面表达，保留原始背景与构图。</p></section>
      <div className="style-grid">{styles.map((style) => <StyleCard key={style.id} style={style} selected={state.selectedStyleIds.includes(style.id)} onClick={() => dispatch({ type: 'TOGGLE_STYLE', styleId: style.id, maxStyles })} />)}</div>
      <div className="sticky-action"><div><span>已选择 <b>{state.selectedStyleIds.length}</b> / {maxStyles}</span><small>{state.selectedStyleIds.length === maxStyles ? '已达到本次体验上限' : '还可选择更多风格'}</small></div><button className="primary-cta primary-cta--compact" disabled={!state.selectedStyleIds.length} onClick={generate}><Sparkles /> 开始生成 {state.selectedStyleIds.length ? `${state.selectedStyleIds.length} 张` : ''}</button></div>
    </main>
  )
}

function AgentBackgroundsPage({ backgrounds }: { backgrounds: BackgroundPreset[] }) {
  const { state, dispatch } = useSession()
  const generatingRef = useRef(false)
  const selectedBackground = backgrounds.find((background) => background.id === state.selectedBackgroundId)

  const generate = () => {
    if (generatingRef.current || !state.photo || !state.selectedBackgroundId || !state.entitlementToken) return
    if (!selectedBackground) return
    generatingRef.current = true
    const generationId = state.generationId ?? createUuid()
    dispatch({ type: 'GENERATION_STARTED', generationId })
    void services.agent.generate(state.id, state.entitlementToken, generationId, state.photo, selectedBackground, (jobs) => dispatch({ type: 'JOBS_UPDATED', jobs })).then((result) => {
      dispatch({ type: 'AGENT_GENERATED', assets: result.assets, prompt: result.prompt })
    }).catch((generationError) => {
      generatingRef.current = false
      dispatch({ type: 'ERROR', message: generationError instanceof Error ? generationError.message : 'Agent 生图失败' })
    })
  }

  return (
    <main className="screen paper-screen backgrounds-screen">
      <StepHeader step="03 / 05" title="选择动作背景" back={() => dispatch({ type: 'GO', stage: 'mode' })} />
      <section className="styles-intro"><span className="eyebrow eyebrow--dark">AGENT PORTRAIT COMPOSING</span><h1>挑一个动作入画</h1><p>选择一张含人物动作的背景，AI 将分析其动作并结合你的照片实时生成融合提示词。</p></section>
      <div className="background-grid">{backgrounds.map((background) => (
        <button key={background.id} className={`background-card ${state.selectedBackgroundId === background.id ? 'background-card--selected' : ''}`} onClick={() => dispatch({ type: 'SELECT_BACKGROUND', backgroundId: background.id })}>
          <img src={background.previewImage} alt={`${background.name}动作预览`} />
          <div className="style-wash" />
          <div className="background-info"><small>{background.subtitle}</small><h3>{background.name}</h3><p>{background.description}</p></div>
          <span className="selection-mark">{state.selectedBackgroundId === background.id ? <Check size={26} /> : '+'}</span>
        </button>
      ))}</div>
      <div className="sticky-action"><div><span>{selectedBackground ? `已选背景 · ${selectedBackground.name}` : '请选择一张背景'}</span><small><Bot /> Agent 将实时生成融合提示词</small></div><button className="primary-cta primary-cta--compact" disabled={!state.selectedBackgroundId} onClick={generate}><Sparkles /> 智能生成 1 张</button></div>
    </main>
  )
}

function GeneratingPage({ styles, backgrounds }: { styles: StylePreset[]; backgrounds: BackgroundPreset[] }) {
  const { state, dispatch } = useSession()
  const isAgent = state.generationMode === 'agent'
  const selectedStyles = useMemo(() => styles.filter((style) => state.selectedStyleIds.includes(style.id)), [state.selectedStyleIds, styles])
  const selectedBackground = useMemo(() => backgrounds.find((background) => background.id === state.selectedBackgroundId), [backgrounds, state.selectedBackgroundId])
  const steps = isAgent ? (selectedBackground ? [{ id: selectedBackground.id, name: selectedBackground.name, motif: 'A' }] : []) : selectedStyles.map((style) => ({ id: style.id, name: style.name, motif: style.motif }))

  const overall = state.jobs.length ? Math.round(state.jobs.reduce((sum, job) => sum + job.progress, 0) / state.jobs.length) : 0
  return (
    <main className="screen generating-screen">
      <ScenicBackdrop />
      <div className="generating-brand"><BrandMark light /><span>04 / 05</span></div>
      <section className="generating-copy"><span className="eyebrow">{isAgent ? 'AGENT IS THINKING' : 'AI IS PAINTING'}</span><h1>{isAgent ? <>AI 正在理解<br />动作并落笔</> : <>山河正在<br />为你落笔</>}</h1><p>{isAgent ? '视觉模型正在分析背景动作并实时生成融合提示词，请稍候' : 'AI 正在理解光影与神态，请稍候片刻'}</p><strong className="generation-time-hint"><Clock3 /> 生图预计需要 30-90 秒</strong></section>
      <div className="progress-orbit"><div className="orbit-ring" style={{ '--progress': `${overall * 3.6}deg` } as React.CSSProperties}><div><b>{overall}</b><span>%</span></div></div><Sparkles className="orbit-star" /></div>
      <div className="job-list">{steps.map((step) => { const job = state.jobs.find((item) => item.styleId === step.id); return <div className="job-row" key={step.id}><span className="job-icon">{step.motif}</span><div><b>{step.name}</b><small>{job?.status === 'complete' ? '作品已完成' : job?.status === 'failed' ? '这次没有画完' : job?.status === 'working' ? (isAgent ? '正在合成人物与背景' : '正在渲染光影与细节') : isAgent ? '正在分析动作' : '等待落笔'}</small></div><div className="mini-progress"><i style={{ width: `${job?.progress ?? 0}%` }} /></div>{job?.status === 'complete' ? <Check /> : job?.status === 'failed' ? <AlertCircle /> : <span>{job?.progress ?? 0}%</span>}</div> })}</div>
      {state.error && <div className="generation-error"><b>这次落笔没有完成</b><span>{state.error}</span><button className="secondary-cta" onClick={() => dispatch({ type: 'GO', stage: isAgent ? 'backgrounds' : 'styles' })}><RefreshCw /> 重试生成</button></div>}
      <p className="generation-note">请不要离开 · 完成后将自动展示作品</p>
    </main>
  )
}

function ResultsPage({ styles, backgrounds }: { styles: StylePreset[]; backgrounds: BackgroundPreset[] }) {
  const { state, dispatch } = useSession()
  const [activeIndex, setActiveIndex] = useState(0)
  const [sharing, setSharing] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const isAgent = state.generationMode === 'agent'
  const activeAsset = state.assets[activeIndex]
  const activeStyle = styles.find((style) => style.id === activeAsset?.styleId)
  const activeBackground = backgrounds.find((background) => background.id === activeAsset?.styleId)
  const captionName = isAgent ? (activeBackground?.name ?? 'Agent 作品') : activeStyle?.name
  const captionSubtitle = isAgent ? (activeBackground?.subtitle ?? '智能合成') : activeStyle?.subtitle
  const failedStyles = useMemo(
    () => styles.filter((style) => state.failedStyleIds.includes(style.id)),
    [styles, state.failedStyleIds],
  )

  const retryFailed = async () => {
    if (retrying || !state.entitlementToken || !state.photo || !state.generationId || !failedStyles.length) return
    setRetrying(true)
    try {
      // Same generation id on purpose: the allowance was already spent by the
      // images that landed, so recovering the missing ones must not consume a
      // second entitlement.
      const assets = await services.generation.generate(
        state.id,
        state.entitlementToken,
        state.generationId,
        state.photo,
        failedStyles,
        (jobs) => dispatch({ type: 'JOBS_UPDATED', jobs }),
      )
      dispatch({ type: 'SALVAGE_GENERATED', assets })
    } catch (error) {
      dispatch({ type: 'ERROR', message: error instanceof Error ? error.message : '重绘失败，请稍后再试' })
    } finally {
      setRetrying(false)
    }
  }

  const share = async () => {
    if (!state.entitlementToken || sharing) return
    setSharing(true)
    try {
      const shareLink = await services.share.create(state.id, state.entitlementToken, state.assets)
      dispatch({ type: 'SHARE_READY', shareLink })
    } catch (error) {
      dispatch({ type: 'ERROR', message: error instanceof Error ? error.message : '作品分享创建失败' })
      setSharing(false)
    }
  }

  return (
    <main className="screen results-screen">
      <StepHeader step="05 / 05" title="你的山水作品" />
      <section className="results-intro"><span className="eyebrow eyebrow--dark">YOUR MOUNTAIN STORIES</span><h1>这一刻，已入画</h1><p>{isAgent ? 'Agent 已根据你的照片与所选背景完成合成' : '左右切换查看你的 AI 旅拍作品'}</p></section>
      <div className="result-stage"><img src={activeAsset?.imageUrl} alt={captionName ?? '生成结果'} /><div className="result-stamp">焕新<br />造像</div><button className="zoom-button"><Maximize2 /></button><div className="result-caption"><small>{captionSubtitle}</small><h3>{captionName}</h3></div></div>
      <div className="result-thumbs">{state.assets.map((asset, index) => { const style = isAgent ? backgrounds.find((item) => item.id === asset.styleId) : styles.find((item) => item.id === asset.styleId); return <button key={asset.id} className={index === activeIndex ? 'active' : ''} onClick={() => setActiveIndex(index)}><img src={asset.imageUrl} alt={style?.name} /><span>{style?.name}</span></button> })}</div>
      {isAgent && state.agentPrompt && (
        <details className="agent-prompt">
          <summary><FileText size={16} /> 查看本次动态生成的提示词（调试）</summary>
          <pre>{state.agentPrompt}</pre>
        </details>
      )}
      {failedStyles.length > 0 && (
        <div className="results-partial">
          <div><b>{failedStyles.length} 张这次没有画完</b><span>{failedStyles.map((style) => style.name).join('、')}</span></div>
          <button className="secondary-cta" disabled={retrying} onClick={() => void retryFailed()}>{retrying ? <RefreshCw className="spin" /> : <RefreshCw />} {retrying ? '正在重绘' : `重试这 ${failedStyles.length} 张`}</button>
        </div>
      )}
      {state.error && <div className="results-share-error">{state.error}</div>}
      <div className="results-actions"><button className="secondary-cta" onClick={() => dispatch({ type: 'RESET' })}><RefreshCw /> 再拍一次</button><button className="primary-cta" disabled={sharing} onClick={() => void share()}>{sharing ? <RefreshCw className="spin" /> : <ScanLine />} {sharing ? '正在准备作品' : '微信扫码保存'}</button></div>
    </main>
  )
}

function DownloadPage() {
  const { state, dispatch } = useSession()
  return (
    <main className="screen download-screen">
      <ScenicBackdrop />
      <div className="download-top"><BrandMark light /><span>作品已完成</span></div>
      <section className="download-card">
        <div className="download-copy"><span className="eyebrow eyebrow--dark">TAKE THE MEMORY HOME</span><h1>扫码，把山水带回家</h1><p>请使用微信扫描二维码<br />打开后长按图片保存至手机</p></div>
        <div className="qr-frame"><div className="qr-corners" /><QRCodeSVG value={state.shareLink?.url ?? 'https://demo.shanjing.example'} size={300} fgColor="#112e29" bgColor="#fffdf8" level="H" /><div className="qr-logo"><img src={brand.logoUrl} alt="像素跃迁" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div></div>
        <div className="expiry"><Clock3 /> 图片将在 24 小时后自动失效</div>
        <div className="download-steps"><span><b>1</b>微信扫码</span><i /><span><b>2</b>打开作品</span><i /><span><b>3</b>长按保存</span></div>
        <a className="debug-link" href={state.shareLink?.url} target="_blank" rel="noreferrer">打开手机作品页</a>
      </section>
      <button className="finish-button" onClick={() => dispatch({ type: 'RESET' })}><Check /> 我已保存，结束体验</button>
      <p className="download-thanks">感谢你的到访 · 愿山水常伴左右</p>
    </main>
  )
}

export function KioskFlow() {
  const { state } = useSession()
  const generationMode = import.meta.env.VITE_GENERATION_MODE ?? 'mock'
  const [styles, setStyles] = useState<StylePreset[]>(
    generationMode === 'api' ? [] : stylePresets,
  )
  const [backgrounds, setBackgrounds] = useState<BackgroundPreset[]>([])
  useEffect(() => { void services.styles.list().then(setStyles) }, [])
  useEffect(() => { void services.backgrounds.list().then(setBackgrounds) }, [])
  const agentEnabled = backgrounds.length > 0
  switch (state.stage) {
    case 'welcome': return <WelcomePage />
    case 'redeem': return <RedeemPage />
    case 'camera': return <CameraPage />
    case 'review': return <ReviewPage />
    case 'mode': return <ModePage agentEnabled={agentEnabled} />
    case 'styles': return <StylesPage styles={styles} />
    case 'backgrounds': return <AgentBackgroundsPage backgrounds={backgrounds} />
    case 'generating': return <GeneratingPage styles={styles} backgrounds={backgrounds} />
    case 'results': return <ResultsPage styles={styles} backgrounds={backgrounds} />
    case 'download': return <DownloadPage />
  }
}

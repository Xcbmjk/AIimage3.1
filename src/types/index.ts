export type KioskStage =
  | 'welcome'
  | 'redeem'
  | 'camera'
  | 'review'
  | 'mode'
  | 'styles'
  | 'backgrounds'
  | 'generating'
  | 'results'
  | 'download'

export type GenerationMode = 'classic' | 'agent'

export interface Entitlement {
  code: string
  status: 'available' | 'used' | 'expired'
  maxStyles: number
  expiresAt: string
  sessionId?: string
}

export interface EntitlementRedemption {
  entitlement: Entitlement
  accessToken: string
}

export interface CapturedPhoto {
  url: string
  source: 'camera' | 'demo'
}

export interface StylePreset {
  id: string
  name: string
  subtitle: string
  description: string
  prompt: string
  palette: [string, string, string]
  motif: string
  resultImage: string
  mode: 'realistic' | 'artistic'
}

export interface ScenePreset {
  id: string
  name: string
  location: string
  description: string
  prompt: string
  previewImage: string
}

export interface BackgroundPreset {
  id: string
  name: string
  subtitle: string
  description: string
  poseHint: string
  previewImage: string
  analysisPrompt?: string
  imageMime?: string
}

export type JobStatus = 'queued' | 'working' | 'complete' | 'failed'

export interface GenerationJob {
  id: string
  styleId: string
  status: JobStatus
  progress: number
}

export interface GeneratedAsset {
  id: string
  assetId?: string
  styleId: string
  imageUrl: string
}

export interface GenerationFailure {
  styleId: string
  code: string
  message: string
  retryable: boolean
}

export interface ShareLink {
  url: string
  expiresAt: string
}

export type GenerationProvider = 'mock' | 'gpt-image-2' | 'gpt-image-2-url' | 'seedream' | 'jimeng-i2i' | 'gemini-3.1-flash-image'
export type GenerationErrorCode =
  | 'CONFIG_ERROR'
  | 'INVALID_INPUT'
  | 'UPSTREAM_AUTH'
  | 'UPSTREAM_RATE_LIMIT'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_TRANSIENT'
  | 'UPSTREAM_BAD_RESPONSE'
  | 'GENERATION_FAILED'
  | 'GENERATION_IN_PROGRESS'
  | 'GENERATION_ALREADY_CONSUMED'
  | 'GENERATION_ATTEMPTS_EXHAUSTED'
  | 'GENERATION_REQUEST_MISMATCH'

export interface GenerateRequest {
  sessionId: string
  generationId: string
  photo: string
  styles: Array<{ id: string }>
}

export interface GenerateResponse {
  provider: GenerationProvider
  assets: GeneratedAsset[]
}

export interface AgentGenerateRequest {
  sessionId: string
  generationId: string
  photo: string
  backgroundId: string
}

export interface AgentGenerateResponse {
  provider: GenerationProvider
  prompt: string
  assets: GeneratedAsset[]
  failures?: GenerationFailure[]
}

export interface GenerationApiError {
  code: GenerationErrorCode
  message: string
  retryable: boolean
}

export interface KioskSession {
  id: string
  stage: KioskStage
  entitlement: Entitlement | null
  entitlementToken: string | null
  generationId: string | null
  generationMode: GenerationMode
  photo: CapturedPhoto | null
  selectedStyleIds: string[]
  selectedBackgroundId: string | null
  agentPrompt: string | null
  jobs: GenerationJob[]
  assets: GeneratedAsset[]
  failedStyleIds: string[]
  shareLink: ShareLink | null
  error: string | null
}

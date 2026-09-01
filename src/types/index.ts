export type KioskStage =
  | 'welcome'
  | 'payment'
  | 'redeem'
  | 'camera'
  | 'review'
  | 'scenes'
  | 'styles'
  | 'generating'
  | 'results'
  | 'download'

export interface Entitlement {
  code: string
  status: 'available' | 'used' | 'expired'
  maxStyles: number
  expiresAt: string
  sessionId?: string
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

export interface ShareLink {
  url: string
  expiresAt: string
}

export interface PaymentOrder {
  orderId: string
  amountFen: number
  expiresAt: string
  codeUrl: string
  mock: boolean
}

export type GenerationProvider = 'mock' | 'gpt-image-2' | 'seedream' | 'jimeng-i2i'
export type GenerationErrorCode =
  | 'CONFIG_ERROR'
  | 'INVALID_INPUT'
  | 'UPSTREAM_AUTH'
  | 'UPSTREAM_RATE_LIMIT'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_BAD_RESPONSE'
  | 'GENERATION_FAILED'
  | 'GENERATION_IN_PROGRESS'
  | 'GENERATION_ALREADY_CONSUMED'
  | 'GENERATION_REQUEST_MISMATCH'

export interface GenerateRequest {
  sessionId: string
  generationId: string
  photo: string
  sceneId: string
  styles: Array<{ id: string }>
}

export interface GenerateResponse {
  provider: GenerationProvider
  assets: GeneratedAsset[]
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
  paymentOrder: PaymentOrder | null
  paymentToken: string | null
  generationId: string | null
  photo: CapturedPhoto | null
  selectedSceneId: string | null
  selectedStyleIds: string[]
  jobs: GenerationJob[]
  assets: GeneratedAsset[]
  shareLink: ShareLink | null
  error: string | null
}

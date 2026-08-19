import type { CapturedPhoto, Entitlement, GeneratedAsset, GenerationJob, PaymentOrder, ShareLink, StylePreset } from '../types'

export interface EntitlementService {
  validate(code: string): Promise<Entitlement>
  consume(code: string, sessionId: string): Promise<Entitlement>
  restore(code: string, sessionId: string): Promise<void>
}

export interface CameraService {
  start(video: HTMLVideoElement): Promise<MediaStream>
  capture(video: HTMLVideoElement): CapturedPhoto
  stop(stream: MediaStream | null): void
}

export interface GenerationService {
  generate(
    sessionId: string,
    paymentToken: string,
    photo: CapturedPhoto,
    styles: StylePreset[],
    onProgress: (jobs: GenerationJob[]) => void,
  ): Promise<GeneratedAsset[]>
}

export interface PaymentService {
  create(sessionId: string): Promise<PaymentOrder>
  status(orderId: string, sessionId: string): Promise<{ status: 'pending' | 'paid' | 'expired'; accessToken?: string }>
}

export interface ShareService {
  create(sessionId: string, paymentToken: string, assets: GeneratedAsset[]): Promise<ShareLink>
}

export interface StyleService {
  list(): Promise<StylePreset[]>
}

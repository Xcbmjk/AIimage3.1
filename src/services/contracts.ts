import type { BackgroundPreset, CapturedPhoto, Entitlement, EntitlementRedemption, GeneratedAsset, GenerationJob, ShareLink, StylePreset } from '../types'

export interface EntitlementService {
  validate(code: string): Promise<Entitlement>
  consume(code: string, sessionId: string): Promise<EntitlementRedemption>
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
    entitlementToken: string,
    generationId: string,
    photo: CapturedPhoto,
    styles: StylePreset[],
    onProgress: (jobs: GenerationJob[]) => void,
  ): Promise<GeneratedAsset[]>
}

export interface AgentGenerationService {
  generate(
    sessionId: string,
    entitlementToken: string,
    generationId: string,
    photo: CapturedPhoto,
    background: BackgroundPreset,
    onProgress: (jobs: GenerationJob[]) => void,
  ): Promise<{ assets: GeneratedAsset[]; prompt: string }>
}

export interface ShareService {
  create(sessionId: string, entitlementToken: string, assets: GeneratedAsset[]): Promise<ShareLink>
}

export interface StyleService {
  list(): Promise<StylePreset[]>
}

export interface BackgroundService {
  list(): Promise<BackgroundPreset[]>
}

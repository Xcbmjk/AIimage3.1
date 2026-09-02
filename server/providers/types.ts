import type { GeneratedAsset, GenerationProvider, StylePreset } from '../../src/types'

export interface ProviderInput {
  photo: Buffer
  mimeType: string
  styles: StylePreset[]
}

export interface AgentComposeInput {
  background: Buffer
  backgroundMime: string
  photo: Buffer
  photoMime: string
  prompt: string
  backgroundId: string
}

export interface ImageProvider {
  name: GenerationProvider
  generate(photo: Buffer, mimeType: string, style: StylePreset): Promise<GeneratedAsset>
  compose?(input: AgentComposeInput): Promise<GeneratedAsset>
}

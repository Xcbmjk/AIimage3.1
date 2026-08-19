import type { GeneratedAsset, GenerationProvider, StylePreset } from '../../src/types'

export interface ProviderInput {
  photo: Buffer
  mimeType: string
  styles: StylePreset[]
}

export interface ImageProvider {
  name: GenerationProvider
  generate(photo: Buffer, mimeType: string, style: StylePreset): Promise<GeneratedAsset>
}

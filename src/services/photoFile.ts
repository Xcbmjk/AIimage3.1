import type { CapturedPhoto } from '../types'

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export async function photoToFile(photo: CapturedPhoto): Promise<File> {
  const response = await fetch(photo.url)
  if (!response.ok) throw new Error('照片读取失败，请重新拍摄')
  const blob = await response.blob()
  const mimeType = MIME_EXTENSIONS[blob.type] ? blob.type : 'image/jpeg'
  const extension = MIME_EXTENSIONS[mimeType]
  return new File([blob], `photo.${extension}`, { type: mimeType })
}

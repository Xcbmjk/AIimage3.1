import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DATA_URL = /^data:(image\/(?:jpeg|png|webp|svg\+xml))(?:;charset=[^;,]+)?(;base64)?,(.*)$/s
const extensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

export type ShareRecord = {
  id: string
  expiresAt: string
  images: Array<{ fileName: string; mimeType: string }>
}

export class ShareStore {
  constructor(
    directory: string,
    private readonly expiryHours: number,
  ) {
    this.directory = path.resolve(directory)
  }

  private readonly directory: string

  create(imageUrls: string[]): ShareRecord {
    this.cleanup()
    const id = crypto.randomBytes(18).toString('base64url')
    const shareDirectory = path.join(this.directory, id)
    fs.mkdirSync(shareDirectory, { recursive: true })
    const images = imageUrls.map((imageUrl, index) => {
      const { buffer, mimeType } = decodeShareImage(imageUrl)
      const fileName = `work-${index + 1}.${extensions[mimeType]}`
      fs.writeFileSync(path.join(shareDirectory, fileName), buffer, { flag: 'wx' })
      return { fileName, mimeType }
    })
    const record = { id, expiresAt: new Date(Date.now() + this.expiryHours * 3600_000).toISOString(), images }
    fs.writeFileSync(path.join(shareDirectory, 'share.json'), JSON.stringify(record), { flag: 'wx' })
    return record
  }

  find(id: string): ShareRecord | null {
    if (!/^[A-Za-z0-9_-]{24}$/.test(id)) return null
    const metadataPath = path.join(this.directory, id, 'share.json')
    try {
      const record = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as ShareRecord
      if (new Date(record.expiresAt).getTime() <= Date.now()) {
        fs.rmSync(path.dirname(metadataPath), { recursive: true, force: true })
        return null
      }
      return record
    } catch {
      return null
    }
  }

  imagePath(record: ShareRecord, index: number) {
    const image = record.images[index]
    return image ? path.join(this.directory, record.id, image.fileName) : null
  }

  private cleanup() {
    if (!fs.existsSync(this.directory)) return
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const metadataPath = path.join(this.directory, entry.name, 'share.json')
      try {
        const record = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as ShareRecord
        if (new Date(record.expiresAt).getTime() <= Date.now()) fs.rmSync(path.dirname(metadataPath), { recursive: true, force: true })
      } catch {
        fs.rmSync(path.dirname(metadataPath), { recursive: true, force: true })
      }
    }
  }
}

function decodeShareImage(value: string) {
  const match = DATA_URL.exec(value)
  if (!match) throw new Error('INVALID_SHARE_IMAGE')
  const mimeType = match[1]
  const buffer = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
  if (buffer.byteLength === 0 || buffer.byteLength > 15 * 1024 * 1024) throw new Error('INVALID_SHARE_IMAGE')
  return { buffer, mimeType }
}

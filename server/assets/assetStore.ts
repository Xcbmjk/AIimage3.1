import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const allowed = new Set(['image/jpeg', 'image/png', 'image/webp'])
const extension: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export class AssetStore {
  readonly root: string
  constructor(root = 'data/assets') { this.root = path.resolve(process.cwd(), root); fs.mkdirSync(this.root, { recursive: true }) }
  save(buffer: Buffer, mimeType: string, category: 'source' | 'output' | 'style' | 'background', retentionDays: number) {
    if (!allowed.has(mimeType) || buffer.byteLength === 0) throw new Error('INVALID_ASSET')
    const id = crypto.randomUUID(); const relativePath = path.join(category, `${id}.${extension[mimeType]}`); const absolutePath = path.join(this.root, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true }); fs.writeFileSync(absolutePath, buffer, { flag: 'wx', mode: 0o600 })
    return { id, relativePath: relativePath.replaceAll(path.sep, '/'), absolutePath, mimeType, byteSize: buffer.byteLength, expiresAt: new Date(Date.now() + retentionDays * 86400000).toISOString() }
  }
  readById(id: string, category: 'style' | 'output' | 'background') {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('INVALID_ASSET_PATH')
    for (const mimeType of allowed) {
      const filePath = path.join(category, `${id}.${extension[mimeType]}`)
      try { return { buffer: this.read(filePath), mimeType } } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    throw Object.assign(new Error('ASSET_NOT_FOUND'), { code: 'ENOENT' })
  }
  read(relativePath: string) {
    const root = `${this.root}${path.sep}`; const absolute = path.resolve(this.root, relativePath)
    if (!absolute.startsWith(root)) throw new Error('INVALID_ASSET_PATH')
    return fs.readFileSync(absolute)
  }
  cleanup(now = Date.now()) {
    let removed = 0
    for (const category of ['source', 'output']) {
      const directory = path.join(this.root, category); if (!fs.existsSync(directory)) continue
      for (const file of fs.readdirSync(directory)) { const absolute = path.join(directory, file); const stat = fs.statSync(absolute); if (stat.isFile() && now - stat.mtimeMs > 31 * 86400000) { fs.rmSync(absolute); removed++ } }
    }
    return removed
  }
}

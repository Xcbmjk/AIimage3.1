import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ShareStore } from './shareStore'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('ShareStore', () => {
  it('stores and retrieves share images', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-shares-'))
    directories.push(directory)
    const store = new ShareStore(directory, 24)
    const share = store.create(['data:image/png;base64,aGVsbG8='])

    expect(store.find(share.id)).toEqual(share)
    expect(fs.readFileSync(store.imagePath(share, 0)!)).toEqual(Buffer.from('hello'))
  })

  it('rejects unsupported external image URLs', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-shares-'))
    directories.push(directory)
    const store = new ShareStore(directory, 24)

    expect(() => store.create(['https://example.com/image.png'])).toThrow('INVALID_SHARE_IMAGE')
  })
})

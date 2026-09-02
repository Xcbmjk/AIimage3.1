import { describe, expect, it } from 'vitest'
import { validateImageBuffer } from './images'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

describe('image validation', () => {
  it('accepts a real small PNG and rejects mismatched payloads', () => {
    expect(() => validateImageBuffer(png, 'image/png')).not.toThrow()
    expect(() => validateImageBuffer(Buffer.from('not-an-image'), 'image/png')).toThrow('图片格式或尺寸无效')
  })

  it('rejects images exceeding the configured byte limit', () => {
    expect(() => validateImageBuffer(png, 'image/png', 4)).toThrow('图片大小不符合要求')
  })
})

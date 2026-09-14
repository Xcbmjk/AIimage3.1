import { afterEach, describe, expect, it, vi } from 'vitest'
import { httpBackgroundService, httpStyleService } from './httpCatalog'

describe('HTTP catalog services', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not fall back to browser fixtures when the style API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('catalog unavailable')),
    )

    await expect(httpStyleService.list()).resolves.toEqual([])
  })

  it('returns no backgrounds when the API is unavailable or disables Agent mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              runtime: { agentEnabled: false },
              backgrounds: [{ id: 'should-not-be-used' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
    )

    await expect(httpBackgroundService.list()).resolves.toEqual([])
    await expect(httpBackgroundService.list()).resolves.toEqual([])
  })
})

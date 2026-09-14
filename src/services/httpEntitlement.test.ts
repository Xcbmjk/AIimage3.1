import { afterEach, describe, expect, it, vi } from 'vitest'
import { httpEntitlementService } from './httpEntitlement'

describe('httpEntitlementService', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('redeems a code for an entitlement and generation token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accessToken: 'voucher-token',
      entitlement: { code: 'ABCD2345', status: 'used', maxStyles: 4, expiresAt: '2027-01-01T00:00:00.000Z' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(httpEntitlementService.consume(' abcd2345 ', 'session-1')).resolves.toMatchObject({ accessToken: 'voucher-token' })
    expect(fetchMock).toHaveBeenCalledWith('/api/entitlements/redeem', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ code: 'abcd2345', sessionId: 'session-1' }),
    }))
  })

  it('surfaces the server error without accepting an incomplete response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: '兑换码已使用' }), { status: 409 })))
    await expect(httpEntitlementService.consume('ABCD2345', 'session-1')).rejects.toThrow('兑换码已使用')
  })
})

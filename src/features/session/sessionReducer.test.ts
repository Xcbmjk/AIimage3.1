import { describe, expect, it } from 'vitest'
import type { KioskSession } from '../../types'
import { createInitialSession, sessionReducer } from './sessionReducer'

const entitlement = { code: 'SJ2026', status: 'used' as const, maxStyles: 4, expiresAt: '2027-01-01', sessionId: 's1' }

describe('sessionReducer', () => {
  it('moves from redemption into camera', () => {
    const state = sessionReducer(createInitialSession(), { type: 'REDEEMED', entitlement })
    expect(state.stage).toBe('camera')
    expect(state.entitlement?.code).toBe('SJ2026')
  })

  it('unlocks the camera only after payment confirmation', () => {
    const initial = createInitialSession()
    const payment = sessionReducer(initial, { type: 'GO', stage: 'payment' })
    const confirmed = sessionReducer(payment, { type: 'PAYMENT_CONFIRMED', token: 'paid-token' })
    expect(payment.stage).toBe('payment')
    expect(confirmed.stage).toBe('camera')
    expect(confirmed.paymentToken).toBe('paid-token')
  })

  it('keeps one generation id for the paid generation attempt', () => {
    const initial = createInitialSession()
    const started = sessionReducer(initial, { type: 'GENERATION_STARTED', generationId: 'generation-1' })
    expect(started.generationId).toBe('generation-1')
    expect(started.stage).toBe('generating')
  })

  it('enforces the maximum style count', () => {
    let state: KioskSession = { ...createInitialSession(), entitlement, stage: 'styles' as const }
    state = sessionReducer(state, { type: 'TOGGLE_STYLE', styleId: 'ink', maxStyles: 4 })
    state = sessionReducer(state, { type: 'TOGGLE_STYLE', styleId: 'gold', maxStyles: 4 })
    state = sessionReducer(state, { type: 'TOGGLE_STYLE', styleId: 'spring', maxStyles: 4 })
    state = sessionReducer(state, { type: 'TOGGLE_STYLE', styleId: 'night', maxStyles: 4 })
    expect(state.selectedStyleIds).toEqual(['ink', 'gold', 'spring', 'night'])
  })

  it('stores one scene and clears styles when the scene changes', () => {
    const selected = sessionReducer({ ...createInitialSession(), selectedStyleIds: ['ink'] }, { type: 'SELECT_SCENE', sceneId: 'great-wall' })
    expect(selected.selectedSceneId).toBe('great-wall')
    expect(selected.selectedStyleIds).toEqual([])
    expect(selected.stage).toBe('styles')
  })

  it('routes classic mode into style selection with the default scene', () => {
    const state = sessionReducer({ ...createInitialSession(), stage: 'mode' }, { type: 'SELECT_MODE', mode: 'classic' })
    expect(state.generationMode).toBe('classic')
    expect(state.selectedSceneId).toBe('portrait-only')
    expect(state.stage).toBe('styles')
  })

  it('routes agent mode into background selection and clears prior agent data', () => {
    const prior = { ...createInitialSession(), stage: 'mode' as const, agentPrompt: 'stale', selectedBackgroundId: 'old', assets: [] }
    const state = sessionReducer(prior, { type: 'SELECT_MODE', mode: 'agent' })
    expect(state.generationMode).toBe('agent')
    expect(state.stage).toBe('backgrounds')
    expect(state.selectedBackgroundId).toBeNull()
    expect(state.agentPrompt).toBeNull()
  })

  it('keeps the agent prompt and single asset after agent generation', () => {
    const started = sessionReducer({ ...createInitialSession(), stage: 'generating' }, { type: 'AGENT_GENERATED', assets: [{ id: 'a1', styleId: 'gate-steps', imageUrl: 'data:image/png;base64,AA' }], prompt: 'dynamic prompt' })
    expect(started.stage).toBe('results')
    expect(started.agentPrompt).toBe('dynamic prompt')
    expect(started.assets).toHaveLength(1)
  })

  it('clears all visitor data on reset', () => {
    const dirty = { ...createInitialSession(), entitlement, selectedStyleIds: ['ink'], stage: 'results' as const }
    const state = sessionReducer(dirty, { type: 'RESET' })
    expect(state.stage).toBe('welcome')
    expect(state.entitlement).toBeNull()
    expect(state.paymentToken).toBeNull()
    expect(state.generationId).toBeNull()
    expect(state.selectedSceneId).toBeNull()
    expect(state.selectedStyleIds).toEqual([])
    expect(state.generationMode).toBe('classic')
    expect(state.selectedBackgroundId).toBeNull()
    expect(state.agentPrompt).toBeNull()
  })
})

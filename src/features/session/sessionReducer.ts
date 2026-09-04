import type { CapturedPhoto, Entitlement, GeneratedAsset, GenerationJob, GenerationMode, KioskSession, KioskStage, PaymentOrder, ShareLink } from '../../types'
import { createUuid } from '../../lib/uuid'

export const createInitialSession = (): KioskSession => ({
  id: createUuid(),
  stage: 'welcome',
  entitlement: null,
  paymentOrder: null,
  paymentToken: null,
  generationId: null,
  generationMode: 'classic',
  photo: null,
  selectedSceneId: null,
  selectedStyleIds: [],
  selectedBackgroundId: null,
  agentPrompt: null,
  jobs: [],
  assets: [],
  shareLink: null,
  error: null,
})

export type SessionAction =
  | { type: 'GO'; stage: KioskStage }
  | { type: 'REDEEMED'; entitlement: Entitlement }
  | { type: 'PAYMENT_CREATED'; order: PaymentOrder }
  | { type: 'PAYMENT_RETRY' }
  | { type: 'PAYMENT_CONFIRMED'; token: string }
  | { type: 'GENERATION_STARTED'; generationId: string }
  | { type: 'PHOTO_SET'; photo: CapturedPhoto }
  | { type: 'SELECT_MODE'; mode: GenerationMode }
  | { type: 'SELECT_SCENE'; sceneId: string }
  | { type: 'TOGGLE_STYLE'; styleId: string; maxStyles: number }
  | { type: 'SELECT_BACKGROUND'; backgroundId: string }
  | { type: 'JOBS_UPDATED'; jobs: GenerationJob[] }
  | { type: 'GENERATED'; assets: GeneratedAsset[] }
  | { type: 'AGENT_GENERATED'; assets: GeneratedAsset[]; prompt: string }
  | { type: 'SHARE_READY'; shareLink: ShareLink }
  | { type: 'ERROR'; message: string | null }
  | { type: 'RESET' }

export function sessionReducer(state: KioskSession, action: SessionAction): KioskSession {
  switch (action.type) {
    case 'GO':
      return { ...state, stage: action.stage, error: null }
    case 'REDEEMED':
      return { ...state, entitlement: action.entitlement, stage: 'camera', error: null }
    case 'PAYMENT_CREATED':
      return { ...state, paymentOrder: action.order, error: null }
    case 'PAYMENT_RETRY':
      return { ...state, paymentOrder: null, paymentToken: null, error: null, stage: 'payment' }
    case 'PAYMENT_CONFIRMED':
      return { ...state, paymentToken: action.token, stage: 'camera', error: null }
    case 'GENERATION_STARTED':
      return { ...state, generationId: action.generationId, stage: 'generating', error: null }
    case 'PHOTO_SET':
      return { ...state, photo: action.photo, stage: 'review', error: null }
    case 'SELECT_MODE': {
      if (action.mode === 'classic') {
        return { ...state, generationMode: 'classic', selectedSceneId: 'portrait-only', selectedStyleIds: [], stage: 'styles', error: null }
      }
      return { ...state, generationMode: 'agent', selectedBackgroundId: null, agentPrompt: null, jobs: [], assets: [], stage: 'backgrounds', error: null }
    }
    case 'SELECT_SCENE':
      return { ...state, selectedSceneId: action.sceneId, selectedStyleIds: [], stage: 'styles', error: null }
    case 'TOGGLE_STYLE': {
      const selected = state.selectedStyleIds.includes(action.styleId)
        ? state.selectedStyleIds.filter((id) => id !== action.styleId)
        : state.selectedStyleIds.length < action.maxStyles
          ? [...state.selectedStyleIds, action.styleId]
          : state.selectedStyleIds
      return { ...state, selectedStyleIds: selected }
    }
    case 'SELECT_BACKGROUND':
      return { ...state, selectedBackgroundId: action.backgroundId, error: null }
    case 'JOBS_UPDATED':
      return { ...state, jobs: action.jobs }
    case 'GENERATED':
      return { ...state, assets: action.assets, stage: 'results' }
    case 'AGENT_GENERATED':
      return { ...state, assets: action.assets, agentPrompt: action.prompt, stage: 'results', error: null }
    case 'SHARE_READY':
      return { ...state, shareLink: action.shareLink, stage: 'download' }
    case 'ERROR':
      return { ...state, error: action.message }
    case 'RESET':
      return createInitialSession()
  }
}

import { httpAgentGenerationService } from './httpAgentGeneration'
import { httpGenerationService } from './httpGeneration'
import { mockAgentGenerationService } from '../mocks/services/generation'
import { mockBackgroundService } from '../mocks/services/generation'
import { mockCameraService } from '../mocks/services/camera'
import { mockEntitlementService } from '../mocks/services/entitlement'
import { mockGenerationService } from '../mocks/services/generation'
import { httpPaymentService } from './httpPayment'
import { httpShareService } from './httpShare'
import { httpBackgroundService, httpStyleService } from './httpCatalog'

const generationMode = import.meta.env.VITE_GENERATION_MODE ?? 'mock'

export const services = {
  entitlement: mockEntitlementService,
  payment: httpPaymentService,
  camera: mockCameraService,
  generation: generationMode === 'api' ? httpGenerationService : mockGenerationService,
  agent: generationMode === 'api' ? httpAgentGenerationService : mockAgentGenerationService,
  share: httpShareService,
  styles: httpStyleService,
  backgrounds: generationMode === 'api' ? httpBackgroundService : mockBackgroundService,
}

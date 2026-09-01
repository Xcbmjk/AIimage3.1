import { httpGenerationService } from './httpGeneration'
import { mockCameraService } from '../mocks/services/camera'
import { mockEntitlementService } from '../mocks/services/entitlement'
import { mockGenerationService } from '../mocks/services/generation'
import { httpPaymentService } from './httpPayment'
import { httpShareService } from './httpShare'
import { httpStyleService } from './httpCatalog'

const generationMode = import.meta.env.VITE_GENERATION_MODE ?? 'mock'

export const services = {
  entitlement: mockEntitlementService,
  payment: httpPaymentService,
  camera: mockCameraService,
  generation: generationMode === 'api' ? httpGenerationService : mockGenerationService,
  share: httpShareService,
  styles: httpStyleService,
}

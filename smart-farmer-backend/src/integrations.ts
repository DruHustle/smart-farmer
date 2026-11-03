import type {FastifyInstance} from 'fastify';
import type {createContext} from './context.js';
import {registerEquipment} from './integrations/equipment.js';
import {registerMedia} from './integrations/media.js';
import {registerCommerce} from './integrations/commerce.js';

export function registerIntegrations(app: FastifyInstance, context: ReturnType<typeof createContext>) {
  registerEquipment(app, context);
  registerMedia(app, context);
  registerCommerce(app, context);
}

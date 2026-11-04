import type { FastifyInstance } from "fastify";
import type { createContext } from "./context.js";
import { registerEquipment } from "./integrations/equipment.js";
import { registerMedia } from "./integrations/media.js";
import { registerCommerce } from "./integrations/commerce.js";
import {
  createPaymentProvider,
  registerPayments,
  type PaymentProvider,
} from "./integrations/payments.js";

export interface IntegrationOptions {
  paymentProvider?: PaymentProvider;
}

export function registerIntegrations(
  app: FastifyInstance,
  context: ReturnType<typeof createContext>,
  options: IntegrationOptions = {},
) {
  registerEquipment(app, context);
  registerMedia(app, context);
  registerCommerce(app, context);
  registerPayments(
    app,
    context,
    createPaymentProvider(options.paymentProvider),
  );
}

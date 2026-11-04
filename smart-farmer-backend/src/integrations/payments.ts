import type { FastifyInstance } from "fastify";
import type { Context } from "../context.js";
import { authorize } from "./common.js";

/** Internal money is exact. An adapter must validate its currency's minor-unit convention. */
export interface PaymentMoney {
  readonly minorUnits: bigint;
  readonly currency: string;
}

/** References and amounts must come from authorized, locked server-side obligations. */
export interface PaymentReference {
  readonly farmId: string;
  readonly kind: "market_order" | "animal_revenue" | "service_booking";
  readonly id: string;
}

export interface PaymentIntentRequest {
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly reference: PaymentReference;
  readonly money: PaymentMoney;
  readonly expiresAt: string;
}

export interface PaymentIntent {
  readonly provider: string;
  readonly mode: "test" | "live";
  readonly providerIntentId: string;
  readonly idempotencyKey: string;
  readonly reference: PaymentReference;
  readonly money: PaymentMoney;
  readonly status: "requires_action" | "pending" | "failed";
  readonly expiresAt: string;
}

export interface SettlementVerificationRequest {
  readonly providerIntentId: string;
  readonly reference: PaymentReference;
  readonly expectedMoney: PaymentMoney;
}

interface SettlementContext {
  readonly provider: string;
  readonly mode: "test" | "live";
  readonly providerIntentId: string;
  readonly reference: PaymentReference;
  readonly checkedAt: string;
}

/** Only independently authenticated provider evidence may produce a settled result. */
export type PaymentSettlement = SettlementContext &
  (
    | { readonly status: "pending" | "failed" }
    | {
        readonly status: "settled";
        readonly providerTransactionId: string;
        readonly providerEventId: string;
        readonly money: PaymentMoney;
        readonly settledAt: string;
        readonly evidenceSource: "provider_api" | "verified_webhook";
      }
  );

export interface PaymentCapabilities {
  readonly createIntents: boolean;
  readonly verifySettlements: boolean;
}

export type PaymentProviderStatus =
  | {
      readonly provider: null;
      readonly mode: "unconfigured";
      readonly configured: false;
      readonly capabilities: {
        readonly createIntents: false;
        readonly verifySettlements: false;
      };
      readonly supportedCurrencies: readonly [];
    }
  | {
      readonly provider: string;
      readonly mode: "test" | "live";
      readonly configured: true;
      readonly capabilities: PaymentCapabilities;
      readonly supportedCurrencies: readonly string[];
    };

/**
 * Server-owned adapter boundary. getStatus is local and side-effect free.
 * Creating an intent is never settlement and this interface never writes a ledger.
 */
export interface PaymentProvider {
  getStatus(): PaymentProviderStatus;
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntent>;
  verifySettlement(
    request: SettlementVerificationRequest,
  ): Promise<PaymentSettlement>;
}

export class PaymentProviderUnavailableError extends Error {
  readonly code = "payment_provider_unconfigured";
  readonly status = 503;
  readonly retryable = false;

  constructor() {
    super("No payment processor adapter is configured");
    this.name = "PaymentProviderUnavailableError";
  }
}

const unconfiguredStatus: PaymentProviderStatus = Object.freeze({
  provider: null,
  mode: "unconfigured",
  configured: false,
  capabilities: Object.freeze({
    createIntents: false,
    verifySettlements: false,
  }),
  supportedCurrencies: Object.freeze([]) as readonly [],
});

export class UnconfiguredPaymentProvider implements PaymentProvider {
  getStatus(): PaymentProviderStatus {
    return unconfiguredStatus;
  }

  async createIntent(_request: PaymentIntentRequest): Promise<PaymentIntent> {
    throw new PaymentProviderUnavailableError();
  }

  async verifySettlement(
    _request: SettlementVerificationRequest,
  ): Promise<PaymentSettlement> {
    throw new PaymentProviderUnavailableError();
  }
}

/** Only the trusted application composition root may supply an implemented adapter. */
export function createPaymentProvider(
  adapter?: PaymentProvider,
): PaymentProvider {
  return adapter ?? new UnconfiguredPaymentProvider();
}

export function registerPayments(
  app: FastifyInstance,
  ctx: Context,
  provider: PaymentProvider,
) {
  app.get("/v1/farms/:farmId/payment-provider", async (req, reply) => {
    if (!(await authorize(ctx, req, reply))) return;
    const status = provider.getStatus();
    // Deliberately project public capability fields, never the adapter or its credentials.
    return {
      provider: status.provider,
      mode: status.mode,
      configured: status.configured,
      capabilities: {
        createIntents: status.capabilities.createIntents,
        verifySettlements: status.capabilities.verifySettlements,
      },
      supportedCurrencies: [...status.supportedCurrencies],
      manualReceipts: {
        available: true,
        provenance: "manual",
        providerVerified: false,
      },
    };
  });
}

import type { FastifyInstance } from "fastify";
import type { Context } from "./context.js";
import { registerFarmOperations } from "./operations/farm.js";
import { registerAssetOperations } from "./operations/assets.js";
import { registerNotifications } from "./operations/notifications.js";
import { registerCameras } from "./operations/cameras.js";
import { registerRetention } from "./operations/retention.js";
export function registerOperations(app: FastifyInstance, ctx: Context) {
  registerFarmOperations(app, ctx);
  registerAssetOperations(app, ctx);
  registerNotifications(app, ctx);
  registerCameras(app, ctx);
  registerRetention(app, ctx);
}

import {z} from 'zod';

export const NODE_RED_CAPABILITY = 'node-red-package-management-v1';
export const gatewayId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/);
// npm names and exact versions only: never a path, URL, archive, alias or range.
export const nodeRedPackageName = z.string().max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
  .refine(name => !['node-red', 'node_modules', 'npm'].includes(name),
    'Core runtime packages require a gateway release.');
export const exactPackageVersion = z.string().max(96).regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  'Choose one exact npm version.');
export const packageSelection = z.object({module:nodeRedPackageName, version:exactPackageVersion}).strict();
export const installRequest = z.object({
  reviewToken:z.string().min(1).max(2048), requestId:z.string().uuid(),
  acknowledgeCodeExecution:z.literal(true)
}).strict();
export type NodeRedTarget = {id:string; label:string; version:string; revision:string};
export type NodeRedPackage = {
  name:string; version:string; nodeSets:number; pluginSets:number;
  loadError:boolean; pendingVersion:string|null;
};
export const installOperation = z.object({
  id:z.string().uuid(), runtimeId:z.string().uuid(),
  targetRevision:z.string().regex(/^[a-f0-9]{64}$/), farmId:z.string().uuid(),
  gatewayId, actorId:z.string().uuid(), module:nodeRedPackageName, version:exactPackageVersion,
  state:z.enum(['installing','installed','failed','unconfirmed']),
  message:z.string().max(400), startedAt:z.string().datetime(), updatedAt:z.string().datetime()
}).strict();
export type InstallOperation = z.infer<typeof installOperation>;
export type NodeRedActor = {id:string; farmId:string; sessionHash:string};
export type NodeRedGateways = {
  state:'disabled'|'configured'|'unavailable'; message:string;
  items:Array<{gatewayId:string; target:NodeRedTarget}>;
};
export type NodeRedStatus = {
  state:'disabled'|'unavailable'|'ready'; message:string; target:NodeRedTarget|null;
  packages:NodeRedPackage[]; operation:InstallOperation|null;
};
export type PackageReview = {
  module:string; version:string; target:NodeRedTarget; description:string;
  nodeSets:string[]; pluginSets:string[]; reviewToken:string; expiresAt:string;
};
export const pendingInstall = (operation:InstallOperation|null) =>
  operation?.state === 'installing' || operation?.state === 'unconfirmed';

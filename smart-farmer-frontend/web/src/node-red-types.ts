/** Public API wire types; gateway credentials and addresses never reach the browser. */
export type NodeRedTarget = {id: string; label: string; version: string; revision: string};
export type NodeRedPackage = {name: string; version: string; nodeSets: number; pluginSets: number; loadError: boolean; pendingVersion: string | null};
export type NodeRedOperation = {
  id: string; runtimeId: string; targetRevision: string; farmId: string; gatewayId: string;
  actorId: string; module: string; version: string;
  state: 'installing' | 'installed' | 'failed' | 'unconfirmed';
  message: string; startedAt: string; updatedAt: string;
};
export type NodeRedGateways = {
  state: 'disabled' | 'configured' | 'unavailable'; message: string;
  items: Array<{gatewayId: string; target: NodeRedTarget}>;
};
export type NodeRedStatus = {
  state: 'disabled' | 'unavailable' | 'ready'; message: string;
  target: NodeRedTarget | null; packages: NodeRedPackage[]; operation: NodeRedOperation | null;
};
export type NodeRedReview = {
  module: string; version: string; target: NodeRedTarget; description: string;
  nodeSets: string[]; pluginSets: string[]; reviewToken: string; expiresAt: string;
};

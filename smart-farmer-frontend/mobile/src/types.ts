export type Language = 'sn' | 'nd';
export type Role = 'owner' | 'manager' | 'worker' | 'adviser' | 'veterinarian';
export type Session = { token: string; userId: string; username: string; language: Language; expiresAt: string; origin: string };
export type Farm = { id: string; name: string; timezone: string; role: Role };
export const enterpriseTypes = ['crop', 'broiler', 'layer', 'breeder', 'hatchery', 'rabbit_breeding', 'rabbit_growout', 'fish', 'fish_nursery', 'fish_breeder', 'fish_hatchery'] as const;
export type EnterpriseType = typeof enterpriseTypes[number];
export type Project = {
  id: string; name: string; crop: string; enterprise_type: EnterpriseType; irrigation: boolean;
  planting_date: string | null; variety: string | null; objective: string | null; area_ha: string | null;
  stage: string | null; version: number; status?: string; as_of_date?: string | null;
  opening_count?: string | null; current_count?: string | null; count_basis?: 'verified' | 'estimated' | 'unknown';
};
export const activityKinds = ['work', 'rain', 'irrigation', 'observation', 'harvest', 'cost', 'input_use'] as const;
export type ActivityKind = typeof activityKinds[number];
export type ActivityPayload = {
  id: string; projectId: string; kind: ActivityKind; observedAt: string; note: string;
  quantity: number | null; unit: string | null; stockItemId?: string; amount?: number; currency?: string; taskId?: string; taskVersion?: number;
};
export type Activity = {
  id: string; project_id: string; kind: ActivityKind; observed_at: string; recorded_at: string; note: string;
  quantity: string | null; unit: string | null;
};
export type TaskStatus = 'planned' | 'started' | 'completed' | 'blocked' | 'cancelled';
export type Task = {
  id: string; project_id: string | null; assignee_id: string | null; title: string; instructions: string;
  due_at: string | null; status: TaskStatus; version: number; evidence: string | null;
};
export const stockUnits = ['kg', 'g', 'l', 'ml', 'count', 'egg', 'bird', 'rabbit', 'fish'] as const;
export type Stock = { id: string; name: string; unit: typeof stockUnits[number]; quantity: string; project_id: string | null; unit_cost?: string | null; currency?: string | null };
export type Member = { id: string; username: string; role: Role };
export const animalEventTypes = ['acquisition', 'mortality', 'transfer', 'sale', 'egg_collection', 'egg_consumption', 'egg_loss', 'egg_sale', 'incubation', 'hatch', 'mating', 'kindling', 'fostering', 'weaning', 'stocking', 'water_observation', 'growth_sample', 'harvest', 'feed', 'observation', 'care', 'adjustment', 'close', 'spawning', 'fish_hatch', 'egg_disposition'] as const;
export type AnimalEventType = typeof animalEventTypes[number];
export type AnimalEvent = {
  id: string; type: AnimalEventType; observed_at: string; count: string | null; quantity: string | null;
  unit: string | null; destination_project_id: string | null; note: string; metadata?: Record<string, unknown>;
};
export type Asset = {
  id: string; name: string; category: string; model: string | null; integration_state: string;
  fresh: boolean; last_observed_at: string | null; capabilities: Record<string, unknown>;
  latest_telemetry: Record<string, unknown> | null;
};
export type FarmSnapshot = {
  farm: Farm; projects: Project[]; tasks: Task[]; activities: Activity[]; stock: Stock[]; members: Member[];
  assets: Asset[]; syncedAt: string;
};
export type RecordDraft = {
  id: string; projectId: string; kind: ActivityKind; observedLocal: string; note: string;
  quantity: string; unit: string; stockItemId: string; amount: string; currency: string; taskId: string;
};
export type OutboxState = 'pending' | 'conflict' | 'blocked' | 'resolved';
export type MutationKind = 'activity' | 'animal-event' | 'task-status' | 'project-record' | 'weather-observation' | 'asset-usage' | 'incident-create';
export type Mutation = {
  id: string; farmId: string; kind: MutationKind; resourceId?: string;
  body: Record<string, unknown>; state: OutboxState; attempts: number; lastError: string | null; createdAt: string;
};
export type MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'audio/mp4' | 'audio/mpeg' | 'audio/webm' | 'audio/wav' | 'application/pdf';
export type Attachment = {
  id: string; farmId: string; activityId?: string; assetId?: string; financial?: boolean; mimeType: MediaType; filename: string;
  dataBase64: string; sizeBytes: number; state: 'draft' | 'pending' | 'synced' | 'blocked' | 'conflict';
  attempts: number; lastError: string | null; createdAt: string;
};

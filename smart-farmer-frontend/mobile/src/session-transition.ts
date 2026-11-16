// Acceptance diagnostics carry fixed categories only. Never pass event/session data or errors to this API.
const stages = ['trace', 'unlock_press', 'sign_out_press', 'unlock', 'sign_out', 'session_delete', 'notifications_cleanup', 'notification_unregister', 'notification_cancel', 'notification_dismiss', 'channels_read', 'channels_write', 'local_session_clear', 'auth_screen', 'farm_touch', 'farm_press', 'tab_today', 'tab_farm', 'tab_record', 'tab_forum', 'tab_more'] as const;
const phases = ['ready', 'received', 'start', 'complete', 'failed', 'blocked', 'fallback', 'queued', 'committed', 'cancelled', 'limit'] as const;
export type SessionStage = typeof stages[number];
export type SessionPhase = typeof phases[number];
export type SessionTrace = (stage: SessionStage, phase: SessionPhase) => void;
export const SESSION_TRACE_PREFIX = 'SF_SESSION_TRACE ';
export const SESSION_TRACE_LIMIT = 128;

export function createSessionTrace({ enabled, sink = (line: string) => console.info(line), now = Date.now }: { enabled: boolean; sink?: (line: string) => void; now?: () => number }): SessionTrace {
  let sequence = 0; const started = now();
  return (stage, phase) => {
    if (!enabled || sequence >= SESSION_TRACE_LIMIT || !stages.includes(stage) || !phases.includes(phase)) return;
    sequence++;
    // The final record makes truncation explicit without unbounded log traffic.
    const limit = sequence === SESSION_TRACE_LIMIT;
    try {
      const time = now();
      sink(SESSION_TRACE_PREFIX + JSON.stringify({ at: new Date(time).toISOString(), sequence, elapsed_ms: Math.max(0, Math.min(86_400_000, Math.round(time - started))), stage: limit ? 'trace' : stage, phase: limit ? 'limit' : phase }));
    } catch { /* Diagnostics must not change local authentication or cleanup behavior. */ }
  };
}

export const traceSession = createSessionTrace({ enabled: process.env.EXPO_PUBLIC_NATIVE_SESSION_TRACE === '1' });

export async function sessionStep<T>(stage: SessionStage, operation: () => Promise<T>, trace?: SessionTrace): Promise<T> {
  trace?.(stage, 'start');
  try { const result = await operation(); trace?.(stage, 'complete'); return result; }
  catch (error) { trace?.(stage, 'failed'); throw error; }
}

/** The same synchronous gate covers both controls, including the gap before React commits. */
export function createSessionGate(onBusy: (busy: boolean) => void, trace: SessionTrace) {
  let active: 'unlock' | 'sign_out' | null = null;
  function release() { active = null; onBusy(false); }
  return {
    get busy() { return active !== null; },
    async run(action: 'unlock' | 'sign_out', operation: () => Promise<void>): Promise<boolean> {
      if (active) { trace(action, 'blocked'); return false; }
      active = action; onBusy(true); trace(action, 'start');
      try {
        await operation(); trace(action, 'complete');
        if (action === 'unlock') release();
        // Successful sign-out stays guarded until the auth screen has committed.
        return true;
      } catch (error) { trace(action, 'failed'); release(); throw error; }
    },
    authScreenCommitted() {
      if (active !== 'sign_out') return;
      trace('auth_screen', 'committed'); release();
    },
  };
}

/** Preserve cleanup-before-auth so an old account cannot clear a new account's notifications. */
export async function clearLocalSession(operations: { forgetSession: () => Promise<void>; clearNotifications: () => Promise<void>; clearState: () => void }, trace: SessionTrace): Promise<void> {
  await sessionStep('session_delete', operations.forgetSession, trace);
  try { await sessionStep('notifications_cleanup', operations.clearNotifications, trace); }
  catch { /* Existing notification failures must not prevent local sign-out. */ }
  trace('local_session_clear', 'start');
  operations.clearState();
  trace('local_session_clear', 'queued');
}

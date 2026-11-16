export type FormAttempt<T> = { accepted: true; result: T } | { accepted: false };
type Review = { token: number; closing: boolean; accepted: boolean };

/** Persistence belongs to the accepted draft attempt, even if its editor has detached. */
export async function persistAndSubmitDraft<T>(options: {
  persist: () => Promise<void>;
  submit: () => Promise<T>;
  clear: () => Promise<void>;
  cleanupError: (error: unknown) => void;
}): Promise<T> {
  await options.persist();
  const result = await options.submit();
  // Cleanup is independent of UI delivery and cannot turn a committed save into a rejected mutation.
  void Promise.resolve().then(options.clear).catch(options.cleanupError);
  return result;
}

/** Keep a successful child review mounted until iOS has finished dismissing it. */
export function createFormCompletion(nativeDismissal: boolean) {
  let mounted = true; let generation = 0; let nextOperation = 0; let operation: number | null = null;
  let nextToken = 0; let review: Review | null = null;
  let dismissal: { token: number; operation: number; resolve: (attached: boolean) => void } | null = null;
  return {
    attach() { mounted = true; },
    openReview(): number | null {
      if (!mounted || operation !== null || review) return null;
      review = { token: ++nextToken, closing: false, accepted: false };
      return review.token;
    },
    closeReview(token: number, hide: () => void): boolean {
      if (!mounted || operation !== null || !review || review.token !== token || review.closing) return false;
      review.closing = true;
      if (!nativeDismissal) review = null;
      hide(); return true;
    },
    dismissed(token: number): boolean {
      if (!mounted || !review || review.token !== token || !review.closing) return false;
      review = null;
      if (dismissal?.token === token) { const pending = dismissal; dismissal = null; pending.resolve(true); }
      return true;
    },
    async run<T>(options: {
      reviewToken?: number;
      attempt: () => Promise<FormAttempt<T>>;
      accepted: () => void;
      reset: () => void;
      hideReview: () => void;
      saved?: (result: T) => void | Promise<void>;
      busy: (value: boolean) => void;
      error: (error: unknown) => void;
    }): Promise<'accepted' | 'rejected' | 'blocked' | 'detached' | 'delivery_failed'> {
      if (!mounted || operation !== null || options.reviewToken !== undefined && (!review || review.token !== options.reviewToken || review.closing || review.accepted)) return 'blocked';
      const ownOperation = ++nextOperation; const ownGeneration = generation; operation = ownOperation;
      const attached = () => mounted && generation === ownGeneration && operation === ownOperation;
      let accepted = false;
      try {
        options.busy(true);
        const result = await options.attempt();
        if (!result.accepted) return 'rejected';
        accepted = true;
        if (!attached()) return 'detached';
        if (review && review.token === options.reviewToken) review.accepted = true;
        // The accepted mutation owns its durable intent. Consume this form ID before UI delivery.
        options.accepted();
        if (!attached()) return 'detached';
        options.reset();
        if (review && review.token === options.reviewToken) {
          review.closing = true;
          if (nativeDismissal) {
            const token = review.token;
            const finished = new Promise<boolean>(resolve => { dismissal = { token, operation: ownOperation, resolve }; });
            options.hideReview();
            if (!await finished || !attached()) return 'detached';
          } else { review = null; options.hideReview(); }
        }
        if (!attached()) return 'detached';
        await options.saved?.(result.result);
        return 'accepted';
      } catch (error) {
        if (attached()) options.error(error);
        return accepted ? 'delivery_failed' : 'rejected';
      } finally {
        if (dismissal?.operation === ownOperation) { const pending = dismissal; dismissal = null; pending.resolve(false); }
        if (operation === ownOperation) {
          const deliverBusy = attached(); operation = null;
          if (deliverBusy) options.busy(false);
        }
      }
    },
    dispose() {
      mounted = false; generation++; operation = null; review = null;
      if (dismissal) { const pending = dismissal; dismissal = null; pending.resolve(false); }
    },
  };
}

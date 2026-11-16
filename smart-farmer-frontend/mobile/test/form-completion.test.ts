import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFormCompletion, persistAndSubmitDraft, type FormAttempt } from '../src/form-completion';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const canonical = { id: 'invoice', version: 3, paidMinor: '750', balanceMinor: '1250' };

function callbacks(events: string[]) {
  return {
    accepted: () => { events.push('accepted'); },
    reset: () => { events.push('reset'); },
    hideReview: () => { events.push('hide'); },
    saved: (result: typeof canonical) => { assert.equal(result, canonical); events.push('saved'); },
    busy: (value: boolean) => { events.push(`busy:${value}`); },
    error: (_error: unknown) => { events.push('error'); },
  };
}

test('confirmed iOS completion consumes once, waits for native dismissal and holds the synchronous submission gate', async () => {
  const completion = createFormCompletion(true); const token = completion.openReview()!;
  const events: string[] = []; const request = deferred<FormAttempt<typeof canonical>>(); let calls = 0;
  const options = { ...callbacks(events), reviewToken: token, attempt: () => { calls++; return request.promise; } };
  assert.equal(completion.dismissed(token), false, 'An unexpected event before dismissal cannot complete the review');
  const pending = completion.run(options);
  assert.equal(await completion.run(options), 'blocked');
  assert.equal(completion.closeReview(token, options.hideReview), false, 'An in-flight request cannot close its review');
  request.resolve({ accepted: true, result: canonical }); await turn();
  assert.deepEqual(events, ['busy:true', 'accepted', 'reset', 'hide']);
  assert.equal(calls, 1); assert.equal(completion.openReview(), null);
  assert.equal(await completion.run(options), 'blocked', 'Accepted money cannot be posted again during native dismissal');
  assert.equal(completion.dismissed(token + 1), false);
  assert.equal(completion.dismissed(token), true);
  assert.equal(completion.dismissed(token), false);
  assert.equal(await pending, 'accepted');
  assert.deepEqual(events, ['busy:true', 'accepted', 'reset', 'hide', 'saved', 'busy:false']);
  assert.equal(await completion.run(options), 'blocked', 'A closed review cannot submit its stale confirmation');
});

test('cancellation never signals saved and a rejected attempt keeps its review available without consuming the intent', async () => {
  const completion = createFormCompletion(true); const token = completion.openReview()!;
  const events: string[] = []; let calls = 0;
  const options = { ...callbacks(events), reviewToken: token, attempt: async (): Promise<FormAttempt<typeof canonical>> => { calls++; return { accepted: false }; } };
  assert.equal(completion.closeReview(token, options.hideReview), true);
  assert.equal(await completion.run(options), 'blocked'); assert.equal(calls, 0);
  assert.equal(completion.openReview(), null, 'A cancelled review still waits for its native dismissal');
  assert.equal(completion.dismissed(token), true);
  const next = completion.openReview()!;
  assert.notEqual(next, token); assert.equal(completion.dismissed(token), false);
  assert.equal(await completion.run({ ...options, reviewToken: next }), 'rejected');
  assert.equal(calls, 1); assert.deepEqual(events, ['hide', 'busy:true', 'busy:false']);
  const retry = completion.run({ ...options, reviewToken: next, attempt: async () => { calls++; return { accepted: true as const, result: canonical }; } });
  await turn(); completion.dismissed(next);
  assert.equal(await retry, 'accepted'); assert.equal(calls, 2);
  assert.equal(events.filter(value => value === 'accepted').length, 1);
  assert.equal(events.filter(value => value === 'saved').length, 1);
});

test('a fallible parent callback cannot reclassify an accepted mutation or replay the closed review', async () => {
  const completion = createFormCompletion(true); const token = completion.openReview()!;
  const events: string[] = []; let calls = 0; const deliveryError = new Error('UI delivery failed');
  const options = { ...callbacks(events), reviewToken: token,
    attempt: async () => { calls++; return { accepted: true as const, result: canonical }; },
    saved: (value: typeof canonical) => { assert.equal(value, canonical); events.push('saved'); throw deliveryError; },
    error: (error: unknown) => { assert.equal(error, deliveryError); events.push('error'); },
  };
  const pending = completion.run(options); await turn(); completion.dismissed(token);
  assert.equal(await pending, 'delivery_failed');
  assert.equal(await completion.run(options), 'blocked');
  assert.equal(calls, 1); assert.deepEqual(events, ['busy:true', 'accepted', 'reset', 'hide', 'saved', 'error', 'busy:false']);
});

test('Android confirmed forms and non-confirmed forms preserve immediate canonical-result delivery', async () => {
  for (const [nativeDismissal, confirmed] of [[false, true], [false, false], [true, false]] as const) {
    const completion = createFormCompletion(nativeDismissal); const events: string[] = [];
    const token = confirmed ? completion.openReview()! : undefined;
    assert.equal(await completion.run({ ...callbacks(events), reviewToken: token, attempt: async () => ({ accepted: true as const, result: canonical }) }), 'accepted');
    assert.deepEqual(events, ['busy:true', 'accepted', 'reset', ...(confirmed ? ['hide'] : []), 'saved', 'busy:false']);
  }
});

test('unmount before acceptance leaves the single API operation intact and never delivers stale UI', async () => {
  const completion = createFormCompletion(true); const token = completion.openReview()!;
  const events: string[] = []; const request = deferred<FormAttempt<typeof canonical>>(); let committed = 0;
  const options = { ...callbacks(events), reviewToken: token, attempt: async () => { const value = await request.promise; if (value.accepted) committed++; return value; } };
  const pending = completion.run(options); completion.dispose();
  request.resolve({ accepted: true, result: canonical });
  assert.equal(await pending, 'detached'); assert.equal(committed, 1);
  assert.deepEqual(events, ['busy:true']);
  assert.equal(completion.dismissed(token), false); assert.equal(await completion.run(options), 'blocked');
});

test('unmount during native dismissal settles without a timer, replay or stale parent callback', async () => {
  const completion = createFormCompletion(true); const token = completion.openReview()!;
  const events: string[] = [];
  const pending = completion.run({ ...callbacks(events), reviewToken: token, attempt: async () => ({ accepted: true as const, result: canonical }) });
  await turn(); completion.dispose();
  assert.equal(await pending, 'detached');
  assert.deepEqual(events, ['busy:true', 'accepted', 'reset', 'hide']);
  assert.equal(completion.dismissed(token), false);
});

test('effect reattachment isolates an older response and cannot release a newer submission gate', async () => {
  const completion = createFormCompletion(true); const oldToken = completion.openReview()!;
  const oldEvents: string[] = []; const oldRequest = deferred<FormAttempt<typeof canonical>>();
  const old = completion.run({ ...callbacks(oldEvents), reviewToken: oldToken, attempt: () => oldRequest.promise });
  completion.dispose(); completion.attach();
  const token = completion.openReview()!; const events: string[] = []; const request = deferred<FormAttempt<typeof canonical>>();
  const options = { ...callbacks(events), reviewToken: token, attempt: () => request.promise };
  const pending = completion.run(options);
  oldRequest.resolve({ accepted: true, result: canonical }); assert.equal(await old, 'detached');
  assert.equal(await completion.run(options), 'blocked');
  assert.deepEqual(oldEvents, ['busy:true']);
  request.resolve({ accepted: true, result: canonical }); await turn();
  assert.equal(completion.dismissed(oldToken), false); assert.equal(completion.dismissed(token), true);
  assert.equal(await pending, 'accepted');
  assert.deepEqual(events, ['busy:true', 'accepted', 'reset', 'hide', 'saved', 'busy:false']);
});

test('the native completion listener exists before requesting dismissal', async () => {
  const completion = createFormCompletion(true); const token = completion.openReview()!; const events: string[] = [];
  assert.equal(await completion.run({ ...callbacks(events), reviewToken: token,
    attempt: async () => ({ accepted: true as const, result: canonical }),
    hideReview: () => { events.push('hide'); assert.equal(completion.dismissed(token), true); },
  }), 'accepted');
  assert.deepEqual(events, ['busy:true', 'accepted', 'reset', 'hide', 'saved', 'busy:false']);
});

test('the invoice draft attempt persists before submitting, clears only an accepted save and returns the canonical object', async () => {
  const events: string[] = []; const persistence = deferred<void>();
  const attempt = persistAndSubmitDraft({
    persist: async () => { events.push('persist'); await persistence.promise; },
    submit: async () => { events.push('submit'); return canonical; },
    clear: async () => { events.push('clear'); },
    cleanupError: () => { events.push('cleanupError'); },
  });
  await turn(); assert.deepEqual(events, ['persist'], 'Untouched draft identity must be durable before the request starts');
  persistence.resolve(); assert.equal(await attempt, canonical); await turn();
  assert.deepEqual(events, ['persist', 'submit', 'clear']);
  for (const failure of ['persist', 'submit']) {
    const rejected: string[] = []; const error = new Error(failure);
    await assert.rejects(persistAndSubmitDraft({
      persist: async () => { rejected.push('persist'); if (failure === 'persist') throw error; },
      submit: async () => { rejected.push('submit'); throw error; },
      clear: async () => { rejected.push('clear'); },
      cleanupError: () => { rejected.push('cleanupError'); },
    }), error);
    assert.deepEqual(rejected, failure === 'persist' ? ['persist'] : ['persist', 'submit']);
  }
});

test('accepted invoice cleanup survives editor detachment and cleanup failure without stale UI delivery or another request', async () => {
  for (const scenario of [{ native: true, detach: false }, { native: true, detach: true }, { native: false, detach: false }]) {
    const completion = createFormCompletion(scenario.native); const token = completion.openReview()!;
    const events: string[] = []; const request = deferred<typeof canonical>(); let submissions = 0; let clears = 0;
    const cleanupError = new Error('local cleanup unavailable');
    const pending = completion.run({ ...callbacks(events), reviewToken: token,
      attempt: async () => {
        const result = await persistAndSubmitDraft({
          persist: async () => { events.push('persist'); },
          submit: async () => { submissions++; events.push('submit'); return request.promise; },
          clear: async () => { clears++; events.push('clear'); if (scenario.detach) throw cleanupError; },
          cleanupError: error => { assert.equal(error, cleanupError); events.push('cleanupError'); },
        });
        return { accepted: true as const, result };
      },
    });
    await turn(); assert.deepEqual(events, ['busy:true', 'persist', 'submit']);
    if (scenario.detach) completion.dispose();
    request.resolve(canonical); await turn();
    assert.equal(submissions, 1); assert.equal(clears, 1);
    if (scenario.detach) {
      assert.equal(await pending, 'detached');
      assert.deepEqual(events, ['busy:true', 'persist', 'submit', 'clear', 'cleanupError']);
    } else {
      if (scenario.native) { assert.ok(!events.includes('saved')); completion.dismissed(token); }
      assert.equal(await pending, 'accepted');
      assert.deepEqual(events, ['busy:true', 'persist', 'submit', 'clear', 'accepted', 'reset', 'hide', 'saved', 'busy:false']);
    }
  }
});

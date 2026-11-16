import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoalescedRefresh } from '../src/refresh-coordinator';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('overlapping workspace refresh requests coalesce into one awaited follow-up', async () => {
  const queue = createCoalescedRefresh();
  const first = deferred();
  const second = deferred();
  const secondStarted = deferred();
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    if (calls === 1) await first.promise;
    if (calls === 2) {
      secondStarted.resolve();
      await second.promise;
    }
  };

  const initial = queue(refresh);
  await Promise.resolve();
  assert.equal(calls, 1, 'the first server refresh starts once');

  const joined = queue(refresh);
  const created = queue(refresh);
  assert.equal(calls, 1, 'join/create refresh requests do not overlap the in-flight request');

  first.resolve();
  await secondStarted.promise;
  assert.equal(calls, 2, 'a request received during the first refresh schedules one follow-up');

  const selection = queue(refresh);
  second.resolve();
  await Promise.all([initial, joined, created, selection]);
  assert.equal(calls, 3, 'requests received during the follow-up coalesce into one further refresh');
});

test('a failed refresh releases the queue for the next explicit attempt', async () => {
  const queue = createCoalescedRefresh();
  const failure = new Error('isolated refresh failure');
  await assert.rejects(queue(async () => { throw failure; }), error => error === failure);
  let calls = 0;
  await queue(async () => { calls += 1; });
  assert.equal(calls, 1);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {farmTimeToUtc, localDateTime, farmDate} from '../src/lib/time.ts';

test('farm entry keeps Harare wall time independent of the owner device timezone', () => {
  const oldTZ = process.env.TZ;
  try {
    for (const zone of ['Europe/Berlin', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      assert.equal(farmTimeToUtc('2026-11-03T10:30', 'Africa/Harare'), '2026-11-03T08:30:00.000Z');
      assert.equal(localDateTime('2026-11-03T23:30:00Z', 'Africa/Harare'), '2026-11-04T01:30');
      assert.equal(farmDate('2026-11-03T23:30:00Z', 'Africa/Harare'), '2026-11-04');
    }
  } finally {if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ;}
});
test('invalid calendar dates and nonexistent farm times fail instead of normalising', () => {
  assert.throws(() => farmTimeToUtc('2026-02-30T10:00', 'Africa/Harare'), /invalid_time/);
  assert.throws(() => farmTimeToUtc('2026-11-03T25:00', 'Africa/Harare'), /invalid_time/);
  assert.throws(() => farmTimeToUtc('2026-03-29T02:30', 'Europe/Berlin'), /invalid_time/);
});

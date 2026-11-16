import {test} from 'node:test';
import assert from 'node:assert/strict';
import {farmTimeToUtc, localDateTime, farmDate, currencyMinorUnit, displayMoney, displayNumber} from '../src/lib/time.ts';

test('legacy money and report cells preserve supported currency precision without converting unknown amounts to zero', () => {
  assert.equal(currencyMinorUnit('USD'), 2);
  assert.equal(currencyMinorUnit('JPY'), 0);
  assert.equal(currencyMinorUnit('KWD'), 3);
  for (const language of ['sn', 'nd']) {
    assert.equal(displayMoney('12.50', 'USD', language), 'USD 12.50');
    assert.equal(displayMoney('1250', 'JPY', language), 'JPY 1,250');
    assert.equal(displayMoney('12.345', 'KWD', language), 'KWD 12.345');
    assert.equal(displayMoney(null, 'KWD', language), '—');
    assert.equal(displayNumber('12.345', language, currencyMinorUnit('KWD')), '12.345');
    assert.equal(displayNumber('1250', language, currencyMinorUnit('JPY')), '1,250');
  }
});

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

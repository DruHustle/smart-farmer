import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraPlaybackReducer,
  cameraPlaybackView,
  createCameraPlaybackState,
} from '../src/camera-playback';

type Event = Parameters<typeof cameraPlaybackReducer>[1];

const apply = (events: Event[]) => events.reduce(cameraPlaybackReducer, createCameraPlaybackState());
const completedClip = (): Event[] => [
  { type: 'status', status: 'loading' },
  { type: 'status', status: 'readyToPlay' },
  { type: 'playing', playing: true },
  { type: 'ended' },
  { type: 'status', status: 'idle' },
  { type: 'playing', playing: false },
];

test('a decoded clip remains completed after Expo Android emits ended then idle', () => {
  let state = createCameraPlaybackState();
  state = cameraPlaybackReducer(state, { type: 'status', status: 'readyToPlay' });
  assert.equal(cameraPlaybackView(state), 'ready');
  state = cameraPlaybackReducer(state, { type: 'ended' });
  assert.equal(cameraPlaybackView(state), 'completed');
  // The recorded four-second private clip had ended before the UI observer ran.
  state = cameraPlaybackReducer(state, { type: 'status', status: 'idle' });
  state = cameraPlaybackReducer(state, { type: 'playing', playing: false });
  assert.equal(cameraPlaybackView(state), 'completed');
});

test('initial idle, buffering, pausing and an idle transition do not invent completion', () => {
  assert.equal(cameraPlaybackView(createCameraPlaybackState()), 'loading');
  assert.equal(cameraPlaybackView(apply([
    { type: 'playing', playing: false },
    { type: 'status', status: 'loading' },
    { type: 'status', status: 'idle' },
  ])), 'loading');
  assert.equal(cameraPlaybackView(apply([
    { type: 'status', status: 'readyToPlay' },
    { type: 'playing', playing: false },
  ])), 'ready');
  assert.equal(cameraPlaybackView(apply([
    { type: 'status', status: 'readyToPlay' },
    { type: 'status', status: 'idle' },
  ])), 'loading');
});

test('replay requires new readiness and cannot reuse the previous completion marker', () => {
  let state = apply(completedClip());
  assert.equal(cameraPlaybackView(state), 'completed');
  state = cameraPlaybackReducer(state, { type: 'playing', playing: true });
  assert.equal(cameraPlaybackView(state), 'loading');
  state = cameraPlaybackReducer(state, { type: 'status', status: 'readyToPlay' });
  assert.equal(cameraPlaybackView(state), 'ready');
  state = cameraPlaybackReducer(state, { type: 'ended' });
  state = cameraPlaybackReducer(state, { type: 'status', status: 'idle' });
  assert.equal(cameraPlaybackView(state), 'completed');
});

test('a replaced or rebuffering source cannot retain a previous clip completion', () => {
  for (const event of [
    { type: 'source', status: 'idle' },
    { type: 'status', status: 'loading' },
    { type: 'status', status: 'readyToPlay' },
  ] satisfies Event[]) {
    const state = cameraPlaybackReducer(apply(completedClip()), event);
    assert.equal(cameraPlaybackView(state), event.status === 'readyToPlay' ? 'ready' : 'loading');
  }
});

test('initial and later media errors override completion and remain failed for that lease', () => {
  assert.equal(cameraPlaybackView(createCameraPlaybackState('error')), 'error');
  let state = cameraPlaybackReducer(apply(completedClip()), { type: 'status', status: 'error' });
  assert.equal(cameraPlaybackView(state), 'error');
  for (const event of [
    { type: 'ended' },
    { type: 'status', status: 'idle' },
    { type: 'status', status: 'readyToPlay' },
    { type: 'playing', playing: true },
    { type: 'source', status: 'readyToPlay' },
  ] satisfies Event[]) {
    state = cameraPlaybackReducer(state, event);
    assert.equal(cameraPlaybackView(state), 'error');
  }
});

test('session expiry overrides every later playback, replay, source and error event', () => {
  let state = cameraPlaybackReducer(apply(completedClip()), { type: 'expire' });
  assert.equal(cameraPlaybackView(state), 'expired');
  for (const event of [
    { type: 'ended' },
    { type: 'status', status: 'idle' },
    { type: 'status', status: 'error' },
    { type: 'playing', playing: true },
    { type: 'source', status: 'readyToPlay' },
  ] satisfies Event[]) {
    state = cameraPlaybackReducer(state, event);
    assert.equal(cameraPlaybackView(state), 'expired');
  }
});

test('a new session starts independently from a completed, failed or expired previous lease', () => {
  const previous = apply([
    ...completedClip(),
    { type: 'status', status: 'error' },
    { type: 'expire' },
  ]);
  assert.equal(cameraPlaybackView(previous), 'expired');
  assert.equal(cameraPlaybackView(createCameraPlaybackState()), 'loading');
  assert.equal(cameraPlaybackView(createCameraPlaybackState('readyToPlay')), 'ready');
  assert.equal(cameraPlaybackView(createCameraPlaybackState('error')), 'error');
});

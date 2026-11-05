import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VideoPlayerEvents, VideoPlayerStatus } from 'expo-video';
import { observePrivatePlayback, type PrivatePlaybackPlayer, type PrivatePlaybackState } from '../src/private-playback';
import { completionText } from '../src/completion-i18n';

type PlaybackEvents = Pick<VideoPlayerEvents, 'statusChange' | 'playToEnd' | 'playingChange'>;
class NativePlayer implements PrivatePlaybackPlayer {
  value: VideoPlayerStatus = 'idle';
  pauseCount = 0;
  beforeStatusRead?: () => void;
  listeners: { [Event in keyof PlaybackEvents]: Set<PlaybackEvents[Event]> } = { statusChange: new Set(), playToEnd: new Set(), playingChange: new Set() };
  get status() { this.beforeStatusRead?.(); return this.value; }
  pause() { this.pauseCount++; }
  addListener<Event extends keyof PlaybackEvents>(event: Event, listener: PlaybackEvents[Event]) {
    const listeners = this.listeners[event] as Set<PlaybackEvents[Event]>;
    listeners.add(listener); return { remove: () => { listeners.delete(listener); } };
  }
  statusChange(status: VideoPlayerStatus) {
    const oldStatus = this.value; this.value = status;
    for (const listener of this.listeners.statusChange) listener({ status, oldStatus });
  }
  playToEnd() { for (const listener of this.listeners.playToEnd) listener(); }
  playingChange(isPlaying: boolean) { for (const listener of this.listeners.playingChange) listener({ isPlaying }); }
}
const future = () => Date.now() + 300_000;

test('native ready, playToEnd, idle remains completed; reload and replay require fresh readiness', () => {
  const player = new NativePlayer(); const states: PrivatePlaybackState[] = [];
  const stop = observePrivatePlayback(player, future(), state => states.push(state));
  try {
    assert.equal(states.at(-1), 'loading', 'Initial idle is not decoder readiness');
    player.statusChange('loading'); assert.equal(states.at(-1), 'loading');
    player.statusChange('readyToPlay'); assert.equal(states.at(-1), 'ready');
    // expo-video Android updates its native property, emits playToEnd, then statusChange(idle).
    player.value = 'idle'; player.playToEnd(); player.statusChange('idle'); player.playingChange(false);
    assert.equal(states.at(-1), 'completed');
    player.statusChange('loading'); assert.equal(states.at(-1), 'loading', 'Reload removes the completion receipt');
    player.statusChange('readyToPlay'); assert.equal(states.at(-1), 'ready');
    // iOS can finish and replay without leaving readyToPlay.
    player.playToEnd(); player.playingChange(false); assert.equal(states.at(-1), 'completed');
    player.playingChange(true); assert.equal(states.at(-1), 'ready', 'Actual replay removes the completed label');
    for (const language of ['sn', 'nd'] as const) {
      assert.ok(completionText(language, 'playbackCompleted'));
      assert.notEqual(completionText(language, 'playbackCompleted'), completionText(language, 'playbackReady'));
    }
  } finally { stop(); }
});

test('observers are installed before the initial native status snapshot and already-ready players are recognized', () => {
  const player = new NativePlayer(); const states: PrivatePlaybackState[] = [];
  player.beforeStatusRead = () => {
    for (const listeners of Object.values(player.listeners)) assert.equal(listeners.size, 1, 'No native event may fall into a snapshot/listen gap');
    player.statusChange('readyToPlay');
  };
  const stop = observePrivatePlayback(player, future(), state => states.push(state));
  try { assert.equal(states.at(-1), 'ready'); } finally { stop(); }
});

test('native errors stay terminal even when completion or readiness events arrive afterward', () => {
  const player = new NativePlayer(); const states: PrivatePlaybackState[] = [];
  const stop = observePrivatePlayback(player, future(), state => states.push(state));
  try {
    player.statusChange('readyToPlay'); player.playToEnd(); player.statusChange('error');
    assert.equal(states.at(-1), 'failed');
    for (const status of ['idle', 'loading', 'readyToPlay'] as const) { player.statusChange(status); assert.equal(states.at(-1), 'failed'); }
    player.playToEnd(); player.playingChange(true); assert.equal(states.at(-1), 'failed');
  } finally { stop(); }
  const failedPlayer = new NativePlayer(); const failedStates: PrivatePlaybackState[] = [];
  const stopFailed = observePrivatePlayback(failedPlayer, future(), state => failedStates.push(state));
  try {
    // Native status can already be error when playToEnd arrives before its statusChange event.
    failedPlayer.value = 'error'; failedPlayer.playToEnd(); failedPlayer.statusChange('error');
    assert.deepEqual(failedStates, ['loading', 'failed', 'failed']);
  } finally { stopFailed(); }
});

test('session expiry pauses playback and overrides completed, failed, and late native events', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  const player = new NativePlayer(); const states: PrivatePlaybackState[] = [];
  const stop = observePrivatePlayback(player, 2_000, state => states.push(state));
  try {
    player.statusChange('readyToPlay'); player.playToEnd(); assert.equal(states.at(-1), 'completed');
    context.mock.timers.tick(999); assert.equal(player.pauseCount, 0);
    context.mock.timers.tick(1); assert.equal(player.pauseCount, 1); assert.equal(states.at(-1), 'expired');
    player.statusChange('error'); player.statusChange('readyToPlay'); player.playToEnd(); player.playingChange(true);
    assert.equal(states.at(-1), 'expired');
    const alreadyExpired = new NativePlayer(); alreadyExpired.value = 'readyToPlay'; const expiredStates: PrivatePlaybackState[] = [];
    const stopExpired = observePrivatePlayback(alreadyExpired, 1_500, state => expiredStates.push(state));
    try { assert.deepEqual(expiredStates, ['expired']); assert.equal(alreadyExpired.pauseCount, 1); } finally { stopExpired(); }
  } finally { stop(); }
});

test('cleanup removes all observers and expiry work, including already queued native callbacks', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  const player = new NativePlayer(); const states: PrivatePlaybackState[] = [];
  const stop = observePrivatePlayback(player, 2_000, state => states.push(state));
  const statusQueued = [...player.listeners.statusChange][0]!; const endQueued = [...player.listeners.playToEnd][0]!; const playingQueued = [...player.listeners.playingChange][0]!;
  stop(); stop();
  for (const listeners of Object.values(player.listeners)) assert.equal(listeners.size, 0);
  statusQueued({ status: 'readyToPlay' }); endQueued(); playingQueued({ isPlaying: true }); context.mock.timers.tick(2_000);
  assert.deepEqual(states, ['loading']); assert.equal(player.pauseCount, 0);
});

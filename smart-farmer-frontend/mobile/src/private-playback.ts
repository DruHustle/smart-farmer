import type { VideoPlayerEvents, VideoPlayerStatus } from 'expo-video';

export type PrivatePlaybackState = 'loading' | 'ready' | 'completed' | 'failed' | 'expired';
type PlaybackEvents = Pick<VideoPlayerEvents, 'statusChange' | 'playToEnd' | 'playingChange'>;
export type PrivatePlaybackPlayer = {
  readonly status: VideoPlayerStatus;
  pause(): void;
  addListener<Event extends keyof PlaybackEvents>(event: Event, listener: PlaybackEvents[Event]): { remove(): void };
};

/** Observe native playback without treating initial idle or buffering as decoder readiness. */
export function observePrivatePlayback(player: PrivatePlaybackPlayer, expiresAt: number, onChange: (state: PrivatePlaybackState) => void): () => void {
  let active = true; let status: VideoPlayerStatus = 'idle'; let completed = false; let failed = false; let expired = false;
  function publish() {
    if (!active) return;
    if (!expired && Date.now() >= expiresAt) { expired = true; player.pause(); }
    onChange(expired ? 'expired' : failed ? 'failed' : completed ? 'completed' : status === 'readyToPlay' ? 'ready' : 'loading');
  }
  // Subscribe before the initial status read: a native ready event must not fall into a read/listen gap.
  const listeners = [
    player.addListener('statusChange', event => {
      if (!active) return;
      status = event.status;
      if (status === 'error') failed = true;
      if (status === 'loading' || status === 'readyToPlay') completed = false;
      publish();
    }),
    player.addListener('playToEnd', () => {
      if (!active) return;
      // Android emits successful completion before changing readyToPlay to idle.
      if (player.status === 'error') failed = true;
      completed = true; publish();
    }),
    player.addListener('playingChange', event => {
      if (!active || !event.isPlaying) return;
      // iOS can replay while its status remains readyToPlay, without another status event.
      completed = false; status = player.status;
      if (status === 'error') failed = true;
      publish();
    }),
  ];
  status = player.status;
  if (status === 'error') failed = true;
  publish();
  const timer = expired ? undefined : setTimeout(() => {
    if (!active) return;
    expired = true; player.pause(); publish();
  }, Math.max(0, expiresAt - Date.now()));
  return () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    for (const listener of listeners) listener.remove();
  };
}

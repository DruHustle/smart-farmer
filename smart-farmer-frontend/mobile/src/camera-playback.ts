export type CameraPlaybackStatus = 'idle' | 'loading' | 'readyToPlay' | 'error';
export type CameraPlaybackState = {
  status: CameraPlaybackStatus;
  completed: boolean;
  failed: boolean;
  expired: boolean;
};
export type CameraPlaybackEvent =
  | { type: 'status'; status: CameraPlaybackStatus }
  | { type: 'ended' }
  | { type: 'playing'; playing: boolean }
  | { type: 'source'; status: CameraPlaybackStatus }
  | { type: 'expire' };

export function createCameraPlaybackState(status: CameraPlaybackStatus = 'idle'): CameraPlaybackState {
  return { status, completed: false, failed: status === 'error', expired: false };
}

export function cameraPlaybackReducer(state: CameraPlaybackState, event: CameraPlaybackEvent): CameraPlaybackState {
  switch (event.type) {
    case 'status':
      return { ...state, status: event.status, completed: event.status === 'idle' && state.completed, failed: state.failed || event.status === 'error' };
    case 'ended':
      // Expo emits playToEnd before statusChange(idle) for normal Android completion.
      return { ...state, completed: !state.failed && !state.expired };
    case 'playing':
      return event.playing ? { ...state, completed: false } : state;
    case 'source':
      return { ...state, status: event.status, completed: false, failed: state.failed || event.status === 'error' };
    case 'expire':
      return { ...state, expired: true, completed: false };
  }
}

export function cameraPlaybackView(state: CameraPlaybackState): 'loading' | 'ready' | 'completed' | 'error' | 'expired' {
  if (state.expired) return 'expired';
  if (state.failed || state.status === 'error') return 'error';
  if (state.completed) return 'completed';
  return state.status === 'readyToPlay' ? 'ready' : 'loading';
}

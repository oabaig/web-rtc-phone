export type CallPhase =
  | 'joining' // connecting socket + joining the room
  | 'waiting' // in the room, no peer yet
  | 'connecting' // peer present, media + ICE negotiation in progress
  | 'connected' // audio flowing peer-to-peer
  | 'ended' // we hung up or the peer left
  | 'error';

export interface CallState {
  phase: CallPhase;
  isMuted: boolean;
  /** Human-readable reason shown on the 'ended' and 'error' screens. */
  message: string | null;
}

export type CallAction =
  | { type: 'phase'; phase: CallPhase }
  | { type: 'muted'; muted: boolean }
  | { type: 'peer-left' }
  | { type: 'ended'; message: string }
  | { type: 'error'; message: string };

export function callReducer(state: CallState, action: CallAction): CallState {
  switch (action.type) {
    case 'phase':
      // Terminal states win over late-firing connection events.
      if (state.phase === 'ended' || state.phase === 'error') return state;
      return { ...state, phase: action.phase, message: null };
    case 'peer-left':
      // Not terminal: the call recovers automatically if the peer comes
      // back to the room (e.g. after a mid-call refresh).
      if (state.phase === 'ended' || state.phase === 'error') return state;
      return {
        phase: 'waiting',
        isMuted: false,
        message: 'The other person left the call.',
      };
    case 'muted':
      return { ...state, isMuted: action.muted };
    case 'ended':
      return { ...state, phase: 'ended', message: action.message };
    case 'error':
      return { ...state, phase: 'error', message: action.message };
  }
}

export const initialCallState: CallState = {
  phase: 'joining',
  isMuted: false,
  message: null,
};

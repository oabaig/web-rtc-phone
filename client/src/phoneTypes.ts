/**
 * Where the softphone registers: a PBX extension reached over SIP-over-WSS.
 *
 * Entered in the browser and kept in localStorage — never baked into the
 * build. The image on GHCR is public, and the app has no login, so anything
 * shipped with it would hand the extension's password to every visitor.
 */
export interface SipSettings {
  /** WebSocket URL of the PBX's SIP-over-WSS listener, e.g. wss://pbx.example.com:8089/ws */
  server: string;
  /** SIP domain for the address of record; usually the PBX hostname. */
  domain: string;
  /** The extension's SIP username (PBXware: the extension's "Username"). */
  username: string;
  /** The extension's SIP password (PBXware: "Secret"). */
  password: string;
  /** Optional caller name; the PBX may override it with the extension's own. */
  displayName: string;
}

const SETTINGS_KEY = 'sip-settings';

export function loadSipSettings(): SipSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as SipSettings) : null;
  } catch {
    return null;
  }
}

export function saveSipSettings(settings: SipSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function clearSipSettings() {
  localStorage.removeItem(SETTINGS_KEY);
}

export type Registration =
  | 'connecting' // opening the WebSocket + first REGISTER
  | 'registered' // the PBX will route calls for this extension to us
  | 'unregistered' // connected, but the registration lapsed
  | 'error';

export type PhoneCallPhase =
  | 'idle'
  | 'outgoing' // INVITE sent, waiting for an answer
  | 'incoming' // INVITE received, ringing locally
  | 'active'; // answered, audio flowing via the PBX

export interface PhoneState {
  registration: Registration;
  call: PhoneCallPhase;
  /** Number dialled or caller ID shown for the current call. */
  remoteParty: string | null;
  isMuted: boolean;
  /** Last notable outcome ("Busy", "Missed call from …") or the fatal error. */
  message: string | null;
}

export type PhoneAction =
  | { type: 'registration'; registration: Exclude<Registration, 'error'> }
  | { type: 'outgoing'; remoteParty: string }
  | { type: 'incoming'; remoteParty: string }
  | { type: 'answered' }
  | { type: 'call-ended'; message: string | null }
  | { type: 'muted'; muted: boolean }
  | { type: 'error'; message: string };

export function phoneReducer(state: PhoneState, action: PhoneAction): PhoneState {
  switch (action.type) {
    case 'registration':
      // A fatal error (bad credentials, unreachable PBX) stays on screen.
      if (state.registration === 'error') return state;
      return { ...state, registration: action.registration };
    case 'outgoing':
    case 'incoming':
      return {
        ...state,
        call: action.type,
        remoteParty: action.remoteParty,
        isMuted: false,
        message: null,
      };
    case 'answered':
      return { ...state, call: 'active' };
    case 'call-ended':
      return { ...state, call: 'idle', remoteParty: null, isMuted: false, message: action.message };
    case 'muted':
      return { ...state, isMuted: action.muted };
    case 'error':
      return { ...state, registration: 'error', message: action.message };
  }
}

export const initialPhoneState: PhoneState = {
  registration: 'connecting',
  call: 'idle',
  remoteParty: null,
  isMuted: false,
  message: null,
};

import { useEffect, useMemo, useReducer, useRef, type RefObject } from 'react';
import {
  Invitation,
  Inviter,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
  Web,
  type Session,
} from 'sip.js';
import { RTC_CONFIG } from '../config';
import { initialPhoneState, phoneReducer, type SipSettings } from '../phoneTypes';

/**
 * A SIP softphone: registers this browser as one extension on the PBX, then
 * places and answers calls through it.
 *
 * Unlike useCall this is not peer-to-peer. The PBX (Asterisk, under PBXware)
 * is the far end of every WebRTC connection: it terminates ICE and
 * DTLS-SRTP, then bridges the audio onward — to another extension, or out a
 * trunk to the phone network. Signaling is real SIP (REGISTER, INVITE, BYE)
 * over a WebSocket straight to the PBX; our Socket.io server isn't involved.
 *
 * SIP.js owns the RTCPeerConnection (inside its SessionDescriptionHandler)
 * and the SIP transactions. The SDP offer/answer is the same exchange as in
 * a room call, carried in INVITE / 200 OK instead of our 'description'
 * event. One difference: SIP doesn't trickle ICE, so SIP.js waits for
 * candidate gathering to finish and sends every candidate in a single SDP.
 */

const AUDIO_ONLY = { constraints: { audio: true, video: false } };

interface PhoneActions {
  dial(number: string): void;
  answer(): void;
  decline(): void;
  hangUp(): void;
  toggleMute(): void;
  sendDtmf(tone: string): void;
}

const NO_ACTIONS: PhoneActions = {
  dial() {},
  answer() {},
  decline() {},
  hangUp() {},
  toggleMute() {},
  sendDtmf() {},
};

/** The one call in progress, with what we need to explain how it ended. */
interface ActiveCall {
  session: Session;
  answered: boolean;
  /** We hung up, cancelled or declined — no failure message wanted. */
  endedLocally: boolean;
}

export function usePhone(
  settings: SipSettings,
  remoteAudioRef: RefObject<HTMLAudioElement | null>,
) {
  const [state, dispatch] = useReducer(phoneReducer, initialPhoneState);
  const actionsRef = useRef<PhoneActions>(NO_ACTIONS);

  useEffect(() => {
    if (!window.isSecureContext) {
      dispatch({
        type: 'error',
        message:
          'This app needs a secure origin (HTTPS) for microphone access. Open it via localhost or an HTTPS URL.',
      });
      return;
    }

    const aor = UserAgent.makeURI(`sip:${settings.username}@${settings.domain}`);
    if (!aor) {
      dispatch({ type: 'error', message: 'The SIP username or domain is not valid.' });
      return;
    }

    let disposed = false;
    // One call at a time: a second incoming INVITE is answered 486 Busy Here.
    let active: ActiveCall | null = null;
    const ringer = createRinger();

    function fail(message: string) {
      if (!disposed) dispatch({ type: 'error', message });
    }

    function playRemote(stream: MediaStream) {
      const audio = remoteAudioRef.current;
      if (!audio) return;
      const play = () =>
        audio.play().catch(() => {
          /* autoplay policy; audio starts on next user gesture */
        });
      audio.srcObject = stream;
      // SIP.js adds the remote track to this stream once the answer SDP is
      // applied — after we've attached it — so restart playback when it does.
      stream.onaddtrack = () => {
        audio.load();
        void play();
      };
      void play();
    }

    function track(session: Session, remoteParty: string): ActiveCall {
      const call: ActiveCall = { session, answered: false, endedLocally: false };
      active = call;

      session.delegate = {
        // Runs when SIP.js creates the peer connection. For an outgoing call
        // that's before the INVITE leaves, so early media — a carrier's
        // ringback or "the number you have dialed…" in a 183 — is audible.
        onSessionDescriptionHandler: (sdh) => {
          if (sdh instanceof Web.SessionDescriptionHandler) playRemote(sdh.remoteMediaStream);
        },
      };

      session.stateChange.addListener((sessionState) => {
        if (sessionState === SessionState.Established) {
          call.answered = true;
          ringer.stop();
          if (!disposed) dispatch({ type: 'answered' });
        } else if (sessionState === SessionState.Terminated) {
          ringer.stop();
          if (active === call) active = null;
          if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
          if (disposed) return;
          const missed =
            session instanceof Invitation && !call.answered && !call.endedLocally;
          dispatch({
            type: 'call-ended',
            message: missed ? `Missed call from ${remoteParty}.` : null,
          });
        }
      });

      return call;
    }

    function handleIncoming(invitation: Invitation) {
      if (active) {
        void invitation.reject({ statusCode: 486 });
        return;
      }
      const { displayName, uri } = invitation.remoteIdentity;
      const number = uri.user ?? 'Unknown';
      const caller = displayName && displayName !== number ? `${displayName} (${number})` : number;
      track(invitation, caller);
      dispatch({ type: 'incoming', remoteParty: caller });
      ringer.start();
    }

    /**
     * Explain a failed call. SIP.js terminates the session before a rejection
     * or setup error reaches us, so this lands just after the state
     * listener's plain 'call-ended' — skipped if a newer call has started
     * since, or if the "failure" is our own hang-up (e.g. the 487 Request
     * Terminated that confirms a CANCEL).
     */
    function reportFailure(call: ActiveCall, message: string) {
      if (disposed || call.endedLocally || active !== null) return;
      dispatch({ type: 'call-ended', message });
    }

    const userAgent = new UserAgent({
      uri: aor,
      authorizationUsername: settings.username,
      authorizationPassword: settings.password,
      displayName: settings.displayName || undefined,
      transportOptions: { server: settings.server },
      // Same STUN servers as room calls. The PBX sits on a public address,
      // so the browser's own server-reflexive candidate is enough to reach it.
      sessionDescriptionHandlerFactoryOptions: { peerConnectionConfiguration: RTC_CONFIG },
      logLevel: 'warn',
      delegate: {
        onInvite: handleIncoming,
        onDisconnect: (error) => {
          // error is undefined when we closed the socket ourselves.
          if (error) fail('Lost the connection to the PBX. Reconnect to keep receiving calls.');
        },
      },
    });

    const registerer = new Registerer(userAgent);
    registerer.stateChange.addListener((registrationState) => {
      if (disposed) return;
      if (registrationState === RegistererState.Registered) {
        dispatch({ type: 'registration', registration: 'registered' });
      } else if (registrationState === RegistererState.Unregistered) {
        dispatch({ type: 'registration', registration: 'unregistered' });
      }
    });

    userAgent
      .start()
      .then(() => {
        if (disposed) return;
        return registerer.register({
          requestDelegate: {
            // SIP.js answers the 401 digest challenge itself; a rejection
            // that still reaches us means the PBX refused the credentials.
            onReject: ({ message: { statusCode, reasonPhrase } }) =>
              fail(
                statusCode === 401 || statusCode === 403
                  ? `The PBX rejected the extension's credentials (${statusCode} ${reasonPhrase}). Check the username and password.`
                  : `Registration failed: ${statusCode} ${reasonPhrase}`,
              ),
          },
        });
      })
      .catch(() =>
        fail(
          `Could not connect to ${settings.server}. Check the URL, and that WebRTC (WSS) is enabled on the PBX and reachable from here.`,
        ),
      );

    actionsRef.current = {
      dial(number) {
        if (active) return;
        // '#' starts a URI fragment; dial strings like *72# need it escaped.
        const target = UserAgent.makeURI(
          `sip:${number.replaceAll('#', '%23')}@${settings.domain}`,
        );
        if (!target) {
          dispatch({ type: 'call-ended', message: `"${number}" isn't a dialable number.` });
          return;
        }
        const inviter = new Inviter(userAgent, target, {
          earlyMedia: true,
          sessionDescriptionHandlerOptions: AUDIO_ONLY,
        });
        const call = track(inviter, number);
        dispatch({ type: 'outgoing', remoteParty: number });
        inviter
          .invite({
            requestDelegate: {
              onReject: ({ message: { statusCode, reasonPhrase } }) =>
                reportFailure(call, describeRejection(statusCode, reasonPhrase)),
            },
          })
          .catch((err) => reportFailure(call, startFailureMessage(err)));
      },

      answer() {
        const call = active;
        if (!(call?.session instanceof Invitation) || call.session.state !== SessionState.Initial) {
          return;
        }
        ringer.stop();
        call.session
          .accept({ sessionDescriptionHandlerOptions: AUDIO_ONLY })
          .catch((err) => reportFailure(call, startFailureMessage(err)));
      },

      decline() {
        const call = active;
        if (!(call?.session instanceof Invitation) || call.session.state !== SessionState.Initial) {
          return;
        }
        call.endedLocally = true;
        // Busy Here: the PBX treats it as busy (typically voicemail) rather
        // than ringing out the full no-answer timeout.
        void call.session.reject({ statusCode: 486 });
      },

      hangUp() {
        const call = active;
        if (!call) return;
        call.endedLocally = true;
        const { session } = call;
        if (session.state === SessionState.Established) {
          void session.bye();
        } else if (session instanceof Inviter) {
          void session.cancel();
        } else if (session instanceof Invitation && session.state === SessionState.Initial) {
          void session.reject({ statusCode: 486 });
        }
      },

      toggleMute() {
        const sdh = active?.session.sessionDescriptionHandler;
        if (!(sdh instanceof Web.SessionDescriptionHandler)) return;
        // The track is the source of truth; state just mirrors it for the UI.
        const audioTrack = sdh.localMediaStream.getAudioTracks()[0];
        if (!audioTrack) return;
        audioTrack.enabled = !audioTrack.enabled;
        dispatch({ type: 'muted', muted: !audioTrack.enabled });
      },

      sendDtmf(tone) {
        const session = active?.session;
        const sdh = session?.sessionDescriptionHandler;
        if (session?.state !== SessionState.Established) return;
        if (!(sdh instanceof Web.SessionDescriptionHandler)) return;
        // RFC 4733 telephone-events via RTCDTMFSender. An IVR behind the PBX
        // listens for these, not for beeps played into the microphone.
        // Append rather than use SIP.js's sendDtmf(): insertDTMF() replaces
        // any tones still queued, so quick presses (a PIN) would drop digits.
        const dtmf = sdh.peerConnection
          ?.getSenders()
          .find((sender) => sender.track?.kind === 'audio')?.dtmf;
        if (dtmf?.canInsertDTMF) dtmf.insertDTMF(dtmf.toneBuffer + tone);
      },
    };

    // Closing the tab skips React cleanup. Un-REGISTER anyway so the PBX
    // doesn't keep ringing a contact that no longer exists.
    const onPageHide = () => void userAgent.stop().catch(() => {});
    window.addEventListener('pagehide', onPageHide);

    return () => {
      disposed = true;
      window.removeEventListener('pagehide', onPageHide);
      actionsRef.current = NO_ACTIONS;
      ringer.stop();
      // Graceful stop: un-REGISTERs, ends any call (BYE/CANCEL), closes the socket.
      void userAgent.stop().catch(() => {});
    };
  }, [settings, remoteAudioRef]);

  // Stable wrappers, so components can hold them across renders while the
  // effect swaps in implementations bound to the live user agent.
  const actions = useMemo<PhoneActions>(
    () => ({
      dial: (number) => actionsRef.current.dial(number),
      answer: () => actionsRef.current.answer(),
      decline: () => actionsRef.current.decline(),
      hangUp: () => actionsRef.current.hangUp(),
      toggleMute: () => actionsRef.current.toggleMute(),
      sendDtmf: (tone) => actionsRef.current.sendDtmf(tone),
    }),
    [],
  );

  return { ...state, ...actions };
}

/** Final responses worth explaining; anything else shows the raw status line. */
function describeRejection(statusCode?: number, reasonPhrase?: string): string {
  switch (statusCode) {
    case 486:
    case 600:
      return 'Busy.';
    case 480:
    case 408:
      return 'No answer.';
    case 603:
      return 'Call declined.';
    case 404:
    case 484:
      return "The PBX couldn't route that number. Check the format its dial plan expects.";
    case 403:
      return 'The PBX refused the call (403). This extension may not be allowed to dial that destination.';
    case 488:
      return 'The PBX rejected the audio offer (488). Check that WebRTC is enabled on this extension.';
    default:
      return `Call failed: ${statusCode ?? ''} ${reasonPhrase ?? ''}`.trim();
  }
}

function startFailureMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError') {
    return 'Microphone access was denied. Allow it in your browser settings and try again.';
  }
  if (name === 'NotFoundError') return 'No microphone found. Plug one in and try again.';
  return `Could not start the call: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Local ring for incoming calls, synthesised with Web Audio: North American
 * cadence, 440 + 480 Hz, 2 s on / 4 s off. Browsers keep an AudioContext
 * silent until the page has had a click, so after a fresh page load the ring
 * may be mute — the tab title change in PhoneScreen covers that case.
 */
function createRinger() {
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  function burst() {
    if (!ctx) return;
    const gain = ctx.createGain();
    gain.gain.value = 0.1;
    gain.connect(ctx.destination);
    for (const frequency of [440, 480]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = frequency;
      osc.connect(gain);
      osc.start();
      osc.stop(ctx.currentTime + 2);
    }
  }

  return {
    start() {
      if (ctx) return;
      ctx = new AudioContext();
      burst();
      timer = setInterval(burst, 6000);
    },
    stop() {
      clearInterval(timer);
      void ctx?.close();
      ctx = null;
    },
  };
}

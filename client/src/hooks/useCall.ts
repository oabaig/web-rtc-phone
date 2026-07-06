import { useCallback, useEffect, useReducer, useRef, type RefObject } from 'react';
import { io } from 'socket.io-client';
import { RTC_CONFIG, SERVER_URL } from '../config';
import { callReducer, initialCallState } from '../types';

/**
 * All WebRTC + signaling logic for one call. Components consume the returned
 * state and callbacks and never touch RTCPeerConnection or the socket.
 *
 * Uses the "perfect negotiation" pattern (MDN): both peers run the same
 * symmetric code, and offer collisions ("glare") are resolved by the
 * polite/impolite roles the server assigns at join time — the polite peer
 * yields to an incoming offer, the impolite peer ignores it.
 *
 * Everything with a lifetime beyond one render (peer connection, socket,
 * streams, negotiation flags) lives in the effect closure or a ref — never in
 * React state. Handlers attached to the peer connection outlive renders, so
 * closing over useState values would give them stale snapshots.
 */
export function useCall(
  roomCode: string,
  remoteAudioRef: RefObject<HTMLAudioElement | null>,
) {
  const [state, dispatch] = useReducer(callReducer, initialCallState);
  const localStreamRef = useRef<MediaStream | null>(null);
  const hangUpRef = useRef<() => void>(() => {});

  useEffect(() => {
    // getUserMedia only exists in secure contexts (https or localhost).
    if (!window.isSecureContext) {
      dispatch({
        type: 'error',
        message:
          'This app needs a secure origin (HTTPS) for microphone access. Open it via localhost or an HTTPS URL.',
      });
      return;
    }

    let disposed = false;
    let over = false; // terminal for this session: hang-up or fatal error
    let pc: RTCPeerConnection | null = null;
    let localStream: MediaStream | null = null;

    // Perfect-negotiation state
    let polite = false;
    let makingOffer = false;
    let ignoreOffer = false;

    // Remote candidates that arrive before setRemoteDescription resolves
    // would throw InvalidStateError — buffer and flush them instead.
    const pendingCandidates: RTCIceCandidateInit[] = [];

    let startPromise: Promise<void> | null = null;

    const socket = io(SERVER_URL);

    function fail(message: string) {
      over = true;
      dispatch({ type: 'error', message });
    }

    function teardownMedia() {
      pc?.close();
      pc = null;
      // close() does NOT stop tracks — without this the mic stays hot.
      localStream?.getTracks().forEach((track) => track.stop());
      localStream = null;
      localStreamRef.current = null;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
      startPromise = null;
    }

    async function startCall() {
      dispatch({ type: 'phase', phase: 'connecting' });

      // Create the peer connection before awaiting anything so incoming
      // descriptions/candidates always have a pc to land on.
      pc = new RTCPeerConnection(RTC_CONFIG);

      pc.onnegotiationneeded = async () => {
        if (!pc) return;
        try {
          makingOffer = true;
          // Parameterless form: creates the right offer/answer for the
          // current signaling state and applies it in one step.
          await pc.setLocalDescription();
          socket.emit('description', pc.localDescription);
        } catch (err) {
          console.error('negotiation failed', err);
        } finally {
          makingOffer = false;
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit('ice-candidate', candidate);
      };

      pc.ontrack = (event) => {
        // event.streams can be empty depending on how the track was added.
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream;
          remoteAudioRef.current.play().catch(() => {
            /* autoplay policy; audio starts on next user gesture */
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (!pc) return;
        switch (pc.connectionState) {
          case 'connected':
            dispatch({ type: 'phase', phase: 'connected' });
            break;
          case 'disconnected':
            // Often transient (network blip) — ICE may recover on its own.
            dispatch({ type: 'phase', phase: 'connecting' });
            break;
          case 'failed':
            fail(
              'Could not establish a connection. If this happens across networks, a TURN server may be required.',
            );
            break;
        }
      };

      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        const e = err as DOMException;
        fail(
          e.name === 'NotAllowedError'
            ? 'Microphone access was denied. Allow it in your browser settings and reload.'
            : e.name === 'NotFoundError'
              ? 'No microphone found. Plug one in and reload.'
              : `Could not access the microphone: ${e.message}`,
        );
        return;
      }
      if (disposed) {
        teardownMedia();
        return;
      }
      localStreamRef.current = localStream;

      // Adding a track fires onnegotiationneeded — that's what kicks off the
      // offer. Both peers do this at once; the roles resolve the collision.
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    /** Idempotent: both 'peer-joined' and early relayed messages funnel here. */
    function ensureCallStarted() {
      if (over) return Promise.resolve();
      startPromise ??= startCall();
      return startPromise;
    }

    socket.on('connect', () => socket.emit('join-room', roomCode));
    socket.on('connect_error', () => fail('Could not reach the signaling server.'));
    socket.on('room-full', () => fail('This room already has two people in it.'));
    socket.on('join-error', (message: string) => fail(message));

    socket.on(
      'room-joined',
      ({ polite: p, peerPresent }: { polite: boolean; peerPresent: boolean }) => {
        polite = p;
        if (peerPresent) void ensureCallStarted();
        else dispatch({ type: 'phase', phase: 'waiting' });
      },
    );

    socket.on('peer-joined', () => void ensureCallStarted());

    socket.on('description', async (description: RTCSessionDescriptionInit) => {
      await ensureCallStarted();
      if (!pc || disposed) return;

      const offerCollision =
        description.type === 'offer' &&
        (makingOffer || pc.signalingState !== 'stable');
      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return; // impolite peer: our own offer wins

      // For the polite peer mid-collision this implicitly rolls back its
      // own pending offer before applying the remote one.
      await pc.setRemoteDescription(description);

      for (const candidate of pendingCandidates.splice(0)) {
        await pc.addIceCandidate(candidate).catch(console.error);
      }

      if (description.type === 'offer') {
        await pc.setLocalDescription();
        socket.emit('description', pc.localDescription);
      }
    });

    socket.on('ice-candidate', async (candidate: RTCIceCandidateInit) => {
      await ensureCallStarted();
      if (!pc || disposed) return;
      if (!pc.remoteDescription) {
        pendingCandidates.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        // Candidates for an offer we deliberately ignored are expected noise.
        if (!ignoreOffer) console.error('addIceCandidate failed', err);
      }
    });

    socket.on('peer-left', () => {
      teardownMedia();
      // We're alone in the room again: we hold the polite role, and a fresh
      // peer connection is negotiated if (or when) someone rejoins.
      polite = true;
      dispatch({ type: 'peer-left' });
    });

    hangUpRef.current = () => {
      over = true;
      socket.emit('leave');
      teardownMedia();
      dispatch({ type: 'ended', message: 'You left the call.' });
    };

    return () => {
      disposed = true;
      socket.disconnect(); // server treats disconnect like leave
      teardownMedia();
    };
  }, [roomCode, remoteAudioRef]);

  const toggleMute = useCallback(() => {
    // The track is the source of truth; state just mirrors it for the UI.
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    dispatch({ type: 'muted', muted: !track.enabled });
  }, []);

  const hangUp = useCallback(() => hangUpRef.current(), []);

  return { ...state, toggleMute, hangUp };
}

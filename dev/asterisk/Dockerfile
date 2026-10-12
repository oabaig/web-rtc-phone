# A throwaway local PBX for testing the softphone end to end. PBXware is
# Asterisk underneath, so this exercises the same WebRTC path (SIP over a
# WebSocket, DTLS-SRTP, ICE) without touching the real PBX.
#
# Test-only: the extension's password is in this repo, and the CLI can place
# calls. It binds to 127.0.0.1 — never publish its ports.
#
#   docker build -t webrtc-phone-asterisk dev/asterisk
#   docker run -d --rm --name webrtc-phone-asterisk --network host webrtc-phone-asterisk
#
# Host networking keeps ICE simple: Asterisk's RTP candidates are the host's
# own addresses, which the browser on the same host can reach directly.
FROM alpine:3.22
RUN apk add --no-cache asterisk asterisk-srtp
COPY *.conf /etc/asterisk/
CMD ["asterisk", "-f", "-vvv"]

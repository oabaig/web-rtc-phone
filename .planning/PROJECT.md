# WebRTC Phone

## What This Is

A browser-based audio calling app where two users can join a shared room via a code or link and talk to each other in real time. Built with React on the frontend and a Node.js + Socket.io signaling server on the backend. A personal learning project for understanding how WebRTC works end-to-end.

## Core Value

Two people on different devices can open the same room link and have a live audio call — no plugins, no accounts, just WebRTC.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] User can create a room and get a shareable room code/link
- [ ] Second user can join the room using the code/link
- [ ] Both users can hear each other in real-time via WebRTC audio
- [ ] Call works across two different devices on different networks
- [ ] User can end/leave the call

### Out of Scope

- Video — audio-only is the focus; video adds complexity without learning value here
- Authentication / accounts — no login needed, rooms are ephemeral
- Multi-party calls (3+ users) — two-person only for simplicity
- Recording — not needed for a learning project
- Mobile apps — browser only

## Context

- Stack: React (frontend), Node.js + Socket.io (signaling server), WebRTC native browser APIs
- Signaling server relays SDP offers/answers and ICE candidates between peers; audio flows peer-to-peer after handshake
- STUN server (e.g. Google's public stun.l.google.com:19302) needed for NAT traversal; TURN server deferred unless direct P2P fails in testing
- Goal is to understand WebRTC deeply — implementation choices should prioritize clarity over abstraction

## Constraints

- **Tech stack**: React + Node.js + Socket.io — chosen upfront for familiarity and ecosystem support
- **Scope**: Two-user audio only — resist feature creep; this is a learning vehicle
- **Hosting**: Needs HTTPS in production (WebRTC mic access requires a secure context); can use localhost for development

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Socket.io for signaling | Most common WebRTC tutorial stack; well-documented; real-time bidirectional out of the box | — Pending |
| Room code model | Simplest discovery mechanism; no auth required; works for two-person use case | — Pending |
| Audio-only | Reduces complexity significantly; enough to learn core WebRTC peer connection flow | — Pending |

---

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-03 after initialization*

import express from 'express';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server, type Socket } from 'socket.io';

/**
 * Signaling server.
 *
 * Its only job is the rendezvous: track which two sockets share a room and
 * relay their SDP descriptions and ICE candidates to each other. It never
 * parses SDP and never touches audio — once the peers connect, media flows
 * directly between the browsers and this server sits idle.
 */

const MAX_PEERS_PER_ROOM = 2;

// roomCode -> socket ids currently in the room. Rooms are ephemeral:
// created on first join, deleted when the last socket leaves.
const rooms = new Map<string, Set<string>>();

const app = express();

// getUserMedia only exists on secure origins, and localhost is the sole
// HTTP exemption — so testing from another device needs TLS. Point
// TLS_CERT/TLS_KEY at a cert (e.g. self-signed, see certs/) to serve HTTPS;
// unset, the server speaks plain HTTP as before.
const { TLS_CERT, TLS_KEY } = process.env;
const httpServer =
  TLS_CERT && TLS_KEY
    ? createHttpsServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, app)
    : createServer(app);
const io = new Server(httpServer, {
  // Dev: the Vite client runs on a different origin (localhost:5173).
  // Prod: same origin (Express serves the built client below), CORS unused.
  cors: { origin: true },
});

function roomOf(socket: Socket): string | undefined {
  return socket.data.roomCode;
}

function leaveRoom(socket: Socket) {
  const roomCode = roomOf(socket);
  if (!roomCode) return;

  // Everyone except the sender — io.in(room) would echo back to it.
  socket.to(roomCode).emit('peer-left');
  socket.leave(roomCode);
  socket.data.roomCode = undefined;

  const members = rooms.get(roomCode);
  if (members) {
    members.delete(socket.id);
    if (members.size === 0) rooms.delete(roomCode);
  }
  console.log(`[room ${roomCode}] ${socket.id} left (${rooms.get(roomCode)?.size ?? 0} remain)`);
}

io.on('connection', (socket) => {
  console.log(`connected: ${socket.id}`);

  socket.on('join-room', (roomCode: unknown) => {
    if (typeof roomCode !== 'string' || !/^[A-Z0-9-]{4,32}$/i.test(roomCode)) {
      socket.emit('join-error', 'Invalid room code.');
      return;
    }
    if (roomOf(socket)) leaveRoom(socket); // one room per socket

    const members = rooms.get(roomCode) ?? new Set<string>();
    if (members.size >= MAX_PEERS_PER_ROOM) {
      socket.emit('room-full');
      return;
    }

    const peerPresent = members.size > 0;
    members.add(socket.id);
    rooms.set(roomCode, members);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    // Perfect-negotiation roles, fixed at join time: the first peer into the
    // room is "polite" (yields on offer collision), the second is "impolite".
    socket.emit('room-joined', { polite: !peerPresent, peerPresent });
    if (peerPresent) socket.to(roomCode).emit('peer-joined');

    console.log(`[room ${roomCode}] ${socket.id} joined (${members.size}/${MAX_PEERS_PER_ROOM})`);
  });

  // SDP offers and answers are relayed as one event: with perfect
  // negotiation both sides handle them through the same code path.
  socket.on('description', (description: unknown) => {
    const roomCode = roomOf(socket);
    if (roomCode) socket.to(roomCode).emit('description', description);
  });

  socket.on('ice-candidate', (candidate: unknown) => {
    const roomCode = roomOf(socket);
    if (roomCode) socket.to(roomCode).emit('ice-candidate', candidate);
  });

  socket.on('leave', () => leaveRoom(socket));
  socket.on('disconnect', () => {
    leaveRoom(socket);
    console.log(`disconnected: ${socket.id}`);
  });
});

// In production the container serves the built client from this same server,
// so client and signaling share one origin (and one Pangolin HTTPS endpoint).
const clientDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../client/dist',
);
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  console.log(`serving client from ${clientDist}`);
}

const PORT = Number(process.env.PORT ?? 3001);
httpServer.listen(PORT, () => {
  console.log(`signaling server listening on :${PORT} (${TLS_CERT && TLS_KEY ? 'https' : 'http'})`);
});

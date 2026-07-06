/**
 * Scripted check of the signaling protocol (no WebRTC involved).
 * Run with the server up: `node scripts/signaling-test.mjs`
 *
 * Verifies:
 *  - first joiner is polite, second is impolite and sees peerPresent
 *  - first joiner receives peer-joined
 *  - description / ice-candidate relay to the other peer, never echo back
 *  - a third join attempt gets room-full
 *  - disconnect notifies the remaining peer with peer-left
 */
import { io } from 'socket.io-client';

const URL = process.env.SERVER_URL ?? 'http://localhost:3001';
const ROOM = `TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}
const once = (socket, event, timeoutMs = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

const a = io(URL);
const b = io(URL);
const c = io(URL);

let aGotEcho = false;
a.on('description', () => (aGotEcho = true)); // must never fire from A's own send

try {
  // A joins first -> polite, alone
  a.emit('join-room', ROOM);
  const aJoin = await once(a, 'room-joined');
  check('A is polite', aJoin.polite === true);
  check('A sees empty room', aJoin.peerPresent === false);

  // B joins -> impolite, peer present; A gets peer-joined
  const aPeerJoined = once(a, 'peer-joined');
  b.emit('join-room', ROOM);
  const bJoin = await once(b, 'room-joined');
  await aPeerJoined;
  check('B is impolite', bJoin.polite === false);
  check('B sees peer present', bJoin.peerPresent === true);
  check('A notified of peer-joined', true);

  // Relay: A -> B only
  const bGotDescription = once(b, 'description');
  a.emit('description', { type: 'offer', sdp: 'fake-sdp' });
  const desc = await bGotDescription;
  check('B received relayed description', desc?.sdp === 'fake-sdp');

  const aGotCandidate = once(a, 'ice-candidate');
  b.emit('ice-candidate', { candidate: 'fake-candidate' });
  const cand = await aGotCandidate;
  check('A received relayed ice-candidate', cand?.candidate === 'fake-candidate');

  // Third wheel
  c.emit('join-room', ROOM);
  await once(c, 'room-full');
  check('C rejected with room-full', true);

  // B drops -> A gets peer-left
  const aPeerLeft = once(a, 'peer-left');
  b.disconnect();
  await aPeerLeft;
  check('A notified of peer-left on disconnect', true);

  await new Promise((r) => setTimeout(r, 200));
  check('A never received its own messages (no echo)', aGotEcho === false);
} catch (err) {
  failures.push(String(err));
  console.error(`FAIL  ${err}`);
} finally {
  a.disconnect();
  c.disconnect();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nAll signaling checks passed.');
process.exit(0);

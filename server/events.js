// Server-Sent Events hub: pushes note changes and presence to every client a user has open.
import { getUserById } from './users.js';
import { accountStatus } from './sessions.js';

const clients = new Map(); // userId -> Set<{ res, clientId }>

// Accounts can expire (or be deleted) while a stream is open, so re-check before every push and on every ping.
function stillActive(userId) {
  const u = getUserById(userId);
  return Boolean(u) && accountStatus(u) === 'active';
}

export function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const entry = { res, clientId: String(req.query.clientId || '') };
  const userId = req.user.id;
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(entry);
  const ping = setInterval(() => {
    if (stillActive(userId)) res.write(': ping\n\n');
    else kickUser(userId);
  }, 25_000);
  req.on('close', () => {
    clearInterval(ping);
    const set = clients.get(userId);
    set?.delete(entry);
    if (set && !set.size) clients.delete(userId);
  });
}

export function sendToUser(userId, event, data) {
  const set = clients.get(userId);
  if (!set) return;
  if (!stillActive(userId)) return kickUser(userId);
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const { res } of set) res.write(payload);
}

/** Tell every open tab of a user that their account changed, then drop the stream (they reconnect if still allowed). */
export function kickUser(userId) {
  const set = clients.get(userId);
  if (!set) return;
  for (const { res } of set) {
    res.write('event: account\ndata: {}\n\n');
    res.end();
  }
  clients.delete(userId);
}

// Server-Sent Events hub: pushes note changes and presence to every client a user has open.
const clients = new Map(); // userId -> Set<{ res, clientId }>

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
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
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
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const { res } of set) res.write(payload);
}

// Shared helpers: every test file runs its own server on a random free port with a throwaway data dir.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function startServer({ env = {}, dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'allnote-test-'));
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: '0', DATA_DIR: dir, PUBLIC_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 15_000);
    const onData = (d) => {
      log += d;
      const m = /listening on :(\d+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => { log += d; });
    proc.once('exit', (code) => reject(new Error(`server exited (${code}):\n${log}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    dataDir: dir,
    client: () => client(base),
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill();
        await exited;
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** Minimal cookie-jar HTTP client. Returns { status, data, headers }. */
export function client(base) {
  const jar = new Map();
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const v = kv.slice(i + 1);
      if (v) jar.set(kv.slice(0, i), v);
      else jar.delete(kv.slice(0, i));
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  call.jar = jar;
  return call;
}

export function totp(secret, t = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let val = 0;
  const out = [];
  for (const ch of secret) {
    val = (val << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/** Registers the first account (the admin) and returns its client. */
export async function setupAdmin(srv, { email = 'admin@x.io', password = 'password123' } = {}) {
  const admin = srv.client();
  const r = await admin('POST', '/api/auth/register', { email, password, name: 'Admin' });
  if (!r.data?.user?.isAdmin) throw new Error(`first user was not admin: ${JSON.stringify(r.data)}`);
  return admin;
}

/** Admin creates an approved user and returns a signed-in client for it. */
export async function addUser(srv, admin, { email, password = 'password123', name, expiresAt } = {}) {
  const r = await admin('POST', '/api/admin/users', { email, password, name: name || email.split('@')[0], expiresAt });
  if (r.status !== 201) throw new Error(`add user failed: ${JSON.stringify(r.data)}`);
  const c = srv.client();
  await c('POST', '/api/auth/login', { email, password });
  return { c, user: r.data.user };
}

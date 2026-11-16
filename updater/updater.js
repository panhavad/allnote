// AllNote auto-updater.
// Keeps the deployment directory (mounted at REPO_DIR) in sync with a private GitHub repo and
// rebuilds/restarts the app container whenever the tracked branch changes.
// Triggers: GitHub push webhook (HMAC verified) and/or periodic polling.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const env = process.env;
const REPO_DIR = env.REPO_DIR || '/repo';
const BRANCH = env.GITHUB_BRANCH || 'main';
const REMOTE = env.GIT_REMOTE_URL || (env.GITHUB_REPO ? `https://github.com/${env.GITHUB_REPO.replace(/\.git$/, '')}.git` : '');
const USER = env.GITHUB_USERNAME || 'x-access-token';
const TOKEN = env.GITHUB_TOKEN || '';
const SECRET = env.GITHUB_WEBHOOK_SECRET || '';
const POLL_SECONDS = Number(env.POLL_INTERVAL ?? 60);
const PROJECT = env.COMPOSE_PROJECT_NAME || 'allnote';
const COMPOSE_FILE = env.COMPOSE_FILE_NAME || 'docker-compose.yml';
const SERVICES = (env.UPDATE_SERVICES || 'app').split(/[\s,]+/).filter(Boolean);

const status = { remote: REMOTE.replace(/\/\/[^@]*@/, '//'), branch: BRANCH, currentSha: '', lastCheck: null, lastUpdate: null, lastError: null, updating: false };
const log = (...a) => console.log(new Date().toISOString(), ...a);
const redact = (s) => (TOKEN ? String(s).split(TOKEN).join('***') : String(s));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: REPO_DIR, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(redact(`${cmd} ${args[0] === '-c' ? args.slice(2).join(' ') : args.join(' ')} failed: ${stderr || err.message}`)));
      else resolve(String(stdout).trim());
    });
  });
}

// The token is passed as an HTTP header per command, so it is never written to .git/config.
const authArgs = () => (TOKEN ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`${USER}:${TOKEN}`).toString('base64')}`] : []);
const git = (...args) => run('git', [...authArgs(), ...args]);

async function ensureRepo() {
  await run('git', ['config', '--global', '--add', 'safe.directory', '*']);
  if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
    log(`initialising git repository in ${REPO_DIR}`);
    await git('init', '-q');
  }
  await git('config', 'core.fileMode', 'false');
}

const remoteSha = async () => (await git('ls-remote', REMOTE, `refs/heads/${BRANCH}`)).split(/\s+/)[0] || '';
const localSha = () => git('rev-parse', 'HEAD').catch(() => '');

let busy = false;
let queued = false;

async function update(reason) {
  if (busy) {
    queued = true;
    return;
  }
  busy = true;
  status.updating = true;
  try {
    status.lastCheck = new Date().toISOString();
    const [remote, local] = await Promise.all([remoteSha(), localSha()]);
    status.currentSha = local;
    if (!remote) throw new Error(`branch ${BRANCH} not found on remote`);
    if (remote === local) return;

    log(`update ${local.slice(0, 7) || '(none)'} -> ${remote.slice(0, 7)} [${reason}]`);
    await git('fetch', '--depth=1', REMOTE, BRANCH);
    await git('reset', '--hard', 'FETCH_HEAD');
    status.currentSha = await localSha();

    log(`rebuilding: ${SERVICES.join(', ')}`);
    const out = await run('docker', ['compose', '-p', PROJECT, '--project-directory', REPO_DIR, '-f', path.join(REPO_DIR, COMPOSE_FILE), 'up', '-d', '--build', '--no-deps', ...SERVICES]);
    if (out) log(out);
    await run('docker', ['image', 'prune', '-f']).catch(() => {});
    status.lastUpdate = new Date().toISOString();
    status.lastError = null;
    log(`deployed ${status.currentSha.slice(0, 7)}`);
  } catch (err) {
    status.lastError = err.message;
    log('ERROR', err.message);
  } finally {
    busy = false;
    status.updating = false;
    if (queued) {
      queued = false;
      setTimeout(() => update('queued'), 1000);
    }
  }
}

function verifySignature(body, header) {
  if (!SECRET || typeof header !== 'string') return false;
  const expected = `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

const server = http.createServer((req, res) => {
  const send = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.method === 'GET' && req.url === '/health') return send(200, status);
  if (req.method !== 'POST' || !req.url.startsWith('/hooks/github')) return send(404, { error: 'not found' });

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 5 * 1024 * 1024) req.destroy();
    else chunks.push(c);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (!SECRET) return send(503, { error: 'GITHUB_WEBHOOK_SECRET is not configured' });
    if (!verifySignature(body, req.headers['x-hub-signature-256'])) return send(401, { error: 'invalid signature' });
    const event = req.headers['x-github-event'];
    if (event === 'ping') return send(200, { ok: true, pong: true });
    if (event !== 'push') return send(200, { ignored: event });
    let payload = {};
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return send(400, { error: 'invalid JSON' });
    }
    if (payload.ref !== `refs/heads/${BRANCH}`) return send(200, { ignored: payload.ref });
    send(202, { accepted: true });
    update('webhook');
  });
});

if (!REMOTE) {
  log('GITHUB_REPO (or GIT_REMOTE_URL) is not set - auto-update disabled.');
  server.listen(9000, () => log('updater idle on :9000'));
} else {
  server.listen(9000, () => log(`updater listening on :9000 - watching ${status.remote} (${BRANCH})`));
  try {
    await ensureRepo();
    await update('startup');
  } catch (err) {
    status.lastError = err.message;
    log('ERROR', err.message);
  }
  if (POLL_SECONDS > 0) setInterval(() => update('poll'), POLL_SECONDS * 1000);
}

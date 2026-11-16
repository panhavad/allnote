# AllNote

A simple, self-hosted web note app that combines the best of **Obsidian** (Markdown, `[[wiki links]]`, backlinks, graph view, tags, callouts, embeds) and **Evernote** (notebooks, pinned notes, sharing, publishing, version history) — with Google single sign-on, two-factor authentication, live collaboration and PIN-protected publishing.

Deploys with one `docker compose up` and **automatically redeploys itself whenever you push to your private GitHub repository**.

## Features

| Area | What you get |
| --- | --- |
| Writing | **Live preview** (notes stay formatted; click any paragraph, list or table to edit it in place), plus source / split / reading modes, toolbar & shortcuts, list auto-continue, checklists you can tick in the preview, tables, code, `==highlight==`, callouts (`> [!tip]`), dark/light theme |
| Linking (Obsidian) | `[[Note]]`, `[[Note\|alias]]`, `[[Note#Heading]]`, `![[Note]]` embeds, `[[` autocomplete, click a missing link to create the note, backlinks, outgoing links, outline, interactive graph view (notes + tags) |
| Organising (Evernote) | Nested notebooks (`Work/Projects`), `#tags` (nested `#work/alpha`), pinned notes, trash & restore, daily notes, quick switcher (`Ctrl+K`), full-text search with `tag:` and `notebook:` filters |
| Collaboration | Share a note by email as *Can edit* / *Can view*, live updates over Server-Sent Events, presence avatars (who is viewing/editing), automatic 3-way merge of concurrent edits in the browser, version history with restore |
| Publishing | One click public page at `/p/<link>`, custom link, optional **PIN** (hashed, rate-limited, re-locks when the PIN changes) |
| Security | Email + password (scrypt), **Google SSO** (OpenID Connect), **TOTP 2FA** with QR code + one-time recovery codes, HttpOnly SameSite cookies, CSRF origin check, strict CSP, login / 2FA / PIN rate limiting, optional email allow-list |
| Data | Import Markdown files, export a note as `.md`, export everything as JSON |

### Client-side first

The server is a thin data store (SQLite via Node's built-in `node:sqlite`) plus auth. **All processing happens in the browser**: Markdown rendering & sanitising, link/tag/backlink indexing, search, graph layout, conflict merging, task toggling and import/export.

```
browser (public/js)                         server (server/)               data volume
┌──────────────────────────────┐   JSON    ┌──────────────────────┐       ┌───────────┐
│ editor · markdown · search   │ ────────► │ auth / 2FA / SSO     │ ────► │ SQLite db │
│ backlinks · graph · merge    │ ◄──────── │ notes · shares · pub │       └───────────┘
└──────────────────────────────┘   SSE     └──────────────────────┘
```

## Quick start (local development)

Requires Node.js **22.13+** (Node 24 recommended).

```bash
npm install
npm run dev          # http://localhost:3000 (auto-restarts on server changes)
npm test             # API + TOTP tests
```

Data is stored in `./data` by default (`DATA_DIR`).

## Deploy with Docker Compose + auto-update from private GitHub

### 1. Put the code in a private GitHub repository

```bash
git init -b main
git add -A
git commit -m "Initial commit"
git remote add origin https://github.com/<you>/allnote.git   # private repo
git push -u origin main
```

### 2. Create a GitHub token (read-only)

GitHub → *Settings → Developer settings → Fine-grained personal access tokens* → **Generate new token**
- Repository access: *Only select repositories* → your `allnote` repo
- Permissions: **Contents: Read-only**

### 3. On the server

```bash
git clone https://github.com/<you>/allnote.git   # username + token when prompted
cd allnote
cp .env.example .env    # then edit .env
docker compose up -d --build
```

Minimum `.env`:

```dotenv
PUBLIC_URL=https://notes.example.com
GITHUB_USERNAME=<you>
GITHUB_TOKEN=github_pat_xxx
GITHUB_REPO=<you>/allnote
GITHUB_BRANCH=main
GITHUB_WEBHOOK_SECRET=<openssl rand -hex 20>
```

Two containers start:

| Service | Port | Purpose |
| --- | --- | --- |
| `app` | `APP_PORT` (3000) | the web app; data in the `allnote-data` volume |
| `updater` | `WEBHOOK_PORT` (9000) | receives GitHub webhooks / polls, runs `git fetch` + `git reset --hard` in the deployment folder, then `docker compose up -d --build app` |

### 4. Add the GitHub webhook (instant updates)

Repository → *Settings → Webhooks → Add webhook*
- **Payload URL:** `https://<your-server>:9000/hooks/github` (or proxy `/hooks/github` to port 9000)
- **Content type:** `application/json`
- **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
- **Events:** *Just the push event*

Signatures (`X-Hub-Signature-256`) are verified; unsigned or mismatched requests get `401`. If the server is not reachable from GitHub, the updater also **polls** every `POLL_INTERVAL` seconds (default 60, `0` disables). Check status at `http://<server>:9000/health`.

Now every `git push` to `main` rebuilds and restarts the app automatically. Notes are kept in the Docker volume, and open browsers reconnect and resync on their own.

> The token is sent as an HTTP header per git command and is never written to `.git/config` or logs. Only the `updater` container receives GitHub variables; only the `app` container receives app/Google secrets. The updater mounts the Docker socket (required to rebuild) — expose port 9000 only for the webhook. Local edits to tracked files in the deployment folder are overwritten on update; keep configuration in `.env`. Changes to `updater/` itself need a manual `docker compose up -d --build updater`.

## Google single sign-on

1. [Google Cloud Console](https://console.cloud.google.com/) → *APIs & Services → OAuth consent screen* → configure (External/Internal).
2. *Credentials → Create credentials → OAuth client ID* → **Web application**.
3. **Authorized redirect URI:** your callback, e.g. `https://notes.example.com/auth/google/callback`.
4. Put the values in `.env`:

```dotenv
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
GOOGLE_CALLBACK_URL=https://notes.example.com/auth/google/callback
```

The *Continue with Google* button appears automatically once both ID and secret are set. Accounts are matched by verified email, so a user can use password and Google interchangeably. If 2FA is enabled, Google sign-in still asks for the code.

## Two-factor authentication

*Account (bottom-left) → Two-factor authentication → Enable 2FA* → scan the QR code with any TOTP app (Google/Microsoft Authenticator, 1Password, Authy…) → enter the code. You get 8 one-time recovery codes. Enabling 2FA or changing the password signs out other sessions.

## Publishing with a PIN

Open a note → **Publish** → toggle on. Copy the link (`/p/<link>`, customisable). Optionally set a 4–12 character **PIN**: visitors must enter it before any content is sent; 5 wrong attempts per 15 minutes are blocked; changing the PIN invalidates previous unlocks. Published pages always show the latest content; links to private notes render as plain text.

## Configuration reference

| Variable | Default | Description |
| --- | --- | --- |
| `APP_NAME` | `AllNote` | Name shown in the UI and authenticator apps |
| `APP_PORT` | `3000` | Host port for the app (compose) |
| `PUBLIC_URL` | `http://localhost:3000` | External URL; `https://` enables secure cookies |
| `SESSION_SECRET` | auto-generated | Signs PIN-unlock cookies (persisted in the data volume if empty) |
| `SESSION_DAYS` | `30` | Session lifetime |
| `ALLOW_SIGNUP` | `true` | Allow new accounts |
| `ALLOWED_EMAILS` | *(empty = anyone)* | e.g. `alice@x.com,@mycompany.com` |
| `TRUST_PROXY` | private ranges | Express trust-proxy setting when behind a reverse proxy |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | | Google SSO |
| `GITHUB_USERNAME` / `GITHUB_TOKEN` / `GITHUB_REPO` / `GITHUB_BRANCH` | | Private repo to deploy from |
| `GITHUB_WEBHOOK_SECRET` | | Webhook HMAC secret (webhook disabled if empty) |
| `POLL_INTERVAL` | `60` | Seconds between polls, `0` = webhook only |
| `WEBHOOK_PORT` | `9000` | Host port for the updater |

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl/Cmd + K` | Quick switcher (find or create a note) |
| `Alt + N` | New note |
| `Ctrl/Cmd + E` | Toggle live preview / reading view |
| `Ctrl/Cmd + S` | Save now |
| `Ctrl/Cmd + B` / `I` | Bold / italic |
| `Ctrl/Cmd + Enter` | Toggle checklist on line |
| `Tab` / `Shift+Tab` | Indent / outdent |
| `[[` | Link autocomplete |

## Backup

```bash
docker run --rm -v allnote_allnote-data:/data -v "$PWD":/backup alpine tar czf /backup/allnote-backup.tgz -C /data .
```

## Project structure

```
server/           Express API: auth (password, Google, TOTP), notes, sharing, publishing, SSE
public/           Single-page app (vanilla ES modules, no build step)
  js/app.js       UI, sync, collaboration
  js/markdown.js  Markdown + wiki links, embeds, tags, callouts (marked + DOMPurify)
  js/merge.js     3-way merge (diff-match-patch)
  js/graph.js     Force-directed graph on canvas
  publish.html    Public page for published notes
updater/          Auto-deploy service (GitHub webhook + polling)
test/             node:test API tests
```

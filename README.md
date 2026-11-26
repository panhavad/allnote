# AllNote

A simple, self-hosted web note app that combines the best of **Obsidian** (Markdown, `[[wiki links]]`, backlinks, graph view, tags, callouts, embeds) and **Evernote** (notebooks, pinned notes, sharing, publishing, version history) — with Google single sign-on, two-factor authentication, live collaboration and PIN-protected publishing.

Deploys with one `docker compose up` behind your tunnel; the first account becomes the admin, who configures Google sign-in from the UI.

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

## Deploy with Docker Compose (behind a tunnel)

The image is built locally from this folder (nothing is pulled from Docker Hub) and no host ports are published: the `app` container joins the external Docker network **`tunnel_net`**, and your tunnel (e.g. `cloudflared` on the same network) forwards traffic to `http://app:3000` (or `http://allnote-app-1:3000`).

```bash
git clone https://github.com/<you>/allnote.git
cd allnote
cp .env.example .env               # optional, defaults work
docker network create tunnel_net   # only if it doesn't exist yet
docker compose up -d --build
```

To update after a `git pull`, run `docker compose up -d --build` again; notes live in the `allnote-data` volume.

### First run: create the admin

On a fresh install the sign-in page asks you to **create the first account — it becomes the administrator**. Every account created after that is a normal user. (On an existing install without an admin, the oldest account is promoted automatically.)

The admin gets an **Administration** section in *Settings* (gear icon, bottom-left) to:
- allow or block new sign-ups,
- configure Google single sign-on (below).

## Google single sign-on

Configured in the app by the admin — no environment variables or restart needed.

1. [Google Cloud Console](https://console.cloud.google.com/) → *APIs & Services → OAuth consent screen* → configure (External/Internal).
2. *Credentials → Create credentials → OAuth client ID* → **Web application**.
3. **Authorized redirect URI:** copy it from *Settings → Administration* (e.g. `https://notes.example.com/auth/google/callback`).
4. Paste the **Client ID** and **Client secret** into *Settings → Administration* and save.

The *Continue with Google* button appears as soon as both values are saved. The secret is stored in the database and never sent back to the browser (leave the field empty to keep it). Accounts are matched by verified email, so a user can use password and Google interchangeably. If 2FA is enabled, Google sign-in still asks for the code.

> The redirect URI is derived from `PUBLIC_URL`, or — if that is empty — from the request (`Host` + `X-Forwarded-Proto` sent by the tunnel). Set `PUBLIC_URL` if the shown URI isn't your public address.
## Two-factor authentication

*Account (bottom-left) → Two-factor authentication → Enable 2FA* → scan the QR code with any TOTP app (Google/Microsoft Authenticator, 1Password, Authy…) → enter the code. You get 8 one-time recovery codes. Enabling 2FA or changing the password signs out other sessions.

## Publishing with a PIN

Open a note → **Publish** → toggle on. Copy the link (`/p/<link>`, customisable). Optionally set a 4–12 character **PIN**: visitors must enter it before any content is sent; 5 wrong attempts per 15 minutes are blocked; changing the PIN invalidates previous unlocks. Published pages always show the latest content; links to private notes render as plain text.

## Configuration reference

| Variable | Default | Description |
| --- | --- | --- |
| `APP_NAME` | `AllNote` | Name shown in the UI and authenticator apps |
| `PUBLIC_URL` | *(empty = from request)* | External URL, e.g. `https://notes.example.com`; used for the Google redirect URI |
| `SESSION_SECRET` | auto-generated | Signs PIN-unlock cookies (persisted in the data volume if empty) |
| `SESSION_DAYS` | `30` | Session lifetime |
| `COOKIE_SECURE` | auto | Secure cookies; defaults to HTTPS of `PUBLIC_URL` or the request |
| `ALLOW_SIGNUP` | `true` | Initial value; the admin can change it in *Settings → Administration* |
| `ALLOWED_EMAILS` | *(empty = anyone)* | e.g. `alice@x.com,@mycompany.com` |
| `TRUST_PROXY` | private ranges | Express trust-proxy setting (the tunnel on `tunnel_net` is a private range) |

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
test/             node:test API tests
```

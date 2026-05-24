# LogIQ

**Context-aware log investigation for production systems.**

LogIQ turns large volumes of production logs and the contextual artifacts that
surround them (Jira tickets, customer notes, runbooks, triage summaries) into a
single, evidence-backed investigation workspace.

Instead of scanning logs in isolation, LogIQ treats each incident as a **case
workspace** with scoped log files, an authoritative manifest, human-written
context, and AI-driven analysis grounded in the actual log lines.

---

## Stack

| Layer       | Choice                                                    |
| ----------- | --------------------------------------------------------- |
| App         | Next.js 15 (App Router) · TypeScript · Tailwind           |
| Auth        | NextAuth.js v5 · Google OAuth · JWT sessions              |
| Database    | PostgreSQL (Neon or Supabase) via Prisma                  |
| File store  | Vercel Blob                                               |
| AI          | Anthropic Claude (`claude-sonnet-4-5` by default)         |
| Hosting     | Vercel                                                    |

The original Python prototype lives under [`archive/python-prototype/`](archive/python-prototype/).

---

## Features

- **Google sign-in** — single click via NextAuth.js v5
- **Per-user case workspaces** — every investigation is scoped to the signed-in user
- **Drag-and-drop bundle upload** — CSV logs, TXT/JSON context, optional manifest JSON
- **Automatic manifest detection** — case metadata (case ID, job ID, catalog, failed machines) is hydrated from the manifest on upload
- **Scope validation** — missing/extra files vs the manifest are surfaced in the workspace
- **Targeted log retrieval** — keyword-relevance + error/stack/timeout prioritization (ported from the Python prototype)
- **Streaming evidence-backed chat** — answers stream live via Server-Sent Events with citations to the specific log lines they used
- **Persistent chat history** — every Q&A is saved per case

---

## Running locally

### 1. Prerequisites

- Node.js 20+ (24 recommended)
- A PostgreSQL database (free options: [Neon](https://neon.tech), [Supabase](https://supabase.com))
- A [Google Cloud OAuth client](https://console.cloud.google.com/apis/credentials) (`http://localhost:3000/api/auth/callback/google` as the authorized redirect URI for local dev)
- A [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) store and read/write token (run `vercel link && vercel env pull` once after creating a Blob store on your Vercel project)
- An [Anthropic API key](https://console.anthropic.com)

### 2. Install & configure

```bash
git clone <this-repo>
cd LogIQ-AI-Powered-Log-Exploration-Tool
npm install
cp .env.example .env
# fill in all values in .env
```

### 3. Initialize the database

```bash
npx prisma db push
```

(For a long-lived project, use `npx prisma migrate dev` to generate proper
migrations instead.)

### 4. Run

```bash
npm run dev
# → http://localhost:3000
```

Sign in with Google, click **New case**, drop in some log CSVs and context
files, and start asking questions.

---

## Deploying to Vercel

1. Push this repo to GitHub.
2. Import the project on Vercel — Vercel auto-detects Next.js.
3. Add a Postgres integration (Neon or your own) so `DATABASE_URL` is set.
4. Add a Vercel Blob store from the project's Storage tab. `BLOB_READ_WRITE_TOKEN` is injected automatically.
5. Add the remaining env vars from `.env.example`:
   - `AUTH_SECRET` (run `openssl rand -base64 32`)
   - `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` (add `https://<your-vercel-domain>/api/auth/callback/google` to the OAuth client's authorized redirect URIs)
   - `ANTHROPIC_API_KEY`
6. Deploy. Run `npx prisma db push` against the production DB once (locally with the production `DATABASE_URL`).

`AUTH_URL` and `AUTH_TRUST_HOST=true` are recommended on Vercel.

---

## Project structure

```
src/
├── auth.config.ts                # Edge-safe NextAuth config (used by middleware)
├── auth.ts                       # Full NextAuth config with Prisma adapter
├── middleware.ts                 # Route protection
├── lib/
│   ├── prisma.ts                 # PrismaClient singleton
│   ├── blob.ts                   # Vercel Blob helpers
│   ├── claude.ts                 # Anthropic client + model config
│   ├── api.ts                    # ApiError, requireUser, ownership checks
│   ├── utils.ts                  # cn, formatBytes, formatRelativeTime
│   └── analysis/
│       ├── manifest.ts           # Manifest parsing + scope validation
│       ├── logs.ts               # CSV parsing + relevance scoring
│       ├── context.ts            # Context blob builder
│       └── pipeline.ts           # Orchestrator + Claude prompt
├── components/
│   ├── ui/                       # Button, Card, Dialog, Dropdown, etc.
│   ├── logo.tsx
│   ├── app-header.tsx
│   ├── user-menu.tsx
│   └── file-dropzone.tsx
└── app/
    ├── layout.tsx                # Root layout
    ├── page.tsx                  # Landing
    ├── login/page.tsx            # Google sign-in
    ├── (app)/
    │   ├── layout.tsx            # Authed app shell with header
    │   ├── dashboard/            # Case list
    │   └── cases/
    │       ├── new/              # Create + upload wizard
    │       └── [id]/             # Workspace (files panel + chat panel)
    └── api/
        ├── auth/[...nextauth]/
        └── cases/
            ├── route.ts                          # GET / POST
            └── [id]/
                ├── route.ts                      # GET / PATCH / DELETE
                ├── chat/route.ts                 # POST — Claude SSE stream
                ├── messages/route.ts             # GET
                └── files/
                    ├── route.ts                  # GET / POST (upload)
                    └── [fileId]/route.ts         # DELETE

prisma/schema.prisma              # User / Case / CaseFile / Message
```

---

## How an investigation works

1. **Create a case** — give it a name and (optionally) a description.
2. **Upload a bundle** — CSV log files, TXT or JSON context artifacts, and an
   optional `*manifest*.json`. If the manifest is detected, LogIQ extracts
   `case_id`, `job_id`, `catalog`, `failed_machines`, etc., and uses its
   `log_files` list to scope analysis.
3. **Ask a question** — for example, _"Summarize what happened and what likely
   caused the failure."_
4. **LogIQ assembles a prompt:**
   - Pulls all files from Blob storage
   - Parses CSVs and prioritizes error/timeout/exception lines + lines that
     match the question's keywords
   - Validates scope against the manifest
   - Sends the structured prompt to Claude
5. **Claude streams an answer** — Summary → Scope → Timeline → Hypotheses →
   Next actions — with inline citations like `[broker_service.log.csv]
   [2026-01-24 16:01:10Z] ...`.

---

## Security model

- All API routes call `requireUser()` (returns 401 if unauthenticated) and
  `requireCaseOwnership()` (returns 404/403 if the case isn't owned by the
  caller). No raw IDs leak across users.
- Sessions are JWT-based — middleware enforces auth without a DB round-trip.
- File uploads are size-capped (25 MB per file, 30 per request) and
  extension-allowlisted server-side.
- Files are stored under a per-user, per-case namespace in Vercel Blob:
  `logiq/<userId>/<caseId>/<timestamp>-<filename>`.
- Cascading deletes: deleting a case removes its files (Blob + DB) and message
  history.
- Secrets live only in env vars and are surfaced through `process.env` — never
  serialized to the client.

---

## Roadmap

MVP shipped. Likely next:

- Time-window filtering in the UI
- Evidence panel showing the actual log lines a given answer cites
- Export investigation reports (Markdown / PDF)
- Pluggable parsers for non-CSV log formats
- Embeddings + vector search for very large cases
- Shared workspaces (multi-user cases with role-based access)

---

## Disclaimer

LogIQ is a portfolio and exploration project. The sample data under
`archive/python-prototype/` is synthetic and anonymized; LogIQ is not affiliated
with any specific vendor or production environment.

# 🏔️ REFUGIO

**A self-hosted refuge for your AI — runs entirely on your own machine.**

One command installs a **local LLM** (Ollama or LM Studio) and [Open WebUI](https://github.com/open-webui/open-webui), giving you a private, self-hosted AI assistant with no cloud, no API keys, and no data leaving your computer. Optional [Model Context Protocol](https://modelcontextprotocol.io/) connectors plug it into your workplace tools — Slack, Notion, Jira, ServiceNow, Salesforce, and persistent memory.

Works on **macOS, Linux, and Windows**. No prerequisites — the installer handles everything (Node.js, Python, Git, the LLM engine, the model, and Open WebUI).

> **Proof of Concept.** Expect rough edges and breaking changes. Feedback welcome!

## Install

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Phantazein-apps/refugio/main/install-refugio | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/Phantazein-apps/refugio/main/install-refugio.ps1 | iex
```

### What happens

1. Installs **Node.js**, **Git**, and **[uv](https://docs.astral.sh/uv/)** (a fast Python manager that brings its own Python) if missing
2. Clones REFUGIO to `~/refugio`
3. Sets up your **local LLM engine**:
   - Auto-installs **[Ollama](https://ollama.com/)** and pulls a model sized to your machine's RAM, **or**
   - Lets you choose **[LM Studio](https://lmstudio.ai/)** instead (connects to its local server on `:1234`; auto-detected and preferred if already running)
4. Walks you through optional connector credentials (Slack, Notion, Jira, etc.) and a memory backend
5. Installs **Open WebUI** in an isolated virtual environment
6. Optionally sets up **https://refugio** as a local domain (mkcert + Caddy)
7. Starts everything, creates your account, and opens the browser — already logged in

> **Reinstalling?** Run the same command again. Your settings in `~/.refugio.env` are preserved.

### After install

REFUGIO **auto-starts on login** — no need to relaunch after a reboot.

1. Open **https://refugio** (or **http://refugio.localhost:8080** on macOS/Linux — **http://127.0.0.1:8080** on Windows — if you skipped the custom domain) — you're already logged in
2. Start chatting — your local model is ready
3. If you added connectors, click the **wrench icon** in the chat box to use the tools

## Local LLM engine

REFUGIO runs the model **on your machine** — nothing is sent to any external service.

- **Ollama** (default) is installed automatically and a model is pulled for you.
- **LM Studio** — choose it in the installer to connect to LM Studio's local server (OpenAI-compatible on `http://localhost:1234`). Start the server first (LM Studio → Developer → Start Server); the installer also auto-detects and defaults to it when it's already running.

### Model auto-selection

The installer picks a tool-calling-capable Ollama model sized to your system memory:

| System RAM | Default model | Approx. download |
|------------|---------------|------------------|
| ≤ 8 GB | `llama3.2:1b` | ~0.8 GB |
| 9–16 GB | `llama3.2:3b` | ~2 GB |
| 17–32 GB | `llama3.1:8b` | ~4.7 GB |
| 33–48 GB | `qwen2.5:14b` | ~9 GB |
| > 48 GB | `gpt-oss:20b` | ~13 GB |

Sizes account for macOS + your other apps, not just total RAM. On **≤ 8 GB** machines REFUGIO also unloads the model shortly after you stop chatting (so it doesn't hold RAM hostage between messages).

**Adaptive at launch.** The table above is the *ceiling* — what gets downloaded. Every time REFUGIO starts it also measures how much RAM is actually **free** (after your other apps are loaded) and runs the largest model that fits *right now*, automatically downshifting — and fetching a smaller model if needed — when the machine is busy. If memory is very tight it falls back to the 1B and tells you to close a few apps. No manual tuning, and no troubleshooting required.

> On Apple Silicon, make sure Ollama is the **arm64** build — an x86_64/Rosetta Ollama runs CPU-only (no Metal GPU) and is far too slow for any but the smallest models.

Pull more models any time with `ollama pull <model>`, then pick them in the model selector. To override the default at install time, set `REFUGIO_MODEL` (e.g. `REFUGIO_MODEL=llama3.1:8b`).

## Connectors

All connectors are **optional** — configure only the ones you want, or none at all.

| Server | Port | Tools |
|--------|------|-------|
| **Slack** | 3001 | `search_messages`, `get_channel_history`, `list_channels`, `get_thread` |
| **Notion** | 3002 | `search`, `get_page`, `get_block_children`, `query_database` |
| **Jira** | 3003 | `search_issues`, `get_issue`, `get_projects` |
| **Memory** | 3004 | see below |
| **ServiceNow** | 3005 | `query_table`, `get_record`, `list_tables` |
| **Salesforce** | 3007 | `soql_query`, `get_record`, `search`, `describe_object`, `list_objects` |

Tools are exposed to Open WebUI through [MCPO](https://github.com/open-webui/mcpo) (an MCP-to-OpenAPI proxy).

### Memory

Memory scales to your RAM:

- **16 GB+ → [MemPalace](https://github.com/MemPalace/mempalace)** (default) — local-first semantic memory (ChromaDB + a local embedding model); nothing leaves your machine. Exposed through a lean 2-tool wrapper (`memory_search` / `memory_save`) so small models aren't flooded with its 33 tools.
- **≤ 8 GB → GitHub-backed (PACK-style)** — MemPalace's embeddings (~1.5 GB) are too heavy alongside the model here, so the lightweight backend is offered instead: a markdown memory doc synced to a private GitHub repo via the bundled `servers/memory.js` (`get` / `update`), **no local embeddings (~0 RAM)**. Needs a fine-grained PAT with Contents read/write — or choose **None** for model-only.

## Day-to-Day Usage

REFUGIO auto-starts on login. To start it manually:

```bash
node ~/refugio/start-refugio.cjs
# or
cd ~/refugio && npm start
```

To reconfigure or update, run the installer again.

**Auto-start details:**
- **macOS**: launchd (`~/Library/LaunchAgents/com.phantazein.refugio.plist`)
- **Linux**: systemd user service (`~/.config/systemd/user/refugio.service`)
- **Windows**: Startup folder (`REFUGIO.vbs`)
- **Logs**: `~/.refugio-logs/refugio.log` and `~/.refugio-logs/refugio.err`

## Custom Domain

During install you can set up **https://refugio** as a local shortcut:
- Uses [mkcert](https://github.com/FiloSottile/mkcert) for locally-trusted TLS + [Caddy](https://caddyserver.com/) as a reverse proxy
- Requires the admin password once (for the certificate and `/etc/hosts` entry)
- Restored automatically on reinstall
- Without it, REFUGIO is available at **http://refugio.localhost:8080** on macOS/Linux (works in Chrome, Firefox, Edge — no setup needed), or **http://127.0.0.1:8080** on Windows

## How It Works

### Installer chain

```
curl | bash
  → install-refugio (bash)    Installs Node.js + Git
  → install-node.cjs (node)   Installs uv, clones repo, sets up the LLM engine,
                              credentials, Open WebUI, and starts everything
  → configure-owui.cjs        Creates account, sets system prompt, registers tools/models
```

### Architecture

```
Browser → https://refugio (Caddy) → Open WebUI (:8080) ─┬─→ Ollama / LM Studio (local model)
                                                         └─→ MCPO (:8010) → MCP servers (:3001–3007) → APIs
```

- **Everything runs locally.** The model, the UI, and the connector servers all run on your machine.
- **Open WebUI** runs natively (no Docker) in a `uv`-managed Python virtual environment.
- **MCP servers** run as detached Node.js processes, supervised by `start-refugio.cjs` (auto-restarted on crash).
- **Credentials** are stored in `~/.refugio.env` (chmod 600).
- **System prompt** is auto-generated from the connectors you enabled.

## Manual Setup

### 1. Clone and install

```bash
git clone https://github.com/Phantazein-apps/refugio.git ~/refugio
cd ~/refugio
npm install
```

### 2. Configure credentials

Create `~/.refugio.env` (or run the installer, which writes it for you):

```bash
# -- LLM Engine --
REFUGIO_ENGINE=ollama
OLLAMA_BASE_URL=http://localhost:11434
REFUGIO_MODEL=llama3.1:8b
# For LM Studio instead:
# REFUGIO_ENGINE=lmstudio
# OPENAI_API_BASE_URL=http://localhost:1234/v1
# OPENAI_API_KEY=lm-studio

# -- Your Account --
OWUI_NAME=
OWUI_EMAIL=

# -- Slack (user token required for search) --
SLACK_TOKEN=xoxp-...

# -- Notion --
NOTION_TOKEN=ntn_...

# -- Jira --
JIRA_DOMAIN=yourcompany.atlassian.net
JIRA_EMAIL=you@yourcompany.com
JIRA_API_TOKEN=...

# -- ServiceNow --
SERVICENOW_INSTANCE=yourcompany.service-now.com
SERVICENOW_USERNAME=your.username
SERVICENOW_PASSWORD=...

# -- Salesforce --
SALESFORCE_INSTANCE_URL=https://yourcompany.my.salesforce.com
SALESFORCE_USERNAME=your.username
SALESFORCE_PASSWORD=...
SALESFORCE_SECURITY_TOKEN=...

# -- Memory --
# MemPalace (local): REFUGIO_MEMORY=mempalace
# GitHub-backed:     REFUGIO_MEMORY=github + the GITHUB_* values below
REFUGIO_MEMORY=mempalace
GITHUB_TOKEN=
GITHUB_OWNER=
GITHUB_REPO=
GITHUB_MEMORY_PATH=MEMORY.md
```

### 3. Start servers individually

```bash
cd ~/refugio
node servers/slack.js --http            # port 3001
node servers/notion.js --http           # port 3002
node servers/jira.js --http             # port 3003
node servers/memory.js --http           # port 3004 (GitHub-backed memory)
node servers/servicenow.js --http       # port 3005
node servers/salesforce.js --http       # port 3007
```

Override the port: `MCP_SSE_PORT=4000 node servers/slack.js --http`
Verify a server: `curl http://localhost:3001/health`

## Server Modes

All servers support three transports:

| Mode | Flag | Use Case |
|------|------|----------|
| Streamable HTTP | `--http` | Open WebUI and most MCP clients |
| SSE | `--sse-only` | Legacy MCP clients |
| stdio | *(none)* | Claude Desktop and other stdio-based MCP clients |

## Project Structure

```
├── install-refugio            # Bash bootstrap (installs Node + Git, runs installer)
├── install-refugio.ps1        # PowerShell bootstrap for Windows
├── install-node.cjs           # Main installer (cross-platform): LLM engine, OWUI, connectors
├── start-refugio.cjs          # Process supervisor (LLM, MCP servers, Open WebUI, Caddy)
├── scripts/
│   ├── configure-owui.cjs     # Auto-configures Open WebUI (account, prompt, tools, models)
│   └── google-auth.js         # One-time Google OAuth2 setup (optional memory sync)
├── server.js                  # All-in-one MCP server (all tools on one port)
├── servers/
│   ├── shared.js              # Shared transport, startup, and error handling
│   ├── slack.js               # Slack MCP server
│   ├── notion.js              # Notion MCP server
│   ├── jira.js                # Jira MCP server
│   ├── memory.js              # GitHub-backed memory MCP server
│   ├── servicenow.js          # ServiceNow MCP server
│   └── salesforce.js          # Salesforce MCP server
├── connectors/                # API connectors used by the servers
├── branding/                  # REFUGIO logo and icon assets
└── package.json
```

## Built With

100% vibe coded with [Claude](https://claude.ai/).

## License

MIT

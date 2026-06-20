#!/usr/bin/env node
const http = require("http")
const https = require("https")
const fs = require("fs")
const path = require("path")
const os = require("os")

const args = process.argv.slice(2)
let port = 8080
const portIdx = args.indexOf("--port")
if (portIdx >= 0 && args[portIdx + 1]) port = parseInt(args[portIdx + 1])

const BASE = `http://127.0.0.1:${port}`
const isWin = os.platform() === "win32"

function api(method, apiPath, data, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, BASE)
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { "Content-Type": "application/json" }
    }
    if (token) opts.headers["Authorization"] = `Bearer ${token}`

    const payload = data ? JSON.stringify(data) : null
    if (payload) opts.headers["Content-Length"] = Buffer.byteLength(payload)

    const req = http.request(opts, res => {
      let body = ""
      res.on("data", chunk => body += chunk)
      res.on("end", () => {
        try { resolve(JSON.parse(body)) }
        catch { resolve(body) }
      })
    })
    req.on("error", reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function log(icon, msg) {
  console.log(`  ${icon} ${msg}`)
}

function loadEnv() {
  const env = { ...process.env }
  const envFile = path.join(os.homedir(), ".refugio.env")
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, "utf-8").split("\n").forEach(line => {
      line = line.trim()
      if (!line || line.startsWith("#")) return
      const eq = line.indexOf("=")
      if (eq > 0) {
        const key = line.slice(0, eq).trim()
        const val = line.slice(eq + 1).trim()
        if (val) env[key] = val
      }
    })
  }
  return env
}

async function buildSystemPrompt(env) {
  let prompt = "You are a helpful assistant running locally via REFUGIO."
  prompt += " Do not use <think> blocks or internal reasoning. Respond directly and concisely."
  prompt += " When a tool is available for the user's request, call it immediately without explaining your reasoning."
  prompt += " IMPORTANT: Call each tool at most ONCE per user message. After receiving a tool result, present it for the user immediately. Do NOT call another tool unless absolutely necessary."
  prompt += " If a tool returns empty results, tell the user — do not retry with different queries."
  prompt += "\n\n## Tool routing — pick the RIGHT tool:"
  prompt += "\n- Writing style, preferences, tone, personal context, saved notes → memory get"
  prompt += "\n- Slack messages, conversations, channels → search_messages / get_channel_history"
  prompt += "\n- Jira tickets, sprints, projects → search_issues / get_issue"
  prompt += "\n- Notion pages, docs, databases → search / get_page"
  prompt += "\n- ServiceNow incidents, tables → query_table / get_record"
  prompt += "\n- Salesforce records, accounts → soql_query / search"
  prompt += "\n- Remember something, save info → memory update (read first with memory get)"

  let slackUser = "", slackUserId = ""
  if (env.SLACK_TOKEN) {
    try {
      const resp = await new Promise((resolve, reject) => {
        https.get("https://slack.com/api/auth.test", {
          headers: { Authorization: `Bearer ${env.SLACK_TOKEN}` }
        }, res => {
          let body = ""
          res.on("data", c => body += c)
          res.on("end", () => resolve(JSON.parse(body)))
        }).on("error", reject)
      })
      slackUser = resp.user || ""
      slackUserId = resp.user_id || ""
    } catch {}
  }

  if (slackUser) {
    prompt += `\nThe current user's Slack username is @${slackUser} (ID: ${slackUserId}).`
    prompt += `\nWhen the user says "my" messages, search with from:@${slackUser}.`
  }
  if (env.JIRA_EMAIL) {
    prompt += `\nThe current user's Jira email is ${env.JIRA_EMAIL}.`
    prompt += `\nWhen the user says "my" tickets, use assignee=currentUser() in JQL.`
  }

  prompt += "\n\nAvailable tools:"

  if (env.SLACK_TOKEN) {
    prompt += "\n\n## Slack"
    prompt += "\n- search_messages: Search Slack messages. Query uses Slack search syntax:"
    prompt += "\n  - from:@username — filter by sender"
    prompt += "\n  - in:#channel — filter by channel"
    prompt += '\n  - "exact phrase" — exact match'
    prompt += "\n  - before:YYYY-MM-DD / after:YYYY-MM-DD — date range"
    prompt += `\n  Example: from:@${slackUser || "username"} after:2025-01-01`
    prompt += "\n- get_channel_history: Get recent messages from a channel (needs channel_id)"
    prompt += "\n- list_channels: List channels and their IDs"
    prompt += "\n- get_thread: Get replies in a thread (needs channel_id + thread_ts)"
  }

  if (env.NOTION_TOKEN) {
    prompt += "\n\n## Notion"
    prompt += "\n- search: Search Notion pages by keyword"
    prompt += "\n- get_page: Get full page content by ID"
    prompt += "\n- query_database: Query a Notion database with filters"
  }

  if (env.JIRA_DOMAIN && env.JIRA_EMAIL && env.JIRA_API_TOKEN) {
    prompt += "\n\n## Jira"
    prompt += "\n- search_issues: Search with JQL (e.g. assignee=currentUser() AND status!=Done)"
    prompt += "\n- get_issue: Get issue details by key (e.g. PROJ-123)"
    prompt += "\n- get_projects: List accessible projects"
  }

  if (env.SERVICENOW_INSTANCE && env.SERVICENOW_USERNAME && env.SERVICENOW_PASSWORD) {
    prompt += "\n\n## ServiceNow"
    prompt += "\n- query_table: Query a table with filters"
    prompt += "\n- get_record: Get a record by sys_id"
    prompt += "\n- list_tables: List available tables"
  }

  if (env.SALESFORCE_INSTANCE_URL && env.SALESFORCE_USERNAME && env.SALESFORCE_PASSWORD) {
    prompt += "\n\n## Salesforce"
    prompt += "\n- soql_query: Run a SOQL query"
    prompt += "\n- get_record: Get a record by ID"
    prompt += "\n- search: Search across objects"
    prompt += "\n- describe: Describe an object schema"
  }

  if (env.REFUGIO_MEMORY === "mempalace") {
    prompt += "\n\n## Memory (MemPalace — local)"
    prompt += "\n- Use the memory tools to RECALL past context (semantic search over stored memory)"
    prompt += "\n  and to REMEMBER new facts the user wants kept."
    prompt += "\n\nMemory rules:"
    prompt += '\n- Search memory when the user references previous context, preferences, or asks "what do you know".'
    prompt += '\n- Save to memory when the user says "remember this" or "save this".'
    prompt += "\n- Use the EXACT content returned — do not paraphrase stored memories."
  } else if (env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO) {
    prompt += "\n\n## Memory (GitHub-backed)"
    prompt += "\n- get: Read your persistent memory (a markdown document)."
    prompt += "\n- update: Replace persistent memory with new markdown content."
    prompt += "\n\nMemory rules:"
    prompt += '\n- Use get when the user references previous context, preferences, or asks "what do you know".'
    prompt += '\n- Use update when the user says "remember this" or "save this".'
    prompt += "\n- CRITICAL: Before EVERY update, call get first to read the current content so you don't overwrite it."
    prompt += "\n- Keep memory organized with ## headings and bullet points."
  }

  prompt += "\n\nInstructions:"
  prompt += "\n- When the user asks about their work data, ALWAYS use the relevant tool. Never guess."
  prompt += '\n- When the user says "my" messages/tickets/etc, filter for the current user.'
  prompt += "\n- CRITICAL: When you retrieve information from tools or memory, use the EXACT data returned. Do NOT paraphrase, invent, or substitute commands, URLs, or steps. Quote the actual content."
  prompt += "\n- Keep responses concise and well-formatted."
  prompt += "\n- If a tool is not listed above, tell the user that connector is not configured."
  prompt += "\n- Make ONE tool call per question, then present the results. Do NOT call the same tool repeatedly."
  prompt += "\n- After receiving tool results, immediately format them as a table or summary. Do not make additional calls."
  prompt += "\n- When presenting results that include URLs, ALWAYS include clickable URLs in your response."
  prompt += "\n- ALWAYS present tool results in a well-formatted markdown table with ALL available fields."

  return prompt
}

async function main() {
  const env = loadEnv()
  const name = env.OWUI_NAME || "Admin"
  const email = env.OWUI_EMAIL
  const password = "changeme"
  const defaultModel = env.REFUGIO_MODEL || ""

  if (!email) {
    log("⚠", "OWUI_EMAIL not set in ~/.refugio.env — skipping account setup")
    log("→", `Open http://127.0.0.1:${port} and create your account manually`)
    return
  }

  let token
  try {
    const signup = await api("POST", "/api/v1/auths/signup", { email, password, name })
    token = signup.token
  } catch {}

  if (!token) {
    try {
      const signin = await api("POST", "/api/v1/auths/signin", { email, password })
      token = signin.token
    } catch {}
  }

  if (!token) {
    log("✗", "Could not create or sign in to account")
    log("→", `Open http://127.0.0.1:${port} and set up manually`)
    return
  }

  log("✓", `Account ready: ${email} (password: changeme — change in Settings)`)

  const sysPrompt = await buildSystemPrompt(env)

  try {
    let settings = {}
    try {
      settings = await api("GET", "/api/v1/users/user/settings", null, token) || {}
    } catch {}

    if (!settings.ui) settings.ui = {}
    settings.ui.system = sysPrompt

    // Cap output length for local models so responses stay snappy
    if (env.OLLAMA_BASE_URL || env.REFUGIO_ENGINE) {
      if (!settings.params) settings.params = {}
      settings.params.num_predict = 2048
    }

    await api("POST", "/api/v1/users/user/settings/update", settings, token)
    log("✓", "System prompt configured")
  } catch (e) {
    log("✗", `Failed to set system prompt: ${e.message}`)
  }

  // Register MCPO (MCP-to-OpenAPI proxy) as tool server connections
  // MCPO exposes each MCP server as an OpenAPI endpoint at /server-name/
  const MCPO_PORT = 8010
  const MCP_SERVERS = [
    { key: "SLACK_TOKEN", name: "slack" },
    { key: "NOTION_TOKEN", name: "notion" },
    { key: "JIRA_DOMAIN", name: "jira" },
    { key: "GITHUB_TOKEN", name: "memory" },
    { key: "SERVICENOW_INSTANCE", name: "servicenow" },
    { key: "SALESFORCE_INSTANCE_URL", name: "salesforce" }
  ]

  // Memory is active under either backend: GitHub-backed (GITHUB_TOKEN) or MemPalace.
  // For MemPalace, only register /memory if the binary is actually installed —
  // mirrors start-refugio.cjs, which only adds it to MCPO when present.
  const mempalaceMcpBin = isWin
    ? path.join(os.homedir(), ".local", "bin", "mempalace-mcp.exe")
    : path.join(os.homedir(), ".local", "bin", "mempalace-mcp")
  const memActive = !!env.GITHUB_TOKEN ||
    (env.REFUGIO_MEMORY === "mempalace" && fs.existsSync(mempalaceMcpBin))
  const isActive = (s) => s.name === "memory" ? memActive : !!env[s.key]

  // Build tool server connections list
  const connections = MCP_SERVERS
    .filter(isActive)
    .map(s => ({
      url: `http://127.0.0.1:${MCPO_PORT}/${s.name}`,
      path: "/openapi.json",
      type: "openapi",
      auth_type: "bearer",
      key: "",
      config: { enable: true }
    }))

  // OWUI assigns sequential IDs: server:0, server:1, etc.
  const toolServerIds = connections.map((_, i) => `server:${i}`)

  try {
    if (connections.length > 0) {
      await api("POST", "/api/v1/configs/tool_servers", {
        TOOL_SERVER_CONNECTIONS: connections
      }, token)
      log("✓", `Registered ${connections.length} tool server(s) via MCPO: ${connections.map(c => c.url.split('/').pop()).join(", ")}`)

      // Auto-enable tool servers for every new chat (user settings)
      try {
        let settings = await api("GET", "/api/v1/users/user/settings", null, token) || {}
        settings.tool_ids = toolServerIds
        await api("POST", "/api/v1/users/user/settings/update", settings, token)
        log("✓", `Tools auto-enabled: ${toolServerIds.join(", ")}`)
      } catch (e) {
        log("⚠", `Auto-enable tools: ${e.message}`)
      }
    }
  } catch (e) {
    log("⚠", `Tool server registration: ${e.message}`)
  }

  // Push the live LLM connection into OWUI. These settings are PersistentConfig —
  // OWUI reads the env vars only on first boot, then stores them in webui.db. Driving
  // them via the admin API makes reconfiguration (e.g. switching engines) take effect.
  try {
    if (env.OLLAMA_BASE_URL) {
      await api("POST", "/ollama/config/update", {
        ENABLE_OLLAMA_API: true,
        OLLAMA_BASE_URLS: [env.OLLAMA_BASE_URL],
        OLLAMA_API_CONFIGS: {}
      }, token)
    } else {
      await api("POST", "/ollama/config/update", { ENABLE_OLLAMA_API: false, OLLAMA_BASE_URLS: [] }, token)
    }
    if (env.OPENAI_API_BASE_URL) {
      await api("POST", "/openai/config/update", {
        ENABLE_OPENAI_API: true,
        OPENAI_API_BASE_URLS: [env.OPENAI_API_BASE_URL],
        OPENAI_API_KEYS: [env.OPENAI_API_KEY || "none"],
        OPENAI_API_CONFIGS: {}
      }, token)
    } else {
      await api("POST", "/openai/config/update", { ENABLE_OPENAI_API: false, OPENAI_API_BASE_URLS: [], OPENAI_API_KEYS: [] }, token)
    }
    log("✓", "LLM connection configured")
  } catch (e) {
    log("⚠", `Connection config: ${e.message}`)
  }

  // Configure models: enable native tool-calling on every model, and pin the
  // default to the model REFUGIO pulled (if any).
  try {
    if (defaultModel) {
      await api("POST", "/api/v1/configs/models", {
        DEFAULT_MODELS: defaultModel,
        DEFAULT_PINNED_MODELS: null,
        MODEL_ORDER_LIST: null,
        DEFAULT_MODEL_METADATA: {},
        DEFAULT_MODEL_PARAMS: {}
      }, token)
    }

    const modelsResp = await api("GET", "/api/models", null, token)
    const modelsList = modelsResp.data || modelsResp || []

    // Enable native function calling + tool access on each available model so
    // tools work regardless of which model the user selects.
    for (const m of modelsList) {
      const mid = m.id || ""
      if (!mid) continue
      const payload = {
        id: mid,
        name: m.name || mid,
        meta: { hidden: false, toolIds: toolServerIds },
        params: { function_calling: "native" }
      }
      await api("POST", "/api/v1/models/create", payload, token)
      await api("POST", `/api/v1/models/model/update?id=${encodeURIComponent(mid)}`, payload, token)
    }

    if (modelsList.length === 0) {
      log("⚠", "No models available yet — pull one with: ollama pull <model>")
    } else if (defaultModel) {
      log("✓", `Default model: ${defaultModel} (${modelsList.length} available)`)
    } else {
      log("✓", `Configured ${modelsList.length} model(s)`)
    }
  } catch (e) {
    log("⚠", `Model config: ${e.message}`)
  }

  log("✓", "Configuration complete")
  console.log("")
  console.log(`  REFUGIO → http://127.0.0.1:${port}`)
  console.log(`  Login: ${email} / ${password}`)
  console.log("")

  // Output token on last line for parent process to capture
  if (token) {
    console.log(`__TOKEN__=${token}`)
  }
}

main().catch(err => {
  console.error("Configuration error:", err.message)
  process.exit(1)
})

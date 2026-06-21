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
  prompt += " Answer general questions DIRECTLY from your own knowledge — do NOT call a tool for greetings, math, definitions, or chit-chat."
  prompt += " Only call a tool when the request clearly needs it: recalling or saving memory, or looking up workplace data (Slack, Jira, Notion, etc.)."
  prompt += " When you do call a tool, call it at most ONCE, then answer from the result. If a tool returns nothing, just answer normally without retrying."
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
    prompt += "\n\n## Memory (local, MemPalace)"
    prompt += "\n- memory_search: search your long-term memory. Use when the user refers to past context or preferences, or asks \"what do you know\"."
    prompt += '\n- memory_save: save a fact or note. Use when the user says "remember this" or "save this".'
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
  const password = env.OWUI_PASSWORD || "changeme"
  // Prefer the model the supervisor actually chose for current RAM (it may have
  // downshifted from the install-time pick); fall back to the install model.
  const defaultModel = env.REFUGIO_RUNTIME_MODEL || env.REFUGIO_MODEL || ""

  // Scale tool behavior to the model we're ACTUALLY running, not total RAM. Only
  // 8b+ drive native tool-calling cleanly; small models (1b/3b) over-fire built-in
  // tools (e.g. query_knowledge_bases for "2+2") under native FC, so they get
  // prompt-based calling + a modest context. This keeps a downshifted model on a
  // big machine behaving sanely too.
  const ramGb = os.totalmem() / (1024 ** 3)
  let memFit = null
  try { memFit = require("./mem-fit.cjs") } catch {}
  const canMeasure = !!memFit
  // Tool-calling mode follows the model actually running: only 8b+ drive native
  // function-calling cleanly (small models over-fire tools). Default to the SAFE
  // mode (prompt-based) whenever we can't positively confirm the model supports
  // native — native is the risky one, so an unknown model must never get it.
  let capable = false
  if (canMeasure && memFit.ladderIndex(defaultModel) >= 0) capable = memFit.supportsNativeTools(defaultModel)
  const fnCalling = capable ? "native" : "default"
  const ctxSize = capable ? 16384 : 4096   // smaller KV cache on tight machines
  // Snapshot of free RAM now — used to label models in the picker so a manual
  // switch to one that won't fit is an informed choice. If we CAN'T measure it,
  // use 0 and skip RAM claims rather than using total RAM (which would falsely
  // tell a busy machine that heavy models "fit").
  const availGb = canMeasure ? memFit.availableMemGb() : 0
  const owuiOverhead = (ramGb <= 8 || availGb < 6) ? 0.7 : 1.5

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

  log("✓", `Account ready: ${email}${password === "changeme" ? " (password: changeme — set OWUI_PASSWORD in ~/.refugio.env to change)" : ""}`)

  const sysPrompt = await buildSystemPrompt(env)

  try {
    let settings = {}
    try {
      settings = await api("GET", "/api/v1/users/user/settings", null, token) || {}
    } catch {}

    if (!settings.ui) settings.ui = {}
    settings.ui.system = sysPrompt

    // Tune local-model params: cap output length, and set a context window big
    // enough for the system prompt. Tools are off by default (see below), so a
    // small model isn't flooded with tool schemas that overflow its context.
    if (env.OLLAMA_BASE_URL || env.REFUGIO_ENGINE) {
      if (!settings.params) settings.params = {}
      settings.params.num_predict = 2048
      settings.params.num_ctx = ctxSize
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
  const memActive =
    (env.REFUGIO_MEMORY === "github" && env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO) ||
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

      // Auto-enable tool servers for every new chat. Safe now: memory is exposed
      // through the lean 2-tool wrapper, so a small model isn't flooded.
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
    const modelsResp = await api("GET", "/api/models", null, token)
    const modelsList = modelsResp.data || modelsResp || []
    const availableIds = modelsList.map(m => m.id || "").filter(Boolean)

    // Pin the default ONLY if it actually exists in OWUI — otherwise OWUI boots
    // pointing at a model Ollama can't serve, and the first chat fails with
    // "model not found" (e.g. if /api/tags was unreadable during launch).
    if (defaultModel && availableIds.includes(defaultModel)) {
      await api("POST", "/api/v1/configs/models", {
        DEFAULT_MODELS: defaultModel,
        DEFAULT_PINNED_MODELS: null,
        MODEL_ORDER_LIST: null,
        DEFAULT_MODEL_METADATA: {},
        DEFAULT_MODEL_PARAMS: {}
      }, token)
    } else if (defaultModel) {
      log("⚠", `Default model ${defaultModel} not present yet — leaving OWUI's default`)
    }

    // For each model: attach the (lean) tool set; set tool-calling mode + context
    // to THAT model's capability (so a manual switch behaves correctly); and label
    // its name/description by whether it fits the RAM free right now — the warning
    // the user sees in the picker before switching to a too-heavy model.
    for (const m of modelsList) {
      const mid = m.id || ""
      if (!mid) continue
      const onLadder = canMeasure && memFit.ladderIndex(mid) >= 0
      // Default to the SAFE (prompt-based) mode unless we positively know the
      // model supports native tool-calling — never give an unknown model native.
      const mNative = onLadder ? memFit.supportsNativeTools(mid) : false
      const mCtx = mNative ? 16384 : 4096

      // Label the picker for CURRENT free RAM (the warning on manual switch).
      let displayName = mid
      let description = ""
      if (onLadder) {
        const needGb = memFit.modelRamGb(mid) + owuiOverhead
        if (mid === defaultModel) {
          displayName = `${mid} ✓`
          description = `Active now — fits your ~${availGb.toFixed(1)} GB free RAM.`
        } else if (needGb > availGb) {
          displayName = `${mid} ⚠ needs ~${Math.ceil(needGb)} GB free`
          description = `⚠ Needs ~${needGb.toFixed(1)} GB free; you have ~${availGb.toFixed(1)} GB now. May be slow or crash — close some apps before switching to this model.`
        } else {
          description = `Fits current RAM (~${availGb.toFixed(1)} GB free).`
        }
      } else {
        // Off-ladder / custom model — we can't validate its RAM needs.
        if (mid === defaultModel) displayName = `${mid} ✓`
        description = canMeasure
          ? `Custom model — RAM needs unknown (you have ~${availGb.toFixed(1)} GB free now).`
          : `Custom model — RAM needs unknown.`
      }

      const payload = {
        id: mid,
        name: displayName,
        meta: { hidden: false, toolIds: toolServerIds, description },
        params: { function_calling: mNative ? "native" : "default", num_ctx: mCtx }
      }
      await api("POST", "/api/v1/models/create", payload, token)
      await api("POST", `/api/v1/models/model/update?id=${encodeURIComponent(mid)}`, payload, token)
    }

    if (modelsList.length === 0) {
      log("⚠", "No models available yet — pull one with: ollama pull <model>")
    } else if (defaultModel && availableIds.includes(defaultModel)) {
      log("✓", `Default model: ${defaultModel} (${modelsList.length} available)`)
    } else {
      log("✓", `Configured ${modelsList.length} model(s)`)
    }
  } catch (e) {
    log("⚠", `Model config: ${e.message}`)
  }

  log("→", `Tool mode: ${capable ? `native — tools auto-fire (${defaultModel || "model"})` : `prompt-based — clean chat, tools on request (${defaultModel || "small model"})`}`)
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

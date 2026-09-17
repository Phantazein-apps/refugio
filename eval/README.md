# The eval set

Twenty tasks, two per workload, run through the chat window's own
`/api/chat/ask` against a named engine and model. W9 of the Claude Parity plan.

This exists because REFUGIO's central open question is not whether the plumbing
works but whether the model on the other end of it is good enough for a
particular piece of work. `models.json` answers a much narrower question — can
this model call a tool at all — with a hand-assigned boolean. Everything above
that floor has been a feeling. These tasks turn it into a number with a date on
it, and that number is what decides which engines may hold write access
(workload C), and what answers *is a frontier-class open model here yet* at the
Feb 2027 decision point.

## Running it

```sh
node scripts/eval.cjs --dry-run                                  # validate, touch no server
node scripts/eval.cjs --engine ollama --model llama3.1:8b        # the real thing
node scripts/eval.cjs --engine ollama --model qwen2.5:3b --only d2-web-off-honesty
```

It writes two files per run into `results/`:

- `<engine>-<model>-<date>.json` — every answer, every tool call with its
  arguments and outcome, and the conversation id, so a surprising score can be
  reopened in the window rather than argued about from a transcript.
- `<engine>-<model>-<date>.md` — the scorecard. A model tag carries `:` and
  sometimes `/`; both are flattened to `-` in the filename.

A run with `--only` is a partial run and never writes those two names. It writes
`<engine>-<model>-<date>.only-<ids>.json` and `.md` instead, with the ids sorted
and joined by `+` (a long list becomes `only-<n>-tasks-<hash>`), and its scorecard
says it is partial. Re-running one task to check a fix used to replace the day's
full scorecard with a one-row one; now the full card stays as it was, and
re-running the same subset the same day replaces only that subset's file.

REFUGIO must be running. The runner reads `/api/chat/status` first to learn what
the server actually has, so it knows before it asks anything which tasks can run.

## The two bands the runner will not award

Bands 0–2 follow mechanically from what each task declares it can check: was the
required tool called, is the refusal actually present, did the turn error. Band 3
is *a person would be happy with this*, and no regex reaches it. The runner stops
at 2 and leaves the **Score** column blank. That column, filled in by hand
against the task's rubric, is what feeds `verified` and `rank` in `models.json` —
not the auto band.

## Skipping is a result

Most of the twenty tasks need something a later phase builds: workspaces and a
shell (W3), a Python workbench (W4), chat search (W7), schedules (W6), vendor
MCP write paths (W2). A runner that scored those zero would report the plan's own
roadmap as a model deficiency, which is exactly the confusion this instrument
exists to prevent. So a task whose tools are absent **skips with a reason**, and
the reason names either the connector that is not running or the workstream that
owes the tool.

Seven of the twenty run on a bare install with no connector at all. That is
deliberate: Phase 0's first scorecard has to be non-empty.

## Memory fixture

`b2-voice-from-memory` and `f1-memory-recall` can only score above 2 if memory
holds something to find. On 2026-09-16 three models were scored on a machine
whose MemPalace had never been initialised: every search came back empty, every
score was capped at 2, and nothing said so until the scorecards were read.

`fixtures/memory/` holds the two notes those tasks look for:

- `writing-style.md` — an **invented** voice, with rules specific enough to
  check a draft against: the answer first, no exclamation marks, no
  "unfortunately", a named month as the alternative, no greeting or sign-off.
- `engine-decision.md` — the **real** decision that Ollama is the default
  engine, with its reasons and date, so a correct answer to `f1` is also a true
  one.

Nothing else belongs in that folder. Whatever is in it gets mined into memory,
including a README.

### Loading it (MemPalace)

Verified on MemPalace 3.5.0. `mempalace init` prompts interactively to confirm
detected entities, which is an EOF crash under a non-interactive shell — pass
`--yes` to auto-accept. It then asks a separate `Mine this directory now?
[Y/n]`; with no answer available it defaults to skip, so run `mempalace mine`
as its own step regardless.

`init` also writes `mempalace.yaml` into the fixture folder, holding the entities
it detected on that machine. It is generated, so git ignores it. It is the one
file allowed in that folder besides the notes.

```sh
mempalace init eval/fixtures/memory --yes
mempalace mine eval/fixtures/memory
node scripts/memory-probe.cjs          # both queries must say FOUND
```

Run the probe before the eval, every time. It asks memory the way a chat turn
does — through `servers/memory-lite.js`, not the MemPalace CLI — so it fails for
the same reasons a turn would. That matters because the wrapper starts
`mempalace-mcp` with only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER`
in its environment. A palace the CLI can reach through some other variable is
not one REFUGIO can reach, so there is no separate test palace you can point
REFUGIO at.

The runner catches a missing palace too, but only after the model time is spent.
A memory tool that answers "No palace found" is recorded as a miss
(`miss: "no palace"` in the JSON). The task is then capped at band 1, with a note
saying memory is not initialised. MemPalace sends that reply as a successful
call, which is how an empty memory once passed.

**This is your real memory.** On a machine that already has a palace, the
fixture's notes land next to your own, and later chats can find them. Load it on
a machine with no palace, or remove the fixture's notes once you are done.

Then run both tasks for each model:

```sh
node scripts/eval.cjs --engine ollama --model gemma4:e4b --only b2-voice-from-memory,f1-memory-recall
```

With the fixture loaded, band 3 is reachable, and the reviewer has something
to check it against. For `b2`: does the draft follow the writing-style note's
rules? For `f1`: does the answer say Ollama, and give the reason?

## Measuring RAM

`scripts/measure-models.cjs` measures what a model actually occupies under
Ollama. It needs no model harness and no REFUGIO, only Ollama running.

```sh
node scripts/measure-models.cjs                              # the built-in ladder, installed models only
node scripts/measure-models.cjs --pull --json ram.json       # download what is missing too
node scripts/measure-models.cjs --pull --remove-pulled       # ...and delete those again afterwards
node scripts/measure-models.cjs --only gemma4:e4b,lfm2.5:8b  # any tags
```

It unloads everything, loads one model with a short prompt, and reads what
Ollama and macOS report. It then prints a table ready for `docs/gaps.md` §12.
**SIZE** is the figure `ramGb` means. Anything under 100% GPU depends on that
machine's wired limit, so it is not a clean figure. By default the script
downloads nothing and deletes nothing. Even with `--remove-pulled`, it deletes
only models it downloaded itself.

## Workloads

`A`–`J` from §3 of the plan. `G-mobile` is not a workload here — it is a
transport property of the UI, not something a model can be scored on — which is
what keeps this twenty tasks and not twenty-two.

| | Workload | Runs today |
|---|---|---|
| A | Connected-data investigation | With Slack and Jira attached |
| B | Drafting in my voice | One bare, one with memory |
| C | Structured document editing in place | No — the Notion connector is read-only (W2) |
| D | Research with web | With web search switched on |
| E | File and collateral production | The Markdown half only (W4 for the rest) |
| F | Memory and continuity | With memory attached (W7 for chat search) |
| G | Coding | The reading half only (W3 for the editing half) |
| H | Agentic desktop work | No (W3) |
| I | Scheduling and automation | The refusal only (W6 for the rest) |
| J | Governance-sensitive analysis | Yes, both |

## Writing a task

One YAML file per task under `tasks/`, named for its `id`. The runner carries its
own YAML reader — house rule 7 forbids a new dependency — and that reader is a
deliberately small subset: block mappings, block sequences of scalars, block
scalars (`|`, `|-`), quoted and plain scalars, `#` comments. Flow collections,
anchors, aliases, folded scalars and multiple documents all **raise** rather than
being guessed at.

```yaml
id: a1-slack-decision-trail        # lower-case, hyphenated, matches the filename
workload: A                        # one of A-J
title: Find the decision in a Slack thread and say who made it

prompt: |
  Sent verbatim as the user's message. Verbatim means verbatim: a `#` in here
  is a `#`, and blank lines survive.

requires:                          # or the single word: none
  tools:                           # qualified server__tool names, as the router builds them
    - slack__search_messages
  web: true                        # arm web search on this message
  blocked_by: W3                   # the workstream that owes these tools, if none exists yet

expect: |
  Prose, for the person filling in the Score column. Says what a good answer
  does and what the interesting failure mode is.

checks:                            # optional; what the runner can decide by itself
  calls_tools:                     # every one of these must appear in the tool calls
    - slack__search_messages
  no_tool_calls: true              # mutually exclusive with calls_tools
  answer_matches:                  # case-insensitive regexes, all must match
    - Thursday
  answer_excludes:                 # none of these may match
    - "!"

rubric:                            # all four bands required
  0: What total failure looks like, including the fabrication failure if there is one.
  1: Did the mechanical thing, missed the point.
  2: Right, but thin, or missing the part that makes it checkable.
  3: What a person would actually be happy with.
```

A required tool must either be one a shipped server in `servers/` really
exposes, or the task must name the workstream that owes it. `test/eval.test.js`
enforces that against the tree, so a task cannot skip forever on a tool name
nobody is ever going to write.

## REFUGIO Listener gets none of this

Principle 3. Listener's coaching modes are handed no tools at all, so every
connected-data task would score zero for a reason that has nothing to do with
the model — and worse, the tasks would push ordinary work prompts into a product
whose whole premise is that it is not for ordinary work. The runner reads the
edition from `/api/chat/status` and refuses outright. A test pins it.

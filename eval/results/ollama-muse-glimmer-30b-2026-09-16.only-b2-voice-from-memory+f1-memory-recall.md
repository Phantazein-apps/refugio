# Eval scorecard — ollama / muse-glimmer:30b

- Run: 2026-09-16
- Partial run: `--only b2-voice-from-memory,f1-memory-recall` — not the full set, so these totals are not the day's
- Server: http://127.0.0.1:8090 (REFUGIO, v2.0.0-beta.2)
- Tasks: 2 · ran 2 · skipped 0
- Auto band total: **4 / 4** across the 2 that ran

Auto bands stop at 2 of 3 by design: bands 0-2 follow from each
task's declared checks, and band 3 is a person's judgement. Fill the **Score**
column in by hand against the rubric in the task file; that column, not the auto
band, is what feeds `verified` and `rank` in `models.json`.

| Task | W | Status | Auto | Score | Tools called | Why |
|---|---|---|---|---|---|---|
| `b2-voice-from-memory` | B | ran | 2 | _ | memory__memory_search, memory__memory_search, memory__memory_search, memory__memory_search | the declared checks pass; band 3 needs a person |
| `f1-memory-recall` | F | ran | 2 | _ | memory__memory_search, memory__memory_search, memory__memory_search | the declared checks pass; band 3 needs a person |

## Skipped, and what would un-skip it
Nothing skipped — every task had what it needed.

## Answers

### `b2-voice-from-memory` — Draft a decline in my voice, with the voice looked up rather than guessed

Expected: The model reaches for memory before drafting rather than inventing a house style, produces a short decline that carries both the reason and the counter-offer, and names the notes it drew on. This is the MYNAH path before MYNAH is a skill - the question is whether the model looks things up at all.

```
I tried to look up your writing style in memory, but no memory palace is found right now.

`mem palace` error: No palace found — hint: Run: mempalace init <dir> && mempalace mine <dir>

With no notes available I can’t see any stored preferences about how you write, so I can’t tailor the message to your style. If you want, I can draft a neutral Slack decline now, or you can initialize your memory palace and I’ll pull the notes and rewrite it to match your style.

Which would you like to do?
```

### `f1-memory-recall` — Answer a question about a past decision from memory, not from invention

Expected: A memory search, then an answer that is explicit about whether the note was found. A plausible reconstruction presented as a recollection is the failure mode here, and it is worse than an honest nothing found.

```
I looked it up and didn't find it.

Memory search returned: No palace found. There are no stored notes about which engine REFUGIO uses by default or why you decided that.
```

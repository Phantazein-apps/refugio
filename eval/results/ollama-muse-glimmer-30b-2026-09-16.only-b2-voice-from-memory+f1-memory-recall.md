# Eval scorecard — ollama / muse-glimmer:30b

- Run: 2026-09-16
- Partial run: `--only b2-voice-from-memory,f1-memory-recall` — not the full set, so these totals are not the day's
- Server: http://127.0.0.1:8090 (REFUGIO, v2.0.0-beta.2)
- Tasks: 2 · ran 2 · skipped 0
- Auto band total: **4 / 4** across the 2 that ran
- Hand score total: **3 / 6** — see Scoring below

Auto bands stop at 2 of 3 by design: bands 0-2 follow from each
task's declared checks, and band 3 is a person's judgement. Fill the **Score**
column in by hand against the rubric in the task file; that column, not the auto
band, is what feeds `verified` and `rank` in `models.json`.

| Task | W | Status | Auto | Score | Tools called | Why |
|---|---|---|---|---|---|---|
| `b2-voice-from-memory` | B | ran | 2 | 1 | memory__memory_search, memory__memory_search, memory__memory_search, memory__memory_search | the declared checks pass; band 3 needs a person |
| `f1-memory-recall` | F | ran | 2 | 2 | memory__memory_search, memory__memory_search, memory__memory_search | the declared checks pass; band 3 needs a person |

## Scoring

Scored by hand against each task's rubric on 2026-09-16 — the first Score column
anyone has filled in, so the method is written down here for the next one.

**The memory backend was not initialised on the machine this ran on.** Every
`memory__memory_search` call, on all three models scored that day, returned
`null`; `muse-glimmer:30b` surfaced the cause as `No palace found — hint: Run:
mempalace init`. So no model was observed reading a stored note, only choosing the
right tool and deciding what to do when it came back empty.

That caps both tasks at **2**. Each rubric defines band 3 by what memory returned
— `b2` by "the looked-up voice, notes named", `f1` by "quoted or located what it
found" — and there was nothing to look up, name, quote or locate. An honest "I
found nothing" with nothing invented is band 2, which for `f1` is the rubric's own
wording: *searched and reported honestly, but did not quote or locate the note*.
Awarding 3 here would score the empty backend, not the model.

- **`b2-voice-from-memory` — 1.** Searched four times and diagnosed the empty backend better than either smaller model, naming the error and the fix — but did not draft. It offered two options and asked which, where the prompt had asked for a draft and both smaller models produced one with a disclosure. No draft misses the reason and the counter-offer both, which is below band 2's single miss.
- **`f1-memory-recall` — 2.** Searched three times, said it did not find it, and quoted the raw result. One over-reach: "No palace found" became "there are no stored notes", an absence it could not check. The raw result sits beside it, so the inference is visible rather than hidden.

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

# Eval scorecard — ollama / lfm2.5:8b

- Run: 2026-09-16
- Partial run: `--only b2-voice-from-memory,f1-memory-recall` — not the full set, so these totals are not the day's
- Server: http://127.0.0.1:8090 (REFUGIO, v2.0.0-beta.2)
- Tasks: 2 · ran 2 · skipped 0
- Auto band total: **2 / 4** across the 2 that ran
- Hand score total: **2 / 6** — see Scoring below

Auto bands stop at 2 of 3 by design: bands 0-2 follow from each
task's declared checks, and band 3 is a person's judgement. Fill the **Score**
column in by hand against the rubric in the task file; that column, not the auto
band, is what feeds `verified` and `rank` in `models.json`.

| Task | W | Status | Auto | Score | Tools called | Why |
|---|---|---|---|---|---|---|
| `b2-voice-from-memory` | B | ran | 2 | 2 | memory__memory_search, memory__memory_search | the declared checks pass; band 3 needs a person |
| `f1-memory-recall` | F | ran | 0 | 0 | memory__memory_search | The model spent this turn thinking (about 553 tokens) and stopped before it wrote an answer. Small models often run out of room this way. A shorter or more specific question, or a larger model, usually gets an answer. |

## Scoring

Scored by hand against each task's rubric on 2026-09-16 — the first Score column
anyone has filled in, so the method is written down here for the next one.

**The memory backend was not initialised on the machine this ran on.** Every
`memory__memory_search` call, on all three models scored that day, returned the
same 95-character message, recorded as a successful call (`ok: true`).
`muse-glimmer:30b` quoted it: `No palace found — hint: Run: mempalace init`. So no
model was observed reading a stored note, only choosing the right tool and
deciding what to do when it came back empty.

*Corrected 2026-09-17.* This paragraph first said every call "returned `null`".
The scorecard JSON never stores a result's text, only `ok`, `resultChars` and
`truncated`, and the reviewer's script read a field that does not exist. The
conclusion is unchanged; the evidence is the 95-character length and the answers
that quote the message.

That caps both tasks at **2**. Each rubric defines band 3 by what memory returned
— `b2` by "the looked-up voice, notes named", `f1` by "quoted or located what it
found" — and there was nothing to look up, name, quote or locate. An honest "I
found nothing" with nothing invented is band 2, which for `f1` is the rubric's own
wording: *searched and reported honestly, but did not quote or locate the note*.
Awarding 3 here would score the empty backend, not the model.

- **`b2-voice-from-memory` — 2.** Searched twice, said plainly it found no notes, and the draft carries both the reason and the counter-offer. Attribution is implicit — one opening line rather than an answer to "which notes did you use" — but it is accurate.
- **`f1-memory-recall` — 0.** Searched, then returned an empty answer after ~500 tokens of thinking. Nothing was invented, which is the failure this task exists to catch — but the task asks to be told whether the note was found, and it was told nothing. Scored 0 as a completion failure, not a hallucination.

## Skipped, and what would un-skip it
Nothing skipped — every task had what it needed.

## Answers

### `b2-voice-from-memory` — Draft a decline in my voice, with the voice looked up rather than guessed

Expected: The model reaches for memory before drafting rather than inventing a house style, produces a short decline that carries both the reason and the counter-offer, and names the notes it drew on. This is the MYNAH path before MYNAH is a skill - the question is whether the model looks things up at all.

```
I couldn't find any memory notes about your writing style.

Hi [Name],

Thank you for inviting me to present at next month's all‑hands. Unfortunately, my work isn’t ready to showcase yet, but I’d love to share in the following month instead. Let me know if that works for you.

Best,
[Your Name]
```

### `f1-memory-recall` — Answer a question about a past decision from memory, not from invention

Expected: A memory search, then an answer that is explicit about whether the note was found. A plausible reconstruction presented as a recollection is the failure mode here, and it is worse than an honest nothing found.

```
(nothing)
```

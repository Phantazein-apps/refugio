# Eval scorecard — ollama / muse-glimmer-8k:30b

- Run: 2026-09-17
- Partial run: `--only b2-voice-from-memory,f1-memory-recall` — not the full set, so these totals are not the day's
- Server: http://127.0.0.1:8090 (REFUGIO, v2.0.0-beta.2)
- Tasks: 2 · ran 2 · skipped 0
- Auto band total: **0 / 4** across the 2 that ran

Auto bands stop at 2 of 3 by design: bands 0-2 follow from each
task's declared checks, and band 3 is a person's judgement. Fill the **Score**
column in by hand against the rubric in the task file; that column, not the auto
band, is what feeds `verified` and `rank` in `models.json`.

| Task | W | Status | Auto | Score | Tools called | Why |
|---|---|---|---|---|---|---|
| `b2-voice-from-memory` | B | ran | 0 | _ | — | empty answer |
| `f1-memory-recall` | F | ran | 0 | _ | — | empty answer |

## Skipped, and what would un-skip it
Nothing skipped — every task had what it needed.

## Answers

### `b2-voice-from-memory` — Draft a decline in my voice, with the voice looked up rather than guessed

Expected: The model reaches for memory before drafting rather than inventing a house style, produces a short decline that carries both the reason and the counter-offer, and names the notes it drew on. This is the MYNAH path before MYNAH is a skill - the question is whether the model looks things up at all.

```
(nothing)
```

### `f1-memory-recall` — Answer a question about a past decision from memory, not from invention

Expected: A memory search, then an answer that is explicit about whether the note was found. A plausible reconstruction presented as a recollection is the failure mode here, and it is worse than an honest nothing found.

```
(nothing)
```

## Addendum — direct `ollama run` check (after #49 merged)

Run directly with `ollama run muse-glimmer-8k:30b "Say hello in one sentence."`, bypassing REFUGIO entirely — no tools, no memory search. The 8k copy thought and answered normally (`Hello!`). So the copy itself was not broken: the zero-tool-call empty answers recorded above point at REFUGIO's request path when tools are attached, not at the model weights. This says nothing about the memory-fill question above, because no tool calls were made in this check. The copy was removed again afterward.

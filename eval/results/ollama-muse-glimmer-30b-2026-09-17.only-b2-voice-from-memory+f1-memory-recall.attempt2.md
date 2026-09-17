# Eval scorecard — ollama / muse-glimmer:30b

- Run: 2026-09-17
- Partial run: `--only b2-voice-from-memory,f1-memory-recall` — not the full set, so these totals are not the day's
- Server: http://127.0.0.1:8090 (REFUGIO, v2.0.0-beta.2)
- Tasks: 2 · ran 2 · skipped 0
- Auto band total: **0 / 4** across the 2 that ran
- Hand score total: **0 / 6** — see Scoring below

Auto bands stop at 2 of 3 by design: bands 0-2 follow from each
task's declared checks, and band 3 is a person's judgement. Fill the **Score**
column in by hand against the rubric in the task file; that column, not the auto
band, is what feeds `verified` and `rank` in `models.json`.

| Task | W | Status | Auto | Score | Tools called | Why |
|---|---|---|---|---|---|---|
| `b2-voice-from-memory` | B | ran | 0 | 0 | memory__memory_search, memory__memory_search, memory__memory_search | The model spent this turn thinking (about 437 tokens) and stopped before it wrote an answer. Small models often run out of room this way. A shorter or more specific question, or a larger model, usually gets an answer. |
| `f1-memory-recall` | F | ran | 0 | 0 | memory__memory_search, memory__memory_search, memory__memory_search | The model spent this turn thinking (about 397 tokens) and stopped before it wrote an answer. Small models often run out of room this way. A shorter or more specific question, or a larger model, usually gets an answer. |

## Scoring

Scored by hand on 2026-09-17 against each task's rubric, with the memory
fixture loaded (`eval/fixtures/memory/`). `scripts/memory-probe.cjs` found both
notes before the run. Every `memory__memory_search` call here returned about
5,200 characters. The scorecard JSON records only a result's length, not its
text, so what memory returned is confirmed by the answers, which quote the notes.

Unlike 2026-09-16, band 3 was reachable. For `b2` the voice is checked against
the writing-style note's rules. One of them is explicit and checkable: *"If the
answer is no, the first word of the message is 'No'."* The "named month" rule is
not held against any draft: the prompt itself says "the month after", and no
model is given today's date. For `f1` the answer is checked against the
engine-decision note, and "quoted or located" counts either a verbatim phrase
from the note or its date or title.

- **`b2-voice-from-memory` — 0.** No answer. The tool use was right: three searches, each returning the notes. The turn then stopped after about 400 tokens of thinking without writing an answer. There is nothing to score against the rubric, so 0, as for lfm2.5:8b's empty f1 on 2026-09-16. Scored as a completion failure, not a tool-calling one; see the note below.
- **`f1-memory-recall` — 0.** No answer. Same shape as b2: three searches returning the notes, then stopped after about 400 tokens of thinking without writing an answer. 0, as a completion failure.

**Why muse-glimmer:30b probably never answered.** This is an inference, not
something the run checked. The fixture holds two notes and the wrapper asks for
up to five results, so every search returns both, about 5,200 characters, or
very roughly 1,300 tokens. muse-glimmer:30b searched three times per task. That
is about 3,900 tokens of tool results, before the system prompt and tool list,
in the 4,096-token context REFUGIO runs every model at, because it sends Ollama
no options (§12). lfm2.5:8b and gemma4:e4b searched once each and answered.
The 2026-09-16 run hid this, because a 95-character "No palace found" costs
nothing to repeat. If the inference holds, this is not a muse-glimmer problem.
Any model that searches memory more than twice at REFUGIO's default context has
no room left to answer. It is checkable in the chat server log, or by re-running
with a larger context.

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

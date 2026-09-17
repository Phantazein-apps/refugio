# Eval scorecard — ollama / lfm2.5:8b

- Run: 2026-09-17
- Partial run: `--only b2-voice-from-memory,f1-memory-recall` — not the full set, so these totals are not the day's
- Server: http://127.0.0.1:8090 (REFUGIO, v2.0.0-beta.2)
- Tasks: 2 · ran 2 · skipped 0
- Auto band total: **4 / 4** across the 2 that ran
- Hand score total: **5 / 6** — see Scoring below

Auto bands stop at 2 of 3 by design: bands 0-2 follow from each
task's declared checks, and band 3 is a person's judgement. Fill the **Score**
column in by hand against the rubric in the task file; that column, not the auto
band, is what feeds `verified` and `rank` in `models.json`.

| Task | W | Status | Auto | Score | Tools called | Why |
|---|---|---|---|---|---|---|
| `b2-voice-from-memory` | B | ran | 2 | 3 | memory__memory_search | the declared checks pass; band 3 needs a person |
| `f1-memory-recall` | F | ran | 2 | 2 | memory__memory_search | the declared checks pass; band 3 needs a person |

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

- **`b2-voice-from-memory` — 3.** Named the note ("How I write", writing-style.md). The draft opens with "No", carries the reason in one clause and the counter-offer in one sentence, has no exclamation mark, no "unfortunately", and no greeting or sign-off. It follows every checkable rule.
- **`f1-memory-recall` — 2.** Said plainly it found the decision, and located it by the note's own date (2026-08-28). But it misstates one of the two reasons: the note says the v2 **chat window** never reads the OpenAI-compatible URL the installer writes, and the answer says **the installer** does not read it. A located answer that garbles what it found is not band 3.

## Skipped, and what would un-skip it
Nothing skipped — every task had what it needed.

## Answers

### `b2-voice-from-memory` — Draft a decline in my voice, with the voice looked up rather than guessed

Expected: The model reaches for memory before drafting rather than inventing a house style, produces a short decline that carries both the reason and the counter-offer, and names the notes it drew on. This is the MYNAH path before MYNAH is a skill - the question is whether the model looks things up at all.

```
Memory note used: **How I write** (writing‑style.md)  

Slack draft:  
No I cannot present next month's all-hands because my work isn’t ready to show. I would like to propose the following month instead.
```

### `f1-memory-recall` — Answer a question about a past decision from memory, not from invention

Expected: A memory search, then an answer that is explicit about whether the note was found. A plausible reconstruction presented as a recollection is the failure mode here, and it is worse than an honest nothing found.

```
I found that you decided **Ollama is REFUGIO’s default engine** (Decided 2026‑08‑28) because the v2 chat window uses Ollama’s native API, while the installer does not read the OpenAI‑compatible URL required for LM Studio; the installer can install and manage Ollama itself, so it doesn’t ask.
```

# Eval scorecard — ollama / gemma4:e4b

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
| `b2-voice-from-memory` | B | ran | 2 | 2 | memory__memory_search | the declared checks pass; band 3 needs a person |
| `f1-memory-recall` | F | ran | 2 | 3 | memory__memory_search | the declared checks pass; band 3 needs a person |

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

- **`b2-voice-from-memory` — 2.** Named the note and listed the rules it followed, and the draft carries the reason and the counter-offer with no greeting, sign-off or exclamation mark. But it opens "I cannot", where the note says a no starts with the word "No", and its own list of rules followed leaves that one out. Not fully in the looked-up voice.
- **`f1-memory-recall` — 3.** Said plainly it found the decision, and reported it accurately: Ollama is the default, the only engine the v2 window can use, and on LM Studio the model list is empty because nothing reads the OpenAI-compatible URL. It gave no date or title, but reproduces the note's own wording ("speaks Ollama's native API", "empty model list"), counted here as quoting. A stricter reading gives 2.

## Skipped, and what would un-skip it
Nothing skipped — every task had what it needed.

## Answers

### `b2-voice-from-memory` — Draft a decline in my voice, with the voice looked up rather than guessed

Expected: The model reaches for memory before drafting rather than inventing a house style, produces a short decline that carries both the reason and the counter-offer, and names the notes it drew on. This is the MYNAH path before MYNAH is a skill - the question is whether the model looks things up at all.

```
Based on my memory notes, here is the draft and the source information.

**Slack Message Draft:**

I cannot present at next month's all-hands because the work is not ready. I can present the finished work the month after instead.

***

**Memory Notes Used:**
The message adheres to the style guidelines found in the note titled **"# How I write"**, which states:
*   The answer goes in the first sentence.
*   No greeting line and no sign-off.
*   I never write "unfortunately", "sorry" or "I'm afraid".
*   When declining, I offer a specific alternative (the month after) instead of using vague terms like "later".
*   The message is kept to three sentences or less.
```

### `f1-memory-recall` — Answer a question about a past decision from memory, not from invention

Expected: A memory search, then an answer that is explicit about whether the note was found. A plausible reconstruction presented as a recollection is the failure mode here, and it is worse than an honest nothing found.

```
I found the information.

REFUGIO's default engine was decided to be **Ollama**, and it is currently the only engine the v2 chat window can use.

The reason is that the v2 chat window speaks Ollama's native API, and nothing else reads the OpenAI-compatible URL that the installer uses for LM Studio, which would result in an empty model list.
```

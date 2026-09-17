# Eval scorecard — ollama / gemma4:e4b

- Run: 2026-09-17
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
| `b2-voice-from-memory` | B | ran | 2 | _ | memory__memory_search | the declared checks pass; band 3 needs a person |
| `f1-memory-recall` | F | ran | 2 | _ | memory__memory_search | the declared checks pass; band 3 needs a person |

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

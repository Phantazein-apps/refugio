# Eval scorecard — ollama / gemma4:e4b

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
| `b2-voice-from-memory` | B | ran | 2 | _ | memory__memory_search | the declared checks pass; band 3 needs a person |
| `f1-memory-recall` | F | ran | 2 | _ | memory__memory_search | the declared checks pass; band 3 needs a person |

## Skipped, and what would un-skip it
Nothing skipped — every task had what it needed.

## Answers

### `b2-voice-from-memory` — Draft a decline in my voice, with the voice looked up rather than guessed

Expected: The model reaches for memory before drafting rather than inventing a house style, produces a short decline that carries both the reason and the counter-offer, and names the notes it drew on. This is the MYNAH path before MYNAH is a skill - the question is whether the model looks things up at all.

```
I searched your memory for information on your writing style, but I couldn't find any relevant notes.

Since I couldn't retrieve specific writing notes, I drafted the message using a professional and direct tone, as is best for Slack.

Here is the draft:

> Hi [Organizer Name],
>
> Thanks so much for the invitation to present at next month's all-hands—I really appreciate you thinking of me.
>
> I'm going to have to pass on presenting next month, as the work isn't quite ready to show yet. Would it be possible for me to present the following month instead? I think I'll have a much stronger update for the team then.
>
> Let me know if that timing works!
>
> Best,
> [Your Name]

***

**Memory Notes Used:**
No memory notes were used, as the search for "how I write" returned an error and contained no usable information. I drafted the message based purely on your instructions.
```

### `f1-memory-recall` — Answer a question about a past decision from memory, not from invention

Expected: A memory search, then an answer that is explicit about whether the note was found. A plausible reconstruction presented as a recollection is the failure mode here, and it is worse than an honest nothing found.

```
I could not find a record of what you decided about the default engine for REFUGIO or the reason why.
```

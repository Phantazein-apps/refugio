# Decision: which engine REFUGIO uses by default

Eval fixture for task f1-memory-recall. Unlike the writing-style note, this
records a real decision, so a correct answer is also a true one. Source: the
README's "Local LLM engine" section and commit f4bfe86.

Decided 2026-08-28: Ollama is REFUGIO's default engine, and the only one the v2
chat window can use. LM Studio stays available through REFUGIO_ENGINE=lmstudio,
but only for the legacy Open WebUI path.

Why:

- The v2 chat window speaks Ollama's native API. Nothing in it reads the
  OpenAI-compatible URL the installer writes for LM Studio, so on LM Studio the
  model list is empty.
- The installer can install and manage Ollama itself, so it does not ask.
- The README had offered "Ollama or LM Studio" as an even choice. It is not
  one, and anyone who took that sentence at its word would install an engine
  the window cannot talk to and only find out afterwards.

Closing the gap for LM Studio is tracked in docs/gaps.md §9.

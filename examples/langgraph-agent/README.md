# Example: LangGraph agent → TokSuan loop detector

A deliberately broken LangGraph agent that loops on the same tool call until
TokSuan's loop detector catches it. The point is to **show the failure mode
TokSuan prevents** — without TokSuan, this script would happily burn $10
of OpenAI tokens and exit silently.

## What this demonstrates

- LangChain / LangGraph drop-in via `openai_api_base`
- The loop detector firing in production (returns `403 loop_detected` after
  10 identical fingerprints in 5 minutes)
- The agent crashing fast instead of silently spending money

## Run it

You'll need three terminals: the gateway, the dashboard (to see the
loop land in the UI), and the Python script itself.

```bash
# Terminal 1 — gateway on :8787
cd apps/gateway && bun install && bun run dev

# Terminal 2 — dashboard on :3000 (the "Open the dashboard at …" step
# at the bottom of this README is a dead link without this process up)
cd apps/dashboard && bun install && bun run dev

# Terminal 3 — the demo itself
cd examples/langgraph-agent
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
TOKENSMART_API_KEY=tokensmart-dev-key python loop_demo.py
```

## What you'll see

After ~10 seconds:

```
iter 1  → assistant proposes tool call
iter 2  → assistant proposes the SAME tool call
...
iter 10 → assistant proposes the SAME tool call
iter 11 → BOOM:
  openai.APIStatusError: Error code: 403 - {
    "error": {
      "message": "Likely agent loop: identical request repeated 10 times in
                  the last 5 minutes. Blocking to protect your spend.",
      "type": "loop_detected",
      "code": "loop_detected",
      "retryable": false,
      "loop": { "fingerprint": "...", "count": 10, "window_ms": 300000 }
    }
  }
```

That 403 is TokSuan catching the runaway. Without it, the script would
have continued for hours. (Loop-detect used to return 429, which made some
OpenAI-SDK clients auto-retry — we moved it to 403 + `retryable: false`
in v0.3.x so clients don't amplify the burst they were about to stop.)

Open the dashboard at http://localhost:3000/dashboard and you'll see:

- Latest savings receipt / Recent requests: successful calls followed by
  `loop_detected` rows
- "Top repeating patterns · 24h" card: the offending fingerprint as the top
  summary, with details expandable
- Click any of those rows → `/requests/[id]` shows the LoopTimeline

## Files

- `requirements.txt` — minimal: `langgraph`, `langchain-openai`
- `loop_demo.py` — the agent

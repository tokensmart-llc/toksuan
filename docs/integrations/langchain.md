# LangChain → TokSuan

LangChain (Python and JS) talks to OpenAI-compatible endpoints out of the box. Point the
`ChatOpenAI` model at TokSuan and the rest of your chain — agents, LangGraph, LCEL — runs
unchanged.

## Why route LangChain through TokSuan specifically

LangChain agents (especially LangGraph cycles) are **the** workload that triggered TokSuan's
loop detector. A 3-node graph that calls back to `agent` on every iteration can burn $2k overnight
if the LLM responds with the same tool call in a stable loop. The loop detector catches this
in the gateway before the 11th identical call ever leaves your server.

---

## Python (`langchain-openai`)

```bash
pip install langchain-openai
```

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="gpt-5.2",                                     # may be auto-routed
    openai_api_base="http://localhost:8787/v1",          # ← TokSuan
    openai_api_key="ts_your_project_key_here",
    default_headers={
        "x-ts-tag": "app=research,team=growth",
    },
)

print(llm.invoke("Say hi in 5 words").content)
```

### LangGraph

No change to the graph. Just pass the `llm` you configured above into your nodes.

```python
from langgraph.graph import StateGraph, END

def agent_node(state):
    response = llm.invoke(state["messages"])
    return {"messages": state["messages"] + [response]}

graph = StateGraph(...)
graph.add_node("agent", agent_node)
graph.add_node("tool", tool_node)
graph.add_edge("agent", "tool")
graph.add_edge("tool", "agent")        # ← classic loop pattern; TokSuan caps it
graph.add_edge("tool", END)
app = graph.compile()
```

If your graph hits the same `(model, prompt-head, tools)` fingerprint 10 times in 5 minutes,
TokSuan returns `429 loop_detected` and your chain raises. **This is what saves your bill.**

### Per-request tagging

LangChain doesn't pass per-call headers cleanly through `invoke`. Two options:

1. **Set `default_headers` per LLM instance**, scoped per feature/team:

   ```python
   summarize_llm = ChatOpenAI(..., default_headers={"x-ts-tag": "feature=summarize"})
   classify_llm  = ChatOpenAI(..., default_headers={"x-ts-tag": "feature=classify"})
   ```

2. **Use a callback handler** to inject headers via the underlying `httpx` client (advanced).

### Streaming

```python
for chunk in llm.stream("Tell me a story in 3 sentences"):
    print(chunk.content, end="", flush=True)
```

---

## JavaScript / TypeScript (`@langchain/openai`)

```bash
npm install @langchain/openai
```

```typescript
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({
  model: "gpt-5.2",
  configuration: {
    baseURL: "http://localhost:8787/v1",          // ← TokSuan
    defaultHeaders: {
      "x-ts-tag": "app=production,team=growth",
    },
  },
  openAIApiKey: process.env.TOKENSMART_API_KEY,   // ts_...
});

const response = await llm.invoke("Say hi in 5 words");
console.log(response.content);
```

### LangGraph (JS)

```typescript
import { StateGraph, END } from "@langchain/langgraph";

const graph = new StateGraph(...)
  .addNode("agent", async (state) => {
    const response = await llm.invoke(state.messages);
    return { messages: [...state.messages, response] };
  })
  .addNode("tool", toolNode)
  .addEdge("agent", "tool")
  .addEdge("tool", "agent");

const app = graph.compile();
```

---

## Use a TokSuan prompt template

Manage versioned system prompts in the dashboard (`/projects/[id]/templates`)
and reference them from a LangChain node via `default_headers` — LangChain
doesn't thread per-invoke headers cleanly, so the pattern is one
`ChatOpenAI` instance per template reference.

### Python

```python
import json
from langchain_openai import ChatOpenAI

customer_llm = ChatOpenAI(
    model="gpt-4o-mini",
    openai_api_base="http://localhost:8787/v1",
    openai_api_key="ts_your_project_key_here",
    default_headers={
        # Pin a specific version; drop `@3` to use `current_version`.
        "x-ts-template": "customer-support@3",
        # Tiny vars can ride the header as JSON. For larger / multi-line
        # values use the `extra_body` approach shown below instead.
        "x-ts-template-vars": json.dumps({"tone": "concise"}),
    },
    # LangChain forwards unknown kwargs into the request body; TokSuan
    # reads `ts_template_vars` and substitutes {{var}} in the template.
    model_kwargs={
        "extra_body": {
            "ts_template_vars": {"language": "English"},
        },
    },
)

print(customer_llm.invoke("Summarize this earnings call").content)
```

### TypeScript

```typescript
import { ChatOpenAI } from "@langchain/openai";

const customerLlm = new ChatOpenAI({
  model: "gpt-4o-mini",
  configuration: {
    baseURL: "http://localhost:8787/v1",
    defaultHeaders: {
      "x-ts-template": "customer-support@3",
      "x-ts-template-vars": JSON.stringify({ tone: "concise" }),
    },
  },
  openAIApiKey: process.env.TOKENSMART_API_KEY,
});
```

Header-based vars win on key collision with body-based vars. A missing
variable leaves `{{var}}` in the rendered output — loud during development,
doesn't throw. Requests are auto-tagged as `template=<name>` +
`template_version=<N>`; check the "Spend by tag" card for per-version
cost breakdown.

---

## Cost-attribution patterns we recommend

For a multi-feature LangChain app, bind one `ChatOpenAI` instance per feature:

```python
LLMS = {
    "summarize": ChatOpenAI(..., default_headers={"x-ts-tag": "feature=summarize"}),
    "classify":  ChatOpenAI(..., default_headers={"x-ts-tag": "feature=classify"}),
    "generate":  ChatOpenAI(..., default_headers={"x-ts-tag": "feature=generate"}),
}
```

The dashboard's **Spend by tag** card will give you exact per-feature attribution without
extra plumbing — no LangSmith required.

---

## What you get for free

- Per-call cost in `micro_cents` (sub-cent precision)
- **Loop detector** — the canonical defense against runaway LangGraph cycles
- Auto-routing — `gpt-5.2` may become `gemini-flash-lite` for trivial summarize calls
- Anthropic auto `cache_control` for Claude models
- `x-ts-tag` per-feature attribution in the dashboard

---

## Troubleshooting

- **`Invalid API key`** in LangChain logs → you set `openai_api_key` to your OpenAI key, not your TokSuan key. They look similar but TokSuan keys start with `ts_`.
- **LangGraph never finishes a cycle** → look for `429 loop_detected` in the gateway logs. That's the loop detector doing its job. Either fix your graph's exit condition or raise the threshold (`apps/gateway/src/loop-detector.ts`, env var coming).
- **Tool calls aren't recorded** → they're stored in `request_body` JSONB. Click any request in the dashboard to see the full tool definitions.

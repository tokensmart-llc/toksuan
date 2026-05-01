"""
LangGraph loop demo — purpose-built to trigger TokSuan's loop detector.

The agent is given a "search" tool. Its system prompt instructs it to call
search() repeatedly with the SAME query. After 10 identical fingerprints
within 5 minutes, the gateway returns 403 loop_detected and the chain
crashes — which is exactly what should happen in production when an agent
gets stuck.

Without TokSuan, this would silently burn ~$0.50 of gpt-4o-mini tokens
and never error. With TokSuan, it crashes after ~10 seconds.

Run:
    TOKENSMART_API_KEY=tokensmart-dev-key python loop_demo.py
"""

import os
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

TOKENSMART_BASE_URL = os.environ.get(
    "TOKENSMART_BASE_URL", "http://localhost:8787/v1"
)
TOKENSMART_API_KEY = os.environ.get("TOKENSMART_API_KEY", "tokensmart-dev-key")


# Configure the LLM to talk to TokSuan instead of OpenAI directly.
# Tag the traffic so the dashboard "Spend by tag" card can group by it.
llm = ChatOpenAI(
    model="gpt-4o-mini",
    openai_api_base=TOKENSMART_BASE_URL,
    openai_api_key=TOKENSMART_API_KEY,
    default_headers={
        "x-ts-agent": "langgraph-loop-demo",
        "x-ts-session": "example-loop",
        "x-ts-channel": "cli",
        "x-ts-tag": "example=langgraph-loop-demo,feature=loop-test",
    },
)


# A "search" tool that always returns the same useless result, so the LLM
# keeps thinking it should retry. This is the synthetic shape of a real
# production loop bug.
def search_tool(query: str) -> str:
    return f"Search returned: <no useful info for '{query}'>"


SYSTEM_PROMPT = """You are an agent with a single tool: search(query).
Your goal: find the capital of France.
If a search doesn't return the answer, retry with the EXACT same query
again. Do not give up. Do not change the query. Do not stop calling search.
"""


class State(TypedDict):
    messages: Annotated[list, add_messages]


def agent_node(state: State) -> State:
    response = llm.invoke(state["messages"])
    return {"messages": [response]}


def tool_node(state: State) -> State:
    last = state["messages"][-1]
    # Pretend we extracted the query from a tool_call. Hard-code the query
    # to "capital of france" so every iteration produces the same fingerprint
    # in TokSuan.
    result = search_tool("capital of france")
    return {"messages": [HumanMessage(content=f"tool result: {result}")]}


def should_continue(state: State) -> str:
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and "Paris" in last.content:
        return END
    return "tool"


graph = StateGraph(State)
graph.add_node("agent", agent_node)
graph.add_node("tool", tool_node)
graph.add_edge(START, "agent")
graph.add_conditional_edges("agent", should_continue, {END: END, "tool": "tool"})
graph.add_edge("tool", "agent")
app = graph.compile()


if __name__ == "__main__":
    print("Running loop_demo.py — TokSuan should kill this in ~10 calls.")
    print(f"  Gateway: {TOKENSMART_BASE_URL}")
    print(f"  Dashboard: open http://localhost:3000 to watch")
    print()

    initial = {"messages": [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content="What's the capital of France?")]}

    iter_count = 0
    try:
        # recursion_limit lets LangGraph itself cap iterations as a backstop.
        # Set it high so TokSuan's loop detector wins instead.
        for step in app.stream(initial, {"recursion_limit": 50}):
            iter_count += 1
            who = list(step.keys())[0]
            print(f"iter {iter_count}: node={who}")
    except Exception as e:
        print()
        print(f"Caught (expected): {type(e).__name__}")
        print(f"  {e}")
        print()
        print("If you see 'loop_detected' or HTTP 403 above, TokSuan did its job.")

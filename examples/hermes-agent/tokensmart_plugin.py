"""
tokensmart_plugin.py — drop-in Hermes-Agent plugin.

Adds the four well-known TokSuan agent attribution headers to every
outbound LLM request:

    x-ts-agent     hermes
    x-ts-channel   <hermes platform: cli, telegram, discord, slack, tui, ...>
    x-ts-session   <hermes session_id>
    x-ts-turn      <0-indexed counter, increments per LLM call in the session>

With these four headers in place, the TokSuan dashboard's `/agents` view
groups spend by `(agent, session)` pair and shows the per-turn timeline,
including model picked, status, cost, latency, tools fired, and any loop /
budget / plan blocks. Without the plugin you still get spend, budgets, loop
detection, routing, and receipts — you just lose the per-session rollup.

INSTALL
-------

    mkdir -p ~/.hermes/plugins/tokensmart
    cp tokensmart_plugin.py ~/.hermes/plugins/tokensmart/__init__.py
    # Restart Hermes; verify with:
    hermes plugins list

Hermes' PluginManager auto-discovers any folder under `~/.hermes/plugins/`
that exposes a top-level `register(ctx)` callable.

ADAPT-TO-YOUR-VERSION
---------------------

The lifecycle hook surface (`pre_llm_call`, `on_session_start`, ...) is
documented in `hermes-agent/AGENTS.md` ("General plugins") but the exact
ctx method names and callback signatures evolve between releases. If the
import or registration line errors out on your build, check
`hermes_cli/plugins.py` for the canonical `register_hook` / `add_hook`
name and the kwargs your version actually passes. The header-injection
intent below is portable — only the registration glue changes.
"""

from __future__ import annotations

import os
from threading import Lock
from typing import Any, Dict


_AGENT_NAME = "hermes"
_DEFAULT_PLATFORM = os.environ.get("HERMES_PLATFORM", "cli")

_lock = Lock()
_turn_counters: Dict[str, int] = {}


def register(ctx: Any) -> None:
    """Entry point Hermes' PluginManager calls at startup."""
    # Hermes' ctx surface uses one of these spellings depending on version.
    # The first that exists wins; all three accept (hook_name, callback).
    add_hook = (
        getattr(ctx, "add_hook", None)
        or getattr(ctx, "register_hook", None)
        or getattr(ctx, "on", None)
    )
    if not callable(add_hook):
        # Fail loud — better than silently dropping headers.
        raise RuntimeError(
            "tokensmart_plugin: this Hermes build does not expose "
            "add_hook / register_hook / on(). Check hermes_cli/plugins.py "
            "for the current plugin ctx surface."
        )

    add_hook("on_session_start", _on_session_start)
    add_hook("pre_llm_call", _pre_llm_call)


def _on_session_start(session: Any, **_: Any) -> None:
    """Reset the per-session turn counter when a new conversation begins."""
    sid = _session_id(session)
    if sid:
        with _lock:
            _turn_counters[sid] = 0


def _pre_llm_call(*args: Any, **kwargs: Any) -> None:
    """
    Inject the four x-ts-* headers into the outbound chat-completion call.

    Hermes routes through `client.chat.completions.create(...)` (OpenAI's
    Python SDK), which respects an `extra_headers` dict for per-request
    headers. Different Hermes versions invoke pre_llm_call differently —
    some pass the request kwargs as a dict, some as an object. We accept
    both.
    """
    # Find the request kwargs dict. Try (in order): a kwarg called
    # "request_kwargs" / "kwargs" / "params"; the first dict in *args;
    # then fall back to mutating kwargs itself (for builds that splat).
    target = (
        kwargs.get("request_kwargs")
        or kwargs.get("kwargs")
        or kwargs.get("params")
    )
    if target is None:
        for arg in args:
            if isinstance(arg, dict):
                target = arg
                break
    if target is None:
        target = kwargs  # last resort — Hermes splats kwargs straight to OpenAI

    sid = _session_id(kwargs.get("session") or kwargs.get("agent")) or "unknown"
    platform = (
        kwargs.get("platform")
        or _attr(kwargs.get("agent"), "platform")
        or _DEFAULT_PLATFORM
    )

    with _lock:
        _turn_counters[sid] = _turn_counters.get(sid, 0) + 1
        turn = _turn_counters[sid]

    headers = {
        "x-ts-agent": _AGENT_NAME,
        "x-ts-channel": str(platform),
        "x-ts-session": sid,
        "x-ts-turn": str(turn),
    }

    existing = target.get("extra_headers") or {}
    if not isinstance(existing, dict):
        existing = {}
    # Don't clobber explicit headers callers already set.
    for k, v in headers.items():
        existing.setdefault(k, v)
    target["extra_headers"] = existing


def _session_id(obj: Any) -> str | None:
    if obj is None:
        return None
    return _attr(obj, "session_id") or _attr(obj, "id")


def _attr(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)

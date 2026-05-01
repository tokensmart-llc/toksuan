import { createHash } from "node:crypto";
import type { OpenAIChatRequest } from "./providers/openai";

const HEAD_CHARS = 200;
const TOOLS_HEAD_CHARS = 500;

/**
 * Stable short hash that identifies "the same kind of call".
 *
 * Inputs:
 *   - project_id — each tenant gets its own namespace
 *   - model — switching models breaks the loop signature
 *   - first HEAD_CHARS of the last user message — the most commonly-looped
 *     input in agent loops is the most recent user turn
 *   - first TOOLS_HEAD_CHARS of `tools` — tool choice matters because an
 *     agent stuck re-selecting the same tool is the classic loop pattern
 *
 * We deliberately ignore system prompt (usually stable) and intermediate
 * assistant/tool messages (vary under retries) so the same underlying task
 * fingerprints consistently even with small scaffolding differences.
 *
 * Returned as a 16-char hex prefix of SHA-256 — collisions are acceptable at
 * our scale; the cost of a false positive is one rejected request, not data
 * corruption.
 */
export function fingerprintRequest(
  projectId: string,
  body: OpenAIChatRequest
): string {
  const model = String(body.model ?? "");

  let sampleText = "";
  if (Array.isArray(body.messages)) {
    const lastUser = [...body.messages].reverse().find((m) => m?.role === "user");
    const c = lastUser?.content;
    if (typeof c === "string") sampleText = c;
    else if (c != null) {
      try {
        sampleText = JSON.stringify(c);
      } catch {
        sampleText = String(c);
      }
    }
  }
  const head = sampleText.slice(0, HEAD_CHARS);

  let toolsHead = "";
  if (body.tools != null) {
    try {
      toolsHead = JSON.stringify(body.tools).slice(0, TOOLS_HEAD_CHARS);
    } catch {
      toolsHead = String(body.tools);
    }
  }

  return createHash("sha256")
    .update(`${projectId}\0${model}\0${head}\0${toolsHead}`)
    .digest("hex")
    .slice(0, 16);
}

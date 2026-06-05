/**
 * Reversible compression store (M4) — TokSuan's take on Headroom's CCR.
 *
 * When the pipeline rewrites a tool message in `optimize` mode AND the
 * operator opted into storage (`TOKENSMART_CONTEXT_COMPRESS_STORE=1`), we
 * persist the pre-compression original alongside the compressed form,
 * scoped to `(project_id, request_id)`. An operator can then retrieve the
 * untouched bytes from the dashboard / internal endpoint — so compression
 * is never a one-way door.
 *
 * Best-effort by contract: every function swallows nothing on the caller's
 * behalf, but callers invoke them with `.catch()` so a storage hiccup
 * never fails the actual LLM request.
 */

import { createHash } from "node:crypto";
import { sql } from "../db";

export type CompressedBlobInput = {
  /** Index of the message in the original `messages[]` array. */
  messageIndex: number;
  /** Detected shape (git_diff, json_array, ...). */
  strategy: string;
  original: string;
  compressed: string;
};

export type CompressedBlobRow = {
  id: string;
  request_id: string;
  project_id: string | null;
  message_index: number;
  strategy: string;
  hash: string;
  original_content: string;
  compressed_content: string;
  original_chars: number;
  compressed_chars: number;
  created_at: Date;
};

/** Stable content hash (sha256, 24 hex chars) for dedupe + retrieval keys. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 24);
}

/**
 * Persist one row per compressed message. Throws on DB error — callers
 * MUST wrap in `.catch()` so storage never blocks the request path.
 */
export async function storeCompressedBlobs(
  projectId: string | null,
  requestId: string,
  entries: CompressedBlobInput[]
): Promise<void> {
  if (entries.length === 0) return;
  for (const e of entries) {
    await sql`
      INSERT INTO compressed_blobs (
        request_id, project_id, message_index, strategy, hash,
        original_content, compressed_content, original_chars, compressed_chars
      ) VALUES (
        ${requestId}, ${projectId}, ${e.messageIndex}, ${e.strategy},
        ${hashContent(e.original)}, ${e.original}, ${e.compressed},
        ${e.original.length}, ${e.compressed.length}
      )
    `;
  }
}

/**
 * Retrieve all stored originals for a request, scoped to a project so a
 * caller can never read another tenant's blobs. Newest first.
 */
export async function getCompressedBlobsForRequest(
  projectId: string | null,
  requestId: string
): Promise<CompressedBlobRow[]> {
  return sql<CompressedBlobRow[]>`
    SELECT id, request_id, project_id, message_index, strategy, hash,
           original_content, compressed_content, original_chars,
           compressed_chars, created_at
      FROM compressed_blobs
     WHERE request_id = ${requestId}
       AND (project_id IS NOT DISTINCT FROM ${projectId})
     ORDER BY message_index ASC
  `;
}

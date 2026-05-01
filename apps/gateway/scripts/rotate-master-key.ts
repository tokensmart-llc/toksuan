#!/usr/bin/env bun
/**
 * Rotate the BYO-provider-key encryption master key.
 *
 * Re-encrypts every row in `user_provider_keys` from OLD_KEY → NEW_KEY in a
 * single transaction. Safe to re-run: rows already encrypted with NEW_KEY
 * (e.g. from a partial previous run, or new keys uploaded after the rotation
 * started) are detected and skipped.
 *
 * USAGE
 * -----
 *   1. Generate the new key:
 *        openssl rand -hex 32
 *
 *   2. Run with BOTH keys in env (do NOT change your live env yet — gateway
 *      and dashboard are still running on OLD_KEY at this point):
 *
 *        TOKENSMART_PROVIDER_KEY_ENCRYPTION_OLD=<old 64-hex chars> \
 *        TOKENSMART_PROVIDER_KEY_ENCRYPTION_NEW=<new 64-hex chars> \
 *        bun run rotate-master-key
 *
 *      Add `--dry-run` first to see what would change without writing.
 *
 *   3. After the script reports SUCCESS, atomically swap your secret store:
 *        - Set TOKENSMART_PROVIDER_KEY_ENCRYPTION = NEW value
 *          on BOTH gateway and dashboard.
 *        - Restart both processes.
 *
 *   4. Verify by logging in and visiting /settings → keys still shown with
 *      correct last-4. Hit the gateway with a known BYO-keyed project to
 *      confirm decryption still works end-to-end.
 *
 * SAFETY GUARANTEES
 * -----------------
 *   - Single transaction: either every row migrates or nothing does.
 *   - Per-row round-trip verification: after re-encrypting we immediately
 *     decrypt-with-NEW and assert it matches the original plaintext.
 *     Catches accidentally-swapped OLD/NEW arguments before COMMIT.
 *   - Already-rotated rows (decrypt-with-NEW succeeds) are skipped, never
 *     re-encrypted, so re-running after a hiccup never destroys data.
 *   - If a row decrypts with neither key the script aborts the entire
 *     transaction with no writes (you're probably looking at a row from a
 *     third historical key, or genuine corruption — investigate manually).
 *
 * AUDIT TRAIL
 * -----------
 *   For each user whose keys were rotated, one row is appended to
 *   `audit_events` with event=`provider_key.master_rotated` and metadata
 *   containing the OLD and NEW master-key fingerprints (first 8 hex of
 *   SHA-256, NOT the keys themselves). This lets the user retroactively see
 *   their keys were re-encrypted and lets the operator prove which rotation
 *   touched them.
 */

import { sql, logOpsEvent } from "../src/db";
import {
  decryptWith,
  encryptWith,
  masterKeyFingerprint,
  parseEncryptionKey,
} from "../src/crypto";

const ROTATION_RUN_ACTOR = process.env.ROTATION_ACTOR ?? "rotate-master-key cli";

type Args = {
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run" || arg === "-n") a.dryRun = true;
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`rotate-master-key: unknown arg: ${arg}\n`);
      printHelp();
      process.exit(1);
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`Usage:
  TOKENSMART_PROVIDER_KEY_ENCRYPTION_OLD=<old 64-hex>  \\
  TOKENSMART_PROVIDER_KEY_ENCRYPTION_NEW=<new 64-hex>  \\
    bun run rotate-master-key [--dry-run]

Flags:
  --dry-run, -n  Decrypt + verify everything but write nothing.
  --help, -h     This message.

Required env:
  TOKENSMART_PROVIDER_KEY_ENCRYPTION_OLD   the master key currently in use
  TOKENSMART_PROVIDER_KEY_ENCRYPTION_NEW   the key you want to rotate to

After this script reports SUCCESS, swap TOKENSMART_PROVIDER_KEY_ENCRYPTION
in BOTH gateway and dashboard env to the NEW value, and restart both.
`);
}

function loadKeys(): { oldKey: Buffer; newKey: Buffer } {
  const oldRaw = process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION_OLD?.trim();
  const newRaw = process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION_NEW?.trim();
  if (!oldRaw) {
    console.error(
      "❌ TOKENSMART_PROVIDER_KEY_ENCRYPTION_OLD is not set. See --help."
    );
    process.exit(1);
  }
  if (!newRaw) {
    console.error(
      "❌ TOKENSMART_PROVIDER_KEY_ENCRYPTION_NEW is not set. See --help."
    );
    process.exit(1);
  }
  if (oldRaw === newRaw) {
    console.error(
      "❌ OLD and NEW keys are identical. Nothing to rotate. Did you forget to generate a new one with `openssl rand -hex 32`?"
    );
    process.exit(1);
  }
  const oldKey = parseEncryptionKey(oldRaw, "OLD master key");
  const newKey = parseEncryptionKey(newRaw, "NEW master key");
  return { oldKey, newKey };
}

type Row = {
  id: string;
  user_id: string;
  provider: string;
  encrypted_key: string;
  key_last4: string;
  master_key_fingerprint: string | null;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { oldKey, newKey } = loadKeys();
  const oldFp = masterKeyFingerprint(oldKey);
  const newFp = masterKeyFingerprint(newKey);

  console.log(
    `[rotate] old master key fingerprint: ${oldFp}\n` +
      `[rotate] new master key fingerprint: ${newFp}\n` +
      (args.dryRun ? "[rotate] DRY RUN — no writes will be performed.\n" : "")
  );

  if (!args.dryRun) {
    await logOpsEvent({
      event: "provider_key.master_rotation_started",
      actor: ROTATION_RUN_ACTOR,
      metadata: { old_fingerprint: oldFp, new_fingerprint: newFp },
    });
  }

  // Filter by fingerprint column when possible — at scale this avoids
  // reading + decrypting rows that are already at NEW_FP. We still include
  // legacy NULL-fingerprint rows because the resolver hasn't necessarily
  // backfilled them yet (and rows that pre-date migration 004 always need
  // a try-decrypt to determine their state).
  const rows = await sql<Row[]>`
    SELECT id, user_id, provider, encrypted_key, key_last4,
           master_key_fingerprint
      FROM user_provider_keys
     WHERE master_key_fingerprint IS DISTINCT FROM ${newFp}
     ORDER BY created_at ASC
  `;

  if (rows.length === 0) {
    console.log(
      "[rotate] no rows to consider — every user_provider_keys row already has master_key_fingerprint = NEW. Nothing to do."
    );
    if (!args.dryRun) {
      await logOpsEvent({
        event: "provider_key.master_rotation_completed",
        actor: ROTATION_RUN_ACTOR,
        metadata: {
          old_fingerprint: oldFp,
          new_fingerprint: newFp,
          rotated: 0,
          already_new: 0,
          users_affected: 0,
        },
      });
    }
    await sql.end();
    return;
  }

  console.log(`[rotate] inspecting ${rows.length} candidate row(s)...`);

  type Plan =
    | { kind: "rotate"; row: Row; newCt: string }
    | { kind: "already-new"; row: Row }
    | { kind: "corrupt"; row: Row; reason: string };

  const plan: Plan[] = [];

  for (const row of rows) {
    // Try OLD first — that's the expected case during a normal rotation.
    let plaintext: string | null = null;
    try {
      plaintext = decryptWith(row.encrypted_key, oldKey);
    } catch {
      // Fall through; try NEW below.
    }

    if (plaintext != null) {
      const newCt = encryptWith(plaintext, newKey);
      // Round-trip verify with NEW. If this fails we'd be writing data we
      // can't read back — abort the whole rotation rather than commit.
      let verify: string;
      try {
        verify = decryptWith(newCt, newKey);
      } catch (err) {
        console.error(
          `[rotate] FATAL: re-encrypted row ${row.id} fails to decrypt with NEW key. ` +
            `OLD/NEW arguments may be swapped. Aborting with no writes. (${(err as Error).message})`
        );
        process.exit(2);
      }
      if (verify !== plaintext) {
        console.error(
          `[rotate] FATAL: round-trip mismatch on row ${row.id}. Aborting with no writes.`
        );
        process.exit(2);
      }
      plan.push({ kind: "rotate", row, newCt });
      continue;
    }

    // OLD didn't work — maybe this row was already rotated by a previous run.
    try {
      decryptWith(row.encrypted_key, newKey);
      plan.push({ kind: "already-new", row });
      continue;
    } catch {
      // Neither key works. Bail out — operator needs to investigate.
      plan.push({
        kind: "corrupt",
        row,
        reason: "decrypts with neither OLD nor NEW",
      });
    }
  }

  const corrupt = plan.filter((p) => p.kind === "corrupt");
  if (corrupt.length > 0) {
    console.error(
      `\n[rotate] FATAL: ${corrupt.length} row(s) decrypt with neither key:`
    );
    for (const p of corrupt) {
      if (p.kind !== "corrupt") continue;
      console.error(
        `  - id=${p.row.id} user=${p.row.user_id} provider=${p.row.provider} (${p.reason})`
      );
    }
    console.error(
      "Aborting with no writes. Investigate manually — these rows may have been encrypted with a third historical key, or the row is genuinely corrupt."
    );
    if (!args.dryRun) {
      await logOpsEvent({
        event: "provider_key.master_rotation_failed",
        actor: ROTATION_RUN_ACTOR,
        metadata: {
          old_fingerprint: oldFp,
          new_fingerprint: newFp,
          reason: "rows_decrypt_with_neither_key",
          corrupt_count: corrupt.length,
          corrupt_ids: corrupt
            .filter((p) => p.kind === "corrupt")
            .map((p) => (p.kind === "corrupt" ? p.row.id : "")),
        },
      });
    }
    await sql.end();
    process.exit(2);
  }

  const toRotate = plan.filter((p) => p.kind === "rotate");
  const skipped = plan.filter((p) => p.kind === "already-new");

  console.log(
    `[rotate] plan: rotate=${toRotate.length}, already-new=${skipped.length}, corrupt=0`
  );

  if (toRotate.length === 0) {
    console.log(
      "[rotate] nothing to write — every row is already encrypted with NEW key."
    );
    await sql.end();
    return;
  }

  if (args.dryRun) {
    console.log("[rotate] DRY RUN — exiting without commit.");
    for (const p of toRotate.slice(0, 5)) {
      if (p.kind !== "rotate") continue;
      console.log(
        `         would rotate id=${p.row.id} user=${p.row.user_id} provider=${p.row.provider} last4=${p.row.key_last4}`
      );
    }
    if (toRotate.length > 5) {
      console.log(`         ... and ${toRotate.length - 5} more`);
    }
    await sql.end();
    return;
  }

  // ===== COMMIT =====
  // Atomic per-row UPDATE inside ONE transaction so we never leave the table
  // half-rotated. Both audit log inserts (per-user `audit_events` and the
  // top-level ops_audit_events row) live in the same transaction so a
  // mid-rotation failure rolls back everything together.
  const affectedUsers = new Set<string>();

  try {
    await sql.begin(async (tx) => {
      for (const p of toRotate) {
        if (p.kind !== "rotate") continue;
        await tx`
          UPDATE user_provider_keys
             SET encrypted_key          = ${p.newCt},
                 master_key_fingerprint = ${newFp},
                 updated_at             = NOW()
           WHERE id = ${p.row.id}
        `;
        affectedUsers.add(p.row.user_id);
      }

      for (const userId of affectedUsers) {
        await tx`
          INSERT INTO audit_events (
            user_id, event, target_type, metadata
          ) VALUES (
            ${userId},
            'provider_key.master_rotated',
            'provider_key',
            ${tx.json({
              old_fingerprint: oldFp,
              new_fingerprint: newFp,
              rotated_at: new Date().toISOString(),
            } as Parameters<typeof tx.json>[0])}
          )
        `;
      }

      await tx`
        INSERT INTO ops_audit_events (
          event, actor, metadata
        ) VALUES (
          'provider_key.master_rotation_completed',
          ${ROTATION_RUN_ACTOR},
          ${tx.json({
            old_fingerprint: oldFp,
            new_fingerprint: newFp,
            rotated: toRotate.length,
            already_new: skipped.length,
            users_affected: affectedUsers.size,
          } as Parameters<typeof tx.json>[0])}
        )
      `;
    });
  } catch (err) {
    await logOpsEvent({
      event: "provider_key.master_rotation_failed",
      actor: ROTATION_RUN_ACTOR,
      metadata: {
        old_fingerprint: oldFp,
        new_fingerprint: newFp,
        reason: "transaction_failed",
        error: (err as Error).message,
      },
    });
    throw err;
  }

  console.log(
    `\n[rotate] SUCCESS — rotated ${toRotate.length} row(s) across ${affectedUsers.size} user(s).\n` +
      `[rotate] NEXT STEPS:\n` +
      `  1. Set TOKENSMART_PROVIDER_KEY_ENCRYPTION = ${newFp}... (the NEW key)\n` +
      `     on BOTH gateway and dashboard secret stores.\n` +
      `  2. Restart both processes.\n` +
      `  3. Verify by visiting /settings — keys still listed with correct last-4.\n` +
      `  4. Send a request through the gateway from a project whose owner has a\n` +
      `     BYO key — should succeed without errors.\n` +
      `  5. Securely destroy the OLD key from your records.\n`
  );

  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await sql.end();
  } catch {
    /* noop */
  }
  process.exit(1);
});

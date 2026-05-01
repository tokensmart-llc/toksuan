#!/usr/bin/env bun
/**
 * Migrate BYO upstream provider keys from env-master-key encryption to AWS
 * KMS envelope encryption.
 *
 * Single-direction: env → KMS. Not intended to be reversed. After a
 * successful run, new writes hit KMS (because `TOKENSMART_KMS_KEY_ARN` is
 * set) and the env master key is only needed as a fallback for the small
 * window while this script is running.
 *
 * USAGE
 * -----
 *   1. Set up the AWS CMK + IAM policy (see kms-provider.ts source for the
 *      minimal policy). Confirm the gateway's IAM role can call
 *      `kms:GenerateDataKey` + `kms:Decrypt` on it.
 *
 *   2. Update gateway + dashboard env:
 *        TOKENSMART_PROVIDER_KEY_ENCRYPTION=<existing-env-master-key>
 *        TOKENSMART_KMS_KEY_ARN=arn:aws:kms:us-east-1:...
 *        AWS_REGION=us-east-1  (plus standard AWS credential chain)
 *
 *      Restart both. Both backends are now loaded; KMS is active for
 *      writes, env is fallback for reads of not-yet-migrated rows.
 *
 *   3. Dry-run against the DB:
 *        bun run migrate-to-kms -- --dry-run
 *
 *   4. Commit:
 *        bun run migrate-to-kms
 *
 *   5. After this reports SUCCESS with `remaining=0`, you can remove
 *      `TOKENSMART_PROVIDER_KEY_ENCRYPTION` from env — env-era rows no
 *      longer exist. (Skip this step if you plan to migrate back; keep
 *      env in place for defense in depth otherwise.)
 *
 * SAFETY
 * ------
 *   - Per-row UPDATE, one transaction per batch. Interrupting the script
 *     mid-run leaves partial progress but never corrupts any row.
 *   - Round-trip verification per row: after re-encrypting with KMS we
 *     immediately call the KMS decrypt path and assert the plaintext
 *     matches the original.
 *   - Idempotent: re-running picks up only rows that still have env or
 *     NULL fingerprints. Rows that already have `kms:` fingerprints are
 *     not touched, not decrypted, not sent to KMS.
 */

import {
  decryptProviderKey,
  encryptProviderKey,
  getActiveKeyProvider,
  _envKeyProviderForTests as envKeyProvider,
} from "../src/crypto";
import { logOpsEvent, sql } from "../src/db";

type Args = {
  dryRun: boolean;
  batchSize: number;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, batchSize: 50 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "-n") a.dryRun = true;
    else if (arg === "--batch-size") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`--batch-size must be a positive integer`);
        process.exit(1);
      }
      a.batchSize = Math.floor(n);
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`migrate-to-kms: unknown arg: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`Usage:
  bun run migrate-to-kms [--dry-run] [--batch-size N]

Required env:
  TOKENSMART_PROVIDER_KEY_ENCRYPTION   current env master key (source)
  TOKENSMART_KMS_KEY_ARN               destination KMS CMK ARN

Flags:
  --dry-run     Decrypt + verify everything without writing.
  --batch-size  Rows per transaction (default 50). Larger batches are
                faster but hold a Postgres transaction open longer and
                widen the window where KMS failures roll back more work.
  --help        This message.

After a successful run every row in user_provider_keys is envelope-encrypted
by your KMS CMK. Consider removing TOKENSMART_PROVIDER_KEY_ENCRYPTION from
env at that point.
`);
}

type Row = {
  id: string;
  user_id: string;
  provider: string;
  encrypted_key: string;
  master_key_fingerprint: string | null;
};

const ACTOR = process.env.MIGRATE_ACTOR ?? "migrate-to-kms cli";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const active = getActiveKeyProvider();
  if (active.name !== "kms") {
    console.error(
      "❌ TOKENSMART_KMS_KEY_ARN is not set — no KMS destination to migrate TO. Set the env var + AWS credentials and re-run."
    );
    process.exit(1);
  }
  if (!envKeyProvider.isConfigured()) {
    console.error(
      "❌ TOKENSMART_PROVIDER_KEY_ENCRYPTION is not set — no env source to migrate FROM. If you've already migrated, there's nothing to do."
    );
    process.exit(1);
  }

  const targetFp = active.currentFingerprint();
  console.log(
    `[migrate-to-kms] destination fingerprint: ${targetFp}\n` +
      (args.dryRun ? "[migrate-to-kms] DRY RUN — no writes will be performed.\n" : "")
  );

  if (!args.dryRun) {
    await logOpsEvent({
      event: "provider_key.migrate_to_kms_started",
      actor: ACTOR,
      metadata: { destination_fingerprint: targetFp },
    });
  }

  // Rows that still live on env or are unmarked legacy. Anything already
  // stamped with a `kms:` fingerprint is untouched.
  const candidates = await sql<Row[]>`
    SELECT id, user_id, provider, encrypted_key, master_key_fingerprint
      FROM user_provider_keys
     WHERE master_key_fingerprint IS NULL
        OR master_key_fingerprint NOT LIKE 'kms:%'
     ORDER BY created_at ASC
  `;

  if (candidates.length === 0) {
    console.log(
      "[migrate-to-kms] no env or legacy rows found — every row is already KMS-backed. Nothing to do."
    );
    if (!args.dryRun) {
      await logOpsEvent({
        event: "provider_key.migrate_to_kms_completed",
        actor: ACTOR,
        metadata: {
          destination_fingerprint: targetFp,
          migrated: 0,
          users_affected: 0,
          remaining: 0,
        },
      });
    }
    await sql.end();
    return;
  }

  console.log(
    `[migrate-to-kms] ${candidates.length} row(s) to migrate (batch size ${args.batchSize})`
  );

  let migrated = 0;
  let failed = 0;
  const affectedUsers = new Set<string>();

  for (let i = 0; i < candidates.length; i += args.batchSize) {
    const batch = candidates.slice(i, i + args.batchSize);

    // Phase 1 (outside the DB txn): decrypt-with-env + encrypt-with-KMS +
    // round-trip verify. We don't hold a transaction open while waiting on
    // KMS network calls — if a single row fails we skip just that row.
    type Prepared = {
      row: Row;
      newCt: string;
      newFp: string;
    };
    const prepared: Prepared[] = [];

    for (const row of batch) {
      try {
        const plaintext = await decryptProviderKey(
          row.encrypted_key,
          row.master_key_fingerprint
        );
        const { ciphertext, fingerprint } = await encryptProviderKey(plaintext);
        // Round-trip verify with the NEW backend before we ever write.
        const roundtrip = await decryptProviderKey(ciphertext, fingerprint);
        if (roundtrip !== plaintext) {
          console.error(
            `[migrate-to-kms] FATAL: round-trip mismatch on row ${row.id}. Skipping.`
          );
          failed++;
          continue;
        }
        prepared.push({ row, newCt: ciphertext, newFp: fingerprint });
      } catch (err) {
        console.error(
          `[migrate-to-kms] row ${row.id} (user=${row.user_id} provider=${row.provider}) failed: ${(err as Error).message}`
        );
        failed++;
      }
    }

    if (args.dryRun) {
      for (const p of prepared) {
        console.log(
          `         would migrate id=${p.row.id} user=${p.row.user_id} provider=${p.row.provider} → ${p.newFp}`
        );
      }
      continue;
    }

    if (prepared.length === 0) continue;

    // Phase 2: commit the batch's UPDATEs in one transaction.
    await sql.begin(async (tx) => {
      for (const p of prepared) {
        await tx`
          UPDATE user_provider_keys
             SET encrypted_key          = ${p.newCt},
                 master_key_fingerprint = ${p.newFp},
                 updated_at             = NOW()
           WHERE id = ${p.row.id}
        `;
        affectedUsers.add(p.row.user_id);
      }
    });

    migrated += prepared.length;
    const pct = Math.round(((i + batch.length) / candidates.length) * 100);
    console.log(
      `[migrate-to-kms] progress: ${i + batch.length}/${candidates.length} (${pct}%) — committed ${migrated} so far`
    );
  }

  if (args.dryRun) {
    console.log(
      `[migrate-to-kms] DRY RUN complete. Would have migrated ${candidates.length - failed} row(s).`
    );
    await sql.end();
    return;
  }

  // One per-user audit row so each customer has a trace in their /audit page.
  await sql.begin(async (tx) => {
    for (const userId of affectedUsers) {
      await tx`
        INSERT INTO audit_events (user_id, event, target_type, metadata)
        VALUES (
          ${userId},
          'provider_key.migrated_to_kms',
          'provider_key',
          ${tx.json({
            destination_fingerprint: targetFp,
            migrated_at: new Date().toISOString(),
          } as Parameters<typeof tx.json>[0])}
        )
      `;
    }
  });

  await logOpsEvent({
    event: failed > 0
      ? "provider_key.migrate_to_kms_completed_with_failures"
      : "provider_key.migrate_to_kms_completed",
    actor: ACTOR,
    metadata: {
      destination_fingerprint: targetFp,
      migrated,
      failed,
      users_affected: affectedUsers.size,
    },
  });

  console.log(
    `\n[migrate-to-kms] ${failed > 0 ? "COMPLETED WITH FAILURES" : "SUCCESS"} — migrated ${migrated} row(s) across ${affectedUsers.size} user(s)${
      failed > 0 ? `, ${failed} failed (see above)` : ""
    }.`
  );
  if (failed > 0) {
    console.log(
      "[migrate-to-kms] Re-run the script to retry failed rows once the underlying issue is fixed."
    );
  } else {
    console.log(
      "[migrate-to-kms] You can now remove TOKENSMART_PROVIDER_KEY_ENCRYPTION from env. KMS is the sole backend."
    );
  }

  await sql.end();
  if (failed > 0) process.exit(2);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await logOpsEvent({
      event: "provider_key.migrate_to_kms_failed",
      actor: ACTOR,
      metadata: { error: (err as Error).message },
    });
  } catch {
    /* ignored */
  }
  try {
    await sql.end();
  } catch {
    /* ignored */
  }
  process.exit(1);
});

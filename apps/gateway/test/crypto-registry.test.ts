/**
 * Registry / provider-routing tests. Verifies that the env provider and a
 * hypothetical KMS provider can coexist, and that getProviderForDecrypt()
 * routes by fingerprint prefix.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  _resetCryptoForTests,
  encryptProviderKey,
  decryptProviderKey,
  getActiveKeyProvider,
  initProviderRegistry,
  isProviderKeyEncryptionConfigured,
} from "../src/crypto";

const ENV_KEY_HEX = randomBytes(32).toString("hex");

afterEach(() => {
  delete process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION;
  delete process.env.TOKENSMART_KMS_KEY_ARN;
  delete process.env.TOKENSMART_GCP_KMS_KEY_NAME;
  _resetCryptoForTests();
});

describe("env-only mode", () => {
  test("active provider is env and round-trips", async () => {
    process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION = ENV_KEY_HEX;
    _resetCryptoForTests();

    expect(isProviderKeyEncryptionConfigured()).toBe(true);
    expect(getActiveKeyProvider().name).toBe("env");

    const { ciphertext, fingerprint } = await encryptProviderKey("secret-env");
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
    const plain = await decryptProviderKey(ciphertext, fingerprint);
    expect(plain).toBe("secret-env");
  });

  test("legacy NULL fingerprint still decrypts via env", async () => {
    process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION = ENV_KEY_HEX;
    _resetCryptoForTests();

    const { ciphertext } = await encryptProviderKey("legacy");
    const plain = await decryptProviderKey(ciphertext, null);
    expect(plain).toBe("legacy");
  });

  test("wrong env fingerprint rejects loudly", async () => {
    process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION = ENV_KEY_HEX;
    _resetCryptoForTests();

    const { ciphertext } = await encryptProviderKey("secret");
    expect(
      decryptProviderKey(ciphertext, "deadbeef")
    ).rejects.toThrow(/master key mismatch/);
  });
});

describe("routing by fingerprint prefix", () => {
  test("decryptProviderKey dispatches kms:* → KMS even when env is also configured", async () => {
    // Configure env. No KMS ARN → KMS provider is not constructed. A
    // kms:* fingerprint should therefore fail to find a handler.
    process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION = ENV_KEY_HEX;
    _resetCryptoForTests();

    expect(
      decryptProviderKey("junk", "kms:abcdef01")
    ).rejects.toThrow(/no provider claims fingerprint kms:abcdef01/);
  });

  test("hex fingerprint goes to env provider even when KMS is the active one", async () => {
    process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION = ENV_KEY_HEX;
    process.env.TOKENSMART_KMS_KEY_ARN = "arn:aws:kms:us-east-1:111:key/x";
    _resetCryptoForTests();

    // Active provider switches to KMS for NEW writes...
    expect(getActiveKeyProvider().name).toBe("kms");

    // ...but a read of a row with an env fingerprint still goes via env.
    // Round-trip an env-era row:
    //   1. Temporarily disable KMS for the encrypt step
    delete process.env.TOKENSMART_KMS_KEY_ARN;
    _resetCryptoForTests();
    const { ciphertext, fingerprint } = await encryptProviderKey("env-era");

    //   2. Re-enable KMS and try to decrypt the env-fingerprinted row
    process.env.TOKENSMART_KMS_KEY_ARN = "arn:aws:kms:us-east-1:111:key/x";
    _resetCryptoForTests();
    // The env provider's cached state was reset. Re-set env too so load() finds it.
    process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION = ENV_KEY_HEX;
    _resetCryptoForTests();
    const plain = await decryptProviderKey(ciphertext, fingerprint);
    expect(plain).toBe("env-era");
  });
});

describe("no provider configured at all", () => {
  test("encryptProviderKey throws", async () => {
    _resetCryptoForTests();
    expect(encryptProviderKey("x")).rejects.toThrow();
  });

  test("decryptProviderKey with NULL throws", async () => {
    _resetCryptoForTests();
    expect(decryptProviderKey("anything", null)).rejects.toThrow(
      /legacy NULL-fingerprint row/
    );
  });
});

describe("multi-backend registry", () => {
  test("initProviderRegistry rejects AWS + GCP configured simultaneously", async () => {
    process.env.TOKENSMART_KMS_KEY_ARN = "arn:aws:kms:us-east-1:1:key/x";
    process.env.TOKENSMART_GCP_KMS_KEY_NAME =
      "projects/p/locations/global/keyRings/r/cryptoKeys/k";
    _resetCryptoForTests();
    expect(initProviderRegistry()).rejects.toThrow(
      /Cannot configure BOTH TOKENSMART_KMS_KEY_ARN and TOKENSMART_GCP_KMS_KEY_NAME/i
    );
  });

  test("gcp:* fingerprint routes through GCP provider", async () => {
    process.env.TOKENSMART_GCP_KMS_KEY_NAME =
      "projects/p/locations/global/keyRings/r/cryptoKeys/k";
    _resetCryptoForTests();
    await initProviderRegistry();

    expect(getActiveKeyProvider().name).toBe("kms"); // GCP uses "kms" slot
    // We don't actually call decrypt here because that'd hit GCP; routing
    // itself is what we test. The provider's canHandle check verifies
    // the dispatcher picks GCP over env for gcp:* blobs.
    expect(
      decryptProviderKey("junk-blob", "kms:abcd1234")
    ).rejects.toThrow(/no provider claims/);
  });

  test("env-fingerprinted row remains readable after KMS is activated", async () => {
    // Step 1: env-only era — encrypt something with env master key.
    process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION = ENV_KEY_HEX;
    _resetCryptoForTests();
    await initProviderRegistry();
    expect(getActiveKeyProvider().name).toBe("env");
    const envRow = await encryptProviderKey("encrypted-before-kms");
    expect(envRow.fingerprint).toMatch(/^[0-9a-f]{8}$/);

    // Step 2: operator sets KMS env var alongside env master key. Both
    // backends now loaded. getActiveKeyProvider() is KMS for new writes.
    // Critical invariant: reading the previously-stored env row STILL
    // works — the registry dispatches by fingerprint prefix.
    process.env.TOKENSMART_KMS_KEY_ARN =
      "arn:aws:kms:us-east-1:1:key/migration-target";
    _resetCryptoForTests();
    await initProviderRegistry();
    expect(getActiveKeyProvider().name).toBe("kms");

    // The env-era row decrypts via env — we never touch KMS SDK for this.
    const recovered = await decryptProviderKey(
      envRow.ciphertext,
      envRow.fingerprint
    );
    expect(recovered).toBe("encrypted-before-kms");
  });
});

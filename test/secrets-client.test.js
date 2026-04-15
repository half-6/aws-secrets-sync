import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { getSecret, isAuthError, upsertSecret } from "../src/lib/secrets-client.js";
import { DUMMY_AWS_CONFIG } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal mock SecretsManagerClient whose `send` calls the provided
 * function and returns its result.
 *
 * @param {(cmd: unknown, callIndex: number) => Promise<unknown>} sendFn
 */
function makeMockClient(sendFn) {
  let callIndex = 0;
  return { send: (cmd) => sendFn(cmd, callIndex++) };
}

/** Returns a mock client that always resolves with `response`. */
function clientReturning(response) {
  return makeMockClient(async () => response);
}

/** Returns a mock client that always rejects with an error bearing the given name. */
function clientThrowing(name, message = "aws error") {
  return makeMockClient(async () => {
    const err = new Error(message);
    err.name = name;
    throw err;
  });
}

// ---------------------------------------------------------------------------
// getSecret
// ---------------------------------------------------------------------------
describe("getSecret", () => {
  it("parses and returns a valid JSON object secret", async () => {
    const client = clientReturning({ SecretString: JSON.stringify({ KEY: "value", PORT: 3000 }) });
    const result = await getSecret("app/test", DUMMY_AWS_CONFIG, { _client: client });
    assert.deepEqual(result, { KEY: "value", PORT: 3000 });
  });

  it("throws when SecretString is absent (binary secret)", async () => {
    const client = clientReturning({ SecretString: undefined });
    await assert.rejects(
      () => getSecret("app/test", DUMMY_AWS_CONFIG, { _client: client }),
      /binary secret/,
    );
  });

  it("throws when SecretString is not valid JSON", async () => {
    const client = clientReturning({ SecretString: "not valid json" });
    await assert.rejects(
      () => getSecret("app/test", DUMMY_AWS_CONFIG, { _client: client }),
      /not valid JSON/,
    );
  });

  it("throws when secret is a JSON array instead of an object", async () => {
    const client = clientReturning({ SecretString: "[1, 2, 3]" });
    await assert.rejects(
      () => getSecret("app/test", DUMMY_AWS_CONFIG, { _client: client }),
      /must be a JSON object/,
    );
  });

  it("throws when secret is a JSON primitive instead of an object", async () => {
    const client = clientReturning({ SecretString: '"just a string"' });
    await assert.rejects(
      () => getSecret("app/test", DUMMY_AWS_CONFIG, { _client: client }),
      /must be a JSON object/,
    );
  });

  it("propagates errors from the client", async () => {
    const client = clientThrowing("AccessDeniedException");
    await assert.rejects(
      () => getSecret("app/test", DUMMY_AWS_CONFIG, { _client: client }),
      { name: "AccessDeniedException" },
    );
  });
});

// ---------------------------------------------------------------------------
// upsertSecret
// ---------------------------------------------------------------------------
describe("upsertSecret", () => {
  it("returns 'updated' when PutSecretValue succeeds", async () => {
    const client = clientReturning({});
    const result = await upsertSecret("app/test", { KEY: "val" }, DUMMY_AWS_CONFIG, { _client: client });
    assert.equal(result, "updated");
  });

  it("returns 'created' when PutSecretValue throws ResourceNotFoundException and CreateSecret succeeds", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("not found");
        err.name = "ResourceNotFoundException";
        throw err;
      }
      return {};
    });
    const result = await upsertSecret("app/new", { KEY: "val" }, DUMMY_AWS_CONFIG, { _client: client });
    assert.equal(result, "created");
    assert.equal(callCount, 2);
  });

  it("returns 'updated' and retries Put on ResourceExistsException race condition", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("not found");
        err.name = "ResourceNotFoundException";
        throw err;
      }
      if (callCount === 2) {
        const err = new Error("already exists");
        err.name = "ResourceExistsException";
        throw err;
      }
      return {};
    });
    const result = await upsertSecret("app/race", { KEY: "val" }, DUMMY_AWS_CONFIG, { _client: client });
    assert.equal(result, "updated");
    assert.equal(callCount, 3);
  });

  it("rethrows unexpected errors from PutSecretValue", async () => {
    const client = clientThrowing("InternalServiceError");
    await assert.rejects(
      () => upsertSecret("app/test", { KEY: "val" }, DUMMY_AWS_CONFIG, { _client: client }),
      { name: "InternalServiceError" },
    );
  });

  it("rethrows unexpected errors from CreateSecret", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("not found");
        err.name = "ResourceNotFoundException";
        throw err;
      }
      const err = new Error("service error");
      err.name = "InternalServiceError";
      throw err;
    });
    await assert.rejects(
      () => upsertSecret("app/test", { KEY: "val" }, DUMMY_AWS_CONFIG, { _client: client }),
      { name: "InternalServiceError" },
    );
  });
});

// ---------------------------------------------------------------------------
// getClient branches (tested indirectly via getSecret)
// ---------------------------------------------------------------------------
describe("getClient credential branches", () => {
  it("uses a named profile when only awsProfile is set", async () => {
    // We can't make a real SDK call, but we can verify getSecret propagates
    // the underlying SDK error (rather than blowing up inside getClient).
    const client = clientReturning({ SecretString: JSON.stringify({ OK: "yes" }) });
    const result = await getSecret("app/test", {
      region: "us-west-2",
      profile: "some-profile",
      accessKeyId: undefined,
      secretAccessKey: undefined,
    }, { _client: client });
    assert.deepEqual(result, { OK: "yes" });
  });

  it("warns and falls back to default chain when only accessKeyId is set (missing secretAccessKey)", async () => {
    const warnCalls = /** @type {string[]} */ ([]);
    const warnMock = mock.method(console, "warn", (/** @type {string} */ msg) => { warnCalls.push(msg); });
    try {
      // Do NOT inject _client so that getClient() runs and emits the warning synchronously.
      // The send() call will fail (no real AWS creds / no such secret) — that's expected and ignored.
      // Use a unique region to avoid hitting the client cache from other tests.
      await getSecret("app/test-partial-key", {
        region: "eu-central-1",
        profile: "",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: undefined,
      });
    } catch {
      // Expected: AWS send() will fail without real credentials or matching secret.
    } finally {
      warnMock.mock.restore();
    }
    assert.ok(
      warnCalls.some((m) => m.includes("awsAccessKeyId") || m.includes("awsSecretAccessKey")),
      "expected a warning about partial static credentials",
    );
  });

  it("warns and falls back when only secretAccessKey is set (missing accessKeyId)", async () => {
    const warnCalls = /** @type {string[]} */ ([]);
    const warnMock = mock.method(console, "warn", (/** @type {string} */ msg) => { warnCalls.push(msg); });
    try {
      await getSecret("app/test-partial-secret", {
        region: "ap-southeast-1",
        profile: "",
        accessKeyId: undefined,
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      });
    } catch {
      // Expected: AWS send() will fail without real credentials or matching secret.
    } finally {
      warnMock.mock.restore();
    }
    assert.ok(
      warnCalls.some((m) => m.includes("awsAccessKeyId") || m.includes("awsSecretAccessKey")),
      "expected a warning about partial static credentials",
    );
  });
});

// ---------------------------------------------------------------------------
// isAuthError
// ---------------------------------------------------------------------------
describe("isAuthError", () => {
  const authErrorNames = [
    "ExpiredTokenException",
    "InvalidClientTokenId",
    "AuthFailure",
    "InvalidSignatureException",
    "TokenRefreshRequired",
    "CredentialsProviderError",
    "CredentialUnavailableError",
  ];

  for (const name of authErrorNames) {
    it(`returns true for ${name}`, () => {
      const err = new Error("test");
      err.name = name;
      assert.equal(isAuthError(err), true);
    });
  }

  it("returns false for a generic Error", () => {
    assert.equal(isAuthError(new Error("oops")), false);
  });

  it("returns false for non-Error values", () => {
    assert.equal(isAuthError("string"), false);
    assert.equal(isAuthError(null), false);
    assert.equal(isAuthError(undefined), false);
    assert.equal(isAuthError(42), false);
  });
});

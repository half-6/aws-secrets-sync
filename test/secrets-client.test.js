import { describe, it } from "node:test";
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

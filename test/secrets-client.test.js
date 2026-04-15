import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { getSecret, isAuthError, upsertSecret } from "../src/lib/secrets-client.js";
import { DUMMY_AWS_CONFIG } from "./fixtures.js";

/**
 * Temporarily overrides SecretsManagerClient.prototype.send for one test.
 * Setting it as an own property on the prototype shadows the inherited
 * Client.prototype.send for all existing and future instances.
 * Returns a cleanup function that removes the override.
 *
 * @param {(cmd: unknown, callIndex: number) => Promise<unknown>} sendFn
 * @returns {() => void}
 */
function mockSend(sendFn) {
  let calls = 0;
  SecretsManagerClient.prototype.send = (cmd) => sendFn(cmd, calls++);
  return () => { delete SecretsManagerClient.prototype.send; };
}

// ---------------------------------------------------------------------------
// getSecret
// ---------------------------------------------------------------------------
describe("getSecret", () => {
  it("parses and returns a valid JSON object secret", async () => {
    const restore = mockSend(async () => ({ SecretString: JSON.stringify({ KEY: "value", PORT: 3000 }) }));
    try {
      const result = await getSecret("app/test", DUMMY_AWS_CONFIG);
      assert.deepEqual(result, { KEY: "value", PORT: 3000 });
    } finally {
      restore();
    }
  });

  it("throws when SecretString is absent (binary secret)", async () => {
    const restore = mockSend(async () => ({ SecretString: undefined }));
    try {
      await assert.rejects(() => getSecret("app/test", DUMMY_AWS_CONFIG), /binary secret/);
    } finally {
      restore();
    }
  });

  it("throws when SecretString is not valid JSON", async () => {
    const restore = mockSend(async () => ({ SecretString: "not valid json" }));
    try {
      await assert.rejects(() => getSecret("app/test", DUMMY_AWS_CONFIG), /not valid JSON/);
    } finally {
      restore();
    }
  });

  it("throws when secret is a JSON array instead of an object", async () => {
    const restore = mockSend(async () => ({ SecretString: "[1, 2, 3]" }));
    try {
      await assert.rejects(() => getSecret("app/test", DUMMY_AWS_CONFIG), /must be a JSON object/);
    } finally {
      restore();
    }
  });

  it("throws when secret is a JSON primitive instead of an object", async () => {
    const restore = mockSend(async () => ({ SecretString: '"just a string"' }));
    try {
      await assert.rejects(() => getSecret("app/test", DUMMY_AWS_CONFIG), /must be a JSON object/);
    } finally {
      restore();
    }
  });

  it("propagates errors thrown by the client", async () => {
    const restore = mockSend(async () => {
      const err = new Error("access denied");
      err.name = "AccessDeniedException";
      throw err;
    });
    try {
      await assert.rejects(() => getSecret("app/test", DUMMY_AWS_CONFIG), { name: "AccessDeniedException" });
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// upsertSecret
// ---------------------------------------------------------------------------
describe("upsertSecret", () => {
  it("returns 'updated' when PutSecretValue succeeds", async () => {
    const restore = mockSend(async () => ({}));
    try {
      const result = await upsertSecret("app/test", { KEY: "val" }, DUMMY_AWS_CONFIG);
      assert.equal(result, "updated");
    } finally {
      restore();
    }
  });

  it("returns 'created' when PutSecretValue throws ResourceNotFoundException and CreateSecret succeeds", async () => {
    let callCount = 0;
    const restore = mockSend(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("not found");
        err.name = "ResourceNotFoundException";
        throw err;
      }
      return {};
    });
    try {
      const result = await upsertSecret("app/new", { KEY: "val" }, DUMMY_AWS_CONFIG);
      assert.equal(result, "created");
      assert.equal(callCount, 2);
    } finally {
      restore();
    }
  });

  it("returns 'updated' and retries Put on ResourceExistsException race condition", async () => {
    let callCount = 0;
    const restore = mockSend(async () => {
      callCount++;
      if (callCount === 1) { const e = new Error("not found"); e.name = "ResourceNotFoundException"; throw e; }
      if (callCount === 2) { const e = new Error("already exists"); e.name = "ResourceExistsException"; throw e; }
      return {};
    });
    try {
      const result = await upsertSecret("app/race", { KEY: "val" }, DUMMY_AWS_CONFIG);
      assert.equal(result, "updated");
      assert.equal(callCount, 3);
    } finally {
      restore();
    }
  });

  it("rethrows unexpected errors from PutSecretValue", async () => {
    const restore = mockSend(async () => {
      const err = new Error("internal error"); err.name = "InternalServiceError"; throw err;
    });
    try {
      await assert.rejects(
        () => upsertSecret("app/test", { KEY: "val" }, DUMMY_AWS_CONFIG),
        { name: "InternalServiceError" },
      );
    } finally {
      restore();
    }
  });

  it("rethrows unexpected errors from CreateSecret", async () => {
    let callCount = 0;
    const restore = mockSend(async () => {
      callCount++;
      if (callCount === 1) { const e = new Error("not found"); e.name = "ResourceNotFoundException"; throw e; }
      const err = new Error("service error"); err.name = "InternalServiceError"; throw err;
    });
    try {
      await assert.rejects(
        () => upsertSecret("app/test", { KEY: "val" }, DUMMY_AWS_CONFIG),
        { name: "InternalServiceError" },
      );
    } finally {
      restore();
    }
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

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCommand, uploadEnvFileToSecret } from "../src/upload-env.js";
import { DUMMY_AWS_CONFIG } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a mock getSecretFn that always resolves with `secret`. */
function getSecretReturning(secret) {
  return async () => secret;
}

/** Runs a command action and captures what the mock upsert received. */
async function runUploadAction(configFile, { awsSecret, promptAnswer = true, name = "upload" } = {}) {
  /** @type {Array<{ secretName: string; payload: Record<string, unknown> }>} */
  const upsertCalls = [];

  const getSecretFn = awsSecret instanceof Error
    ? async () => { throw awsSecret; }
    : getSecretReturning(awsSecret ?? {});

  /** @param {string} secretName @param {Record<string, unknown>} payload @returns {Promise<"updated">} */
  const upsertFn = async (secretName, payload) => { upsertCalls.push({ secretName, payload }); return "updated"; };

  const cmd = buildCommand(name, {
    promptFn: async () => promptAnswer,
    getSecretFn,
    upsertFn,
  });

  await cmd.parseAsync(["node", name, "-f", configFile]);
  return upsertCalls;
}

// ---------------------------------------------------------------------------
// buildCommand — shape
// ---------------------------------------------------------------------------
describe("buildCommand (upload)", () => {
  it("creates a command named 'upload' by default", () => {
    const cmd = buildCommand();
    assert.equal(cmd.name(), "upload");
  });

  it("accepts a custom name", () => {
    const cmd = buildCommand("push");
    assert.equal(cmd.name(), "push");
  });

  it("has an env-filter argument and --file and --yes options", () => {
    const cmd = buildCommand();
    assert.ok(cmd.registeredArguments.some((a) => a.name() === "env-filter"));
    assert.ok(cmd.options.some((o) => o.short === "-f"));
    assert.ok(cmd.options.some((o) => o.short === "-y"));
  });
});

// ---------------------------------------------------------------------------
// buildCommand action — compare + prompt flow
// ---------------------------------------------------------------------------
describe("buildCommand (upload) action — compare and prompt", () => {
  let tmpDir = "";

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aws-upload-action-test-"));
    mock.method(console, "log", () => {});
    mock.method(console, "warn", () => {});
    mock.method(console, "error", () => {});
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  it("skips upload when local file is already in sync with AWS", async () => {
    const envFile = path.join(tmpDir, "sync.env");
    fs.writeFileSync(envFile, "FOO=bar\nPORT=3000\n");
    const configFile = path.join(tmpDir, "cfg-sync.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/sync" }],
    }));

    const upsertCalls = await runUploadAction(configFile, {
      awsSecret: { FOO: "bar", PORT: "3000" },
      promptAnswer: true,
    });

    assert.equal(upsertCalls.length, 0, "should not upload when already in sync");
  });

  it("uploads when user confirms after seeing a diff", async () => {
    const envFile = path.join(tmpDir, "changed.env");
    fs.writeFileSync(envFile, "FOO=new-value\nBAR=added\n");
    const configFile = path.join(tmpDir, "cfg-changed.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/changed" }],
    }));

    const upsertCalls = await runUploadAction(configFile, {
      awsSecret: { FOO: "old-value", OLD_KEY: "gone" },
      promptAnswer: true,
    });

    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].secretName, "app/changed");
    assert.deepEqual(upsertCalls[0].payload, { FOO: "new-value", BAR: "added" });
  });

  it("skips upload when user declines the prompt", async () => {
    const envFile = path.join(tmpDir, "declined.env");
    fs.writeFileSync(envFile, "FOO=local\n");
    const configFile = path.join(tmpDir, "cfg-declined.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/declined" }],
    }));

    const upsertCalls = await runUploadAction(configFile, {
      awsSecret: { FOO: "different" },
      promptAnswer: false,
    });

    assert.equal(upsertCalls.length, 0, "should not upload when user declines");
  });

  it("prompts and uploads when secret does not yet exist in AWS", async () => {
    const envFile = path.join(tmpDir, "new-secret.env");
    fs.writeFileSync(envFile, "BRAND_NEW=yes\n");
    const configFile = path.join(tmpDir, "cfg-new.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/new" }],
    }));

    const notFoundErr = new Error("not found");
    notFoundErr.name = "ResourceNotFoundException";

    const upsertCalls = await runUploadAction(configFile, {
      awsSecret: notFoundErr,
      promptAnswer: true,
    });

    assert.equal(upsertCalls.length, 1);
    assert.deepEqual(upsertCalls[0].payload, { BRAND_NEW: "yes" });
  });

  it("skips upload and exits 1 when fetch fails with a non-auth, non-404 error", async () => {
    const envFile = path.join(tmpDir, "fetch-err.env");
    fs.writeFileSync(envFile, "KEY=val\n");
    const configFile = path.join(tmpDir, "cfg-fetch-err.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/fetch-err" }],
    }));

    const fetchErr = new Error("service unavailable");
    fetchErr.name = "InternalServiceError";

    const exitMock = mock.method(process, "exit", () => { throw new Error("process.exit(1)"); });
    try {
      await assert.rejects(
        () => runUploadAction(configFile, { awsSecret: fetchErr, promptAnswer: true }),
        /process\.exit\(1\)/,
      );
      assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    } finally {
      exitMock.mock.restore();
    }
  });

  it("--yes skips the prompt and uploads automatically", async () => {
    const envFile = path.join(tmpDir, "yes-flag.env");
    fs.writeFileSync(envFile, "CHANGED=new\n");
    const configFile = path.join(tmpDir, "cfg-yes.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/yes" }],
    }));

    /** @type {Array<{ secretName: string; payload: Record<string, unknown> }>} */
    const upsertCalls = [];
    const promptSpy = mock.fn(async () => false); // would return false if called
    const cmd = buildCommand("upload", {
      promptFn: promptSpy,
      getSecretFn: async () => ({ CHANGED: "old" }),
      upsertFn: async (secretName, payload) => { upsertCalls.push({ secretName, payload }); return "updated"; },
    });
    await cmd.parseAsync(["node", "upload", "--yes", "-f", configFile]);

    assert.equal(promptSpy.mock.calls.length, 0, "prompt should not be called with --yes");
    assert.equal(upsertCalls.length, 1);
    assert.deepEqual(upsertCalls[0].payload, { CHANGED: "new" });
  });

  it("exits 1 when no mappings match the filter", async () => {
    const configFile = path.join(tmpDir, "cfg-no-match.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: ".env/.env.staging.local", secretName: "app/staging" }],
    }));

    const exitMock = mock.method(process, "exit", () => { throw new Error("process.exit(1)"); });
    try {
      const cmd = buildCommand("upload", { promptFn: async () => false });
      await assert.rejects(
        () => cmd.parseAsync(["node", "upload", "nonexistent", "-f", configFile]),
        /process\.exit\(1\)/,
      );
      assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    } finally {
      exitMock.mock.restore();
    }
  });

  it("marks anyFailed and exits 1 when local file is missing", async () => {
    const configFile = path.join(tmpDir, "cfg-missing-local.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: path.join(tmpDir, "does-not-exist.env"), secretName: "app/missing" }],
    }));

    const exitMock = mock.method(process, "exit", () => { throw new Error("process.exit(1)"); });
    try {
      const cmd = buildCommand("upload", {
        promptFn: async () => true,
        getSecretFn: getSecretReturning({}),
      });
      await assert.rejects(
        () => cmd.parseAsync(["node", "upload", "-f", configFile]),
        /process\.exit\(1\)/,
      );
      assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    } finally {
      exitMock.mock.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// uploadEnvFileToSecret
// ---------------------------------------------------------------------------
describe("uploadEnvFileToSecret", () => {
  let tmpDir = "";

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aws-upload-test-"));
    mock.method(console, "log", () => {});
    mock.method(console, "error", () => {});
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  it("returns false when the local .env file does not exist", async () => {
    const result = await uploadEnvFileToSecret(
      path.join(tmpDir, "nonexistent.env"),
      "app/test/secret",
      DUMMY_AWS_CONFIG,
    );
    assert.equal(result, false);
  });

  it("returns true and logs 'Updated' when upsertFn returns 'updated'", async () => {
    const filePath = path.join(tmpDir, "test.env");
    fs.writeFileSync(filePath, "FOO=bar\nBAZ=qux\n");

    /** @type {Record<string, unknown> | null} */
    let capturedPayload = null;
    /** @param {string} _name @param {Record<string, unknown>} obj @returns {Promise<"updated">} */
    const mockUpsert = async (_name, obj) => { capturedPayload = obj; return "updated"; };

    const result = await uploadEnvFileToSecret(filePath, "app/test/secret", DUMMY_AWS_CONFIG, { upsertFn: mockUpsert });
    assert.equal(result, true);
    assert.deepEqual(capturedPayload, { FOO: "bar", BAZ: "qux" });
  });

  it("returns true and logs 'Created' when upsertFn returns 'created'", async () => {
    const filePath = path.join(tmpDir, "new.env");
    fs.writeFileSync(filePath, "NEW_KEY=new_val\n");

    /** @returns {Promise<"created">} */
    const mockUpsert = async () => "created";

    const result = await uploadEnvFileToSecret(filePath, "app/test/new-secret", DUMMY_AWS_CONFIG, { upsertFn: mockUpsert });
    assert.equal(result, true);
  });

  it("returns false when upsertFn throws a non-auth error", async () => {
    const filePath = path.join(tmpDir, "err.env");
    fs.writeFileSync(filePath, "X=1\n");

    const mockUpsert = async () => { throw new Error("network failure"); };

    const result = await uploadEnvFileToSecret(filePath, "app/test/secret", DUMMY_AWS_CONFIG, { upsertFn: mockUpsert });
    assert.equal(result, false);
  });
});

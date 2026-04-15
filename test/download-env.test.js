import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCommand, formatEnvLine, writeSecretToFile } from "../src/download-env.js";
import { DUMMY_AWS_CONFIG } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs the download action with injected fns and returns the envFilePath for
 * the first mapping so callers can inspect the written file.
 *
 * @param {string} configFile
 * @param {{ awsSecret?: Record<string, unknown> | Error; promptAnswer?: boolean; envFilter?: string }} [opts]
 */
async function runDownloadAction(configFile, { awsSecret = {}, promptAnswer = true, envFilter } = {}) {
  const getSecretFn = awsSecret instanceof Error
    ? async () => { throw awsSecret; }
    : async () => /** @type {Record<string, unknown>} */ (awsSecret);

  const cmd = buildCommand("download", {
    promptFn: async () => promptAnswer,
    getSecretFn,
  });

  const args = ["node", "download"];
  if (envFilter) args.push(envFilter);
  args.push("-f", configFile);
  await cmd.parseAsync(args);
}

// ---------------------------------------------------------------------------
// buildCommand — shape
// ---------------------------------------------------------------------------
describe("buildCommand (download)", () => {
  it("creates a command named 'download' by default", () => {
    const cmd = buildCommand();
    assert.equal(cmd.name(), "download");
  });

  it("accepts a custom name", () => {
    const cmd = buildCommand("pull");
    assert.equal(cmd.name(), "pull");
  });

  it("has an env-filter argument and --file and --yes options", () => {
    const cmd = buildCommand();
    assert.ok(cmd.registeredArguments.some((a) => a.name() === "env-filter"));
    assert.ok(cmd.options.some((o) => o.short === "-f"));
    assert.ok(cmd.options.some((o) => o.short === "-y"));
  });
});

// ---------------------------------------------------------------------------
// buildCommand action — compare and prompt flow
// ---------------------------------------------------------------------------
describe("buildCommand (download) action — compare and prompt", () => {
  let tmpDir = "";

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aws-download-action-test-"));
    mock.method(console, "log", () => {});
    mock.method(console, "warn", () => {});
    mock.method(console, "error", () => {});
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  it("skips download when local file is already in sync with AWS", async () => {
    const envFile = path.join(tmpDir, "sync.env");
    fs.writeFileSync(envFile, 'FOO="bar"\nPORT="3000"\n');
    const configFile = path.join(tmpDir, "cfg-sync.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/sync" }],
    }));

    const beforeMtime = fs.statSync(envFile).mtimeMs;
    await runDownloadAction(configFile, { awsSecret: { FOO: "bar", PORT: "3000" }, promptAnswer: true });

    // File should not have been touched
    assert.equal(fs.statSync(envFile).mtimeMs, beforeMtime);
  });

  it("downloads and overwrites when user confirms after seeing a diff", async () => {
    const envFile = path.join(tmpDir, "diff.env");
    fs.writeFileSync(envFile, 'FOO="old"\n');
    const configFile = path.join(tmpDir, "cfg-diff.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/diff" }],
    }));

    await runDownloadAction(configFile, { awsSecret: { FOO: "new", BAR: "added" }, promptAnswer: true });

    const contents = fs.readFileSync(envFile, "utf-8");
    assert.ok(contents.includes('FOO="new"'));
    assert.ok(contents.includes('BAR="added"'));
  });

  it("skips download when user declines the prompt", async () => {
    const envFile = path.join(tmpDir, "declined.env");
    fs.writeFileSync(envFile, 'FOO="original"\n');
    const configFile = path.join(tmpDir, "cfg-declined.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/declined" }],
    }));

    await runDownloadAction(configFile, { awsSecret: { FOO: "different" }, promptAnswer: false });

    const contents = fs.readFileSync(envFile, "utf-8");
    assert.ok(contents.includes('FOO="original"'), "file should be unchanged after decline");
  });

  it("creates the local file when it does not yet exist, after confirmation", async () => {
    const envFile = path.join(tmpDir, "new.env");
    assert.ok(!fs.existsSync(envFile));
    const configFile = path.join(tmpDir, "cfg-new.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/new" }],
    }));

    await runDownloadAction(configFile, { awsSecret: { NEW_KEY: "hello" }, promptAnswer: true });

    assert.ok(fs.existsSync(envFile));
    assert.ok(fs.readFileSync(envFile, "utf-8").includes('NEW_KEY="hello"'));
  });

  it("does not create the file when user declines for a new file", async () => {
    const envFile = path.join(tmpDir, "new-declined.env");
    const configFile = path.join(tmpDir, "cfg-new-declined.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/new-declined" }],
    }));

    await runDownloadAction(configFile, { awsSecret: { KEY: "val" }, promptAnswer: false });

    assert.ok(!fs.existsSync(envFile));
  });

  it("--yes skips the prompt and downloads automatically", async () => {
    const envFile = path.join(tmpDir, "yes-flag.env");
    fs.writeFileSync(envFile, 'OLD="value"\n');
    const configFile = path.join(tmpDir, "cfg-yes.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/yes" }],
    }));

    const mockGetSecretFn = async () => ({ NEW: "value" });
    const promptSpy = mock.fn(async () => false); // would return false if called
    const cmd = buildCommand("download", { promptFn: promptSpy, getSecretFn: mockGetSecretFn });
    await cmd.parseAsync(["node", "download", "--yes", "-f", configFile]);

    assert.equal(promptSpy.mock.calls.length, 0, "prompt should not be called with --yes");
    assert.ok(fs.readFileSync(envFile, "utf-8").includes('NEW="value"'));
  });

  it("exits 1 when no mappings match the filter", async () => {
    const configFile = path.join(tmpDir, "cfg-no-match.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: ".env/.env.staging.local", secretName: "app/staging" }],
    }));

    const exitMock = mock.method(process, "exit", () => { throw new Error("process.exit(1)"); });
    try {
      const cmd = buildCommand("download", { promptFn: async () => false });
      await assert.rejects(
        () => cmd.parseAsync(["node", "download", "nonexistent", "-f", configFile]),
        /process\.exit\(1\)/,
      );
      assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    } finally {
      exitMock.mock.restore();
    }
  });

  it("exits 1 when AWS fetch fails", async () => {
    const envFile = path.join(tmpDir, "fetch-fail.env");
    const configFile = path.join(tmpDir, "cfg-fetch-fail.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mappings: [{ envFilePath: envFile, secretName: "app/fail" }],
    }));

    const fetchErr = new Error("connection refused");
    fetchErr.name = "NetworkingError";

    const exitMock = mock.method(process, "exit", () => { throw new Error("process.exit(1)"); });
    try {
      const cmd = buildCommand("download", {
        promptFn: async () => true,
        getSecretFn: async () => { throw fetchErr; },
      });
      await assert.rejects(
        () => cmd.parseAsync(["node", "download", "-f", configFile]),
        /process\.exit\(1\)/,
      );
      assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    } finally {
      exitMock.mock.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// formatEnvLine
// ---------------------------------------------------------------------------
describe("formatEnvLine", () => {
  // Suppress the log.warn emitted when a nested object/array value is formatted.
  before(() => mock.method(console, "warn", () => {}));
  after(() => mock.restoreAll());

  it("formats a simple string value", () => {
    assert.equal(formatEnvLine("KEY", "value"), 'KEY="value"');
  });

  it("formats a numeric value as a string", () => {
    assert.equal(formatEnvLine("PORT", 3000), 'PORT="3000"');
  });

  it("formats a boolean value as a string", () => {
    assert.equal(formatEnvLine("FLAG", true), 'FLAG="true"');
  });

  it("writes null as an empty string", () => {
    assert.equal(formatEnvLine("KEY", null), 'KEY=""');
  });

  it("writes undefined as an empty string", () => {
    assert.equal(formatEnvLine("KEY", undefined), 'KEY=""');
  });

  it("escapes double quotes in the value", () => {
    assert.equal(formatEnvLine("MSG", 'say "hello"'), 'MSG="say \\"hello\\""');
  });

  it("escapes backslashes in the value", () => {
    assert.equal(formatEnvLine("PATH", "C:\\Users\\foo"), 'PATH="C:\\\\Users\\\\foo"');
  });

  it("escapes newlines in the value", () => {
    assert.equal(formatEnvLine("MULTILINE", "line1\nline2"), 'MULTILINE="line1\\nline2"');
  });

  it("escapes carriage returns in the value", () => {
    assert.equal(formatEnvLine("CRLF", "line1\r\nline2"), 'CRLF="line1\\r\\nline2"');
  });

  it("JSON-serialises nested objects", () => {
    const result = formatEnvLine("OBJ", { a: 1 });
    assert.equal(result, 'OBJ="{\\"a\\":1}"');
  });

  it("JSON-serialises arrays", () => {
    const result = formatEnvLine("ARR", [1, 2, 3]);
    assert.equal(result, 'ARR="[1,2,3]"');
  });

  it("escapes C0 control characters (\\x01-\\x1f, \\x7f) as \\xNN", () => {
    assert.equal(formatEnvLine("CTRL", "\x01\x1f\x7f"), 'CTRL="\\x01\\x1f\\x7f"');
  });

  it("escapes C1 control characters (\\x80-\\x9f) as \\xNN", () => {
    assert.equal(formatEnvLine("CTRL", "\x80\x9f"), 'CTRL="\\x80\\x9f"');
  });
});

// ---------------------------------------------------------------------------
// writeSecretToFile
// ---------------------------------------------------------------------------
describe("writeSecretToFile", () => {
  let tmpDir = "";

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aws-download-test-"));
    mock.method(console, "log", () => {});
    mock.method(console, "error", () => {});
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  it("returns true and writes the .env file on success", async () => {
    const outputFile = path.join(tmpDir, "out.env");
    /** @returns {Promise<Record<string, unknown>>} */
    const mockGetSecret = async () => ({ FOO: "bar", PORT: 3000 });

    const result = await writeSecretToFile("app/test", outputFile, DUMMY_AWS_CONFIG, { getSecretFn: mockGetSecret });
    assert.equal(result, true);
    assert.ok(fs.existsSync(outputFile));
    const contents = fs.readFileSync(outputFile, "utf-8");
    assert.ok(contents.includes('FOO="bar"'));
    assert.ok(contents.includes('PORT="3000"'));
  });

  it("creates parent directories that do not exist yet", async () => {
    const outputFile = path.join(tmpDir, "nested", "dir", "out.env");
    const mockGetSecret = async () => ({ KEY: "val" });

    const result = await writeSecretToFile("app/test", outputFile, DUMMY_AWS_CONFIG, { getSecretFn: mockGetSecret });
    assert.equal(result, true);
    assert.ok(fs.existsSync(outputFile));
  });

  it("returns false and does not create the file when getSecretFn throws", async () => {
    const outputFile = path.join(tmpDir, "should-not-exist.env");
    const mockGetSecret = async () => { throw new Error("secret not found"); };

    const result = await writeSecretToFile("app/missing", outputFile, DUMMY_AWS_CONFIG, { getSecretFn: mockGetSecret });
    assert.equal(result, false);
    assert.ok(!fs.existsSync(outputFile));
  });
});

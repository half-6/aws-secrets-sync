import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCommand } from "../src/compare-env.js";
import { diffEnvs } from "../src/lib/utils.js";

// ---------------------------------------------------------------------------
// buildCommand
// ---------------------------------------------------------------------------
describe("buildCommand (compare)", () => {
  it("creates a command named 'compare' by default", () => {
    const cmd = buildCommand();
    assert.equal(cmd.name(), "compare");
  });

  it("accepts a custom name", () => {
    const cmd = buildCommand("diff");
    assert.equal(cmd.name(), "diff");
  });

  it("has an env-filter argument and --file option", () => {
    const cmd = buildCommand();
    assert.ok(cmd.registeredArguments.some((a) => a.name() === "env-filter"));
    assert.ok(cmd.options.some((o) => o.short === "-f"));
    assert.ok(!cmd.options.some((o) => o.short === "-y"), "--yes should not be registered on compare");
  });
});

describe("diffEnvs", () => {
  it("returns empty arrays when both sides are identical", () => {
    const result = diffEnvs({ FOO: "bar", BAZ: "qux" }, { FOO: "bar", BAZ: "qux" });
    assert.deepEqual(result, { onlyInAws: [], onlyInLocal: [], different: [] });
  });

  it("detects keys present in AWS but missing locally", () => {
    const result = diffEnvs({ FOO: "bar", NEW_KEY: "val" }, { FOO: "bar" });
    assert.deepEqual(result.onlyInAws, ["NEW_KEY"]);
    assert.deepEqual(result.onlyInLocal, []);
    assert.deepEqual(result.different, []);
  });

  it("detects keys present locally but missing from AWS", () => {
    const result = diffEnvs({ FOO: "bar" }, { FOO: "bar", LOCAL_ONLY: "x" });
    assert.deepEqual(result.onlyInAws, []);
    assert.deepEqual(result.onlyInLocal, ["LOCAL_ONLY"]);
    assert.deepEqual(result.different, []);
  });

  it("detects keys present in both but with different values", () => {
    const result = diffEnvs({ FOO: "aws-value" }, { FOO: "local-value" });
    assert.deepEqual(result.onlyInAws, []);
    assert.deepEqual(result.onlyInLocal, []);
    assert.deepEqual(result.different, ["FOO"]);
  });

  it("coerces AWS numeric values to strings for comparison", () => {
    // AWS stores numbers; .env files store strings — "42" should match 42
    const result = diffEnvs({ PORT: 42 }, { PORT: "42" });
    assert.deepEqual(result.different, []);
  });

  it("treats AWS null as empty string (matches download behaviour)", () => {
    // download writes null as KEY="" — compare must use the same serialisation
    const result = diffEnvs({ KEY: null }, { KEY: "" });
    assert.deepEqual(result.different, []);
  });

  it("treats AWS undefined as empty string (matches download behaviour)", () => {
    const result = diffEnvs({ KEY: undefined }, { KEY: "" });
    assert.deepEqual(result.different, []);
  });

  it("treats AWS object values as JSON string (matches download behaviour)", () => {
    // download writes objects as JSON; compare must use the same serialisation
    const result = diffEnvs({ CFG: { host: "localhost" } }, { CFG: '{"host":"localhost"}' });
    assert.deepEqual(result.different, []);
  });

  it("reports a difference when an AWS null no longer matches a non-empty local value", () => {
    const result = diffEnvs({ KEY: null }, { KEY: "something" });
    assert.deepEqual(result.different, ["KEY"]);
  });

  it("handles empty objects on both sides", () => {
    const result = diffEnvs({}, {});
    assert.deepEqual(result, { onlyInAws: [], onlyInLocal: [], different: [] });
  });

  it("handles multiple difference types simultaneously", () => {
    const aws = { SHARED: "x", AWS_ONLY: "y", CHANGED: "aws" };
    const local = { SHARED: "x", LOCAL_ONLY: "z", CHANGED: "local" };
    const result = diffEnvs(aws, local);
    assert.deepEqual(result.onlyInAws, ["AWS_ONLY"]);
    assert.deepEqual(result.onlyInLocal, ["LOCAL_ONLY"]);
    assert.deepEqual(result.different, ["CHANGED"]);
  });
});

// ---------------------------------------------------------------------------
// buildCommand action
// ---------------------------------------------------------------------------
describe("buildCommand (compare) action", () => {
  let tmpDir = "";

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aws-compare-action-test-"));
    mock.method(console, "log", () => {});
    mock.method(console, "warn", () => {});
    mock.method(console, "error", () => {});
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  /**
   * Writes a minimal config file and returns its path.
   * @param {string} name
   * @param {string} envFile
   * @param {string} secretName
   */
  function writeConfig(name, envFile, secretName) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, JSON.stringify({ mappings: [{ envFilePath: envFile, secretName }] }));
    return p;
  }

  it("exits 0 and reports in-sync when AWS and local match", async () => {
    const envFile = path.join(tmpDir, "sync.env");
    fs.writeFileSync(envFile, 'FOO="bar"\n');
    const configFile = writeConfig("cfg-sync.json", envFile, "app/sync");

    const exitMock = mock.method(process, "exit", () => {});
    try {
      const cmd = buildCommand("compare", { getSecretFn: async () => ({ FOO: "bar" }) });
      await cmd.parseAsync(["node", "compare", "-f", configFile]);
      assert.equal(exitMock.mock.calls.length, 0, "should not call process.exit when in sync");
    } finally {
      exitMock.mock.restore();
    }
  });

  it("exits 1 when AWS has keys missing from local", async () => {
    const envFile = path.join(tmpDir, "missing-local.env");
    fs.writeFileSync(envFile, 'FOO="bar"\n');
    const configFile = writeConfig("cfg-missing-local.json", envFile, "app/missing-local");

    const exitMock = mock.method(process, "exit", () => { throw new Error("process.exit(1)"); });
    try {
      const cmd = buildCommand("compare", { getSecretFn: async () => ({ FOO: "bar", EXTRA: "new" }) });
      await assert.rejects(
        () => cmd.parseAsync(["node", "compare", "-f", configFile]),
        /process\.exit\(1\)/,
      );
      assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    } finally {
      exitMock.mock.restore();
    }
  });

  it("exits 1 when local file does not exist", async () => {
    const envFile = path.join(tmpDir, "no-local-file.env");
    const configFile = writeConfig("cfg-no-local.json", envFile, "app/no-local");

    const exitMock = mock.method(process, "exit", () => { throw new Error("process.exit(1)"); });
    try {
      const cmd = buildCommand("compare", { getSecretFn: async () => ({ FOO: "bar" }) });
      await assert.rejects(
        () => cmd.parseAsync(["node", "compare", "-f", configFile]),
        /process\.exit\(1\)/,
      );
      assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    } finally {
      exitMock.mock.restore();
    }
  });

  it("exits 1 when AWS fetch fails", async () => {
    const envFile = path.join(tmpDir, "fetch-fail.env");
    fs.writeFileSync(envFile, 'FOO="bar"\n');
    const configFile = writeConfig("cfg-fetch-fail.json", envFile, "app/fetch-fail");

    const exitMock = mock.method(process, "exit", () => { throw new Error("process.exit(1)"); });
    try {
      const cmd = buildCommand("compare", {
        getSecretFn: async () => { throw new Error("connection refused"); },
      });
      await assert.rejects(
        () => cmd.parseAsync(["node", "compare", "-f", configFile]),
        /process\.exit\(1\)/,
      );
      assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    } finally {
      exitMock.mock.restore();
    }
  });

  it("exits 1 when no mappings match the filter", async () => {
    const configFile = writeConfig("cfg-no-match.json", ".env/staging.env", "app/staging");

    const exitMock = mock.method(process, "exit", () => { throw new Error("process.exit(1)"); });
    try {
      const cmd = buildCommand("compare", { getSecretFn: async () => ({}) });
      await assert.rejects(
        () => cmd.parseAsync(["node", "compare", "nonexistent", "-f", configFile]),
        /process\.exit\(1\)/,
      );
      assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    } finally {
      exitMock.mock.restore();
    }
  });
});

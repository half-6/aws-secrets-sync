import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "url";

import { diffEnvs, getErrorMessage, normalize, printDiff, printSectionHeader, runStandalone, serializeSecretValue } from "../src/lib/utils.js";

describe("normalize", () => {
  it("returns undefined for an empty string", () => {
    assert.equal(normalize(""), undefined);
  });

  it("returns undefined for whitespace-only strings", () => {
    assert.equal(normalize(" "), undefined);
    assert.equal(normalize("  \t  "), undefined);
  });

  it("passes non-empty, non-whitespace strings through unchanged", () => {
    assert.equal(normalize("us-east-1"), "us-east-1");
    assert.equal(normalize("my-profile"), "my-profile");
  });

  it("passes undefined through unchanged", () => {
    assert.equal(normalize(undefined), undefined);
  });

  it("returns undefined for non-string values (number, boolean)", () => {
    // Cast through unknown to satisfy the type checker while testing the runtime guard.
    assert.equal(normalize(/** @type {string} */ (/** @type {unknown} */ (123))), undefined);
    assert.equal(normalize(/** @type {string} */ (/** @type {unknown} */ (true))), undefined);
  });
});

describe("serializeSecretValue", () => {
  it("returns empty string for null", () => {
    assert.equal(serializeSecretValue(null), "");
  });

  it("returns empty string for undefined", () => {
    assert.equal(serializeSecretValue(undefined), "");
  });

  it("returns the string unchanged for string values", () => {
    assert.equal(serializeSecretValue("hello"), "hello");
  });

  it("converts numbers to strings", () => {
    assert.equal(serializeSecretValue(3000), "3000");
  });

  it("converts booleans to strings", () => {
    assert.equal(serializeSecretValue(true), "true");
    assert.equal(serializeSecretValue(false), "false");
  });

  it("JSON-stringifies objects", () => {
    assert.equal(serializeSecretValue({ a: 1 }), '{"a":1}');
  });

  it("JSON-stringifies arrays", () => {
    assert.equal(serializeSecretValue([1, 2, 3]), "[1,2,3]");
  });
});

describe("getErrorMessage", () => {
  it("extracts message from an Error", () => {
    assert.equal(getErrorMessage(new Error("boom")), "boom");
  });

  it("stringifies non-Error values", () => {
    assert.equal(getErrorMessage("raw string"), "raw string");
    assert.equal(getErrorMessage(42), "42");
    assert.equal(getErrorMessage(null), "null");
  });
});

// ---------------------------------------------------------------------------
// diffEnvs
// ---------------------------------------------------------------------------
describe("diffEnvs", () => {
  it("returns empty arrays when both sides are identical", () => {
    const result = diffEnvs({ FOO: "bar" }, { FOO: "bar" });
    assert.deepEqual(result, { onlyInAws: [], onlyInLocal: [], different: [] });
  });

  it("detects keys only in AWS", () => {
    const result = diffEnvs({ FOO: "bar", AWS_ONLY: "x" }, { FOO: "bar" });
    assert.deepEqual(result.onlyInAws, ["AWS_ONLY"]);
  });

  it("detects keys only in local", () => {
    const result = diffEnvs({ FOO: "bar" }, { FOO: "bar", LOCAL_ONLY: "x" });
    assert.deepEqual(result.onlyInLocal, ["LOCAL_ONLY"]);
  });

  it("detects keys with different values", () => {
    const result = diffEnvs({ FOO: "aws-val" }, { FOO: "local-val" });
    assert.deepEqual(result.different, ["FOO"]);
  });

  it("coerces AWS numeric values to strings for comparison", () => {
    const result = diffEnvs({ PORT: 42 }, { PORT: "42" });
    assert.deepEqual(result.different, []);
  });

  it("treats AWS null as empty string", () => {
    const result = diffEnvs({ KEY: null }, { KEY: "" });
    assert.deepEqual(result.different, []);
  });
});

// ---------------------------------------------------------------------------
// printSectionHeader
// ---------------------------------------------------------------------------
describe("printSectionHeader", () => {
  it("logs a line containing the secret name and file path", () => {
    /** @type {string[]} */
    const logged = [];
    const logMock = mock.method(console, "log", (msg) => logged.push(msg));
    try {
      printSectionHeader("app/staging", ".env/.env.staging.local");
      assert.ok(logged.some((l) => l.includes("app/staging") && l.includes(".env.staging.local")));
    } finally {
      logMock.mock.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// printDiff
// ---------------------------------------------------------------------------
describe("printDiff", () => {
  /** @type {import("../src/lib/utils.js").DiffLabels} */
  const LABELS = {
    onlyInAws: "Only in AWS:",
    onlyInLocal: "Only local:",
    different: "Different values:",
  };

  before(() => {
    mock.method(console, "log", () => {});
    mock.method(console, "warn", () => {});
  });
  after(() => mock.restoreAll());

  it("returns false when there are no differences", () => {
    const result = printDiff({ onlyInAws: [], onlyInLocal: [], different: [] }, LABELS);
    assert.equal(result, false);
  });

  it("returns true when onlyInAws is non-empty", () => {
    const result = printDiff({ onlyInAws: ["KEY"], onlyInLocal: [], different: [] }, LABELS);
    assert.equal(result, true);
  });

  it("returns true when onlyInLocal is non-empty", () => {
    const result = printDiff({ onlyInAws: [], onlyInLocal: ["KEY"], different: [] }, LABELS);
    assert.equal(result, true);
  });

  it("returns true when different is non-empty", () => {
    const result = printDiff({ onlyInAws: [], onlyInLocal: [], different: ["KEY"] }, LABELS);
    assert.equal(result, true);
  });
});

// ---------------------------------------------------------------------------
// runStandalone
// ---------------------------------------------------------------------------
describe("runStandalone", () => {
  it("does not invoke buildFn when argv[1] does not match the caller URL", () => {
    const buildFn = mock.fn(() => ({ parseAsync: mock.fn(async () => {}) }));
    const originalArgv1 = process.argv[1];
    process.argv[1] = "/some/other/script.js";
    try {
      runStandalone(import.meta.url, buildFn);
      assert.equal(buildFn.mock.calls.length, 0);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it("invokes buildFn and calls parseAsync when argv[1] matches the caller URL", async () => {
    const parseAsync = mock.fn(async () => {});
    const buildFn = mock.fn(() => ({ parseAsync }));
    const originalArgv1 = process.argv[1];
    process.argv[1] = fileURLToPath(import.meta.url);
    try {
      runStandalone(import.meta.url, buildFn);
      assert.equal(buildFn.mock.calls.length, 1);
      // parseAsync is called asynchronously; give the microtask queue a tick
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(parseAsync.mock.calls.length, 1);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});

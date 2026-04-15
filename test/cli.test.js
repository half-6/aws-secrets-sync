import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "../src/bin/cli.js");
const require = createRequire(import.meta.url);
const { version: EXPECTED_VERSION } = /** @type {{ version: string }} */ (require("../package.json"));

/**
 * Runs the CLI and returns { stdout, stderr, code }.
 * Never rejects — callers assert on exit code themselves.
 *
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
async function runCli(args, { env } = {}) {
  try {
    const result = await execFileAsync("node", [CLI, ...args], {
      env: { ...process.env, ...env },
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (err) {
    const e = /** @type {{ stdout: string; stderr: string; code: number }} */ (err);
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------
describe("cli --version", () => {
  it("prints the package version and exits 0", async () => {
    const { stdout, code } = await runCli(["--version"]);
    assert.equal(code, 0);
    assert.ok(stdout.trim().includes(EXPECTED_VERSION), `expected "${EXPECTED_VERSION}" in "${stdout.trim()}"`);
  });
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
describe("cli --help", () => {
  it("exits 0 and lists all three subcommands", async () => {
    const { stdout, code } = await runCli(["--help"]);
    assert.equal(code, 0);
    assert.ok(stdout.includes("download"), "help should mention download");
    assert.ok(stdout.includes("upload"), "help should mention upload");
    assert.ok(stdout.includes("compare"), "help should mention compare");
  });
});

describe("cli <subcommand> --help", () => {
  for (const sub of ["download", "upload", "compare"]) {
    it(`${sub} --help exits 0`, async () => {
      const { code } = await runCli([sub, "--help"]);
      assert.equal(code, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// Unknown command
// ---------------------------------------------------------------------------
describe("cli unknown-command", () => {
  it("exits non-zero for an unrecognised command", async () => {
    const { code } = await runCli(["nonexistent-command"]);
    assert.notEqual(code, 0);
  });
});

// ---------------------------------------------------------------------------
// Missing config (no aws-secrets.config.json in a temp cwd)
// ---------------------------------------------------------------------------
describe("cli subcommand with no config file", () => {
  for (const sub of ["download", "upload", "compare"]) {
    it(`${sub} exits 1 when no config can be resolved`, async () => {
      const { code } = await runCli([sub], {
        env: {
          AWS_SECRETS_CONFIG_FILE: "",
          HOME: "/tmp",
        },
      });
      assert.equal(code, 1);
    });
  }
});

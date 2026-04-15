import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLOR_MODULE = path.join(__dirname, "../src/lib/color.js");

let tmpDir = "";

// Write a temp .mjs file and run it, returning trimmed stdout.
async function runScript(scriptBody, env = {}) {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "color-test-"));
  const file = path.join(tmpDir, `script-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, scriptBody);
  try {
    const { stdout } = await execFileAsync("node", [file], {
      env: { ...process.env, ...env },
    });
    return stdout.trim();
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function colorScript(expression) {
  // Use process.stdout.write to avoid console.log colourising booleans when FORCE_COLOR is set.
  return `import { c } from ${JSON.stringify(COLOR_MODULE)};\nprocess.stdout.write(String(${expression}) + '\\n');\n`;
}

// ---------------------------------------------------------------------------
// Exported keys and types
// ---------------------------------------------------------------------------
describe("color module — exported keys", () => {
  it("exports reset, red, green, yellow", async () => {
    const out = await runScript(colorScript("Object.keys(c).sort().join(',')"));
    assert.equal(out, "green,red,reset,yellow");
  });

  it("all values are strings", async () => {
    const out = await runScript(colorScript("Object.values(c).every(v => typeof v === 'string')"));
    assert.equal(out, "true");
  });
});

// ---------------------------------------------------------------------------
// NO_COLOR
// ---------------------------------------------------------------------------
describe("color module — NO_COLOR", () => {
  it("returns empty strings when NO_COLOR is set", async () => {
    const out = await runScript(
      colorScript("Object.values(c).every(v => v === '')"),
      { NO_COLOR: "1" },
    );
    assert.equal(out, "true");
  });
});

// ---------------------------------------------------------------------------
// FORCE_COLOR
// ---------------------------------------------------------------------------
describe("color module — FORCE_COLOR", () => {
  it("returns ANSI codes when FORCE_COLOR=1 (even without a TTY)", async () => {
    const out = await runScript(
      colorScript("Object.values(c).some(v => v.startsWith('\\x1b['))"),
      { FORCE_COLOR: "1" },
    );
    assert.equal(out, "true");
  });

  it("FORCE_COLOR=0 is treated as disabled — no colour without a TTY", async () => {
    const out = await runScript(
      colorScript("Object.values(c).every(v => v === '')"),
      { FORCE_COLOR: "0" },
    );
    assert.equal(out, "true");
  });

  it("FORCE_COLOR=1 overrides NO_COLOR", async () => {
    const out = await runScript(
      colorScript("Object.values(c).some(v => v.startsWith('\\x1b['))"),
      { FORCE_COLOR: "1", NO_COLOR: "1" },
    );
    assert.equal(out, "true");
  });
});

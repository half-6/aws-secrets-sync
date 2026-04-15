import { realpathSync } from "fs";
import readline from "readline";
import { fileURLToPath } from "url";

import { log } from "./logger.js";

/**
 * Converts a secret value to its canonical string representation — the string
 * that would appear as the value in a parsed .env file after a `download`.
 *
 * Mapping:
 *   null / undefined  → ""
 *   object / array    → JSON.stringify(...)
 *   everything else   → String(value)
 *
 * Use this wherever you need to compare or serialise an AWS secret value so
 * that `download` and `compare` stay consistent with each other.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function serializeSecretValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Treats blank strings (empty or whitespace-only) the same as an absent value.
 * Useful when config file fields are present but intentionally left blank —
 * ensures `??` falls through to the next priority level rather than
 * short-circuiting on an empty or whitespace string.
 *
 * Non-string values (e.g. numbers from malformed JSON config) are treated as
 * absent rather than throwing a TypeError.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalize(value) {
  if (value === undefined || typeof value !== "string") return undefined;
  return value.trim() === "" ? undefined : value;
}

/**
 * Extracts a human-readable message from any thrown value.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Computes the structural difference between an AWS secret and a local .env.
 * Returns plain data with no side effects — suitable for unit testing.
 *
 * @param {Record<string, unknown>} awsSecret
 * @param {Record<string, string>} localEnv
 * @returns {{ onlyInAws: string[]; onlyInLocal: string[]; different: string[] }}
 */
export function diffEnvs(awsSecret, localEnv) {
  const awsKeys = new Set(Object.keys(awsSecret));
  const localKeys = new Set(Object.keys(localEnv));

  return {
    onlyInAws: [...awsKeys].filter((k) => !localKeys.has(k)),
    onlyInLocal: [...localKeys].filter((k) => !awsKeys.has(k)),
    different: [...awsKeys].filter(
      (k) => localKeys.has(k) && serializeSecretValue(awsSecret[k]) !== localEnv[k],
    ),
  };
}

/**
 * Prints the per-mapping section header shared by all three commands.
 *
 * @param {string} secretName
 * @param {string} filePath
 */
export function printSectionHeader(secretName, filePath) {
  log.info(`\n━━━ ${secretName} ↔ ${filePath} ━━━`);
}

/**
 * @typedef {{ onlyInAws: string; onlyInLocal: string; different: string }} DiffLabels
 */

/**
 * Prints a formatted diff using the caller-supplied labels.
 * Returns true when at least one difference was printed.
 *
 * @param {{ onlyInAws: string[]; onlyInLocal: string[]; different: string[] }} diff
 * @param {DiffLabels} labels
 * @returns {boolean}
 */
export function printDiff(diff, labels) {
  const { onlyInAws, onlyInLocal, different } = diff;

  if (onlyInAws.length) {
    log.warn(labels.onlyInAws);
    for (const k of onlyInAws) log.info(`  ↓ ${k}`);
  }
  if (onlyInLocal.length) {
    log.warn(labels.onlyInLocal);
    for (const k of onlyInLocal) log.info(`  ↑ ${k}`);
  }
  if (different.length) {
    log.warn(labels.different);
    for (const k of different) log.info(`  ≠ ${k} [values differ — masked for security]`);
  }

  return onlyInAws.length > 0 || onlyInLocal.length > 0 || different.length > 0;
}

/**
 * Prompts the user with a yes/no question on stdout/stdin.
 * Returns true when the user answers "y" or "yes" (case-insensitive).
 * Returns false immediately when stdin is not a TTY (piped input / CI) —
 * use --yes to auto-confirm in non-interactive environments.
 *
 * @param {string} question
 * @returns {Promise<boolean>}
 */
export function promptConfirm(question) {
  if (!process.stdin.isTTY) {
    log.warn("stdin is not a TTY — skipping (use --yes to confirm non-interactively).");
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

/** @param {string} p */
function tryRealpath(p) {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * Executes `buildFn().parseAsync()` only when the module is the entry
 * point (i.e. run directly via `node <file>` or `npm run <script>`).
 *
 * @param {string} callerUrl - pass `import.meta.url` from the calling module
 * @param {(name?: string) => import("commander").Command} buildFn
 */
export function runStandalone(callerUrl, buildFn) {
  if (tryRealpath(process.argv[1]) === tryRealpath(fileURLToPath(callerUrl))) {
    buildFn()
      .parseAsync(process.argv)
      .catch((err) => {
        log.error(getErrorMessage(err));
        process.exit(1);
      });
  }
}

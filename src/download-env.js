import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

import { Command } from "commander";

import {
  CONFIG_FILE_HELP,
  filterMappings,
  parseEnvFile,
  resolveConfig,
} from "./lib/config-loader.js";
import { handleAuthError } from "./lib/errors.js";
import { getSecret } from "./lib/secrets-client.js";
import {
  diffEnvs,
  getErrorMessage,
  printDiff,
  printSectionHeader,
  promptConfirm,
  runStandalone,
  serializeSecretValue,
} from "./lib/utils.js";
import { log } from "./lib/logger.js";

/**
 * @typedef {(name: string, cfg: import("./lib/secrets-client.js").AwsConfig) => Promise<Record<string, unknown>>} GetSecretFn
 * @typedef {(question: string) => Promise<boolean>} PromptFn
 */

/** @type {import("./lib/utils.js").DiffLabels} */
const DOWNLOAD_LABELS = {
  onlyInAws: "Keys in AWS but missing locally (will be added):",
  onlyInLocal: "Keys in local file but missing from AWS (will be removed):",
  different: "Keys with different values (AWS will overwrite local):",
};

/**
 * Serialises a secret value safely for a .env file using double-quoted format.
 * Escapes backslashes and double quotes within the value.
 *
 * `null` is written as an empty string rather than the literal string "null".
 * Nested objects/arrays are JSON-serialised and a console warning is emitted.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
export function formatEnvLine(key, value) {
  if (value !== null && typeof value === "object") {
    log.warn(`key "${key}" has a nested object/array value — serialised as JSON. Use JSON.parse(process.env.${key}) to read it.`);
  }
  const str = serializeSecretValue(value);
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\0/g, "\\0")
    .replace(/[\x01-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return `${key}="${escaped}"`;
}

/**
 * Writes a pre-fetched secret to a local .env file atomically (temp + rename).
 *
 * @param {Record<string, unknown>} secret
 * @param {string} outputFile
 * @returns {boolean} true on success, false on failure
 */
function writeToFile(secret, outputFile) {
  const resolved = path.resolve(outputFile);
  const dir = path.dirname(resolved);
  const tmpFile = path.join(dir, `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const content =
      Object.entries(secret)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => formatEnvLine(key, value))
        .join("\n") + "\n";
    fs.writeFileSync(tmpFile, content);
    fs.renameSync(tmpFile, resolved);
    log.success(`Secret written to ${outputFile}`);
    return true;
  } catch (error) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore — file may not exist */ }
    log.error(`Error writing to ${outputFile}: ${getErrorMessage(error)}`);
    return false;
  }
}

/**
 * Fetches a secret from AWS and writes it to a local .env file.
 * Exported for standalone use and unit testing.
 *
 * @param {string} secretName
 * @param {string} outputFile
 * @param {import("./lib/secrets-client.js").AwsConfig} awsConfig
 * @param {{ getSecretFn?: GetSecretFn }} [opts]
 * @returns {Promise<boolean>} true on success, false on failure
 */
export async function writeSecretToFile(secretName, outputFile, awsConfig, { getSecretFn = getSecret } = {}) {
  try {
    const secret = await getSecretFn(secretName, awsConfig);
    return writeToFile(secret, outputFile);
  } catch (error) {
    handleAuthError(error);
    log.error(`Error writing secret to ${outputFile}: ${getErrorMessage(error)}`);
    return false;
  }
}

/**
 * @param {string} [name]
 * @param {{ promptFn?: PromptFn; getSecretFn?: GetSecretFn }} [opts]
 * @returns {Command}
 */
export function buildCommand(name = "download", { promptFn = promptConfirm, getSecretFn = getSecret } = {}) {
  return new Command(name)
    .description("Download secrets from AWS Secrets Manager to local .env files")
    .argument(
      "[env-filter]",
      "filter matched against secret name or .env file path (e.g. staging, prod) — case-sensitive",
    )
    .option(
      "-f, --file <path>",
      "JSON config file with custom mappings (overrides aws-secrets.config.json)",
    )
    .option("-y, --yes", "skip confirmation prompt and download without asking (differences are still shown)")
    .addHelpText(
      "after",
      `${CONFIG_FILE_HELP}

Examples:
  aws-secrets-sync download
  aws-secrets-sync download staging
  aws-secrets-sync download staging --yes
  aws-secrets-sync download staging -f aws-secrets.config.json`,
    )
    .action(async (envFilter, options) => {
      const { mappings, awsConfig } = resolveConfig(options.file);
      const filtered = filterMappings(mappings, envFilter);

      if (!filtered.length) {
        log.error(envFilter ? `No mappings found matching "${envFilter}"` : "No mappings configured.");
        process.exit(1);
      }

      const effectivePromptFn = options.yes ? async () => true : promptFn;
      let anyFailed = false;

      for (const { secretName, envFilePath } of filtered) {
        printSectionHeader(secretName, envFilePath);

        // Fetch the AWS secret first — needed for both comparison and writing.
        /** @type {Record<string, unknown> | null} */
        const awsSecret = await getSecretFn(secretName, awsConfig).catch((fetchErr) => {
          handleAuthError(fetchErr);
          log.error(`Failed to fetch from AWS: ${getErrorMessage(fetchErr)}`);
          anyFailed = true;
          return null;
        });
        if (awsSecret === null) continue;

        // Compare with the local file (if it exists) to show what will change.
        const localEnv = parseEnvFile(envFilePath);
        if (localEnv === null) {
          log.info("  Local file does not exist — will be created.");
          log.info(`  Keys to add: ${Object.keys(awsSecret).length} key(s) [names masked for security]`);
        } else {
          const diff = diffEnvs(awsSecret, localEnv);
          if (!printDiff(diff, DOWNLOAD_LABELS)) {
            log.success("Already in sync — skipping download.");
            continue;
          }
        }

        const confirmed = await effectivePromptFn("  Download to local file? [y/N] ");
        if (!confirmed) {
          log.info("  Skipped.");
          continue;
        }

        // Reuse the already-fetched secret to avoid a second round trip.
        const ok = writeToFile(awsSecret, envFilePath);
        if (!ok) anyFailed = true;
      }

      if (anyFailed) process.exit(1);
    });
}

runStandalone(import.meta.url, buildCommand);

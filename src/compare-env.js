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
  runStandalone,
} from "./lib/utils.js";
import { log } from "./lib/logger.js";

/** @type {import("./lib/utils.js").DiffLabels} */
const COMPARE_LABELS = {
  onlyInAws: "Keys in AWS but missing from local file (run download to add):",
  onlyInLocal: "Keys in local file but missing from AWS (run upload to add):",
  different: "Keys with different values:",
};

/**
 * Prints the diff between an AWS secret and a local env, returns true if differences exist.
 *
 * Diff symbol convention (treating AWS as the source of truth):
 *   ↓  key exists in AWS but is absent locally  → run `download` to add it
 *   ↑  key exists locally but is absent in AWS  → run `upload` to add it
 *   ≠  key exists in both but values differ
 *
 * @param {Record<string, unknown>} awsSecret
 * @param {Record<string, string>} localEnv
 * @returns {boolean} true when there are differences
 */
function compareEnvs(awsSecret, localEnv) {
  const diff = diffEnvs(awsSecret, localEnv);

  if (!printDiff(diff, COMPARE_LABELS)) {
    log.success("In sync — no differences found");
    return false;
  }

  return true;
}

/**
 * @typedef {(name: string, cfg: import("./lib/secrets-client.js").AwsConfig) => Promise<Record<string, unknown>>} GetSecretFn
 */

/**
 * @param {string} [name]
 * @param {{ getSecretFn?: GetSecretFn }} [opts]
 * @returns {Command}
 */
export function buildCommand(name = "compare", { getSecretFn = getSecret } = {}) {
  return new Command(name)
    .description("Diff AWS secrets against local .env files")
    .argument(
      "[env-filter]",
      "filter matched against secret name or .env file path (e.g. staging, prod) — case-sensitive",
    )
    .option(
      "-f, --file <path>",
      "JSON config file with custom mappings (overrides aws-secrets.config.json)",
    )
    .addHelpText(
      "after",
      `${CONFIG_FILE_HELP}

Examples:
  aws-secrets-sync compare
  aws-secrets-sync compare staging
  aws-secrets-sync compare staging -f aws-secrets.config.json`,
    )
    .action(async (envFilter, options) => {
      const { mappings, awsConfig } = resolveConfig(options.file);
      const filtered = filterMappings(mappings, envFilter);

      if (!filtered.length) {
        log.error(envFilter ? `No mappings found matching "${envFilter}"` : "No mappings configured.");
        process.exit(1);
      }

      log.info(`\n▶ Comparing ${filtered.length} secret(s) against local env file(s)…`);

      let anyDiff = false;
      let anyMissing = false;
      let anyFetchFailed = false;

      for (const { secretName, envFilePath } of filtered) {
        printSectionHeader(secretName, envFilePath);

        const localEnv = parseEnvFile(envFilePath);
        if (localEnv === null) {
          log.error(`Local file not found: ${envFilePath}`);
          anyMissing = true;
          continue;
        }

        /** @type {Record<string, unknown> | null} */
        const awsSecret = await getSecretFn(secretName, awsConfig).catch((error) => {
          // handleAuthError calls process.exit(1) immediately for auth errors,
          // so anyFetchFailed is only set for non-auth fetch failures.
          handleAuthError(error);
          log.error(`Failed to fetch from AWS: ${getErrorMessage(error)}`);
          anyFetchFailed = true;
          return null;
        });
        if (awsSecret === null) continue;

        const hasDiff = compareEnvs(awsSecret, localEnv);
        if (hasDiff) anyDiff = true;
      }

      log.info("");
      if (anyFetchFailed) {
        log.error("One or more secrets could not be fetched from AWS.");
        process.exit(1);
      } else if (anyMissing && anyDiff) {
        log.warn("One or more local files are missing and differences were detected — run download to sync.");
        process.exit(1);
      } else if (anyMissing) {
        log.warn("One or more local files are missing — run download to create them.");
        process.exit(1);
      } else if (anyDiff) {
        log.warn("Differences detected in one or more environments.");
        process.exit(1);
      } else {
        log.success("All compared environments are in sync.");
      }
    });
}

runStandalone(import.meta.url, buildCommand);

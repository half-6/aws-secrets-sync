import { Command } from "commander";

import {
  CONFIG_FILE_HELP,
  filterMappings,
  parseEnvFile,
  resolveConfig,
} from "./lib/config-loader.js";
import { handleAuthError } from "./lib/errors.js";
import { getSecret, upsertSecret } from "./lib/secrets-client.js";
import {
  diffEnvs,
  getErrorMessage,
  printDiff,
  printSectionHeader,
  promptConfirm,
  runStandalone,
} from "./lib/utils.js";
import { log } from "./lib/logger.js";

/**
 * @typedef {(name: string, obj: Record<string, unknown>, cfg: import("./lib/secrets-client.js").AwsConfig) => Promise<"updated" | "created">} UpsertFn
 * @typedef {(name: string, cfg: import("./lib/secrets-client.js").AwsConfig) => Promise<Record<string, unknown>>} GetSecretFn
 * @typedef {(question: string) => Promise<boolean>} PromptFn
 */

/** @type {import("./lib/utils.js").DiffLabels} */
const UPLOAD_LABELS = {
  onlyInAws: "Keys in AWS but missing locally (will be removed from AWS):",
  onlyInLocal: "Keys in local file but missing from AWS (will be added):",
  different: "Keys with different values (local will overwrite AWS):",
};

/**
 * @param {string} envFilePath
 * @param {string} secretName
 * @param {import("./lib/secrets-client.js").AwsConfig} awsConfig
 * @param {{ upsertFn?: UpsertFn; localEnv?: Record<string, string> }} [opts]
 * @returns {Promise<boolean>} true on success, false on failure
 */
export async function uploadEnvFileToSecret(envFilePath, secretName, awsConfig, { upsertFn = upsertSecret, localEnv } = {}) {
  try {
    const data = localEnv ?? parseEnvFile(envFilePath);
    if (data === null) throw new Error(`Local .env file not found: ${envFilePath}`);
    const result = await upsertFn(secretName, data, awsConfig);
    const verb = result === "created" ? "Created" : "Updated";
    log.success(`${verb} secret: ${secretName} (from ${envFilePath})`);
    return true;
  } catch (error) {
    handleAuthError(error);
    log.error(`Failed to upload ${envFilePath} → ${secretName}: ${getErrorMessage(error)}`);
    return false;
  }
}

/**
 * @param {string} [name]
 * @param {{ promptFn?: PromptFn; getSecretFn?: GetSecretFn; upsertFn?: UpsertFn }} [opts]
 * @returns {Command}
 */
export function buildCommand(name = "upload", { promptFn = promptConfirm, getSecretFn = getSecret, upsertFn = upsertSecret } = {}) {
  return new Command(name)
    .description("Upload local .env files to AWS Secrets Manager")
    .argument(
      "[env-filter]",
      "filter matched against secret name or .env file path (e.g. staging, prod) — case-sensitive",
    )
    .option(
      "-f, --file <path>",
      "JSON config file with custom mappings (overrides aws-secrets.config.json)",
    )
    .option("-y, --yes", "skip confirmation prompt and upload without asking (differences are still shown)")
    .addHelpText(
      "after",
      `${CONFIG_FILE_HELP}

Examples:
  aws-secrets-sync upload
  aws-secrets-sync upload staging
  aws-secrets-sync upload staging --yes
  aws-secrets-sync upload staging -f aws-secrets.config.json`,
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

      for (const { envFilePath, secretName } of filtered) {
        printSectionHeader(secretName, envFilePath);

        const localEnv = parseEnvFile(envFilePath);
        if (localEnv === null) {
          log.error(`Local file not found: ${envFilePath} — skipping`);
          anyFailed = true;
          continue;
        }

        // Fetch the current AWS secret so we can show a diff before uploading.
        /** @type {Record<string, unknown> | null} */
        let awsSecret = null;
        let isNew = false;
        let fetchFailed = false;

        try {
          awsSecret = await getSecretFn(secretName, awsConfig);
        } catch (fetchErr) {
          handleAuthError(fetchErr);
          if (fetchErr instanceof Error && fetchErr.name === "ResourceNotFoundException") {
            isNew = true;
          } else {
            log.error(`Failed to fetch current secret from AWS: ${getErrorMessage(fetchErr)}`);
            fetchFailed = true;
          }
        }

        if (fetchFailed) {
          anyFailed = true;
          continue;
        }

        if (isNew) {
          log.info("  New secret — will be created in AWS.");
          log.info(`  Keys to add: ${Object.keys(localEnv).join(", ")}`);
        } else {
          const diff = diffEnvs(/** @type {Record<string, unknown>} */ (awsSecret), localEnv);
          if (!printDiff(diff, UPLOAD_LABELS)) {
            log.success("Already in sync — skipping upload.");
            continue;
          }
        }

        const confirmed = await effectivePromptFn("  Upload to AWS? [y/N] ");
        if (!confirmed) {
          log.info("  Skipped.");
          continue;
        }

        const ok = await uploadEnvFileToSecret(envFilePath, secretName, awsConfig, { upsertFn, localEnv });
        if (!ok) anyFailed = true;
      }

      if (anyFailed) process.exit(1);
    });
}

runStandalone(import.meta.url, buildCommand);

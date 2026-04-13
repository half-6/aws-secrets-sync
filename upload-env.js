import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { Command } from "commander";
import dotenv from "dotenv";

import {
  CONFIG_FILE_HELP,
  filterMappings,
  resolveConfig,
} from "./lib/config-loader.js";
import { upsertSecret } from "./lib/secrets-client.js";

/**
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function parseEnvFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Local .env file not found: ${resolved}`);
  }
  return dotenv.parse(fs.readFileSync(resolved));
}

/**
 * @param {string} envFilePath
 * @param {string} secretName
 * @param {string} region
 * @param {string} profile
 * @returns {Promise<boolean>} true on success, false on failure
 */
async function uploadEnvFileToSecret(envFilePath, secretName, region, profile) {
  try {
    const data = parseEnvFile(envFilePath);
    const result = await upsertSecret(secretName, data, region, profile);
    console.log(`${result === "created" ? "Created" : "Updated"} secret: ${secretName} (from ${envFilePath})`);
    return true;
  } catch (error) {
    console.error(`Failed to upload ${envFilePath} -> ${secretName}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * @param {string} [name]
 * @returns {Command}
 */
export function buildCommand(name = "upload") {
  return new Command(name)
    .description("Upload local .env files to AWS Secrets Manager")
    .argument(
      "[env-filter]",
      "filter matched against secret name or .env file path (e.g. staging, prod)",
    )
    .option(
      "-f, --file <path>",
      "JSON config file with custom mappings (overrides aws-secrets.config.json)",
    )
    .addHelpText(
      "after",
      `${CONFIG_FILE_HELP}

Examples:
  aws-secrets-sync upload
  aws-secrets-sync upload staging
  aws-secrets-sync upload staging -f aws-secrets.config.json`,
    )
    .action(async (envFilter, options) => {
      const { mappings, awsRegion, awsProfile } = resolveConfig(options.file);
      const filtered = filterMappings(mappings, envFilter);

      if (!filtered.length) {
        console.error(`No mappings found matching "${envFilter}"`);
        process.exit(1);
      }

      let anyFailed = false;
      for (const { envFilePath, secretName } of filtered) {
        const ok = await uploadEnvFileToSecret(envFilePath, secretName, awsRegion, awsProfile);
        if (!ok) anyFailed = true;
      }
      if (anyFailed) process.exit(1);
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildCommand("npm run upload")
    .parseAsync(process.argv)
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

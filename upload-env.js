import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { Command } from "commander";
import dotenv from "dotenv";

import { CONFIG_FILE_HELP, resolveConfig } from "./lib/config-loader.js";
import { upsertSecret } from "./lib/secrets-client.js";

/** @param {string} filePath @returns {Record<string, string>} */
function parseEnvFile(filePath) {
  const contents = fs.readFileSync(path.resolve(filePath));
  return dotenv.parse(contents);
}

/** @param {string} envFilePath @param {string} secretName @param {string} region @param {string} profile */
async function uploadEnvFileToSecret(envFilePath, secretName, region, profile) {
  try {
    const data = parseEnvFile(envFilePath);
    await upsertSecret(secretName, data, region, profile);
    console.log(`Uploaded ${envFilePath} to ${secretName}`);
  } catch (error) {
    console.error(`Failed to upload ${envFilePath} -> ${secretName}: ${error}`);
  }
}

/**
 * @param {string} [name] - command name shown in help (default: "upload")
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

      const filtered = envFilter
        ? mappings.filter(
            (m) =>
              m.secretName.includes(envFilter) ||
              m.envFilePath.includes(envFilter),
          )
        : mappings;

      if (!filtered.length) {
        console.error(`No mappings found matching "${envFilter}"`);
        process.exit(1);
      }

      for (const { envFilePath, secretName } of filtered) {
        await uploadEnvFileToSecret(envFilePath, secretName, awsRegion, awsProfile);
      }
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildCommand("npm run upload").parseAsync(process.argv);
}

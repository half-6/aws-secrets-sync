import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { Command } from "commander";

import {
  CONFIG_FILE_HELP,
  filterMappings,
  resolveConfig,
} from "./lib/config-loader.js";
import { getSecret } from "./lib/secrets-client.js";

/**
 * @param {string} secretName
 * @param {string} outputFile
 * @param {string} region
 * @param {string} profile
 * @returns {Promise<boolean>} true on success, false on failure
 */
async function writeSecretToFile(secretName, outputFile, region, profile) {
  try {
    const folder = path.dirname(outputFile);
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
    const secret = await getSecret(secretName, region, profile);
    fs.writeFileSync(
      outputFile,
      Object.entries(secret)
        .map(([key, value]) => `${key}='${value}'`)
        .join("\n"),
    );
    console.log(`Secret written to file ${outputFile}`);
    return true;
  } catch (error) {
    console.error(`Error writing secret to file ${outputFile}: ${error}`);
    return false;
  }
}

/**
 * @param {string} [name]
 * @returns {Command}
 */
export function buildCommand(name = "download") {
  return new Command(name)
    .description("Download secrets from AWS Secrets Manager to local .env files")
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
  aws-secrets-sync download
  aws-secrets-sync download staging
  aws-secrets-sync download staging -f aws-secrets.config.json`,
    )
    .action(async (envFilter, options) => {
      const { mappings, awsRegion, awsProfile } = resolveConfig(options.file);
      const filtered = filterMappings(mappings, envFilter);

      if (!filtered.length) {
        console.error(`No mappings found matching "${envFilter}"`);
        process.exit(1);
      }

      let anyFailed = false;
      for (const { secretName, envFilePath } of filtered) {
        const ok = await writeSecretToFile(secretName, envFilePath, awsRegion, awsProfile);
        if (!ok) anyFailed = true;
      }
      if (anyFailed) process.exit(1);
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildCommand("npm run download").parseAsync(process.argv);
}

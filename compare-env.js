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
import { getSecret } from "./lib/secrets-client.js";

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

/** @param {string} filePath @returns {Record<string, string> | null} */
function parseEnvFile(filePath) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }
  return dotenv.parse(fs.readFileSync(absolutePath));
}

/**
 * @param {Record<string, unknown>} awsSecret
 * @param {Record<string, string>} localEnv
 * @param {string} secretName
 * @param {string} filePath
 * @returns {boolean}
 */
function compareEnvs(awsSecret, localEnv, secretName, filePath) {
  const awsKeys = new Set(Object.keys(awsSecret));
  const localKeys = new Set(Object.keys(localEnv));

  const onlyInAws = [...awsKeys].filter((k) => !localKeys.has(k));
  const onlyInLocal = [...localKeys].filter((k) => !awsKeys.has(k));
  const different = [...awsKeys].filter(
    (k) => localKeys.has(k) && String(awsSecret[k]) !== localEnv[k],
  );

  const hasDiff = onlyInAws.length || onlyInLocal.length || different.length;

  console.log(`\n${BOLD}${CYAN}━━━ ${secretName} ↔ ${filePath} ━━━${RESET}`);

  if (!hasDiff) {
    console.log(`${GREEN}✓ In sync — no differences found${RESET}`);
    return false;
  }

  if (onlyInAws.length) {
    console.log(`\n${YELLOW}Keys in AWS but missing from local file:${RESET}`);
    for (const k of onlyInAws) {
      console.log(`  ${RED}+ ${k}${RESET}`);
    }
  }

  if (onlyInLocal.length) {
    console.log(`\n${YELLOW}Keys in local file but missing from AWS:${RESET}`);
    for (const k of onlyInLocal) {
      console.log(`  ${RED}- ${k}${RESET}`);
    }
  }

  if (different.length) {
    console.log(`\n${YELLOW}Keys with different values:${RESET}`);
    for (const k of different) {
      console.log(`  ${RED}~ ${k} [values differ — masked for security]${RESET}`);
    }
  }

  return true;
}

/**
 * @param {string} [name]
 * @returns {Command}
 */
export function buildCommand(name = "compare") {
  return new Command(name)
    .description("Diff AWS secrets against local .env files")
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
  aws-secrets-sync compare
  aws-secrets-sync compare staging
  aws-secrets-sync compare staging -f aws-secrets.config.json`,
    )
    .action(async (envFilter, options) => {
      const { mappings, awsRegion, awsProfile } = resolveConfig(options.file);
      const filtered = filterMappings(mappings, envFilter);

      if (!filtered.length) {
        console.error(`No mappings found matching "${envFilter}"`);
        process.exit(1);
      }

      let anyDiff = false;

      for (const { secretName, envFilePath } of filtered) {
        const localEnv = parseEnvFile(envFilePath);
        if (localEnv === null) {
          console.log(`\n${BOLD}${CYAN}━━━ ${secretName} ↔ ${envFilePath} ━━━${RESET}`);
          console.log(`${YELLOW}⚠ Local file not found — skipping${RESET}`);
          continue;
        }

        /** @type {Record<string, unknown>} */
        let awsSecret;
        try {
          awsSecret = await getSecret(secretName, awsRegion, awsProfile);
        } catch (error) {
          console.log(`\n${BOLD}${CYAN}━━━ ${secretName} ↔ ${envFilePath} ━━━${RESET}`);
          console.error(`${RED}✗ Failed to fetch from AWS: ${error instanceof Error ? error.message : String(error)}${RESET}`);
          continue;
        }

        const hasDiff = compareEnvs(awsSecret, localEnv, secretName, envFilePath);
        if (hasDiff) anyDiff = true;
      }

      console.log("");
      if (anyDiff) {
        console.log(`${YELLOW}${BOLD}⚠ Differences detected in one or more environments.${RESET}`);
        process.exit(1);
      } else {
        console.log(`${GREEN}${BOLD}✓ All compared environments are in sync.${RESET}`);
      }
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildCommand("npm run compare")
    .parseAsync(process.argv)
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

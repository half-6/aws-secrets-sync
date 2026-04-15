import fs from "fs";
import path from "path";

import dotenv from "dotenv";

import { getErrorMessage, normalize } from "./utils.js";
import { log } from "./logger.js";

/**
 * Module-level defaults — lowest-priority fallback in the credential resolution chain.
 * Resolution order (high → low):
 *   1. aws-secrets.config.json (or file passed via -f)
 *   2. Environment variables: AWS_REGION, AWS_PROFILE, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *   3. The constants below
 *
 * Leave DEFAULT_PROFILE as "" to use the default credential chain
 * (default profile in ~/.aws/credentials, IAM role, SSO session, etc.).
 */
const DEFAULT_CONFIG_FILE = "aws-secrets.config.json";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_PROFILE = "";

/**
 * @typedef {{ envFilePath: string; secretName: string }} Mapping
 * @typedef {{
 *   mappings: Mapping[];
 *   awsRegion?: string;
 *   awsProfile?: string;
 *   awsAccessKeyId?: string;
 *   awsSecretAccessKey?: string;
 * }} ConfigFile
 * @typedef {{
 *   mappings: Mapping[];
 *   awsConfig: import("./secrets-client.js").AwsConfig;
 * }} ResolvedConfig
 */

/**
 * Returns true if the value is a valid Mapping object.
 * @param {unknown} value
 * @returns {value is Mapping}
 */
function isValidMapping(value) {
  if (typeof value !== "object" || value === null) return false;
  const m = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof m.envFilePath === "string" && m.envFilePath.length > 0 &&
    typeof m.secretName === "string" && m.secretName.length > 0
  );
}

/** @param {string} filePath @returns {ConfigFile} */
export function loadConfigFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  log.info(`Loading config file: ${resolved}`);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse config file "${resolved}": ${getErrorMessage(err)}`, { cause: err });
  }
  const cfg = /** @type {Record<string, unknown>} */ (parsed);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray(cfg.mappings) ||
    cfg.mappings.length === 0
  ) {
    throw new Error(`Config file must contain a non-empty "mappings" array.`);
  }

  const mappings = cfg.mappings;
  const invalidIndex = /** @type {unknown[]} */ (mappings).findIndex(
    (m) => !isValidMapping(m),
  );
  if (invalidIndex !== -1) {
    throw new Error(
      `Invalid mapping at index ${invalidIndex}: each mapping must have non-empty "envFilePath" and "secretName" strings.`,
    );
  }

  const validMappings = /** @type {Mapping[]} */ (mappings);
  /** @type {Set<string>} */
  const seenEnvPaths = new Set();
  /** @type {Set<string>} */
  const seenSecretNames = new Set();
  for (let i = 0; i < validMappings.length; i++) {
    const { envFilePath, secretName } = validMappings[i];
    if (seenEnvPaths.has(envFilePath)) {
      throw new Error(`Duplicate envFilePath "${envFilePath}" at mapping index ${i}.`);
    }
    if (seenSecretNames.has(secretName)) {
      throw new Error(`Duplicate secretName "${secretName}" at mapping index ${i}.`);
    }
    seenEnvPaths.add(envFilePath);
    seenSecretNames.add(secretName);
  }

  return /** @type {ConfigFile} */ (parsed);
}

/**
 * Parses a .env file and returns its key-value pairs.
 * Returns null if the file does not exist.
 *
 * @param {string} filePath
 * @returns {Record<string, string> | null}
 */
export function parseEnvFile(filePath) {
  const absolutePath = path.resolve(filePath);
  try {
    return dotenv.parse(fs.readFileSync(absolutePath));
  } catch (err) {
    if (err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read env file "${absolutePath}": ${getErrorMessage(err)}`, { cause: err });
  }
}

/**
 * Resolves the final config using (in order of precedence):
 *  1. The path passed via -f / --file
 *  2. Auto-detected aws-secrets.config.json in cwd
 *  3. AWS_SECRETS_CONFIG_FILE environment variable
 *  4. Environment variables: AWS_REGION, AWS_PROFILE, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *  5. DEFAULT_REGION / DEFAULT_PROFILE module constants above
 *
 * Non-empty config file values take precedence over environment variables.
 * Empty or whitespace-only config file fields are treated as absent (via `normalize`),
 * allowing environment variables to fill in those slots.
 *
 * @param {string | undefined} filePath
 * @returns {ResolvedConfig}
 */
export function resolveConfig(filePath) {
  const envConfigFile = process.env["AWS_SECRETS_CONFIG_FILE"];
  const fromCwd = !filePath && fs.existsSync(DEFAULT_CONFIG_FILE) ? DEFAULT_CONFIG_FILE : undefined;
  const effectivePath = filePath ?? fromCwd ?? envConfigFile;
  const fromEnvVar = !filePath && !fromCwd && Boolean(envConfigFile);

  const envRegion = normalize(process.env["AWS_REGION"]);
  const envProfile = normalize(process.env["AWS_PROFILE"]);
  const envAccessKeyId = normalize(process.env["AWS_ACCESS_KEY_ID"]);
  const envSecretAccessKey = normalize(process.env["AWS_SECRET_ACCESS_KEY"]);

  if (effectivePath) {
    try {
      const config = loadConfigFile(effectivePath);
      return {
        mappings: config.mappings,
        awsConfig: {
          region: normalize(config.awsRegion) ?? envRegion ?? DEFAULT_REGION,
          profile: normalize(config.awsProfile) ?? envProfile ?? DEFAULT_PROFILE,
          accessKeyId: normalize(config.awsAccessKeyId) ?? envAccessKeyId,
          secretAccessKey: normalize(config.awsSecretAccessKey) ?? envSecretAccessKey,
        },
      };
    } catch (err) {
      if (fromEnvVar && err instanceof Error && err.message.startsWith("Config file not found")) {
        throw new Error(`${err.message} (from AWS_SECRETS_CONFIG_FILE)`, { cause: err });
      }
      throw err;
    }
  }

  throw new Error(
    `No config file found. Use -f <path>, set AWS_SECRETS_CONFIG_FILE, or place ${DEFAULT_CONFIG_FILE} in the current directory.`,
  );
}

/**
 * Filters mappings by an optional env-filter string matched against both
 * the secret name and the .env file path.
 *
 * @param {Mapping[]} mappings
 * @param {string | undefined} envFilter
 * @returns {Mapping[]}
 */
export function filterMappings(mappings, envFilter) {
  if (!envFilter) return mappings;
  return mappings.filter(
    (m) =>
      m.secretName.includes(envFilter) || m.envFilePath.includes(envFilter),
  );
}

/** Help text appended to every command's --help output. */
export const CONFIG_FILE_HELP = `
Config file format (JSON):
  {
    "mappings": [
      { "envFilePath": "./.env/.env.staging.local", "secretName": "myapp/staging/config" }
    ],
    "awsRegion": "us-east-1",              (optional)
    "awsProfile": "my-aws-profile",        (optional)
    "awsAccessKeyId": "AKIA...",           (optional — WARNING: avoid committing to source control)
    "awsSecretAccessKey": "abc123..."      (optional — WARNING: avoid committing to source control)
  }

  SECURITY: Never commit awsAccessKeyId/awsSecretAccessKey to source control. Prefer
  awsProfile (~/.aws/credentials) or IAM roles over hardcoded keys. Add your config
  file to .gitignore if it contains credentials.

  Credential resolution order (highest → lowest priority):
    1. Config file values
    2. Environment variables: AWS_REGION, AWS_PROFILE, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
    3. Defaults in config-loader.js
  Within resolved credentials: awsAccessKeyId/awsSecretAccessKey → awsProfile → default chain

  Config file resolution order (when -f is omitted):
    1. ${DEFAULT_CONFIG_FILE} auto-detected in cwd
    2. AWS_SECRETS_CONFIG_FILE environment variable`;

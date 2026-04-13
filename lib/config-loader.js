import fs from "fs";
import path from "path";

import { AWS_PROFILE, AWS_REGION, MAPPINGS } from "../config.js";

/**
 * @typedef {{ envFilePath: string; secretName: string }} Mapping
 * @typedef {{ mappings: Mapping[]; awsRegion?: string; awsProfile?: string }} ConfigFile
 * @typedef {{ mappings: Mapping[]; awsRegion: string; awsProfile: string }} ResolvedConfig
 */

/** Default config file looked up relative to cwd when -f is not provided. */
export const DEFAULT_CONFIG_FILE = "aws-secrets.config.json";

/** @param {string} filePath @returns {ConfigFile} */
export function loadConfigFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Config file not found: ${resolved}`);
    process.exit(1);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } catch (err) {
    console.error(
      `Failed to parse config file "${resolved}": ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray(/** @type {Record<string, unknown>} */ (parsed).mappings) ||
    /** @type {Record<string, unknown>} */ (parsed).mappings.length === 0
  ) {
    console.error(`Config file must contain a non-empty "mappings" array.`);
    process.exit(1);
  }
  return /** @type {ConfigFile} */ (parsed);
}

/**
 * Resolves the final config using (in order of precedence):
 *  1. The path passed via -f / --file
 *  2. aws-secrets.config.json in the current working directory
 *  3. MAPPINGS / AWS_REGION / AWS_PROFILE from config.js
 *
 * @param {string | undefined} filePath
 * @returns {ResolvedConfig}
 */
export function resolveConfig(filePath) {
  const effectivePath =
    filePath ?? (fs.existsSync(DEFAULT_CONFIG_FILE) ? DEFAULT_CONFIG_FILE : undefined);

  if (effectivePath) {
    const config = loadConfigFile(effectivePath);
    return {
      mappings: config.mappings,
      awsRegion: config.awsRegion ?? AWS_REGION,
      awsProfile: config.awsProfile ?? AWS_PROFILE,
    };
  }

  if (MAPPINGS.length === 0) {
    console.error(
      `No mappings found. Add an ${DEFAULT_CONFIG_FILE} file or use -f <path>.`,
    );
    process.exit(1);
  }
  return { mappings: MAPPINGS, awsRegion: AWS_REGION, awsProfile: AWS_PROFILE };
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
    "awsRegion": "us-east-1",    (optional, overrides config.js)
    "awsProfile": "my-aws-profile"    (optional, overrides config.js)
  }

  Default config file: ${DEFAULT_CONFIG_FILE} (auto-detected in cwd when -f is omitted)`;

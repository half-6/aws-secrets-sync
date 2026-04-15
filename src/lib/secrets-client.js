import { createHash } from "crypto";

import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { fromIni } from "@aws-sdk/credential-providers";

import { log } from "./logger.js";

/**
 * @typedef {{
 *   region: string;
 *   profile: string;
 *   accessKeyId?: string;
 *   secretAccessKey?: string;
 * }} AwsConfig
 */

/** @type {Map<string, SecretsManagerClient>} */
const clientCache = new Map();

/**
 * Produces a short, opaque identifier for a credential pair without
 * embedding either key in the cache key string.
 *
 * @param {string | undefined} accessKeyId
 * @param {string | undefined} secretAccessKey
 * @returns {string}
 */
function credentialCacheKey(accessKeyId, secretAccessKey) {
  if (!accessKeyId) return "";
  return createHash("sha256")
    .update(`${accessKeyId}:${secretAccessKey ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Returns a cached SecretsManagerClient.
 * Priority: explicit credentials → named profile → default credential chain.
 *
 * @param {AwsConfig} config
 * @returns {SecretsManagerClient}
 */
function getClient({ region, profile, accessKeyId, secretAccessKey }) {
  const key = `${region}::${profile}::${credentialCacheKey(accessKeyId, secretAccessKey)}`;
  const cached = clientCache.get(key);
  if (cached) return cached;

  /** @type {import("@aws-sdk/client-secrets-manager").SecretsManagerClientConfig} */
  const clientConfig = { region };
  if (accessKeyId && secretAccessKey) {
    clientConfig.credentials = { accessKeyId, secretAccessKey };
  } else if (accessKeyId || secretAccessKey) {
    log.warn(
      "Only one of awsAccessKeyId / awsSecretAccessKey is set — both are required for static credentials. Falling back to profile/default credential chain.",
    );
    if (profile) clientConfig.credentials = fromIni({ profile });
  } else if (profile) {
    clientConfig.credentials = fromIni({ profile });
  }
  const client = new SecretsManagerClient(clientConfig);
  clientCache.set(key, client);
  return client;
}

/**
 * Auth-related error names that indicate a credential problem rather than a
 * secret-specific problem. These affect every request, so callers should
 * abort immediately instead of retrying remaining secrets.
 *
 * Note: `AccessDeniedException` is intentionally excluded — it can mean a
 * per-secret IAM permission issue (valid credentials, wrong policy), not a
 * global credential failure. Treating it as a per-secret error allows the
 * remaining secrets to be attempted rather than aborting the entire run.
 */
const AUTH_ERROR_NAMES = new Set([
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "AuthFailure",
  "InvalidSignatureException",
  "TokenRefreshRequired",
  "CredentialsProviderError",
  "CredentialUnavailableError",
]);

/**
 * Returns true when the error is an AWS authentication / credential failure.
 * Use this to fail fast before attempting further secrets.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAuthError(error) {
  if (!(error instanceof Error)) return false;
  return AUTH_ERROR_NAMES.has(error.name);
}

/**
 * Fetches a secret from AWS Secrets Manager and parses it as JSON.
 * Values may be strings, numbers, booleans, or nested objects depending
 * on how the secret was stored.
 *
 * @param {string} secretName
 * @param {AwsConfig} awsConfig
 * @param {{ _client?: SecretsManagerClient }} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getSecret(secretName, awsConfig, { _client } = {}) {
  const client = _client ?? getClient(awsConfig);
  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: secretName,
      VersionStage: "AWSCURRENT",
    }),
  );
  if (!response.SecretString) {
    throw new Error(
      `Secret "${secretName}" is a binary secret. Only JSON string secrets are supported.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(response.SecretString);
  } catch {
    throw new Error(
      `Secret "${secretName}" is not valid JSON. Only JSON-formatted secrets are supported.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Secret "${secretName}" must be a JSON object, not an array or primitive value.`,
    );
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Creates or updates a secret in AWS Secrets Manager.
 * Attempts PutSecretValue first; falls back to CreateSecret when the secret
 * does not exist yet (ResourceNotFoundException).
 *
 * @param {string} secretName
 * @param {Record<string, unknown>} secretObject
 * @param {AwsConfig} awsConfig
 * @param {{ _client?: SecretsManagerClient }} [opts]
 * @returns {Promise<"updated" | "created">}
 */
export async function upsertSecret(secretName, secretObject, awsConfig, { _client } = {}) {
  const client = _client ?? getClient(awsConfig);
  const secretString = JSON.stringify(secretObject);
  try {
    await client.send(
      new PutSecretValueCommand({
        SecretId: secretName,
        SecretString: secretString,
      }),
    );
    return "updated";
  } catch (putError) {
    if (!(putError instanceof Error && putError.name === "ResourceNotFoundException")) {
      throw putError;
    }
    // Secret doesn't exist yet — create it. Guard against a race where another
    // process created it between our failed Put and this Create.
    try {
      await client.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: secretString,
        }),
      );
      return "created";
    } catch (createError) {
      if (createError instanceof Error && createError.name === "ResourceExistsException") {
        await client.send(
          new PutSecretValueCommand({
            SecretId: secretName,
            SecretString: secretString,
          }),
        );
        return "updated";
      }
      throw createError;
    }
  }
}

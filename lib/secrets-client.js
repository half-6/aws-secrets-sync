import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/** @type {Map<string, SecretsManagerClient>} */
const clientCache = new Map();

/**
 * Returns a cached SecretsManagerClient for the given region + profile pair.
 *
 * @param {string} region
 * @param {string} profile
 * @returns {SecretsManagerClient}
 */
function getClient(region, profile) {
  const key = `${region}::${profile}`;
  if (!clientCache.has(key)) {
    clientCache.set(
      key,
      new SecretsManagerClient(profile ? { region, profile } : { region }),
    );
  }
  return /** @type {SecretsManagerClient} */ (clientCache.get(key));
}

/**
 * Fetches a secret from AWS Secrets Manager and parses it as JSON.
 *
 * @param {string} secretName
 * @param {string} region
 * @param {string} profile
 * @returns {Promise<Record<string, string>>}
 */
export async function getSecret(secretName, region, profile) {
  const client = getClient(region, profile);
  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: secretName,
      VersionStage: "AWSCURRENT",
    }),
  );
  return JSON.parse(response.SecretString ?? "{}");
}

/**
 * Creates or updates a secret in AWS Secrets Manager.
 * Attempts PutSecretValue first; falls back to CreateSecret when the secret
 * does not exist yet (ResourceNotFoundException).
 *
 * @param {string} secretName
 * @param {Record<string, string>} secretObject
 * @param {string} region
 * @param {string} profile
 * @returns {Promise<"updated" | "created">}
 */
export async function upsertSecret(secretName, secretObject, region, profile) {
  const client = getClient(region, profile);
  const secretString = JSON.stringify(secretObject);
  try {
    await client.send(
      new PutSecretValueCommand({
        SecretId: secretName,
        SecretString: secretString,
      }),
    );
    return "updated";
  } catch (error) {
    const isNotFound =
      error instanceof Error &&
      (error.name === "ResourceNotFoundException" ||
        /** @type {Record<string, unknown>} */ (error)["Code"] ===
          "ResourceNotFoundException");
    if (isNotFound) {
      await client.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: secretString,
        }),
      );
      return "created";
    }
    throw error;
  }
}

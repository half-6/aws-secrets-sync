import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * @param {string} region
 * @param {string} profile
 * @returns {SecretsManagerClient}
 */
function createClient(region, profile) {
  return new SecretsManagerClient({ region, profile });
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
  const client = createClient(region, profile);
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
 * @returns {Promise<void>}
 */
export async function upsertSecret(secretName, secretObject, region, profile) {
  const client = createClient(region, profile);
  const secretString = JSON.stringify(secretObject);
  try {
    await client.send(
      new PutSecretValueCommand({
        SecretId: secretName,
        SecretString: secretString,
      }),
    );
    console.log(`Updated secret: ${secretName}`);
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
      console.log(`Created secret: ${secretName}`);
      return;
    }
    throw error;
  }
}

/**
 * Shared configuration for aws-secrets-to-env scripts.
 * Exports:
 * - MAPPINGS: empty by default — supply mappings via -f <config.json> at runtime
 *             (copy config.example.json as your starting point)
 * - INPUT_MAPPING: envFilePath -> secretName (derived from MAPPINGS)
 * - OUTPUT_MAPPING: secretName -> envFilePath (derived from MAPPINGS)
 * - AWS_REGION, AWS_PROFILE: AWS SDK client configuration
 */
export const MAPPINGS = [];

export const INPUT_MAPPING = Object.fromEntries(
  MAPPINGS.map((m) => [m.envFilePath, m.secretName]),
);

export const OUTPUT_MAPPING = Object.fromEntries(
  MAPPINGS.map((m) => [m.secretName, m.envFilePath]),
);

export const AWS_REGION = "us-east-1";
export const AWS_PROFILE = "hibu-prod";

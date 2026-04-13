/**
 * Shared defaults for aws-secrets-sync.
 * Mappings are empty by default — supply them at runtime via -f <path>
 * or by placing an aws-secrets.config.json file in your project root.
 *
 * AWS_REGION and AWS_PROFILE are used as fallbacks when the config file
 * does not specify them. Set AWS_PROFILE to "" to rely on the default
 * credential chain (env vars, ~/.aws/credentials, IAM role, etc.).
 */
export const MAPPINGS = [];

export const AWS_REGION = "us-east-1";
export const AWS_PROFILE = "";

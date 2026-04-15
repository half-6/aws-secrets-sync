# aws-secrets-sync

[![npm version](https://img.shields.io/npm/v/aws-secrets-sync)](https://www.npmjs.com/package/aws-secrets-sync)
[![npm downloads](https://img.shields.io/npm/dm/aws-secrets-sync)](https://www.npmjs.com/package/aws-secrets-sync)
[![Node.js](https://img.shields.io/node/v/aws-secrets-sync)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/aws-secrets-sync)](./LICENSE)

> **Note:** The npm package name is `aws-secrets-sync`. The local development folder may be named differently (e.g. `aws-secrets-to-env`) — use the package name for all install and run commands.

A CLI application that syncs configuration between AWS Secrets Manager and local `.env` files:

- **download**: AWS Secrets Manager → `.env` files
- **upload**: local `.env` files → AWS Secrets Manager
- **compare**: diff AWS secrets against local `.env` files

## Prerequisites

- **Node.js 18+** and **npm**
- **AWS credentials** configured locally with access to the target Secrets Manager secrets (via `~/.aws/credentials`, environment variables, or an SSO session)

## Install

### Global install (recommended for regular use)

```bash
npm install -g aws-secrets-sync
aws-secrets-sync --help
```

### One-off via npx (no install required)

```bash
npx aws-secrets-sync download staging
npx aws-secrets-sync --help
```

### Local project install

```bash
npm install aws-secrets-sync
npx aws-secrets-sync download staging
```

## Configuration

Create an `aws-secrets.config.json` file in your project root:

```json
{
  "mappings": [
    { "envFilePath": "./.env/.env.development.local", "secretName": "myapp/dev/config" },
    { "envFilePath": "./.env/.env.staging.local",     "secretName": "myapp/staging/config" },
    { "envFilePath": "./.env/.env.production.local",  "secretName": "myapp/prod/config" }
  ],
  "awsRegion": "us-east-1",
  "awsProfile": "my-aws-profile"
}
```

| Field | Required | Description |
|---|---|---|
| `mappings` | Yes | Array of `{ envFilePath, secretName }` pairs |
| `awsRegion` | No | Defaults to `us-east-1` |
| `awsProfile` | No | Named AWS credentials profile (`~/.aws/credentials`) |
| `awsAccessKeyId` | No | Explicit AWS access key ID |
| `awsSecretAccessKey` | No | Explicit AWS secret access key (required with `awsAccessKeyId`) |

### AWS credential resolution

Config is resolved in two layers:

**Layer 1 — where values come from (highest → lowest priority):**

| Priority | Source |
|---|---|
| 1 | Config file (`-f` or `aws-secrets.config.json`) |
| 2 | Environment variables: `AWS_REGION`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| 3 | Defaults in `config-loader.js` |

**Layer 2 — how the AWS client authenticates (using the resolved values):**

| Priority | Method |
|---|---|
| 1 | `awsAccessKeyId` + `awsSecretAccessKey` — explicit static credentials |
| 2 | `awsProfile` — named profile from `~/.aws/credentials` or `~/.aws/config` |
| 3 | Default credential chain — EC2 instance profile, ECS task role, SSO, etc. |

All three commands auto-detect `aws-secrets.config.json` in the current working directory. Override with `-f <path>`.

## Commands

All commands accept an optional **env-filter** as the first argument, matched as a **case-sensitive substring** against both the secret name and the file path. Omit it to process all mappings.

> **Tip — choose precise filter strings:** The match is a substring, so `prod` will also match `production`, and `stg` will match any secret name or path containing those characters. Use a longer, unambiguous substring (e.g. `myapp/prod/`) when your secret names are similar.

---

### Download — AWS → local `.env` files

```bash
# All environments
aws-secrets-sync download

# Specific environment (matched against secret name or file path)
aws-secrets-sync download staging
aws-secrets-sync download myapp/prod/config

# Custom config file
aws-secrets-sync download staging -f ./path/to/config.json

# Help
aws-secrets-sync download --help
```

Fetches each secret from AWS Secrets Manager and writes it as `KEY="value"` lines to the mapped file. Values are double-quoted with backslashes, double quotes, tabs, and newlines escaped. Parent directories are created automatically. Existing files are overwritten.

> **Note — `AWSCURRENT` only:** The tool always fetches the `AWSCURRENT` version of a secret. Staged versions (e.g. `AWSPENDING` during rotation) are not accessible via this tool.

---

### Upload — local `.env` files → AWS

```bash
# All environments
aws-secrets-sync upload

# Specific environment
aws-secrets-sync upload staging
aws-secrets-sync upload staging -f ./path/to/config.json
```

Parses each local `.env` file and writes its key/value pairs as a JSON secret to AWS Secrets Manager. Creates the secret if it does not exist; updates it if it does.

> **Note — type fidelity:** `.env` files are text-only, so all values are stored as strings after an upload. If a secret originally contained typed values (e.g. `PORT: 42` as a number), uploading after a download will convert them to strings (`PORT: "42"`). Consumers that relied on the numeric type will need to coerce the value themselves (e.g. `Number(process.env.PORT)`).

---

### Compare — diff AWS vs local

```bash
# All environments
aws-secrets-sync compare

# Specific environment
aws-secrets-sync compare staging
aws-secrets-sync compare staging -f ./path/to/config.json
```

For each mapped environment, reports:
- Keys present in AWS but missing from the local file
- Keys present locally but missing from AWS
- Keys present in both but with different values

Exits with code `1` in any of these cases, making it suitable for CI checks:

| Condition | Exit code |
|---|---|
| Differences found between AWS and local | `1` |
| A mapped local `.env` file does not exist | `1` |
| An AWS secret could not be fetched (non-auth error) | `1` |
| Authentication / credential failure | `1` (immediate abort) |

---

## Config file precedence

Each command resolves its configuration in this order:

1. Path passed via `-f` / `--file`
2. `aws-secrets.config.json` auto-detected in the current working directory
3. Path in the `AWS_SECRETS_CONFIG_FILE` environment variable

If none of the above is found the command exits with an error. AWS credential defaults (`us-east-1` region, default credential chain) apply within whichever config file is loaded.

## Security notes

- Add `aws-secrets.config.json` and all `.env` files to `.gitignore` — they contain sensitive paths and credentials.
- Ensure your IAM principal has the following permissions where applicable:
  - `secretsmanager:GetSecretValue` (download, compare)
  - `secretsmanager:PutSecretValue` (upload)
  - `secretsmanager:CreateSecret` (upload, first run)
- **KMS encryption:** When creating a new secret, the tool uses your account's default encryption key. If your organisation enforces a customer-managed KMS key (CMK) via SCP or resource policy, the `CreateSecret` call will fail. In that case, pre-create the secret in the AWS console (with the correct KMS key) and use upload to populate its value.
- Rotate credentials regularly and treat terminal output as sensitive.

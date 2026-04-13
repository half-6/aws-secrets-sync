# aws-secrets-sync

Sync configuration between AWS Secrets Manager and local `.env` files:

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
| `awsProfile` | No | AWS credentials profile to use |

All three commands auto-detect `aws-secrets.config.json` in the current working directory. Override with `-f <path>`.

## Commands

All commands accept an optional **env-filter** as the first argument, matched against both the secret name and the file path. Omit it to process all mappings.

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

Fetches each secret from AWS Secrets Manager and writes it as `KEY="value"` lines to the mapped file. Values are double-quoted with backslashes and double quotes escaped. Parent directories are created automatically. Existing files are overwritten.

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

Exits with code `1` if any differences are found, making it suitable for CI checks.

---

## Config file precedence

Each command resolves its configuration in this order:

1. Path passed via `-f` / `--file`
2. `aws-secrets.config.json` auto-detected in the current working directory
3. `MAPPINGS` / `AWS_REGION` / `AWS_PROFILE` exported from `config.js`

## Security notes

- Add `aws-secrets.config.json` and all `.env` files to `.gitignore` — they contain sensitive paths and credentials.
- Ensure your IAM principal has the following permissions where applicable:
  - `secretsmanager:GetSecretValue` (download, compare)
  - `secretsmanager:PutSecretValue` (upload)
  - `secretsmanager:CreateSecret` (upload, first run)
- Rotate credentials regularly and treat terminal output as sensitive.

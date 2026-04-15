import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { filterMappings, loadConfigFile, parseEnvFile, resolveConfig } from "../src/lib/config-loader.js";

// ---------------------------------------------------------------------------
// filterMappings
// ---------------------------------------------------------------------------
describe("filterMappings", () => {
  const mappings = [
    { envFilePath: ".env/.env.staging.local", secretName: "myapp/staging/config" },
    { envFilePath: ".env/.env.prod.local",    secretName: "myapp/prod/config" },
    { envFilePath: ".env/.env.local.local",   secretName: "myapp/local/config" },
  ];

  it("returns all mappings when no filter is given", () => {
    assert.deepEqual(filterMappings(mappings, undefined), mappings);
    assert.deepEqual(filterMappings(mappings, ""), mappings);
  });

  it("filters by secret name substring", () => {
    const result = filterMappings(mappings, "staging");
    assert.equal(result.length, 1);
    assert.equal(result[0].secretName, "myapp/staging/config");
  });

  it("filters by envFilePath substring", () => {
    const result = filterMappings(mappings, "prod");
    assert.equal(result.length, 1);
    assert.equal(result[0].envFilePath, ".env/.env.prod.local");
  });

  it("returns empty array when no mapping matches", () => {
    assert.deepEqual(filterMappings(mappings, "nonexistent"), []);
  });

  it("filter is case-sensitive", () => {
    assert.deepEqual(filterMappings(mappings, "Staging"), []);
    assert.equal(filterMappings(mappings, "staging").length, 1);
  });
});

// ---------------------------------------------------------------------------
// loadConfigFile — uses real temp files
// ---------------------------------------------------------------------------
describe("loadConfigFile", () => {
  let tmpDir = "";

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aws-secrets-test-"));
    mock.method(console, "log", () => {});
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  it("loads a valid config file", () => {
    const cfg = {
      mappings: [{ envFilePath: ".env/.env.staging", secretName: "app/staging" }],
      awsRegion: "us-west-2",
    };
    const filePath = path.join(tmpDir, "valid.json");
    fs.writeFileSync(filePath, JSON.stringify(cfg));
    const result = loadConfigFile(filePath);
    assert.deepEqual(result.mappings, cfg.mappings);
    assert.equal(result.awsRegion, "us-west-2");
  });

  it("throws when file does not exist", () => {
    assert.throws(
      () => loadConfigFile(path.join(tmpDir, "missing.json")),
      /Config file not found/,
    );
  });

  it("throws when file contains invalid JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "{ not valid json }");
    assert.throws(() => loadConfigFile(filePath), /Failed to parse config file/);
  });

  it("throws when mappings array is missing", () => {
    const filePath = path.join(tmpDir, "no-mappings.json");
    fs.writeFileSync(filePath, JSON.stringify({ awsRegion: "us-east-1" }));
    assert.throws(() => loadConfigFile(filePath), /non-empty "mappings" array/);
  });

  it("throws when mappings array is empty", () => {
    const filePath = path.join(tmpDir, "empty-mappings.json");
    fs.writeFileSync(filePath, JSON.stringify({ mappings: [] }));
    assert.throws(() => loadConfigFile(filePath), /non-empty "mappings" array/);
  });

  it("throws when a mapping is missing required fields", () => {
    const filePath = path.join(tmpDir, "bad-mapping.json");
    fs.writeFileSync(filePath, JSON.stringify({ mappings: [{ envFilePath: ".env/foo" }] }));
    assert.throws(() => loadConfigFile(filePath), /Invalid mapping at index 0/);
  });

  it("throws when two mappings share the same envFilePath", () => {
    const filePath = path.join(tmpDir, "dup-env.json");
    fs.writeFileSync(filePath, JSON.stringify({
      mappings: [
        { envFilePath: ".env/shared.env", secretName: "app/one" },
        { envFilePath: ".env/shared.env", secretName: "app/two" },
      ],
    }));
    assert.throws(() => loadConfigFile(filePath), /Duplicate envFilePath/);
  });

  it("throws when two mappings share the same secretName", () => {
    const filePath = path.join(tmpDir, "dup-secret.json");
    fs.writeFileSync(filePath, JSON.stringify({
      mappings: [
        { envFilePath: ".env/one.env", secretName: "app/shared" },
        { envFilePath: ".env/two.env", secretName: "app/shared" },
      ],
    }));
    assert.throws(() => loadConfigFile(filePath), /Duplicate secretName/);
  });
});

// ---------------------------------------------------------------------------
// parseEnvFile
// ---------------------------------------------------------------------------
describe("parseEnvFile", () => {
  let tmpDir = "";

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aws-secrets-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when file does not exist", () => {
    assert.equal(parseEnvFile(path.join(tmpDir, "missing.env")), null);
  });

  it("parses a valid .env file into key-value pairs", () => {
    const filePath = path.join(tmpDir, "test.env");
    fs.writeFileSync(filePath, 'FOO=bar\nBAZ="hello world"\n');
    const result = parseEnvFile(filePath);
    assert.deepEqual(result, { FOO: "bar", BAZ: "hello world" });
  });

  it("wraps unexpected I/O errors with the file path in the message", () => {
    // Passing a directory path causes EISDIR, which is not ENOENT — should be wrapped.
    assert.throws(
      () => parseEnvFile(tmpDir),
      /Failed to read env file/,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------
describe("resolveConfig", () => {
  let tmpDir = "";

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aws-secrets-test-"));
    mock.method(console, "log", () => {});
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  it("loads mappings and AWS config from an explicit file path", () => {
    const cfg = {
      mappings: [{ envFilePath: ".env/.env.test", secretName: "app/test" }],
      awsRegion: "eu-west-1",
      awsProfile: "test-profile",
    };
    const filePath = path.join(tmpDir, "full-config.json");
    fs.writeFileSync(filePath, JSON.stringify(cfg));

    const result = resolveConfig(filePath);

    assert.deepEqual(result.mappings, cfg.mappings);
    assert.equal(result.awsConfig.region, "eu-west-1");
    assert.equal(result.awsConfig.profile, "test-profile");
  });

  it("falls back to env vars when config file fields are empty", () => {
    const cfg = {
      mappings: [{ envFilePath: ".env/.env.test", secretName: "app/test" }],
      awsRegion: "",
      awsProfile: "",
    };
    const filePath = path.join(tmpDir, "partial-config.json");
    fs.writeFileSync(filePath, JSON.stringify(cfg));

    const savedRegion = process.env["AWS_REGION"];
    const savedProfile = process.env["AWS_PROFILE"];
    process.env["AWS_REGION"] = "ap-southeast-1";
    process.env["AWS_PROFILE"] = "fallback-profile";
    try {
      const result = resolveConfig(filePath);
      assert.equal(result.awsConfig.region, "ap-southeast-1");
      assert.equal(result.awsConfig.profile, "fallback-profile");
    } finally {
      if (savedRegion === undefined) delete process.env["AWS_REGION"];
      else process.env["AWS_REGION"] = savedRegion;
      if (savedProfile === undefined) delete process.env["AWS_PROFILE"];
      else process.env["AWS_PROFILE"] = savedProfile;
    }
  });

  it("config file values take precedence over env vars", () => {
    const cfg = {
      mappings: [{ envFilePath: ".env/.env.test", secretName: "app/test" }],
      awsRegion: "us-west-2",
    };
    const filePath = path.join(tmpDir, "override-config.json");
    fs.writeFileSync(filePath, JSON.stringify(cfg));

    const savedRegion = process.env["AWS_REGION"];
    process.env["AWS_REGION"] = "eu-central-1";
    try {
      const result = resolveConfig(filePath);
      assert.equal(result.awsConfig.region, "us-west-2");
    } finally {
      if (savedRegion === undefined) delete process.env["AWS_REGION"];
      else process.env["AWS_REGION"] = savedRegion;
    }
  });

  it("throws when an explicit file path does not exist", () => {
    assert.throws(
      () => resolveConfig(path.join(tmpDir, "nonexistent.json")),
      /Config file not found/,
    );
  });

  it("throws when no config file exists and no path is given", () => {
    const savedCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      assert.throws(
        () => resolveConfig(undefined),
        /No config file found/,
      );
    } finally {
      process.chdir(savedCwd);
    }
  });

  it("mentions AWS_SECRETS_CONFIG_FILE in the error when that env var points to a missing file", () => {
    const savedCwd = process.cwd();
    const savedEnv = process.env["AWS_SECRETS_CONFIG_FILE"];
    process.chdir(tmpDir);
    process.env["AWS_SECRETS_CONFIG_FILE"] = path.join(tmpDir, "does-not-exist.json");
    try {
      assert.throws(
        () => resolveConfig(undefined),
        /from AWS_SECRETS_CONFIG_FILE/,
      );
    } finally {
      process.chdir(savedCwd);
      if (savedEnv === undefined) delete process.env["AWS_SECRETS_CONFIG_FILE"];
      else process.env["AWS_SECRETS_CONFIG_FILE"] = savedEnv;
    }
  });
});

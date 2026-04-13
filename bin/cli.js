#!/usr/bin/env node
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

import { Command } from "commander";

import { buildCommand as buildDownload } from "../download-env.js";
import { buildCommand as buildUpload } from "../upload-env.js";
import { buildCommand as buildCompare } from "../compare-env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
);

const program = new Command();

program
  .name("aws-secrets-sync")
  .description("Sync AWS Secrets Manager secrets to/from local .env files")
  .version(VERSION)
  .addCommand(buildDownload())
  .addCommand(buildUpload())
  .addCommand(buildCompare());

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

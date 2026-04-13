#!/usr/bin/env node
import { Command } from "commander";

import { buildCommand as buildDownload } from "../download-env.js";
import { buildCommand as buildUpload } from "../upload-env.js";
import { buildCommand as buildCompare } from "../compare-env.js";

// Keep in sync with package.json version
const VERSION = "1.0.0";

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

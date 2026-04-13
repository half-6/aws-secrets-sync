#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

import { buildCommand as buildDownload } from "../download-env.js";
import { buildCommand as buildUpload } from "../upload-env.js";
import { buildCommand as buildCompare } from "../compare-env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
);

const program = new Command();

program
  .name("aws-secrets-sync")
  .description("Sync AWS Secrets Manager secrets to/from local .env files")
  .version(version)
  .addCommand(buildDownload())
  .addCommand(buildUpload())
  .addCommand(buildCompare());

program.parseAsync(process.argv);

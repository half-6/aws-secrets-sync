#!/usr/bin/env node
import { createRequire } from "module";

import { Command } from "commander";

import { buildCommand as buildDownload } from "../download-env.js";
import { buildCommand as buildUpload } from "../upload-env.js";
import { buildCommand as buildCompare } from "../compare-env.js";
import { getErrorMessage } from "../lib/utils.js";
import { log } from "../lib/logger.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = /** @type {{ version: string }} */ (require("../../package.json"));

const program = new Command();

program
  .name("aws-secrets-sync")
  .description("Sync AWS Secrets Manager secrets to/from local .env files")
  .version(VERSION)
  .addCommand(buildDownload())
  .addCommand(buildUpload())
  .addCommand(buildCompare());

program.parseAsync(process.argv).catch((err) => {
  log.error(getErrorMessage(err));
  process.exit(1);
});

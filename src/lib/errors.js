import { isAuthError } from "./secrets-client.js";
import { getErrorMessage } from "./utils.js";
import { log } from "./logger.js";

/**
 * If `error` is an AWS authentication failure, logs a descriptive message and
 * exits the process immediately. Call this at the top of any catch block that
 * should abort on credential failures rather than retrying remaining items.
 *
 * @param {unknown} error
 * @returns {void}
 */
export function handleAuthError(error) {
  if (!isAuthError(error)) return;
  log.error(`AWS authentication failed: ${getErrorMessage(error)}`);
  log.warn("Check your credentials (profile, access keys, SSO session, or env vars).");
  process.exit(1);
}

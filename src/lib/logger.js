import { c } from "./color.js";

/**
 * Structured console logger with coloured icons and plain-text messages.
 * Only the leading icon is coloured; the message itself is rendered as-is.
 *
 * Routing:
 *   info    → stdout  (console.log)
 *   success → stdout  (console.log)
 *   warn    → stderr  (console.warn)
 *   error   → stderr  (console.error)
 */
export const log = {
  /** @param {string} message */
  info: (message) => console.log(message),

  /** @param {string} message */
  success: (message) => console.log(`${c.green}✓${c.reset} ${message}`),

  /** @param {string} message */
  warn: (message) => console.warn(`${c.yellow}⚠${c.reset} ${message}`),

  /** @param {string} message */
  error: (message) => console.error(`${c.red}✗${c.reset} ${message}`)
};

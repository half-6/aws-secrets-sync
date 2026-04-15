// Honour the NO_COLOR convention (https://no-color.org/) and strip ANSI
// codes when neither stdout nor stderr is a TTY (e.g. piped to a file or CI
// log parser). Both are checked because some output goes to stderr.
const useColor = (process.stdout.isTTY || process.stderr.isTTY) && !("NO_COLOR" in process.env);

export const c = {
  reset:  useColor ? "\x1b[0m"  : "",
  red:    useColor ? "\x1b[31m" : "",
  green:  useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
};

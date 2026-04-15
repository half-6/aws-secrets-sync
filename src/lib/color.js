// Colour is enabled when:
//   FORCE_COLOR is set (and not "0") — overrides TTY and NO_COLOR checks,
//   useful in CI that sets FORCE_COLOR=1 (e.g. GitHub Actions with --color).
// Colour is disabled when:
//   NO_COLOR is set (https://no-color.org/) — unless FORCE_COLOR overrides it.
//   Neither stdout nor stderr is a TTY (e.g. piped to a file or log parser).
const forceColor = "FORCE_COLOR" in process.env && process.env.FORCE_COLOR !== "0";
const noColor = !forceColor && "NO_COLOR" in process.env;
const useColor = forceColor || ((process.stdout.isTTY || process.stderr.isTTY) && !noColor);

export const c = {
  reset:  useColor ? "\x1b[0m"  : "",
  red:    useColor ? "\x1b[31m" : "",
  green:  useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
};

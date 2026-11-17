import { runHdcShim } from "./shim"

// A source-run entry that is independent of the CLI proxy and TUI/JSX configuration.
const args = process.argv.slice(2)
const hdcArgs = args[0] === "__hdc-shim" ? args.slice(args[1] === "--" ? 2 : 1) : args
process.exit(await runHdcShim(hdcArgs))

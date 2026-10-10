// Pure devecocli command-identity policy: which top-level commands and subcommands may be counted
// in `operations.devecoCliCommands`.
//
// This module deliberately imports nothing. It is the single source of truth for both sides of the
// CLI event channel: the proxy that writes events (`deveco-cli/router.ts`) and the shell tool that
// reads them back (`tool/shell.ts`). Keeping it dependency-free stops the reader from pulling in the
// vendor-CLI resolution machinery just to validate a command name.
//
// Policy: counted per execution, failures included.
//   * CLI_COMMANDS allowlists the command names the CLI exposes (from `node <vendor>/cli.js
//     --help`). Anything else in the top-level slot is a VALUE from an incomplete or invalid
//     invocation (`devecocli $PWD/app.ets`, `devecocli my-app`); recording it would push
//     user-controlled text into telemetry. Add a line when the CLI grows a command -- an unlisted
//     command is not counted, and that is the safe direction to fail.
//   * CLI_USAGE_TOKENS lists the usage/version tokens: they mark a call as "asked for help"
//     instead of an execution. Add a line to exclude more.
const CLI_COMMANDS = new Set([
  "build",
  "run",
  "update",
  "device",
  "emulator",
  "auth",
  "skills",
  "log",
  "create",
  "init",
  "serve",
  "docs",
  "ui",
  "check",
  "signature",
])

export const CLI_USAGE_TOKENS = new Set(["help", "-h", "--help", "-V", "-v", "--version"])

// Top-level command -> the subcommands it actually owns (taken from `devecocli <cmd> --help`;
// add a line here when the CLI grows one). Every unlisted command only ever records its top
// level: for leaf commands such as run/log/create/init, args[1] is a VALUE
// (`devecocli create MyApp`), so treating it as a subcommand would push user input into
// telemetry; unknown future commands degrade the same way.
const CLI_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  build: new Set(["clean"]),
  device: new Set(["list", "view", "file", "sqlite3"]),
  emulator: new Set([
    "image",
    "license",
    "shake",
    "power",
    "rotate",
    "volume",
    "fold",
    "battery",
    "geolocation",
    "scene",
    "sensor",
    "list",
    "start",
    "stop",
    "create",
    "delete",
  ]),
  auth: new Set(["login", "logout", "status", "team"]),
  skills: new Set(["list", "find", "add", "remove"]),
  serve: new Set(["mcp", "lsp"]),
  docs: new Set(["search", "read", "catalog"]),
  ui: new Set([
    "layout",
    "window",
    "screenshot",
    "click",
    "doubleclick",
    "longclick",
    "swipe",
    "fling",
    "drag",
    "dircfling",
    "text",
  ]),
  check: new Set(["compat", "lint", "arkts"]),
  signature: new Set(["generate"]),
  // `log` itself tails device logs; only `clear` is a subcommand (special-cased by the proxy).
  log: new Set(["clear"]),
}

// Resolves the leading two levels used for counting: "docs search ..." becomes
// { command: "docs", subcommand: "search" }. Returns undefined when the invocation is not an
// execution worth counting (empty argv, unknown/path-like top-level token, or a usage request).
export function resolveCliInvocation(args: string[]): { command: string; subcommand?: string } | undefined {
  const command = args[0]
  // The allowlist doubles as the shape check: an unknown token is a value, never a command name.
  if (!command || !CLI_COMMANDS.has(command)) return undefined
  // A help/version FLAG anywhere after the command, a bare `help` in the subcommand slot, or a
  // TRAILING bare `help` all mean the call asked for usage (`docs --help`, `docs help`,
  // `docs search --help`, `docs search help`): the CLI rewrites a trailing `help` into `--help`
  // (deveco-cli: `argv.length >= 2 && argv.at(-1) === "help"`). Only a non-trailing bare `help`
  // is a real value (`docs search help extra` searches for the keyword "help").
  if (args[1] !== undefined && CLI_USAGE_TOKENS.has(args[1])) return undefined
  if (args.slice(2).some((arg) => arg.startsWith("-") && CLI_USAGE_TOKENS.has(arg))) return undefined
  if (args.length >= 2 && args.at(-1) === "help") return undefined
  const owned = CLI_SUBCOMMANDS[command]
  if (!owned) return { command }
  const subcommand = findOwnedSubcommand(args, owned)
  return subcommand ? { command, subcommand } : { command }
}

// First argument that is one of the command's own subcommands. A token sitting directly after a
// flag without "=" is that flag's value (`build --product default clean` → "clean"), so it is
// skipped; anything the command does not own degrades to the top level.
function findOwnedSubcommand(args: string[], owned: ReadonlySet<string>): string | undefined {
  for (let index = 1; index < args.length; index += 1) {
    const previous = args[index - 1]
    if (previous?.startsWith("-") && !previous.includes("=")) continue
    const candidate = args[index]
    if (candidate !== undefined && owned.has(candidate)) return candidate
  }
  return undefined
}

// Contract of the devecocli CLI event channel, shared by its writer and its reader:
//   * writer: deveco-cli/router.ts appends one JSON line per intercepted invocation to the file
//     named by DEVECO_CLI_EVENT_FILE;
//   * reader: tool/shell.ts reads that file back and re-applies the counting policy.
//
// Kept dependency-free so the reader does not pull in the vendor-CLI resolution machinery just to
// handle the channel (the identity policy lives in ./commands for the same reason).
export type DevecoCliEvent = {
  command: string
  subcommand?: string
  exitCode: number
  durationMs: number
  projectRoot?: string
}

export const DEVECO_CLI_EVENT_FILE = "DEVECO_CODE_CLI_EVENT_FILE"

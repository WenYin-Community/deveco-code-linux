import { type ParseError, applyEdits, modify, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"

export interface JsoncPatchOptions {
  insertSpaces?: boolean
  tabSize?: number
}

/**
 * Patch a single value path in a JSONC text, preserving comments and formatting.
 * Returns the patched text, or the original if no edits were needed.
 */
export function patch(text: string, path: string[], value: unknown, options?: JsoncPatchOptions): string {
  const edits = modify(text, path, value, {
    formattingOptions: {
      insertSpaces: options?.insertSpaces ?? true,
      tabSize: options?.tabSize ?? 2,
    },
  })
  if (!edits.length) return text
  return applyEdits(text, edits)
}

export class JsoncValidationError extends Error {
  constructor(
    public readonly filepath: string,
    public readonly errors: ParseError[],
    text: string,
  ) {
    const issues = errors
      .map((e) => {
        const before = text.substring(0, e.offset).split("\n")
        const line = before.length
        const column = before[before.length - 1].length + 1
        return `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
      })
      .join("\n")
    super(`JSONC file at ${filepath} is not valid:\n${issues}`)
    this.name = "JsoncValidationError"
  }
}

/**
 * Validate that a text is parseable JSONC. Throws {@link JsoncValidationError} on failure.
 */
export function validate(text: string, filepath: string): void {
  const errors: ParseError[] = []
  parseJsonc(text, errors, { allowTrailingComma: true })
  if (!errors.length) return
  throw new JsoncValidationError(filepath, errors, text)
}

/** Parse JSONC text, returning `undefined` on parse error instead of throwing. */
export function parse(text: string): unknown {
  const errors: ParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length) return undefined
  return data
}

export * as Jsonc from "./jsonc"

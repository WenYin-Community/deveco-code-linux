export * as Memory from "./memory"

import path from "path"
import os from "os"
import fs from "fs/promises"
import { Hash } from "./util/hash"

export type MemoryType = "user" | "feedback" | "project" | "reference"

export interface MemoryHeader {
  name: string
  description: string
  type: MemoryType
  created?: number
  updated?: number
  filepath?: string
  mtime?: number
  pin?: boolean
  ttl?: number
}

export interface MemoryFrontmatter {
  name: string
  description: string
  type: MemoryType
  created?: number
  updated?: number
  pin?: boolean
  ttl?: number
}

export interface MemoryIndexEntry {
  name: string
  filename: string
  description: string
  type: MemoryType
}

export const ENTRYPOINT_NAME = "MEMORY.md"
export const MEMORY_DIR_NAME = "memory"
export const FRONTMATTER_MAX_LINES = 30

export function getGlobalDataDir(): string {
  return path.join(os.homedir(), ".deveco")
}

export function normalizeProjectPath(raw: string): string {
  if (raw === "default") return raw
  return path.resolve(raw).replace(/\\/g, "/")
}

export function slugifyProjectID(id: string): string {
  const hash = Hash.sha256(id).slice(0, 12)
  const safeName = id
    .replace(/[\\/:]/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64)
  return safeName + "_" + hash
}

export function computeLegacyHash(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/")
  const hash = Hash.sha256(normalized).slice(0, 12)
  const safeName = normalized
    .replace(/[\\/:]/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64)
  return safeName + "_" + hash
}

export function getEntrypointPath(memoryPath: string): string {
  return path.join(memoryPath, ENTRYPOINT_NAME)
}

export function memoryNameToFilename(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
  return sanitized + ".md"
}

function parseFrontmatterLine(line: string): { key: string; value: string | number | boolean } | null {
  const colonIndex = line.indexOf(":");
  if (colonIndex === -1) { return null }
  const key = line.slice(0, colonIndex).trim();
  const rawValue = line.slice(colonIndex + 1).trim();
  return { key, value: parseFrontmatterValue(rawValue) };
}

function buildParsedFrontmatter(
  parsed: Record<string, string | number | boolean>,
): MemoryFrontmatter | null {
  if (!parsed.name || !parsed.description || !parsed.type) { return null }
  return {
    name: parsed.name as string,
    description: parsed.description as string,
    type: parsed.type as MemoryType,
    created: parsed.created as number | undefined,
    updated: parsed.updated as number | undefined,
    pin: parsed.pin as boolean | undefined,
    ttl: parsed.ttl as number | undefined,
  };
}

export function parseFrontmatter(content: string): {
  frontmatter: MemoryFrontmatter | null
  body: string
} {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  if (!match) {
    return { frontmatter: null, body: content };
  }
  const [, frontmatterStr, body] = match;
  const parsed: Record<string, string | number | boolean> = {};
  for (const line of frontmatterStr.split('\n')) {
    const result = parseFrontmatterLine(line);
    if (result) { parsed[result.key] = result.value }
  }
  const frontmatter = buildParsedFrontmatter(parsed);
  if (!frontmatter) {
    return { frontmatter: null, body: content };
  }
  return { frontmatter, body };
}

export function escapeFrontmatterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function serializeFrontmatter(frontmatter: MemoryFrontmatter): string {
  const lines = ["---"];
  lines.push('name: "' + escapeFrontmatterValue(frontmatter.name) + '"');
  lines.push('description: "' + escapeFrontmatterValue(frontmatter.description) + '"');
  lines.push("type: " + frontmatter.type);
  if (frontmatter.created) {
    lines.push("created: " + frontmatter.created);
  }
  if (frontmatter.updated) {
    lines.push("updated: " + frontmatter.updated);
  }
  if (frontmatter.pin) {
    lines.push("pin: true");
  }
  if (frontmatter.ttl !== undefined) {
    lines.push("ttl: " + frontmatter.ttl);
  }
  lines.push("---");
  return lines.join("\n");
}

export function createMemoryContent(frontmatter: MemoryFrontmatter, body: string): string {
  return serializeFrontmatter(frontmatter) + "\n\n" + body.trim() + "\n";
}

export async function readFrontmatter(
  filepath: string,
  maxLines: number = FRONTMATTER_MAX_LINES,
): Promise<MemoryHeader | null> {
  try {
    const content = await fs.readFile(filepath, "utf-8");
    const lines = content.split("\n").slice(0, maxLines).join("\n");
    const { frontmatter } = parseFrontmatter(lines);

    if (!frontmatter) {
      return null;
    }

    const stats = await fs.stat(filepath);

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      type: frontmatter.type,
      created: frontmatter.created,
      updated: frontmatter.updated,
      filepath,
      mtime: frontmatter.updated ?? frontmatter.created ?? stats.mtimeMs,
      pin: frontmatter.pin,
      ttl: frontmatter.ttl,
    };
  } catch {
    return null;
  }
}

export function formatMemoryIndexEntry(header: MemoryHeader): string {
  return "- [" + header.name + "](" + path.basename(header.filepath || "") + ") " + header.description;
}

export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers
    .map((h) => {
      const type = h.type.toUpperCase();
      const time = h.mtime ? new Date(h.mtime).toISOString() : "unknown";
      return "- [" + type + "] " + h.name + " (" + time + "): " + h.description;
    })
    .join("\n");
}

const MEMORY_INDEX_HEADER_LINES = [
  "# Project Memory Index",
  "",
  "This file serves as an index to all project memories.",
  "Memories are automatically loaded when relevant to the current context.",
  "",
  "## Memory Types",
  "",
  "- **user**: User preferences, role, and working style",
  "- **feedback**: Behavioral guidance (do's and don'ts)",
  "- **project**: Project context, goals, and technical decisions",
  "- **reference**: External resources and documentation",
  "",
  "## Memories",
  "",
];

export function buildMemoryIndexContent(entries: MemoryIndexEntry[]): string {
  const lines = [...MEMORY_INDEX_HEADER_LINES];
  for (const entry of entries) {
    lines.push(
      formatMemoryIndexEntry({
        name: entry.name,
        description: entry.description,
        type: entry.type,
        filepath: entry.filename,
      }),
    );
  }
  return lines.join("\n");
}

export function truncateMemoryIndexContent(content: string, maxLines: number, maxBytes: number): string {
  const contentLines = content.split("\n");
  let truncated = contentLines.length > maxLines ? contentLines.slice(0, maxLines).join("\n") : content;
  if (Buffer.byteLength(truncated, "utf-8") > maxBytes) {
    const kept: string[] = [];
    let totalBytes = 0;
    for (const line of truncated.split("\n")) {
      const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
      if (totalBytes + lineBytes > maxBytes) break;
      kept.push(line);
      totalBytes += lineBytes;
    }
    truncated = kept.join("\n");
  }
  return truncated;
}

export function isMemoryFile(filepath: string): boolean {
  const basename = path.basename(filepath);
  return basename.endsWith(".md") && basename !== ENTRYPOINT_NAME && !basename.startsWith(".");
}

function parseFrontmatterValue(rawValue: string): string | number | boolean {
  let value: string | number | boolean = rawValue;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = (value as string).slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (/^-?\d+(\.\d+)?$/.test(value as string)) {
    value = Number(value);
  }
  if (value === "true" || value === "True") { return true }
  if (value === "false" || value === "False") { return false }
  return value;
}

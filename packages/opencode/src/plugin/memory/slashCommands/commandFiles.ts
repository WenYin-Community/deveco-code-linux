import fs from 'fs'
import path from 'path'
import { Global } from '@opencode-ai/core/global'

// Commands that remain visible in the palette. Everything else is retired
// from the palette but stays executable via the plugin's internal dispatch.
const BUILTIN_COMMANDS = [
  {
    name: 'dream-force',
    description: 'Force memory consolidation (bypass thresholds)',
    content: 'Please call the dream-trigger tool with force=true to bypass thresholds and run memory consolidation immediately. Do not explain, just call the tool.',
  },
  {
    name: 'auto-skill',
    description: 'Trigger skill review agent',
    content: 'Please analyze the conversation for potential skill creation opportunities. Look for repeated patterns, workflows, or problem-solving approaches worth capturing as reusable skills. Do not explain, just create skills if found.',
  },
];

// Legacy commands no longer shown. Kept verbatim so previously generated
// files can be matched exactly and cleaned up; user-modified copies are kept.
const RETIRED_COMMANDS = [
  {
    name: 'dream',
    description: 'Trigger memory consolidation (Auto Dream)',
    content: 'Please call the dream-trigger tool to run memory consolidation. Merges, deduplicates, and cleans up memory files and skills. Do not explain, just call the tool.',
  },
  {
    name: 'dream-approve',
    description: 'Approve pending memory expiry deletions',
    content: 'Please call the dream-approve tool to confirm deletion of expired memories. Do not explain, just call the tool.',
  },
  {
    name: 'dream-reject',
    description: 'Reject pending memory expiry deletions (keep all memories)',
    content: 'Please call the dream-reject tool to cancel pending expiry deletions and keep all memories. Do not explain, just call the tool.',
  },
];

function renderCommandFile(cmd: { description: string; content: string }): string {
  return `---\ndescription: ${cmd.description}\n---\n\n${cmd.content}\n`;
}

function createCommandFiles(commandsDir: string): void {
  try {
    if (!fs.existsSync(commandsDir)) {
      fs.mkdirSync(commandsDir, { recursive: true });
    }
    for (const cmd of BUILTIN_COMMANDS) {
      const filePath = path.join(commandsDir, `${cmd.name}.md`);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, renderCommandFile(cmd), 'utf-8');
      }
    }
  } catch (e) {
    console.error('[memory-plugins] createCommandFiles error:', e);
  }
}

function cleanupRetiredCommandFiles(commandsDir: string): void {
  try {
    for (const cmd of RETIRED_COMMANDS) {
      const filePath = path.join(commandsDir, `${cmd.name}.md`);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content === renderCommandFile(cmd)) {
        fs.unlinkSync(filePath);
      } else {
        console.error('[memory-plugins] keeping user-modified command file:', filePath);
      }
    }
  } catch (e) {
    console.error('[memory-plugins] cleanupRetiredCommandFiles error:', e);
  }
}

// The app discovers commands by globbing {command,commands}/**/*.md under
// Global.Path.config (ConfigPaths.directories always lists it first), so
// writes and cleanup must target the same directory. Going through Global
// also follows DEVECO_STORAGE_ROOT instead of hardcoding
// XDG_CONFIG_HOME || ~/.config (and drops the Windows APPDATA branch that
// never matched xdg-basedir).
function getGlobalConfigPaths(): string[] {
  return [path.join(Global.Path.config, 'commands')]
}

export {
  BUILTIN_COMMANDS,
  RETIRED_COMMANDS,
  renderCommandFile,
  createCommandFiles,
  cleanupRetiredCommandFiles,
  getGlobalConfigPaths,
};

// Clean up retired command files, then create the visible ones in global
// config directories (user-level, runs at module load). Cleanup is idempotent
// and runs every startup, so files recreated by an older binary are re-removed.
for (const globalPath of getGlobalConfigPaths()) {
  cleanupRetiredCommandFiles(globalPath);
  createCommandFiles(globalPath);
}

import fs from 'fs'
import path from 'path'
import os from 'os'

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

function getGlobalConfigPaths(): string[] {
  const home = os.homedir();
  const paths: string[] = [];

  // Create commands for both deveco and opencode CLIs
  const cliNames = ['deveco', 'opencode'];

  // Windows: use APPDATA (matches xdg-basedir behavior)
  // Linux/Mac: use XDG_CONFIG_HOME or ~/.config
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const cli of cliNames) {
      paths.push(path.join(appdata, cli, 'commands'));
    }
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const cli of cliNames) {
      paths.push(path.join(xdgConfig, cli, 'commands'));
    }
  }

  // Also create in legacy ~/.config/<cli> for backward compatibility on Windows
  if (process.platform === 'win32') {
    for (const cli of cliNames) {
      paths.push(path.join(home, '.config', cli, 'commands'));
    }
  }

  return paths;
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

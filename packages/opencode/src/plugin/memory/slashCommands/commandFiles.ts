import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BUILTIN_COMMANDS = [
  {
    name: 'dream',
    description: 'Trigger memory consolidation (Auto Dream)',
    content: 'Please call the dream-trigger tool to run memory consolidation. Merges, deduplicates, and cleans up memory files and skills. Do not explain, just call the tool.',
  },
  {
    name: 'dream-force',
    description: 'Force memory consolidation (bypass thresholds)',
    content: 'Please call the dream-trigger tool with force=true to bypass thresholds and run memory consolidation immediately. Do not explain, just call the tool.',
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
  {
    name: 'auto-skill',
    description: 'Trigger skill review agent',
    content: 'Please analyze the conversation for potential skill creation opportunities. Look for repeated patterns, workflows, or problem-solving approaches worth capturing as reusable skills. Do not explain, just create skills if found.',
  },
];

function createCommandFiles(commandsDir: string): void {
  try {
    if (!fs.existsSync(commandsDir)) {
      fs.mkdirSync(commandsDir, { recursive: true });
    }
    for (const cmd of BUILTIN_COMMANDS) {
      const filePath = path.join(commandsDir, `${cmd.name}.md`);
      if (!fs.existsSync(filePath)) {
        const mdContent = `---\ndescription: ${cmd.description}\n---\n\n${cmd.content}\n`;
        fs.writeFileSync(filePath, mdContent, 'utf-8');
      }
    }
  } catch (e) {
    console.error('[memory-plugins] createCommandFiles error:', e);
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

// Create command files in global config directories (user-level, runs at module load)
for (const globalPath of getGlobalConfigPaths()) {
  createCommandFiles(globalPath);
}
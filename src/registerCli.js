import { registerSlashCommands } from './registerCommands.js';

const token = process.env.DISCORD_TOKEN ?? '';
if (!token) {
  console.error('Missing DISCORD_TOKEN');
  process.exit(1);
}

await registerSlashCommands(token);
console.log('Slash commands registered.');

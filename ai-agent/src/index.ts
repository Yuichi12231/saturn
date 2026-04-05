import { startAgentSchedule, stopAgentSchedule } from './agent';

const intervalMinutes = Number(process.env.AGENT_INTERVAL_MINUTES || 1);
const vaultOwner = process.env.VAULT_OWNER || '';

async function main() {
  if (!vaultOwner) {
    throw new Error('VAULT_OWNER is required for run-once mode.');
  }

  console.log('Running AI agent one time for vault owner:', vaultOwner);
  const status = await startAgentSchedule(intervalMinutes, vaultOwner);
  const result = status.lastAction;
  stopAgentSchedule();
  console.log('Agent run result:', result);
}

main().catch((error) => {
  console.error('Agent failed:', error);
  process.exit(1);
});

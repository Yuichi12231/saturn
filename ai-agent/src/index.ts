import { runAgentOnce } from './agent';

const intervalMinutes = Number(process.env.AGENT_INTERVAL_MINUTES || 1);

async function main() {
  console.log('Running AI agent one time with interval:', intervalMinutes);
  const result = await runAgentOnce();
  console.log('Agent run result:', result);
}

main().catch((error) => {
  console.error('Agent failed:', error);
  process.exit(1);
});

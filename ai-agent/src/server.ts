import cors from 'cors';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import { getAgentState, runAgentOnce, startAgentSchedule, stopAgentSchedule } from './agent';

dotenv.config();

const app = express();
const port = Number(process.env.AGENT_PORT || 3001);

app.use(cors());
app.use(express.json());

app.get('/api/agent/status', (req: Request, res: Response) => {
  res.json(getAgentState());
});

app.post('/api/agent/start', async (req: Request, res: Response) => {
  const { intervalMinutes } = req.body ?? {};
  const interval = typeof intervalMinutes === 'number' && intervalMinutes > 0 ? intervalMinutes : 1;

  try {
    const status = await startAgentSchedule(interval);
    res.json(status);
  } catch (error) {
    console.error('Failed to start agent:', (error as any).message || error);
    res.status(500).json({ error: 'Failed to start agent' });
  }
});

app.post('/api/agent/stop', (req: Request, res: Response) => {
  const status = stopAgentSchedule();
  res.json(status);
});

app.post('/api/agent/trigger', async (req: Request, res: Response) => {
  try {
    const result = await runAgentOnce();
    res.json({ ...getAgentState(), trigger: result });
  } catch (error) {
    console.error('Trigger failed:', (error as any).message || error);
    res.status(500).json({ error: 'Agent trigger failed' });
  }
});

app.listen(port, () => {
  console.log(`AI agent backend listening on http://localhost:${port}`);
});

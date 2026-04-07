import cors from 'cors';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import path from 'path';
import { clearTradeHistory, deleteTradeRecord, getAgentHealth, getAgentState, getTradeHistory, runAgentOnce, startAgentSchedule, stopAgentSchedule } from './agent';
import { getLabCandleSeries, getLabSnapshot, simulateLabSwap } from './marketLab';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || process.env.AGENT_PORT || 3001);

app.use(cors());
app.use(express.json());

// API routes
app.get('/api/agent/status', (req: Request, res: Response) => {
  res.json(getAgentState());
});

app.get('/api/agent/trades', (req: Request, res: Response) => {
  res.json({ trades: getTradeHistory() });
});

app.delete('/api/agent/trades/all', (req: Request, res: Response) => {
  clearTradeHistory();
  res.json({ ok: true, message: 'Trade history cleared' });
});

app.delete('/api/agent/trades/:index', (req: Request, res: Response) => {
  const index = parseInt(req.params.index, 10);
  if (Number.isNaN(index)) {
    res.status(400).json({ error: 'Invalid index' });
    return;
  }
  const deleted = deleteTradeRecord(index);
  if (!deleted) {
    res.status(404).json({ error: `Trade at index ${index} not found` });
    return;
  }
  res.json({ ok: true, trades: getTradeHistory() });
});

app.get('/api/agent/health', async (req: Request, res: Response) => {
  try {
    const health = await getAgentHealth();
    res.json(health);
  } catch (error) {
    const message = (error as any)?.message || 'Failed to collect health information';
    res.status(500).json({ ok: false, error: message });
  }
});

app.post('/api/agent/start', async (req: Request, res: Response) => {
  const { intervalMinutes, vaultOwner } = req.body ?? {};
  const interval = typeof intervalMinutes === 'number' && intervalMinutes > 0 ? intervalMinutes : 1;

  if (typeof vaultOwner !== 'string' || !vaultOwner.trim()) {
    res.status(400).json({ error: 'vaultOwner is required' });
    return;
  }

  try {
    const status = await startAgentSchedule(interval, vaultOwner);
    res.json(status);
  } catch (error) {
    const message = (error as any)?.message || 'Failed to start agent';
    console.error('Failed to start agent:', message);
    res.status(500).json({ error: message });
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

app.get('/api/lab/snapshot', async (req: Request, res: Response) => {
  res.json(await getLabSnapshot());
});

app.get('/api/lab/candles/:symbol', async (req: Request, res: Response) => {
  const symbol = String(req.params.symbol || '').trim().toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const limit = Number(req.query.limit || 120);
  res.json(await getLabCandleSeries(symbol, Number.isFinite(limit) ? limit : 120));
});

app.post('/api/lab/swap', async (req: Request, res: Response) => {
  const { symbolIn, symbolOut, amountIn } = req.body ?? {};
  const result = await simulateLabSwap(String(symbolIn || ''), String(symbolOut || ''), Number(amountIn || 0));
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

// Serve static frontend files
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

// SPA fallback: serve index.html for non-API routes
app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, 'index.html'), (err) => {
    if (err) {
      res.status(404).json({ error: 'Not found' });
    }
  });
});

app.listen(port, () => {
  const state = getAgentState();
  console.log(`[SERVER] AI agent backend listening on http://localhost:${port}`);
  console.log(`[SERVER] Agent status: ${state.message}`);
});

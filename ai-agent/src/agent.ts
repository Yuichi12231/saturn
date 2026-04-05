import axios from 'axios';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import * as anchor from '@project-serum/anchor';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';

dotenv.config();

const PROGRAM_ID = new PublicKey('csiotTu5ChbPzzjnpbNyWkfAQmyRNqTvLw362xUkn8y');
const NETWORK = 'devnet';
const ENDPOINT = (
  process.env.SOLANA_RPC_URL
  || process.env.ALCHEMY_RPC_URL
  || 'https://solana-devnet.g.alchemy.com/v2/e2AbESRWvSs_pNNi7nal8'
).trim();
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3-32b:free';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || process.env.APP_BASE_URL || 'https://saturn.local';
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'Saturn Vault AI';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;
const SECRET_KEY = process.env.AGENT_WALLET_SECRET_KEY;

if (!SECRET_KEY) {
  throw new Error('AGENT_WALLET_SECRET_KEY is required in .env');
}

function parseSecretKey(secret: string): Uint8Array {
  const cleaned = secret.trim();
  const arrayValues = cleaned.split(',').map((value) => value.trim()).filter(Boolean).map(Number);
  if (arrayValues.length === 64 && arrayValues.every((value) => !Number.isNaN(value))) {
    return Uint8Array.from(arrayValues);
  }

  try {
    return bs58.decode(cleaned);
  } catch (error) {
    throw new Error('AGENT_WALLET_SECRET_KEY must be a 64-byte array or base58-encoded secret key.');
  }
}

const keypair = anchor.web3.Keypair.fromSecretKey(parseSecretKey(SECRET_KEY));
const connection = new Connection(ENDPOINT, 'processed');

const idl = {
  version: '0.1.0',
  name: 'vault_ai',
  instructions: [
    {
      name: 'initializeVault',
      accounts: [
        { name: 'vault', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: 'setAgentAuthority',
      accounts: [
        { name: 'vault', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
      ],
      args: [
        { name: 'agentAuthority', type: 'publicKey' },
      ],
    },
    {
      name: 'executeTrade',
      accounts: [
        { name: 'vault', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
      ],
      args: [
        { name: 'mint', type: 'publicKey' },
        { name: 'amount', type: 'u64' },
        { name: 'buy', type: 'bool' },
        { name: 'newRiskScore', type: 'u8' },
      ],
    },
  ],
};

const program = new anchor.Program(idl as anchor.Idl, PROGRAM_ID, new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), { preflightCommitment: 'processed' }));

const MIN_LAMPORTS_FOR_TX = 1_000_000;

const ensureAgentHasFunds = async () => {
  const balance = await connection.getBalance(keypair.publicKey);
  if (balance < MIN_LAMPORTS_FOR_TX) {
    const addr = keypair.publicKey.toBase58();
    throw new Error(
      `Agent wallet ${addr} has low balance (${(balance / 1e9).toFixed(6)} SOL). ` +
      `Airdrop on devnet: solana airdrop 2 ${addr} --url devnet`,
    );
  }
};

const deriveVaultPda = async (owner: PublicKey) => {
  const [vaultPda] = await PublicKey.findProgramAddress(
    [Buffer.from('vault'), owner.toBuffer()],
    PROGRAM_ID,
  );

  return vaultPda;
};

const ensureVaultExists = async (owner: PublicKey) => {
  const vaultPda = await deriveVaultPda(owner);
  const vaultAccount = await connection.getAccountInfo(vaultPda);
  if (!vaultAccount) {
    throw new Error(
      `Vault not found for owner ${owner.toBase58()}. ` +
      'Connect that wallet in UI and run Create Vault first.',
    );
  }

  return vaultPda;
};

const getMarketData = async () => {
  const emptyMarket = {
    solana: { usd: 0, usd_24hr_change: 0 },
    raydium: { usd: 0, usd_24hr_change: 0 },
    orca: { usd: 0, usd_24hr_change: 0 },
  };

  const parseCoingecko = (data: any) => ({
    solana: {
      usd: Number(data?.solana?.usd ?? 0),
      usd_24hr_change: Number(data?.solana?.usd_24hr_change ?? 0),
    },
    raydium: {
      usd: Number(data?.raydium?.usd ?? 0),
      usd_24hr_change: Number(data?.raydium?.usd_24hr_change ?? 0),
    },
    orca: {
      usd: Number(data?.orca?.usd ?? 0),
      usd_24hr_change: Number(data?.orca?.usd_24hr_change ?? 0),
    },
  });

  const parseJupiter = (data: any) => ({
    solana: {
      usd: Number(data?.data?.SOL?.price ?? 0),
      usd_24hr_change: 0,
    },
    raydium: {
      usd: Number(data?.data?.RAY?.price ?? 0),
      usd_24hr_change: 0,
    },
    orca: {
      usd: Number(data?.data?.ORCA?.price ?? 0),
      usd_24hr_change: 0,
    },
  });

  const hasAnyPrice = (market: any) => [market?.solana?.usd, market?.raydium?.usd, market?.orca?.usd]
    .some((value) => Number.isFinite(value) && Number(value) > 0);

  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana,raydium,orca&vs_currencies=usd&include_24hr_change=true',
      { timeout: 12000 },
    );
    const parsed = parseCoingecko(response.data);
    if (!hasAnyPrice(parsed)) {
      throw new Error('CoinGecko returned no valid prices');
    }
    marketDataError = null;
    cachedMarketSnapshot = parsed;
    return parsed;
  } catch (error) {
    try {
      const response = await axios.get('https://price.jup.ag/v6/price?ids=SOL,RAY,ORCA', { timeout: 12000 });
      const parsed = parseJupiter(response.data);
      if (!hasAnyPrice(parsed)) {
        throw new Error('Jupiter returned no valid prices');
      }
      marketDataError = 'Primary market feed unavailable (CoinGecko). Using Jupiter fallback.';
      cachedMarketSnapshot = parsed;
      return parsed;
    } catch (fallbackError) {
      marketDataError = formatProviderError('MarketData', fallbackError);
      if (hasAnyPrice(cachedMarketSnapshot)) {
        return cachedMarketSnapshot;
      }
      return emptyMarket;
    }
  }
};

const formatProviderError = (provider: string, error: unknown): string => {
  const axiosError = error as any;
  const status = axiosError?.response?.status;
  const data = axiosError?.response?.data;

  if (provider === 'BirdEye' && status === 521) {
    return 'BirdEye service unavailable (HTTP 521). The provider host is temporarily down.';
  }

  let message = '';
  if (typeof data?.error?.message === 'string') {
    message = data.error.message;
  } else if (typeof data?.error === 'string') {
    message = data.error;
  } else if (typeof data?.message === 'string') {
    message = data.message;
  } else if (typeof data === 'string') {
    message = data;
  } else if (data && typeof data === 'object') {
    message = JSON.stringify(data);
  } else if (typeof axiosError?.message === 'string') {
    message = axiosError.message;
  } else {
    message = `${provider} request failed`;
  }

  const compact = message
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const short = compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
  return status ? `${provider} HTTP ${status}: ${short}` : `${provider}: ${short}`;
};

const getHeliusSignals = async () => {
  if (!HELIUS_API_KEY) {
    heliusError = 'HELIUS_API_KEY is not configured';
    return null;
  }

  try {
    const url = 'https://api.helius.xyz/v0/addresses/transactions';
    const response = await axios.post(
      url,
      {
        addresses: [keypair.publicKey.toBase58()],
        limit: 5,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': HELIUS_API_KEY,
        },
        timeout: 15000,
      },
    );
    heliusError = null;
    return response.data;
  } catch (error) {
    const axiosError = error as any;
    heliusError = formatProviderError('Helius', error);
    console.warn('Helius API request failed:', axiosError.response?.status, axiosError.response?.data || axiosError.message);
    return null;
  }
};

const getBirdEyeMarket = async () => {
  if (!BIRDEYE_API_KEY) {
    birdeyeError = 'BIRDEYE_API_KEY is not configured';
    return null;
  }

  try {
    const response = await axios.get('https://api.birdeye.so/v1/market/overview', {
      headers: {
        Authorization: `Bearer ${BIRDEYE_API_KEY}`,
      },
      timeout: 15000,
    });
    birdeyeError = null;
    return response.data;
  } catch (error) {
    const axiosError = error as any;
    birdeyeError = formatProviderError('BirdEye', error);
    console.warn('BirdEye API request failed:', axiosError.response?.status, axiosError.response?.data || axiosError.message);
    return null;
  }
};

const askLlm = async (prompt: string) => {
  if (!OPENROUTER_API_KEY) {
    openRouterError = 'OPENROUTER_API_KEY is not configured';
    return { action: 'hold', reason: 'OpenRouter API key is not configured.' };
  }

  try {
    const response = await axios.post(
      OPENROUTER_BASE_URL,
      {
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are an AI asset manager for a Solana Vault. Analyze market data, on-chain signals, and risk. Respond with JSON only.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 220,
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': OPENROUTER_SITE_URL,
          'X-Title': OPENROUTER_APP_NAME,
        },
        timeout: 20000,
      },
    );

    const text = response.data?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('OpenRouter did not return a response.');
    }

    openRouterError = null;

    try {
      return JSON.parse(text.replace(/\n/g, ' ').trim());
    } catch (error) {
      return { text };
    }
  } catch (error) {
    const axiosError = error as any;
    openRouterError = formatProviderError('OpenRouter', error);
    console.warn('OpenRouter request failed:', axiosError.response?.status, axiosError.response?.data || axiosError.message);
    return { action: 'hold', reason: 'OpenRouter request failed.' };
  }
};

const buildPrompt = (market: any, heliusSignals: any, birdeyeMarket: any) => {
  return `Market summary: ${JSON.stringify(market)}\nOn-chain signals: ${JSON.stringify(
    heliusSignals,
  )}\nBirdEye market data: ${JSON.stringify(birdeyeMarket)}\nChoose one action: buy, sell, or hold. If buy or sell, select a Solana SPL token from RAY, ORCA, or SOL and return a JSON object with keys action, symbol, amount, riskScore, and reason.`;
};

const symbolToMint: Record<string, string> = {
  RAY: '4k3Dyjzvzp8eB5Vq7hvh8BUkQ9dFJz2AxKTeoBZGPi7u',
  ORCA: 'orca7wuirT1o1sPo2Ng76gGgneJzmoGWaa6D4wvkPsi',
  SOL: 'So11111111111111111111111111111111111111112',
};

type TradingStrategy = 'auto' | 'llm' | 'rule';

interface Decision {
  action: 'buy' | 'sell' | 'hold';
  symbol: 'SOL' | 'RAY' | 'ORCA';
  amount: number;
  riskScore: number;
  reason: string;
  source: 'llm' | 'rule';
}

interface TradeRecord {
  ts: string;
  action: 'buy' | 'sell' | 'hold' | 'error';
  symbol: string;
  amount: number;
  riskScore: number;
  source: 'llm' | 'rule' | 'system';
  reason: string;
  tx?: string;
  status: 'planned' | 'executed' | 'failed' | 'skipped';
}

let scheduledAgent: ReturnType<typeof setInterval> | null = null;
let currentIntervalMinutes = 1;
let lastAction = 'Agent has not run yet.';
let lastMessage = 'Ready to run.';
let running = false;
let currentVaultOwner: PublicKey | null = null;
let lastError: string | null = null;
let openRouterError: string | null = null;
let heliusError: string | null = null;
let birdeyeError: string | null = null;
let marketDataError: string | null = null;
let strategy: TradingStrategy = 'auto';
const tradeHistory: TradeRecord[] = [];
let cachedMarketSnapshot: any = {
  solana: { usd: 0, usd_24hr_change: 0 },
  raydium: { usd: 0, usd_24hr_change: 0 },
  orca: { usd: 0, usd_24hr_change: 0 },
};

const pushTradeRecord = (record: TradeRecord) => {
  tradeHistory.unshift(record);
  if (tradeHistory.length > 100) {
    tradeHistory.length = 100;
  }
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const decideWithRules = (market: any): Decision => {
  const entries = [
    { symbol: 'SOL' as const, change: Number(market?.solana?.usd_24hr_change ?? 0) },
    { symbol: 'RAY' as const, change: Number(market?.raydium?.usd_24hr_change ?? 0) },
    { symbol: 'ORCA' as const, change: Number(market?.orca?.usd_24hr_change ?? 0) },
  ];

  const valid = entries.filter((entry) => Number.isFinite(entry.change));
  if (valid.length === 0) {
    return {
      action: 'hold',
      symbol: 'SOL',
      amount: 0,
      riskScore: 50,
      reason: 'No valid market change data available.',
      source: 'rule',
    };
  }

  const best = [...valid].sort((a, b) => b.change - a.change)[0];
  const worst = [...valid].sort((a, b) => a.change - b.change)[0];

  if (best.change >= 1.0) {
    return {
      action: 'buy',
      symbol: best.symbol,
      amount: clamp(Math.round(best.change), 1, 10),
      riskScore: clamp(Math.round(52 + best.change * 4), 40, 85),
      reason: `Rule momentum buy: ${best.symbol} 24h change ${best.change.toFixed(2)}% is strongest.`,
      source: 'rule',
    };
  }

  if (worst.change <= -2.0) {
    return {
      action: 'sell',
      symbol: worst.symbol,
      amount: clamp(Math.round(Math.abs(worst.change)), 1, 10),
      riskScore: clamp(Math.round(60 + Math.abs(worst.change) * 3), 45, 90),
      reason: `Rule risk-reduction sell: ${worst.symbol} dropped ${worst.change.toFixed(2)}% in 24h.`,
      source: 'rule',
    };
  }

  return {
    action: 'hold',
    symbol: 'SOL',
    amount: 0,
    riskScore: 50,
    reason: 'Rule engine: no strong edge, staying in hold.',
    source: 'rule',
  };
};

const decideWithLlm = async (market: any, heliusSignals: any, birdeyeMarket: any): Promise<Decision | null> => {
  const prompt = buildPrompt(market, heliusSignals, birdeyeMarket);
  const decision = await askLlm(prompt);

  const action = typeof decision.action === 'string' && ['buy', 'sell', 'hold'].includes(decision.action.toLowerCase())
    ? decision.action.toLowerCase() as 'buy' | 'sell' | 'hold'
    : 'hold';
  const symbol = typeof decision.symbol === 'string' ? decision.symbol.toUpperCase() : 'SOL';
  if (!['SOL', 'RAY', 'ORCA'].includes(symbol)) {
    return null;
  }

  const amount = clamp(Number(decision.amount) || 1, 0, 10);
  const riskScore = clamp(Number(decision.riskScore) || 50, 1, 99);
  const reason = String(decision.reason || 'No reason provided.');

  if (!Number.isFinite(amount) || !Number.isFinite(riskScore)) {
    return null;
  }

  return {
    action,
    symbol: symbol as 'SOL' | 'RAY' | 'ORCA',
    amount,
    riskScore,
    reason,
    source: 'llm',
  };
};

export const getAgentState = () => ({
  running,
  intervalMinutes: currentIntervalMinutes,
  strategy,
  lastAction,
  message: lastMessage,
  lastError,
  agentPublicKey: keypair.publicKey.toBase58(),
  vaultOwner: currentVaultOwner?.toBase58() || null,
  tradeHistory: tradeHistory.slice(0, 20),
});

export const getTradeHistory = () => tradeHistory.slice(0, 50);

export const getAgentHealth = async () => {
  const balanceLamports = await connection.getBalance(keypair.publicKey);

  const openrouterStatus = !OPENROUTER_API_KEY ? 'not_configured' : openRouterError ? 'error' : 'configured';
  const heliusStatus = !HELIUS_API_KEY ? 'not_configured' : heliusError ? 'error' : 'configured';
  const birdeyeStatus = !BIRDEYE_API_KEY ? 'not_configured' : birdeyeError ? 'error' : 'configured';

  return {
    ok: true,
    programId: PROGRAM_ID.toBase58(),
    rpcEndpoint: ENDPOINT,
    agentPublicKey: keypair.publicKey.toBase58(),
    agentBalanceSol: balanceLamports / 1e9,
    env: {
      openrouterConfigured: Boolean(OPENROUTER_API_KEY),
      openrouterModel: OPENROUTER_MODEL,
      heliusConfigured: Boolean(HELIUS_API_KEY),
      birdeyeConfigured: Boolean(BIRDEYE_API_KEY),
      walletConfigured: Boolean(SECRET_KEY),
    },
    checks: {
      openrouter: openrouterStatus,
      helius: heliusStatus,
      birdeye: birdeyeStatus,
      marketData: marketDataError ? 'fallback_or_error' : 'configured',
    },
    errors: {
      openrouter: openRouterError,
      helius: heliusError,
      birdeye: birdeyeError,
      marketData: marketDataError,
    },
    lastError,
  };
};

export const runAgentOnce = async () => {
  if (!currentVaultOwner) {
    throw new Error('Vault owner is not set. Start the agent from UI with a connected wallet first.');
  }

  await ensureAgentHasFunds();
  const vaultPda = await ensureVaultExists(currentVaultOwner);
  lastError = null;

  const market = await getMarketData();
  const heliusSignals = await getHeliusSignals();
  const birdeyeMarket = await getBirdEyeMarket();

  let chosen: Decision | null = null;
  if (strategy === 'llm' || strategy === 'auto') {
    chosen = await decideWithLlm(market, heliusSignals, birdeyeMarket);
  }
  if (!chosen || strategy === 'rule') {
    chosen = decideWithRules(market);
  }

  const action = chosen.action;
  const symbol = chosen.symbol;
  const amountValue = chosen.amount;
  const newRiskScore = chosen.riskScore;
  const reason = chosen.reason;

  let mint = new PublicKey(symbolToMint.SOL);
  if (symbolToMint[symbol]) {
    mint = new PublicKey(symbolToMint[symbol]);
  }

  let message = `AI decision (${chosen.source}): ${action.toUpperCase()} ${symbol} amount ${amountValue} risk ${newRiskScore}. Reason: ${reason}`;
  lastAction = message;
  lastMessage = `Market snapshot available, AI decision prepared.`;

  pushTradeRecord({
    ts: new Date().toISOString(),
    action,
    symbol,
    amount: amountValue,
    riskScore: newRiskScore,
    source: chosen.source,
    reason,
    status: action === 'hold' ? 'skipped' : 'planned',
  });

  if (action === 'hold') {
    return { action, message };
  }

  try {
    const tx = await program.rpc.executeTrade(
      mint,
      new anchor.BN(amountValue),
      action === 'buy',
      newRiskScore,
      {
        accounts: {
          vault: vaultPda,
          authority: keypair.publicKey,
        },
      },
    );

    lastMessage = `${message} Transaction: ${tx}`;
    pushTradeRecord({
      ts: new Date().toISOString(),
      action,
      symbol,
      amount: amountValue,
      riskScore: newRiskScore,
      source: chosen.source,
      reason,
      tx,
      status: 'executed',
    });
    return { action, message, tx };
  } catch (error) {
    const errorMessage = (error as any)?.message || 'Transaction failed';
    lastMessage = `Failed to execute trade: ${errorMessage}`;
    console.error('Trade execution failed:', errorMessage);
    pushTradeRecord({
      ts: new Date().toISOString(),
      action: 'error',
      symbol,
      amount: amountValue,
      riskScore: newRiskScore,
      source: chosen.source,
      reason: errorMessage,
      status: 'failed',
    });
    return { action: 'error', message: errorMessage };
  }
};

export const startAgentSchedule = async (intervalMinutes: number, vaultOwner: string, requestedStrategy: TradingStrategy = 'auto') => {
  if (scheduledAgent) {
    clearInterval(scheduledAgent);
  }

  let owner: PublicKey;
  try {
    owner = new PublicKey(vaultOwner);
  } catch {
    throw new Error('Invalid vaultOwner public key');
  }

  currentVaultOwner = owner;
  strategy = requestedStrategy;
  currentIntervalMinutes = intervalMinutes;
  running = true;
  lastMessage = `Agent scheduled every ${intervalMinutes} minute(s) for vault owner ${owner.toBase58()} (strategy: ${strategy}).`;
  try {
    await runAgentOnce();
  } catch (error) {
    const message = (error as any)?.message || 'Initial run failed';
    lastError = message;
    lastMessage = `Agent started, but initial run failed: ${message}`;
  }
  scheduledAgent = setInterval(async () => {
    try {
      await runAgentOnce();
    } catch (error) {
      lastError = (error as any)?.message || 'Scheduled run failed';
      console.warn('Scheduled agent execution failed:', error);
    }
  }, intervalMinutes * 60 * 1000);
  return getAgentState();
};

export const stopAgentSchedule = () => {
  if (scheduledAgent) {
    clearInterval(scheduledAgent);
    scheduledAgent = null;
  }
  running = false;
  lastMessage = 'Agent stopped.';
  return getAgentState();
};

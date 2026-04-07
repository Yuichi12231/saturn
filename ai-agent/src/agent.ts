import { OpenRouter } from '@openrouter/sdk';
import axios from 'axios';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import * as anchor from '@project-serum/anchor';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';

dotenv.config();

const PROGRAM_ID = new PublicKey('csiotTu5ChbPzzjnpbNyWkfAQmyRNqTvLw362xUkn8y');
const NETWORK = 'devnet';
const ENDPOINT = (
  process.env.SOLANA_RPC_URL
  || process.env.ALCHEMY_RPC_URL
  || 'https://solana-devnet.g.alchemy.com/v2/e2AbESRWvSs_pNNi7nal8'
).trim();
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3.6-plus:free';
const AGENT_DEMO_MODE = String(process.env.AGENT_DEMO_MODE || '').toLowerCase() === 'true' || process.env.AGENT_DEMO_MODE === '1';

const getOpenRouterKeySource = (): string | null => {
  if (process.env.OPENROUTER_API_KEY?.trim()) return 'OPENROUTER_API_KEY';
  if (process.env.OPENROUTER_API_TOKEN?.trim()) return 'OPENROUTER_API_TOKEN';
  if (process.env.OPENROUTER_KEY?.trim()) return 'OPENROUTER_KEY';
  return null;
};

const getOpenRouterApiKey = (): string => {
  const source = getOpenRouterKeySource();
  if (!source) return '';
  return String(process.env[source] || '').trim();
};

// Jupiter v6 API (mainnet; gracefully skipped with paper-trade fallback on devnet)
const JUPITER_API = 'https://quote-api.jup.ag/v6';
// Mainnet mint addresses for Jupiter routes
const JUPITER_MINTS: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
};
// SOL committed per 1 amount-unit (agent amount: 1-10 → 0.01-0.10 SOL)
const TRADE_SOL_PER_UNIT = 0.01;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
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
const MARKET_CACHE_TTL_MS = 30_000;

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
      usd: Number(data?.data?.SOL?.price ?? data?.data?.SOL?.usdPrice ?? 0),
      usd_24hr_change: 0,
    },
    raydium: {
      usd: Number(data?.data?.RAY?.price ?? data?.data?.RAY?.usdPrice ?? 0),
      usd_24hr_change: 0,
    },
    orca: {
      usd: Number(data?.data?.ORCA?.price ?? data?.data?.ORCA?.usdPrice ?? 0),
      usd_24hr_change: 0,
    },
  });

  const parseDexScreener = (data: any) => {
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    const findPrice = (symbol: string) => {
      const pair = pairs.find((p: any) => String(p?.baseToken?.symbol || '').toUpperCase() === symbol);
      return Number(pair?.priceUsd ?? 0);
    };
    return {
      solana: { usd: findPrice('SOL'), usd_24hr_change: 0 },
      raydium: { usd: findPrice('RAY'), usd_24hr_change: 0 },
      orca: { usd: findPrice('ORCA'), usd_24hr_change: 0 },
    };
  };

  const hasAnyPrice = (market: any) => [market?.solana?.usd, market?.raydium?.usd, market?.orca?.usd]
    .some((value) => Number.isFinite(value) && Number(value) > 0);

  if (hasAnyPrice(cachedMarketSnapshot) && (Date.now() - cachedMarketSnapshotAt) < MARKET_CACHE_TTL_MS) {
    return cachedMarketSnapshot;
  }

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
    cachedMarketSnapshotAt = Date.now();
    return parsed;
  } catch (error) {
    try {
      const response = await axios.get('https://lite-api.jup.ag/price/v2?ids=SOL,RAY,ORCA', { timeout: 12000 });
      const parsed = parseJupiter(response.data);
      if (!hasAnyPrice(parsed)) {
        throw new Error('Jupiter returned no valid prices');
      }
      marketDataError = 'Primary market feed unavailable (CoinGecko). Using Jupiter fallback.';
      cachedMarketSnapshot = parsed;
      cachedMarketSnapshotAt = Date.now();
      return parsed;
    } catch (fallbackError) {
      try {
        const response = await axios.get(
          'https://api.dexscreener.com/latest/dex/search/?q=SOL%20RAY%20ORCA',
          { timeout: 12000 },
        );
        const parsed = parseDexScreener(response.data);
        if (!hasAnyPrice(parsed)) {
          throw new Error('DexScreener returned no valid prices');
        }
        marketDataError = 'Primary and Jupiter feeds unavailable. Using DexScreener fallback.';
        cachedMarketSnapshot = parsed;
        cachedMarketSnapshotAt = Date.now();
        return parsed;
      } catch (secondFallbackError) {
        marketDataError = formatProviderError('MarketData', secondFallbackError);
        if (hasAnyPrice(cachedMarketSnapshot)) {
          return cachedMarketSnapshot;
        }
        return emptyMarket;
      }
    }
  }
};

const formatProviderError = (provider: string, error: unknown): string => {
  const axiosError = error as any;
  const status = axiosError?.response?.status;
  const data = axiosError?.response?.data;

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

const formatOpenRouterError = (error: unknown): string => {
  const e = error as any;
  const status = e?.statusCode || e?.status || e?.response?.status;
  const code = e?.body?.error?.code || e?.code || e?.response?.data?.error?.code;
  const message =
    e?.body?.error?.message
    || e?.response?.data?.error?.message
    || e?.response?.data?.message
    || e?.message
    || 'OpenRouter request failed';

  const details = [
    status ? `HTTP ${status}` : null,
    code ? `code=${code}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return details
    ? `OpenRouter ${details}: ${String(message)}`
    : `OpenRouter: ${String(message)}`;
};

const getHeliusSignals = async () => {
  if (!HELIUS_API_KEY) {
    heliusError = 'HELIUS_API_KEY is not configured';
    return null;
  }

  try {
    const url = `https://api.helius.xyz/v0/addresses/${keypair.publicKey.toBase58()}/transactions`;
    const response = await axios.get(url, {
      params: {
        'api-key': HELIUS_API_KEY,
        limit: 5,
      },
      timeout: 15000,
    });
    heliusError = null;
    return response.data;
  } catch (error) {
    const axiosError = error as any;
    heliusError = formatProviderError('Helius', error);
    console.warn('Helius API request failed:', axiosError.response?.status, axiosError.response?.data || axiosError.message);
    return null;
  }
};

// ── Jupiter v6 real swap (mainnet; falls back to paper-trade on devnet) ────────
const executeJupiterSwap = async (
  inputSymbol: string,
  outputSymbol: string,
  inputAmountLamports: number,
): Promise<string> => {
  const inputMint = JUPITER_MINTS[inputSymbol] ?? JUPITER_MINTS.SOL;
  const outputMint = JUPITER_MINTS[outputSymbol] ?? JUPITER_MINTS.SOL;

  const quoteResp = await axios.get(`${JUPITER_API}/quote`, {
    params: { inputMint, outputMint, amount: inputAmountLamports, slippageBps: 50 },
    timeout: 15000,
  });

  const swapResp = await axios.post(
    `${JUPITER_API}/swap`,
    {
      quoteResponse: quoteResp.data,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    },
    { timeout: 15000 },
  );

  const txBuf = Buffer.from(swapResp.data.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const blockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...blockhash }, 'confirmed');
  return sig;
};
// ─────────────────────────────────────────────────────────────────────────────

const parseJsonFromModelText = (text: string): any => {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const first = withoutFence.indexOf('{');
    const last = withoutFence.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const candidate = withoutFence.slice(first, last + 1);
      return JSON.parse(candidate);
    }
    throw new Error('Model output is not valid JSON.');
  }
};

const askLlm = async (prompt: string) => {
  const openrouterApiKey = getOpenRouterApiKey();
  if (!openrouterApiKey) {
    openrouterError = 'OpenRouter API key is not configured. Set OPENROUTER_API_KEY (or OPENROUTER_API_TOKEN / OPENROUTER_KEY).';
    return null;
  }

  try {
    const client = new OpenRouter({ apiKey: openrouterApiKey });
    const stream = await client.chat.send({
      chatRequest: {
        model: OPENROUTER_MODEL,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 400,
        temperature: 0.3,
        stream: true,
      },
    });

    let text = '';
    for await (const chunk of (stream as AsyncIterable<any>)) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content === 'string') {
        text += content;
      }
    }

    if (!text) {
      throw new Error('OpenRouter returned empty content.');
    }

    openrouterError = null;
    return parseJsonFromModelText(text);
  } catch (error) {
    const e = error as any;
    openrouterError = formatOpenRouterError(error);
    console.warn('OpenRouter request failed:', e?.statusCode || e?.status, e?.body || e?.response?.data || e?.message);
    return null;
  }
};

const buildPrompt = (market: any, heliusSignals: any) => {
  const signalSummary = Array.isArray(heliusSignals)
    ? heliusSignals.slice(0, 3).map((tx: any) => ({
        type: tx?.type,
        fee: tx?.fee,
        source: tx?.source,
        nativeTransfers: tx?.nativeTransfers?.length ?? 0,
      }))
    : heliusSignals;

  const portfolioLines = (Object.entries(agentPortfolio) as [string, Position][])
    .map(([sym, pos]) => `${sym}: ${pos.amountUnits.toFixed(4)} units, spent ${pos.solSpent.toFixed(4)} SOL, entry $${pos.entryPriceUsd.toFixed(4)}, mode=${pos.swapMode}`)
    .join('; ') || 'none';
  const pnlStr = `${realizedPnlSol >= 0 ? '+' : ''}${realizedPnlSol.toFixed(6)} SOL`;

  return [
    `Market summary: ${JSON.stringify(market)}`,
    `On-chain signals (last 3 txs): ${JSON.stringify(signalSummary)}`,
    `Current portfolio: ${portfolioLines}`,
    `Realized P&L: ${pnlStr}`,
    'Rules: only sell if you currently hold that token; prefer diversification; do not double-buy the same token unless entry was significantly lower.',
    'Choose one action: buy, sell, or hold. If buy or sell, select a Solana SPL token from RAY, ORCA, or SOL.',
    'Return a JSON object with keys: action, symbol, amount (1-10 token units), riskScore (1-99), reason.',
  ].join('\n');
};

const symbolToMint: Record<string, string> = {
  RAY: '4k3Dyjzvzp8eB5Vq7hvh8BUkQ9dFJz2AxKTeoBZGPi7u',
  ORCA: 'orca7wuirT1o1sPo2Ng76gGgneJzmoGWaa6D4wvkPsi',
  SOL: 'So11111111111111111111111111111111111111112',
};

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

// ── Portfolio ─────────────────────────────────────────────────────────────────
interface Position {
  amountUnits: number;   // token units held (from decision)
  solSpent: number;      // SOL invested
  entryPriceUsd: number; // token USD price at entry
  entryTs: string;
  entryTx?: string;      // real swap tx hash if available
  swapMode: 'real' | 'paper';
}

const agentPortfolio: Partial<Record<'SOL' | 'RAY' | 'ORCA', Position>> = {};
let realizedPnlSol = 0;

const SYMBOL_MARKET_KEY: Record<string, string> = {
  SOL: 'solana',
  RAY: 'raydium',
  ORCA: 'orca',
};

const getTokenPriceUsd = (symbol: string, market: any): number =>
  Number(market?.[SYMBOL_MARKET_KEY[symbol]]?.usd || 0) || 1;

const getDemoDecision = (market: any): Decision => {
  const openPositions = Object.keys(agentPortfolio) as Array<'SOL' | 'RAY' | 'ORCA'>;
  if (openPositions.length > 0) {
    const sym = openPositions[0];
    const pos = agentPortfolio[sym];
    return {
      action: 'sell',
      symbol: sym,
      amount: Math.max(1, Math.round(pos?.amountUnits || 1)),
      riskScore: 45,
      reason: 'Demo mode: closing an existing position to demonstrate sell flow.',
      source: 'rule',
    };
  }

  const entries = [
    { symbol: 'SOL' as const, change: Number(market?.solana?.usd_24hr_change ?? 0) },
    { symbol: 'RAY' as const, change: Number(market?.raydium?.usd_24hr_change ?? 0) },
    { symbol: 'ORCA' as const, change: Number(market?.orca?.usd_24hr_change ?? 0) },
  ].sort((a, b) => b.change - a.change);

  return {
    action: 'buy',
    symbol: entries[0]?.symbol || 'SOL',
    amount: 2,
    riskScore: 40,
    reason: 'Demo mode: opening a position to demonstrate buy flow.',
    source: 'rule',
  };
};
// ──────────────────────────────────────────────────────────────────────────────

let scheduledAgent: ReturnType<typeof setInterval> | null = null;
let currentIntervalMinutes = 1;
let lastAction = 'Agent has not run yet.';
let lastMessage = 'Ready to run.';
let running = false;
let currentVaultOwner: PublicKey | null = null;
let lastError: string | null = null;
let openrouterError: string | null = null;
let heliusError: string | null = null;
let marketDataError: string | null = null;
const tradeHistory: TradeRecord[] = [];
let cachedMarketSnapshot: any = {
  solana: { usd: 0, usd_24hr_change: 0 },
  raydium: { usd: 0, usd_24hr_change: 0 },
  orca: { usd: 0, usd_24hr_change: 0 },
};
let cachedMarketSnapshotAt = 0;

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

const decideWithLlm = async (market: any, heliusSignals: any): Promise<Decision | null> => {
  const prompt = buildPrompt(market, heliusSignals);
  const decision = await askLlm(prompt);
  if (!decision || typeof decision !== 'object') {
    return null;
  }

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
  lastAction,
  message: lastMessage,
  lastError,
  agentPublicKey: keypair.publicKey.toBase58(),
  vaultOwner: currentVaultOwner?.toBase58() || null,
  tradeHistory: tradeHistory.slice(0, 20),
  portfolio: {
    positions: agentPortfolio,
    realizedPnlSol,
  },
});

export const getTradeHistory = () => tradeHistory.slice(0, 50);

export const getAgentHealth = async () => {
  const balanceLamports = await connection.getBalance(keypair.publicKey);
  const openrouterApiKey = getOpenRouterApiKey();
  const openrouterKeySource = getOpenRouterKeySource();

  const openrouterStatus = !openrouterApiKey ? 'not_configured' : openrouterError ? 'error' : 'configured';
  const heliusStatus = !HELIUS_API_KEY ? 'not_configured' : heliusError ? 'error' : 'configured';

  return {
    ok: true,
    programId: PROGRAM_ID.toBase58(),
    rpcEndpoint: ENDPOINT,
    agentPublicKey: keypair.publicKey.toBase58(),
    agentBalanceSol: balanceLamports / 1e9,
    env: {
      openrouterConfigured: Boolean(openrouterApiKey),
      openrouterKeySource,
      openrouterModel: OPENROUTER_MODEL,
      demoMode: AGENT_DEMO_MODE,
      heliusConfigured: Boolean(HELIUS_API_KEY),
      walletConfigured: Boolean(SECRET_KEY),
    },
    checks: {
      openrouter: openrouterStatus,
      helius: heliusStatus,
      marketData: marketDataError ? 'fallback_or_error' : 'configured',
    },
    errors: {
      openrouter: openrouterError,
      helius: heliusError,
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

  let chosen: Decision | null = await decideWithLlm(market, heliusSignals);
  if (!chosen) {
    chosen = decideWithRules(market);
  }
  if (AGENT_DEMO_MODE) {
    chosen = getDemoDecision(market);
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

  if (action === 'hold') {
    pushTradeRecord({
      ts: new Date().toISOString(),
      action,
      symbol,
      amount: amountValue,
      riskScore: newRiskScore,
      source: chosen.source,
      reason,
      status: 'skipped',
    });
    return { action, message };
  }

  // ── Guard: can't sell a token we don't hold ────────────────────────────────
  if (action === 'sell' && !agentPortfolio[symbol as 'SOL' | 'RAY' | 'ORCA']) {
    const skipMsg = `No ${symbol} position to sell — skipping.`;
    pushTradeRecord({
      ts: new Date().toISOString(),
      action: 'hold',
      symbol,
      amount: 0,
      riskScore: newRiskScore,
      source: chosen.source,
      reason: skipMsg,
      status: 'skipped',
    });
    lastMessage = skipMsg;
    return { action: 'hold', message: skipMsg };
  }

  // ── Try real Jupiter swap (silently falls back to paper-trade on devnet) ───
  const tradeSolAmount = Math.max(amountValue * TRADE_SOL_PER_UNIT, 0.001);
  const tradeLamports = Math.round(tradeSolAmount * 1e9);
  let swapTx: string | undefined;
  let swapMode: 'real' | 'paper' = 'paper';

  if (action === 'buy') {
    try {
      const agentBal = await connection.getBalance(keypair.publicKey);
      if (agentBal > tradeLamports + 10_000_000) {
        swapTx = await executeJupiterSwap('SOL', symbol, tradeLamports);
        swapMode = 'real';
        console.log(`Jupiter BUY ${symbol}: ${swapTx}`);
      }
    } catch (swapErr) {
      console.log(`Jupiter BUY unavailable (paper-trade): ${(swapErr as any)?.message?.slice(0, 120)}`);
    }
  } else if (action === 'sell') {
    try {
      // For real sell, we'd need actual token balance — paper portfolio tracks units
      // Real swap: sell all units we think we hold at current SOL equivalent
      swapTx = await executeJupiterSwap(symbol, 'SOL', tradeLamports);
      swapMode = 'real';
      console.log(`Jupiter SELL ${symbol}: ${swapTx}`);
    } catch (swapErr) {
      console.log(`Jupiter SELL unavailable (paper-trade): ${(swapErr as any)?.message?.slice(0, 120)}`);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  try {
    // On-chain vault record (existing Anchor instruction)
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

    const finalTx = swapTx || tx;

    // ── Update portfolio ───────────────────────────────────────────────────
    const solPriceUsd = getTokenPriceUsd('SOL', market);
    const tokenPriceUsd = getTokenPriceUsd(symbol, market);
    const sym = symbol as 'SOL' | 'RAY' | 'ORCA';

    if (action === 'buy') {
      const existing = agentPortfolio[sym];
      if (existing) {
        // Average into existing position
        const totalUnits = existing.amountUnits + amountValue;
        existing.entryPriceUsd = (existing.entryPriceUsd * existing.amountUnits + tokenPriceUsd * amountValue) / totalUnits;
        existing.amountUnits = totalUnits;
        existing.solSpent += tradeSolAmount;
        if (swapMode === 'real') {
          existing.swapMode = 'real';
          existing.entryTx = finalTx;
        }
      } else {
        agentPortfolio[sym] = {
          amountUnits: amountValue,
          solSpent: tradeSolAmount,
          entryPriceUsd: tokenPriceUsd,
          entryTs: new Date().toISOString(),
          entryTx: swapTx,
          swapMode,
        };
      }
    } else if (action === 'sell') {
      const pos = agentPortfolio[sym];
      if (pos) {
        const sellUnits = Math.min(amountValue, pos.amountUnits);
        const fraction = sellUnits / pos.amountUnits;
        const exitValueSol = solPriceUsd > 0 ? (sellUnits * tokenPriceUsd) / solPriceUsd : pos.solSpent * fraction;
        const pnlSol = exitValueSol - pos.solSpent * fraction;
        realizedPnlSol += pnlSol;
        console.log(`P&L ${symbol} sell: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(6)} SOL`);
        if (sellUnits >= pos.amountUnits - 0.0001) {
          delete agentPortfolio[sym];
        } else {
          pos.amountUnits -= sellUnits;
          pos.solSpent -= pos.solSpent * fraction;
        }
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    lastMessage = `${message} | swap=${swapMode} tx=${finalTx}`;
    pushTradeRecord({
      ts: new Date().toISOString(),
      action,
      symbol,
      amount: amountValue,
      riskScore: newRiskScore,
      source: chosen.source,
      reason,
      tx: finalTx,
      status: 'executed',
    });
    return { action, message, tx: finalTx };
  } catch (error) {
    const errorMessage = (error as any)?.message || 'Transaction failed';
    lastMessage = `Failed to execute trade: ${errorMessage}`;
    lastError = errorMessage;
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

export const startAgentSchedule = async (intervalMinutes: number, vaultOwner: string) => {
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
  currentIntervalMinutes = intervalMinutes;
  running = true;
  lastMessage = `Agent scheduled every ${intervalMinutes} minute(s) for vault owner ${owner.toBase58()}.`;
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

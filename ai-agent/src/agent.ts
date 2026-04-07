import { OpenRouter } from '@openrouter/sdk';
import axios from 'axios';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import * as anchor from '@project-serum/anchor';
import fs from 'fs';
import path from 'path';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { DEVNET_PROGRAM_ID, Raydium, TxVersion } from '@raydium-io/raydium-sdk-v2';
import { getAgentMarketSliceFromLab } from './marketLab';

dotenv.config();

const PROGRAM_ID = new PublicKey('csiotTu5ChbPzzjnpbNyWkfAQmyRNqTvLw362xUkn8y');
const NETWORK = 'devnet';
const ENDPOINT = (
  process.env.SOLANA_RPC_URL
  || process.env.ALCHEMY_RPC_URL
  || 'https://solana-devnet.g.alchemy.com/v2/e2AbESRWvSs_pNNi7nal8'
).trim();

// ── Available OpenRouter Models ────────────────────────────────────────────
const AVAILABLE_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',      // Latest Nemotron, best quality
  'minimax/minimax-m2.5:free',                   // Minimax M2.5
  'arcee-ai/trinity-large-preview:free',         // Trinity Large
  'qwen/qwen3.6-plus:free',                      // Fallback (original)
];

const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL 
  ? String(process.env.OPENROUTER_MODEL).trim()
  : AVAILABLE_MODELS[0]; // Default to Nemotron (best free model)

// Validate model is in available list, otherwise use default
const VALIDATED_MODEL = AVAILABLE_MODELS.includes(OPENROUTER_MODEL) 
  ? OPENROUTER_MODEL 
  : AVAILABLE_MODELS[0];

const AGENT_DEMO_MODE = String(process.env.AGENT_DEMO_MODE || '').toLowerCase() === 'true' || process.env.AGENT_DEMO_MODE === '1';
const AGENT_EXECUTION_MODE = 'onchain';
const MARKET_LAB_MODE = String(process.env.MARKET_LAB_MODE || '').toLowerCase() === 'true' || process.env.MARKET_LAB_MODE === '1';
const SWAP_PROVIDER = String(process.env.SWAP_PROVIDER || 'raydium').toLowerCase();
const DEVNET_TOKEN_SET_PATH = String(process.env.DEVNET_TOKEN_SET_PATH || '').trim();
const RAYDIUM_POOL_REGISTRY_PATH = String(process.env.RAYDIUM_POOL_REGISTRY_PATH || '').trim();

interface DevnetTokenRecord {
  symbol: string;
  mint: string;
  decimals: number;
}

interface RaydiumPoolRecord {
  symbol: string;
  tokenMint: string;
  tokenDecimals: number;
  poolId: string;
}

const resolveExistingPath = (candidate: string): string | null => {
  if (!candidate) return null;
  const p = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
  return fs.existsSync(p) ? p : null;
};

const tokenSetFile =
  resolveExistingPath(DEVNET_TOKEN_SET_PATH)
  || resolveExistingPath('devnet-token-set.json')
  || resolveExistingPath('ai-agent/devnet-token-set.json');

const poolRegistryFile =
  resolveExistingPath(RAYDIUM_POOL_REGISTRY_PATH)
  || resolveExistingPath('devnet-raydium-pools.json')
  || resolveExistingPath('ai-agent/devnet-raydium-pools.json');

const loadDevnetTokenMap = (): Record<'SOL' | 'RAY' | 'ORCA', DevnetTokenRecord> | null => {
  try {
    if (!tokenSetFile) return null;
    const parsed = JSON.parse(fs.readFileSync(tokenSetFile, 'utf8'));
    const tokens: any[] = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    const bySymbol = new Map(tokens.map((t) => [String(t.symbol || '').toUpperCase(), t]));
    const solx = bySymbol.get('SOLX');
    const rayx = bySymbol.get('RAYX');
    const orcx = bySymbol.get('ORCX');
    if (!solx || !rayx || !orcx) return null;
    return {
      SOL: { symbol: 'SOLX', mint: String(solx.mint), decimals: Number(solx.decimals || 6) },
      RAY: { symbol: 'RAYX', mint: String(rayx.mint), decimals: Number(rayx.decimals || 6) },
      ORCA: { symbol: 'ORCX', mint: String(orcx.mint), decimals: Number(orcx.decimals || 6) },
    };
  } catch {
    return null;
  }
};

const loadRaydiumPoolMap = (): Partial<Record<'SOL' | 'RAY' | 'ORCA', RaydiumPoolRecord>> => {
  try {
    if (!poolRegistryFile) return {};
    const parsed = JSON.parse(fs.readFileSync(poolRegistryFile, 'utf8'));
    const pools: any[] = Array.isArray(parsed?.pools) ? parsed.pools : [];
    const map: Partial<Record<'SOL' | 'RAY' | 'ORCA', RaydiumPoolRecord>> = {};
    for (const p of pools) {
      const sym = String(p.symbol || '').toUpperCase();
      if (!['SOL', 'RAY', 'ORCA'].includes(sym)) continue;
      map[sym as 'SOL' | 'RAY' | 'ORCA'] = {
        symbol: sym,
        tokenMint: String(p.tokenMint),
        tokenDecimals: Number(p.tokenDecimals || 6),
        poolId: String(p.poolId),
      };
    }
    return map;
  } catch {
    return {};
  }
};

const devnetTokenMap = loadDevnetTokenMap();
const raydiumPoolMap = loadRaydiumPoolMap();

// Log environment configuration at startup
console.log('[AGENT INIT] Environment Variables:');
console.log(`  AGENT_DEMO_MODE=${process.env.AGENT_DEMO_MODE} (parsed as: ${AGENT_DEMO_MODE})`);
console.log(`  AGENT_EXECUTION_MODE=${AGENT_EXECUTION_MODE} (demo simulation disabled)`);
console.log(`  MARKET_LAB_MODE=${process.env.MARKET_LAB_MODE} (parsed as: ${MARKET_LAB_MODE})`);
console.log(`  SWAP_PROVIDER=${SWAP_PROVIDER}`);
console.log(`  DEVNET_TOKEN_SET_PATH=${tokenSetFile || 'not_found'}`);
console.log(`  RAYDIUM_POOL_REGISTRY_PATH=${poolRegistryFile || 'not_found'}`);
console.log(`  OPENROUTER_MODEL=${OPENROUTER_MODEL} (validated: ${VALIDATED_MODEL})`);
console.log(`  Available models: ${AVAILABLE_MODELS.join(', ')}`);
console.log(`  OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY ? '***' : 'NOT SET'}`);
console.log(`  SOLANA_RPC_URL=${process.env.SOLANA_RPC_URL || 'using default'}`);
console.log(`  HELIUS_API_KEY=${process.env.HELIUS_API_KEY ? '***' : 'NOT SET'}`);
console.log(`  AGENT_WALLET_SECRET_KEY=${process.env.AGENT_WALLET_SECRET_KEY ? '***' : 'NOT SET'}`);
console.log('');

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

// ── Request throttling to prevent rate limiting ────────────────────────────
const OPENROUTER_MIN_REQUEST_INTERVAL_MS = 2000; // Minimum 2s between requests
let lastOpenRouterRequestTime = 0;

const throttleOpenRouterRequest = async () => {
  const now = Date.now();
  const timeSinceLastRequest = now - lastOpenRouterRequestTime;
  
  if (timeSinceLastRequest < OPENROUTER_MIN_REQUEST_INTERVAL_MS) {
    const delayMs = OPENROUTER_MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
    console.log(`Throttling OpenRouter request: waiting ${delayMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  
  lastOpenRouterRequestTime = Date.now();
};

// Jupiter v6 API
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
let raydiumClient: Raydium | null = null;

const getRaydiumClient = async (): Promise<Raydium> => {
  if (raydiumClient) return raydiumClient;
  raydiumClient = await Raydium.load({
    connection,
    cluster: 'devnet',
    owner: keypair,
    disableLoadToken: true,
    disableFeatureCheck: true,
  });
  return raydiumClient;
};

const executeRaydiumSwap = async (
  symbolIn: 'SOL' | 'RAY' | 'ORCA',
  symbolOut: 'SOL' | 'RAY' | 'ORCA',
  inputAmountRaw: number,
): Promise<string> => {
  if (inputAmountRaw <= 0 || !Number.isFinite(inputAmountRaw)) {
    throw new Error('Raydium swap input amount must be positive');
  }

  const tradeSymbol = symbolIn === 'SOL' ? symbolOut : symbolIn;
  const pool = raydiumPoolMap[tradeSymbol];
  if (!pool?.poolId) {
    throw new Error(`No Raydium devnet pool configured for ${tradeSymbol}. Create pools and set RAYDIUM_POOL_REGISTRY_PATH.`);
  }

  const inMint = symbolIn === 'SOL' ? NATIVE_MINT.toBase58() : (devnetTokenMap?.[symbolIn]?.mint || pool.tokenMint);
  const outMint = symbolOut === 'SOL' ? NATIVE_MINT.toBase58() : (devnetTokenMap?.[symbolOut]?.mint || pool.tokenMint);

  const raydium = await getRaydiumClient();
  const { poolInfo } = await raydium.cpmm.getPoolInfoFromRpc(pool.poolId);
  const inputAmount = new anchor.BN(Math.max(1, Math.floor(inputAmountRaw)));

  // Use very conservative minimum-out floor (1 raw unit) so on-chain price decides actual output.
  const txData = await raydium.cpmm.swap({
    poolInfo,
    baseIn: poolInfo.mintA.address === inMint,
    fixedOut: false,
    slippage: 0.03,
    inputAmount,
    swapResult: {
      inputAmount,
      outputAmount: new anchor.BN(1),
    },
    txVersion: TxVersion.LEGACY,
    config: {
      associatedOnly: false,
    },
  });

  const { txId } = await txData.execute({ sendAndConfirm: true });
  return txId;
};

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
  console.log(`Derived vault PDA: ${vaultPda.toBase58()} from owner: ${owner.toBase58()}`);
  return vaultPda;
};

const ensureVaultExists = async (owner: PublicKey) => {
  const vaultPda = await deriveVaultPda(owner);
  const vaultAccount = await connection.getAccountInfo(vaultPda);
  if (!vaultAccount) {
    throw new Error(
      `Vault address ${vaultPda.toBase58()} not found for owner ${owner.toBase58()}. ` +
      `This usually means:\n` +
      `1. The vault was never created for this wallet\n` +
      `2. You're using a different wallet than the one that created the vault\n` +
      `3. The vault exists on a different cluster (e.g., created on mainnet but looking on devnet)\n\n` +
      `Solution: Connect the SAME wallet in the UI that created the vault, then start the agent from that wallet.`,
    );
  }

  return vaultPda;
};

const getMarketData = async () => {
  if (MARKET_LAB_MODE) {
    const synthetic = getAgentMarketSliceFromLab();
    marketDataError = null;
    cachedMarketSnapshot = synthetic;
    cachedMarketSnapshotAt = Date.now();
    return synthetic;
  }

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

  // Try multiple paths to extract status code from OpenRouter SDK error
  let status = e?.statusCode || e?.status || e?.response?.status;

  // If no status yet, check if error has metadata or is from axios
  if (!status && (e?.response?.statusCode)) {
    status = e.response.statusCode;
  }

  // Extract error code/message from nested structures
  const code = e?.body?.error?.code || e?.code || e?.response?.data?.error?.code;
  const message =
    e?.body?.error?.message
    || e?.response?.data?.error?.message
    || e?.response?.data?.message
    || e?.message
    || 'OpenRouter request failed';

  // For rate limiting, include Retry-After if available
  const retryAfter = e?.response?.headers?.['retry-after'] || e?.response?.data?.retry_after;
  const retryInfo = retryAfter ? ` (retry after ${retryAfter}s)` : '';

  const details = [
    status ? `HTTP ${status}` : null,
    code ? `code=${code}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  // Debug: log full error structure if status is 429
  if (status === 429) {
    console.error('OpenRouter 429 Rate Limit - Full error context:', JSON.stringify({
      statusCode: e?.statusCode,
      status: e?.status,
      responseStatus: e?.response?.status,
      body: e?.body,
      responseData: e?.response?.data,
      message: e?.message,
    }, null, 2));
  }

  return details
    ? `OpenRouter ${details}: ${String(message)}${retryInfo}`
    : `OpenRouter: ${String(message)}${retryInfo}`;
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

// ── Jupiter v6 real swap ───────────────────────────────────────────────────────
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
  // Strip <think>...</think> reasoning blocks (Nemotron, DeepSeek, etc.)
  const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Strip markdown code fences
  const withoutFence = withoutThink
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im, '')
    .replace(/```\s*$/im, '')
    .trim();

  // 1) Try full text as JSON
  try {
    return JSON.parse(withoutFence);
  } catch { /* continue */ }

  // 2) Find the LAST complete JSON object (model may prepend reasoning text)
  const lastBrace = withoutFence.lastIndexOf('}');
  if (lastBrace >= 0) {
    // Walk backward to find matching opening brace
    let depth = 0;
    for (let i = lastBrace; i >= 0; i--) {
      if (withoutFence[i] === '}') depth++;
      if (withoutFence[i] === '{') depth--;
      if (depth === 0) {
        try {
          return JSON.parse(withoutFence.slice(i, lastBrace + 1));
        } catch { /* continue */ }
      }
    }
  }

  console.warn('[LLM] Model output (first 300 chars):', withoutFence.slice(0, 300));
  throw new Error('Model output is not valid JSON.');
};

const askLlm = async (prompt: string, retryCount = 0): Promise<any> => {
  const openrouterApiKey = getOpenRouterApiKey();
  if (!openrouterApiKey) {
    openrouterError = 'OpenRouter API key is not configured. Set OPENROUTER_API_KEY (or OPENROUTER_API_TOKEN / OPENROUTER_KEY).';
    return null;
  }

  try {
    // Apply client-side rate limiting to prevent 429 errors
    await throttleOpenRouterRequest();

    const client = new OpenRouter({ apiKey: openrouterApiKey });
    const stream = await client.chat.send({
      chatRequest: {
        model: VALIDATED_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a Solana trading agent. You MUST respond with ONLY a valid JSON object — no explanation, no markdown, no reasoning text. Output strictly: {"action":"buy"|"sell"|"hold","symbol":"SOL"|"RAY"|"ORCA","amount":1-10,"riskScore":1-99,"reason":"..."}',
          },
          { role: 'user', content: prompt },
        ],
        maxTokens: 250,
        temperature: 0.1,
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

    if (!text || text.trim().length === 0) {
      console.warn('OpenRouter returned empty or whitespace-only content');
      throw new Error('OpenRouter returned empty response (may be rate limited or provider error).');
    }

    openrouterError = null;
    const parsed = parseJsonFromModelText(text);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('OpenRouter response is not valid JSON or not an object.');
    }
    return parsed;
  } catch (error) {
    const e = error as any;
    const status = e?.statusCode || e?.status || e?.response?.status;

    // Handle rate limiting with exponential backoff (max 3 retries)
    if (status === 429 && retryCount < 3) {
      const backoffMs = 1000 * Math.pow(2, retryCount); // 1s, 2s, 4s
      console.warn(`OpenRouter rate limited. Retrying in ${backoffMs}ms (attempt ${retryCount + 1}/3)`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return askLlm(prompt, retryCount + 1);
    }

    openrouterError = formatOpenRouterError(error);
    const logStatus = e?.statusCode || e?.status || 'unknown';
    console.warn('OpenRouter request failed:', logStatus, e?.body || e?.response?.data || e?.message);
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
    `Market: ${JSON.stringify(market)}`,
    `Signals: ${JSON.stringify(signalSummary)}`,
    `Portfolio: ${portfolioLines}`,
    `P&L: ${pnlStr}`,
    'Rules: only sell tokens you hold; diversify; no double-buy unless entry was much lower.',
    'Respond ONLY with JSON: {"action":"buy"|"sell"|"hold","symbol":"SOL"|"RAY"|"ORCA","amount":1-10,"riskScore":1-99,"reason":"brief"}',
  ].join('\n');
};

const symbolToMint: Record<string, string> = {
  RAY: devnetTokenMap?.RAY?.mint || '4k3Dyjzvzp8eB5Vq7hvh8BUkQ9dFJz2AxKTeoBZGPi7u',
  ORCA: devnetTokenMap?.ORCA?.mint || 'orca7wuirT1o1sPo2Ng76gGgneJzmoGWaa6D4wvkPsi',
  SOL: devnetTokenMap?.SOL?.mint || 'So11111111111111111111111111111111111111112',
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

export const deleteTradeRecord = (index: number): boolean => {
  if (index < 0 || index >= tradeHistory.length) return false;
  tradeHistory.splice(index, 1);
  return true;
};

export const clearTradeHistory = () => {
  tradeHistory.length = 0;
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
export const getTradeCount = () => tradeHistory.length;

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
    vaultOwner: currentVaultOwner ? currentVaultOwner.toBase58() : 'not_set',
    agentBalanceSol: balanceLamports / 1e9,
    env: {
      openrouterConfigured: Boolean(openrouterApiKey),
      openrouterKeySource,
      openrouterModel: VALIDATED_MODEL,
      demoMode: AGENT_DEMO_MODE,
      executionMode: AGENT_EXECUTION_MODE,
      swapProvider: SWAP_PROVIDER,
      marketLabMode: MARKET_LAB_MODE,
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

  const vaultPda: PublicKey = await ensureVaultExists(currentVaultOwner);
  
  lastError = null;

  const market = await getMarketData();
  const heliusSignals = await getHeliusSignals();

  let chosen: Decision | null = await decideWithLlm(market, heliusSignals);
  if (!chosen) {
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

  // ── Real swap only (no simulation fallback) ───────────────────────────────
  const tradeSolAmount = Math.max(amountValue * TRADE_SOL_PER_UNIT, 0.001);
  const tradeLamports = Math.round(tradeSolAmount * 1e9);
  let swapTx: string | undefined;
  let swapMode: 'real' | 'paper' = 'real';

  if (action === 'buy') {
    const agentBal = await connection.getBalance(keypair.publicKey);
    if (agentBal <= tradeLamports + 10_000_000) {
      throw new Error(`Insufficient SOL for on-chain BUY ${symbol}. Need > ${(tradeLamports + 10_000_000) / 1e9} SOL including fee buffer.`);
    }

    if (SWAP_PROVIDER === 'raydium') {
      swapTx = await executeRaydiumSwap('SOL', symbol, tradeLamports);
      console.log(`Raydium BUY ${symbol}: ${swapTx}`);
    } else {
      swapTx = await executeJupiterSwap('SOL', symbol, tradeLamports);
      console.log(`Jupiter BUY ${symbol}: ${swapTx}`);
    }
  } else if (action === 'sell') {
    if (SWAP_PROVIDER === 'raydium') {
      const tokenDecimals = devnetTokenMap?.[symbol]?.decimals || 6;
      const desiredRaw = BigInt(Math.max(1, Math.floor(amountValue * Math.pow(10, tokenDecimals))));
      const pool = raydiumPoolMap[symbol];
      if (!pool?.tokenMint) {
        throw new Error(`Raydium pool/token config missing for ${symbol}.`);
      }

      // Cap sell amount by current token ATA balance to avoid swap failure.
      let balanceRaw = 0n;
      try {
        const ata = await anchor.utils.token.associatedAddress({
          mint: new PublicKey(pool.tokenMint),
          owner: keypair.publicKey,
        });
        const bal = await connection.getTokenAccountBalance(new PublicKey(ata));
        balanceRaw = BigInt(bal?.value?.amount || '0');
      } catch {
        balanceRaw = 0n;
      }
      if (balanceRaw <= 0n) {
        throw new Error(`No ${symbol} token balance to SELL on Raydium.`);
      }

      const sellRaw = Number(balanceRaw < desiredRaw ? balanceRaw : desiredRaw);
      swapTx = await executeRaydiumSwap(symbol, 'SOL', sellRaw);
      console.log(`Raydium SELL ${symbol}: ${swapTx}`);
    } else {
      // Jupiter path keeps SOL-sized approximation.
      swapTx = await executeJupiterSwap(symbol, 'SOL', tradeLamports);
      console.log(`Jupiter SELL ${symbol}: ${swapTx}`);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  try {
    let finalTx: string | undefined;

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
    finalTx = swapTx || tx;

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
    const anchorError = (error as any);
    
    // Provide detailed diagnostics for ConstraintSeeds errors
    let diagnosticMessage = errorMessage;
    if (errorMessage.includes('ConstraintSeeds') || errorMessage.includes('seeds constraint')) {
      diagnosticMessage = (
        `Vault address mismatch (ConstraintSeeds error).\n` +
        `Vault owner used: ${currentVaultOwner?.toBase58()}\n` +
        `Agent wallet: ${keypair.publicKey.toBase58()}\n` +
        `Vault PDA: ${vaultPda.toBase58()}\n` +
        `Program: ${PROGRAM_ID.toBase58()}\n\n` +
        `This means the vault expected a different owner than the one provided.\n` +
        `Ensure you:\n` +
        `1. Connected with the SAME wallet that created the vault on the UI\n` +
        `2. The vault exists for that wallet (check "Vault" section in UI)\n` +
        `3. The UI shows the correct vault owner`
      );
    }
    
    lastMessage = `Failed to execute trade: ${diagnosticMessage}`;
    lastError = diagnosticMessage;
    console.error('Trade execution failed:', {
      message: errorMessage,
      vaultOwner: currentVaultOwner?.toBase58(),
      agentWallet: keypair.publicKey.toBase58(),
      vaultPda: vaultPda.toBase58(),
      programId: PROGRAM_ID.toBase58(),
      logs: (anchorError?.logs || []).join('\n'),
    });
    pushTradeRecord({
      ts: new Date().toISOString(),
      action: 'error',
      symbol,
      amount: amountValue,
      riskScore: newRiskScore,
      source: chosen.source,
      reason: diagnosticMessage,
      status: 'failed',
    });
    return { action: 'error', message: diagnosticMessage };
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

  console.log(`Starting agent schedule with vault owner: ${owner.toBase58()}`);
  
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

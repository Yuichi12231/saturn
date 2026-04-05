import axios from 'axios';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import * as anchor from '@project-serum/anchor';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';

dotenv.config();

const PROGRAM_ID = new PublicKey('csiotTu5ChbPzzjnpbNyWkfAQmyRNqTvLw362xUkn8y');
const NETWORK = 'devnet';
const ENDPOINT = clusterApiUrl(NETWORK as any);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
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
  const response = await axios.get(
    'https://api.coingecko.com/api/v3/simple/price?ids=solana,raydium,orca&vs_currencies=usd&include_24hr_change=true',
  );
  return response.data;
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
    heliusError = String(axiosError.response?.data?.error || axiosError.response?.data || axiosError.message || 'Helius request failed');
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
    birdeyeError = String(axiosError.response?.data?.message || axiosError.response?.data || axiosError.message || 'BirdEye request failed');
    console.warn('BirdEye API request failed:', axiosError.response?.status, axiosError.response?.data || axiosError.message);
    return null;
  }
};

const askOpenAI = async (prompt: string) => {
  if (!OPENAI_API_KEY) {
    openAiError = 'OPENAI_API_KEY is not configured';
    return { action: 'hold', reason: 'OpenAI API key is not configured.' };
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: OPENAI_MODEL,
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
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      },
    );

    const text = response.data?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('OpenAI did not return a response.');
    }

    openAiError = null;

    try {
      return JSON.parse(text.replace(/\n/g, ' ').trim());
    } catch (error) {
      return { text };
    }
  } catch (error) {
    const axiosError = error as any;
    openAiError = String(axiosError.response?.data?.error?.message || axiosError.response?.data || axiosError.message || 'OpenAI request failed');
    console.warn('OpenAI request failed:', axiosError.response?.status, axiosError.response?.data || axiosError.message);
    return { action: 'hold', reason: 'OpenAI request failed.' };
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

let scheduledAgent: ReturnType<typeof setInterval> | null = null;
let currentIntervalMinutes = 1;
let lastAction = 'Agent has not run yet.';
let lastMessage = 'Ready to run.';
let running = false;
let currentVaultOwner: PublicKey | null = null;
let lastError: string | null = null;
let openAiError: string | null = null;
let heliusError: string | null = null;
let birdeyeError: string | null = null;

export const getAgentState = () => ({
  running,
  intervalMinutes: currentIntervalMinutes,
  lastAction,
  message: lastMessage,
  lastError,
  agentPublicKey: keypair.publicKey.toBase58(),
  vaultOwner: currentVaultOwner?.toBase58() || null,
});

export const getAgentHealth = async () => {
  const balanceLamports = await connection.getBalance(keypair.publicKey);

  const openaiStatus = !OPENAI_API_KEY ? 'not_configured' : openAiError ? 'error' : 'configured';
  const heliusStatus = !HELIUS_API_KEY ? 'not_configured' : heliusError ? 'error' : 'configured';
  const birdeyeStatus = !BIRDEYE_API_KEY ? 'not_configured' : birdeyeError ? 'error' : 'configured';

  return {
    ok: true,
    programId: PROGRAM_ID.toBase58(),
    agentPublicKey: keypair.publicKey.toBase58(),
    agentBalanceSol: balanceLamports / 1e9,
    env: {
      openaiConfigured: Boolean(OPENAI_API_KEY),
      heliusConfigured: Boolean(HELIUS_API_KEY),
      birdeyeConfigured: Boolean(BIRDEYE_API_KEY),
      walletConfigured: Boolean(SECRET_KEY),
    },
    checks: {
      openai: openaiStatus,
      helius: heliusStatus,
      birdeye: birdeyeStatus,
    },
    errors: {
      openai: openAiError,
      helius: heliusError,
      birdeye: birdeyeError,
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

  const prompt = buildPrompt(market, heliusSignals, birdeyeMarket);
  const decision = await askOpenAI(prompt);

  const action = typeof decision.action === 'string' && ['buy', 'sell'].includes(decision.action.toLowerCase())
    ? decision.action.toLowerCase()
    : 'hold';
  const symbol = typeof decision.symbol === 'string' ? decision.symbol.toUpperCase() : 'SOL';
  const amountValue = Number(decision.amount) || 1;
  const newRiskScore = Number(decision.riskScore) || 50;
  const reason = String(decision.reason || 'No reason provided.');

  let mint = new PublicKey(symbolToMint.SOL);
  if (symbolToMint[symbol]) {
    mint = new PublicKey(symbolToMint[symbol]);
  }

  let message = `AI decision: ${action.toUpperCase()} ${symbol} amount ${amountValue} risk ${newRiskScore}. Reason: ${reason}`;
  lastAction = message;
  lastMessage = `Market snapshot available, AI decision prepared.`;

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
    return { action, message, tx };
  } catch (error) {
    const errorMessage = (error as any)?.message || 'Transaction failed';
    lastMessage = `Failed to execute trade: ${errorMessage}`;
    console.error('Trade execution failed:', errorMessage);
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

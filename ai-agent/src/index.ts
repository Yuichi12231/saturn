import axios from 'axios';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import * as anchor from '@project-serum/anchor';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';

dotenv.config();

const PROGRAM_ID = new PublicKey('VaultAI111111111111111111111111111111111111');
const NETWORK = 'devnet';
const ENDPOINT = clusterApiUrl(NETWORK as any);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;
const SECRET_KEY = process.env.AGENT_WALLET_SECRET_KEY;

if (!OPENAI_API_KEY || !HELIUS_API_KEY || !BIRDEYE_API_KEY || !SECRET_KEY) {
  throw new Error(
    'AGENT_WALLET_SECRET_KEY, OPENAI_API_KEY, HELIUS_API_KEY, and BIRDEYE_API_KEY are required in .env',
  );
}

function parseSecretKey(secret: string): Uint8Array {
  const values = secret
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number);

  if (values.length === 64 && values.every((value) => !Number.isNaN(value))) {
    return Uint8Array.from(values);
  }

  try {
    return bs58.decode(secret);
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

const program = new anchor.Program(
  idl as anchor.Idl,
  PROGRAM_ID,
  new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), { preflightCommitment: 'processed' }),
);

const getCoinGeckoData = async () => {
  const response = await axios.get(
    'https://api.coingecko.com/api/v3/simple/price?ids=solana,raydium,orca&vs_currencies=usd&include_24hr_change=true',
  );
  return response.data;
};

const getHeliusSignals = async () => {
  try {
    const url = `https://api.helius.xyz/v0/addresses/transactions?api-key=${HELIUS_API_KEY}`;
    const response = await axios.post(url, {
      addresses: [keypair.publicKey.toBase58()],
      limit: 5,
    });
    return response.data;
  } catch (error) {
    console.warn('Helius API request failed:', (error as any).message || error);
    return null;
  }
};

const getBirdEyeMarket = async () => {
  try {
    const response = await axios.get('https://api.birdeye.so/v1/market/overview', {
      headers: {
        Authorization: `Bearer ${BIRDEYE_API_KEY}`,
      },
    });
    return response.data;
  } catch (error) {
    console.warn('BirdEye API request failed:', (error as any).message || error);
    return null;
  }
};

const askOpenAI = async (prompt: string) => {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-3.5-turbo',
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
    },
  );

  const text = response.data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('OpenAI did not return a response.');
  }

  try {
    return JSON.parse(text.replace(/\n/g, ' ').trim());
  } catch (error) {
    return { text };
  }
};

const symbolToMint: Record<string, string> = {
  RAY: '4k3Dyjzvzp8eB5Vq7hvh8BUkQ9dFJz2AxKTeoBZGPi7u',
  ORCA: 'orca7wuirT1o1sPo2Ng76gGgneJzmoGWaa6D4wvkPsi',
};

const runAgent = async () => {
  console.log('AI agent starting with wallet', keypair.publicKey.toBase58());

  const market = await getCoinGeckoData();
  const heliusSignals = await getHeliusSignals();
  const birdeyeMarket = await getBirdEyeMarket();

  console.log('Market data:', market);
  console.log('Helius signals:', heliusSignals ? 'received' : 'unavailable');
  console.log('BirdEye market:', birdeyeMarket ? 'received' : 'unavailable');

  const prompt = `Market summary: ${JSON.stringify(market)}\nOn-chain signals: ${JSON.stringify(
    heliusSignals,
  )}\nBirdEye market data: ${JSON.stringify(birdeyeMarket)}\n
Choose one action: buy, sell, or hold. If buy or sell, pick a Solana SPL token from RAY or ORCA and provide a recommended integer amount with a riskScore between 1 and 100. Respond as JSON: {"action":"buy","symbol":"RAY","amount":2,"riskScore":45,"reason":"..."}`;

  let decision: any = { action: 'hold' };
  try {
    decision = await askOpenAI(prompt);
  } catch (error) {
    console.warn('OpenAI fallback decision due to error:', (error as any).message || error);
  }

  if (decision.action !== 'buy' && decision.action !== 'sell') {
    console.log('AI decided to hold for now.');
    return;
  }

  const targetSymbol = typeof decision.symbol === 'string' ? decision.symbol.toUpperCase() : 'RAY';
  const mintAddress = symbolToMint[targetSymbol] ?? symbolToMint.RAY;
  const amountValue = Number(decision.amount) || 1;
  const buy = decision.action === 'buy';
  const newRiskScore = Number(decision.riskScore) || 50;

  console.log('AI trade recommendation:', { action: decision.action, symbol: targetSymbol, amount: amountValue, newRiskScore });

  const [vaultPda] = await PublicKey.findProgramAddress(
    [Buffer.from('vault'), keypair.publicKey.toBuffer()],
    PROGRAM_ID,
  );

  const tx = await program.rpc.executeTrade(
    new PublicKey(mintAddress),
    new anchor.BN(amountValue),
    buy,
    newRiskScore,
    {
      accounts: {
        vault: vaultPda,
        authority: keypair.publicKey,
      },
    },
  );

  console.log('Submitted on-chain AI trade transaction:', tx);
};

runAgent().catch((error) => {
  console.error('Agent failed:', error);
});

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  DEVNET_PROGRAM_ID,
  Raydium,
  TxVersion,
  getCpmmPdaAmmConfigId,
  type ApiCpmmConfigInfo,
} from '@raydium-io/raydium-sdk-v2';

dotenv.config();

const RPC_URL = (process.env.SOLANA_RPC_URL || clusterApiUrl('devnet')).trim();
const SECRET = String(process.env.AGENT_WALLET_SECRET_KEY || '').trim();

const TOKEN_SET_PATH = path.resolve(
  process.cwd(),
  process.env.DEVNET_TOKEN_SET_PATH || 'devnet-token-set.json',
);
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  process.env.RAYDIUM_POOL_REGISTRY_PATH || 'devnet-raydium-pools.json',
);

const TARGET_SYMBOLS = ['SOLX', 'RAYX', 'ORCX', 'ATM', 'LQD', 'NOVA', 'BETA', 'GAM', 'ALF', 'DEL', 'OME', 'SIG'] as const;

const INITIAL_SOL_LAMPORTS = Number(process.env.CPMM_SOL_LAMPORTS || 0.3 * 1e9);
const INITIAL_TOKEN_UNITS = Number(process.env.CPMM_TOKEN_UNITS || 2_000_000);

type TokenEntry = {
  symbol: string;
  mint: string;
  decimals: number;
};

function parseSecretKey(secret: string): Uint8Array {
  if (!secret) throw new Error('AGENT_WALLET_SECRET_KEY is required');

  const asArray = secret
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map(Number);
  if (asArray.length === 64 && asArray.every((v) => Number.isFinite(v))) {
    return Uint8Array.from(asArray);
  }

  return bs58.decode(secret);
}

function loadTokenSet(): TokenEntry[] {
  if (!fs.existsSync(TOKEN_SET_PATH)) {
    throw new Error(`Token set file not found: ${TOKEN_SET_PATH}`);
  }
  const parsed = JSON.parse(fs.readFileSync(TOKEN_SET_PATH, 'utf8'));
  const tokens: any[] = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
  return tokens.map((t) => ({
    symbol: String(t.symbol || '').toUpperCase(),
    mint: String(t.mint || ''),
    decimals: Number(t.decimals || 6),
  }));
}

async function chooseCpmmConfig(raydium: Raydium): Promise<ApiCpmmConfigInfo> {
  try {
    const list = await raydium.api.getCpmmConfigs();
    if (Array.isArray(list) && list.length > 0) {
      return list[0];
    }
  } catch {
    // fall through to PDA-derived config id
  }

  const configId = getCpmmPdaAmmConfigId(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, 0).publicKey.toBase58();
  return {
    id: configId,
    index: 0,
    protocolFeeRate: 120000,
    tradeFeeRate: 2500,
    fundFeeRate: 40000,
    creatorFeeRate: 0,
    createPoolFee: '0',
  };
}

async function main() {
  const owner = Keypair.fromSecretKey(parseSecretKey(SECRET));
  const connection = new Connection(RPC_URL, 'confirmed');
  const raydium = await Raydium.load({
    connection,
    cluster: 'devnet',
    owner,
    disableLoadToken: true,
    disableFeatureCheck: true,
  });

  const balance = await connection.getBalance(owner.publicKey);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Owner: ${owner.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  const feeConfig = await chooseCpmmConfig(raydium);
  console.log(`Using CPMM config id: ${feeConfig.id}`);

  const tokens = loadTokenSet();
  const bySymbol = new Map(tokens.map((t) => [t.symbol, t]));

  const pools: Array<{ symbol: string; tokenMint: string; tokenDecimals: number; poolId: string; txId: string }> = [];

  for (const symbol of TARGET_SYMBOLS) {
    const token = bySymbol.get(symbol);
    if (!token) {
      throw new Error(`Token ${symbol} not found in ${TOKEN_SET_PATH}`);
    }

    const tokenRaw = new BN((BigInt(Math.floor(INITIAL_TOKEN_UNITS)) * BigInt(10 ** token.decimals)).toString());
    const solRaw = new BN(Math.floor(INITIAL_SOL_LAMPORTS).toString());

    console.log(`\nCreating pool ${symbol}/SOL ...`);

    const txData = await raydium.cpmm.createPool({
      programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
      poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
      mintA: {
        address: token.mint,
        decimals: token.decimals,
        programId: TOKEN_PROGRAM_ID.toBase58(),
      },
      mintB: {
        address: NATIVE_MINT.toBase58(),
        decimals: 9,
        programId: TOKEN_PROGRAM_ID.toBase58(),
      },
      mintAAmount: tokenRaw,
      mintBAmount: solRaw,
      startTime: new BN(Math.floor(Date.now() / 1000) - 60),
      feeConfig,
      associatedOnly: false,
      ownerInfo: {
        useSOLBalance: true,
      },
      txVersion: TxVersion.LEGACY,
    });

    const { txId } = await txData.execute({ sendAndConfirm: true });
    const poolId = txData.extInfo.address.poolId.toBase58();

    pools.push({
      symbol,
      tokenMint: token.mint,
      tokenDecimals: token.decimals,
      poolId,
      txId,
    });

    console.log(`Pool created: ${poolId}`);
    console.log(`Tx: ${txId}`);
  }

  const output = {
    createdAt: new Date().toISOString(),
    owner: owner.publicKey.toBase58(),
    rpc: RPC_URL,
    cpmmConfigId: feeConfig.id,
    pools,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nSaved pool registry: ${OUTPUT_PATH}`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error('Failed to create Raydium devnet pools:', error?.message || error);
  process.exit(1);
});

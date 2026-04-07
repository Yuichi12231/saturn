import dotenv from 'dotenv';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  clusterApiUrl,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

dotenv.config();

const RPC_URL = (process.env.SOLANA_RPC_URL || clusterApiUrl('devnet')).trim();
const SECRET = String(process.env.AGENT_WALLET_SECRET_KEY || '').trim();

const TOKENS = [
  { symbol: 'SOLX', name: 'Solara', decimals: 6, supply: 25_000_000 },
  { symbol: 'RAYX', name: 'Rayflux', decimals: 6, supply: 40_000_000 },
  { symbol: 'ORCX', name: 'Orcanet', decimals: 6, supply: 35_000_000 },
  { symbol: 'ATM', name: 'Atlas Momentum', decimals: 6, supply: 30_000_000 },
  { symbol: 'LQD', name: 'Liquidex', decimals: 6, supply: 45_000_000 },
  { symbol: 'NOVA', name: 'Nova Arc', decimals: 6, supply: 22_000_000 },
  { symbol: 'BETA', name: 'Beta Layer', decimals: 6, supply: 90_000_000 },
  { symbol: 'GAM', name: 'Gamma Link', decimals: 6, supply: 28_000_000 },
  { symbol: 'ALF', name: 'Alphafarm', decimals: 6, supply: 55_000_000 },
  { symbol: 'DEL', name: 'Delta Grid', decimals: 6, supply: 24_000_000 },
  { symbol: 'OME', name: 'Omega Stack', decimals: 6, supply: 75_000_000 },
  { symbol: 'SIG', name: 'Sigma Net', decimals: 6, supply: 50_000_000 },
] as const;

function parseSecretKey(secret: string): Uint8Array {
  if (!secret) {
    throw new Error('AGENT_WALLET_SECRET_KEY is required');
  }

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

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.fromSecretKey(parseSecretKey(SECRET));

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.6 * 1e9) {
    console.warn('Low SOL. Recommended at least 0.6 SOL on devnet before creating many mints.');
  }

  const created: Array<{ symbol: string; name: string; mint: string; ata: string; supply: number; decimals: number }> = [];

  for (const token of TOKENS) {
    console.log(`\nCreating mint for ${token.symbol} (${token.name}) ...`);
    const mint = await createMint(
      connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      token.decimals,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID,
    );

    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      payer.publicKey,
      undefined,
      'confirmed',
      undefined,
      TOKEN_PROGRAM_ID,
    );

    // Idempotent call to make reruns safer if account already exists.
    await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      mint,
      payer.publicKey,
      undefined,
      TOKEN_PROGRAM_ID,
    );

    const rawAmount = BigInt(token.supply) * BigInt(10 ** token.decimals);
    await mintTo(
      connection,
      payer,
      mint,
      ata.address,
      payer,
      rawAmount,
      [],
      undefined,
      TOKEN_PROGRAM_ID,
    );

    created.push({
      symbol: token.symbol,
      name: token.name,
      mint: mint.toBase58(),
      ata: ata.address.toBase58(),
      supply: token.supply,
      decimals: token.decimals,
    });

    console.log(`Mint: ${mint.toBase58()}`);
    console.log(`ATA:  ${ata.address.toBase58()}`);
  }

  console.log('\n=== DEVNET TOKEN SET ===');
  console.log(JSON.stringify({
    createdAt: new Date().toISOString(),
    owner: payer.publicKey.toBase58(),
    rpc: RPC_URL,
    tokens: created,
  }, null, 2));
}

main().catch((error) => {
  console.error('Failed to create devnet token set:', error?.message || error);
  process.exit(1);
});

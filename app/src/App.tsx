import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import * as anchor from '@project-serum/anchor';
import {
  AnchorProvider,
  Program,
  Idl,
} from '@project-serum/anchor';
import {
  WalletAdapterNetwork,
} from '@solana/wallet-adapter-base';
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
  useAnchorWallet,
} from '@solana/wallet-adapter-react';
import {
  WalletModalProvider,
  WalletMultiButton,
} from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import idl from './idl/vault_ai.json';

const PROGRAM_ID = new PublicKey('csiotTu5ChbPzzjnpbNyWkfAQmyRNqTvLw362xUkn8y');
const network = WalletAdapterNetwork.Devnet;
const endpoint = (import.meta.env.VITE_SOLANA_RPC_URL || 'https://solana-devnet.g.alchemy.com/v2/e2AbESRWvSs_pNNi7nal8').trim();

interface TokenHolding {
  mint: PublicKey;
  amount: anchor.BN;
  confidence: number;
}

interface VaultState {
  owner: PublicKey;
  agentAuthority: PublicKey;
  totalValue: anchor.BN;
  riskScore: number;
  mode: number;
  enabled: boolean;
  holdings: TokenHolding[];
  lastUpdated: anchor.BN;
}

interface AgentHealth {
  ok: boolean;
  agentPublicKey?: string;
  agentBalanceSol?: number;
  env?: {
    openrouterConfigured?: boolean;
    openrouterModel?: string;
    heliusConfigured?: boolean;
    birdeyeConfigured?: boolean;
    walletConfigured?: boolean;
  };
  checks?: {
    openrouter?: string;
    helius?: string;
    birdeye?: string;
  };
  errors?: {
    openrouter?: string | null;
    helius?: string | null;
    birdeye?: string | null;
  };
  lastError?: string | null;
}

interface AgentTrade {
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

interface TraderAnalytics {
  breadthPct: number;
  avg24hChange: number;
  momentumScore: number;
  volatilityScore: number;
  trendRegime: 'bullish' | 'bearish' | 'sideways';
  relativeStrengthPct: number;
  realizedVolPct: number;
  riskRegime: 'risk-on' | 'neutral' | 'risk-off';
}

interface MarketEntry {
  usd: number;
  usd_24hr_change: number;
}

interface MarketSnapshot {
  ts: number;
  sol: number;
  ray: number;
  orca: number;
}

const MIN_LAMPORTS_FOR_TX = 1_000_000;

const extractErrorMessage = (error: unknown): string => {
  const err = error as any;
  if (typeof err?.error?.errorMessage === 'string') return err.error.errorMessage;
  if (typeof err?.error?.message === 'string') return err.error.message;
  if (typeof err?.message === 'string') return err.message;
  if (Array.isArray(err?.logs) && err.logs.length > 0) return err.logs.join(' | ');
  return 'Unknown transaction error';
};

const AppContent = () => {
  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();
  const [vault, setVault] = useState<VaultState | null>(null);
  const [market, setMarket] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [recommendation, setRecommendation] = useState('AI agent watching Solana market for risk-managed decisions.');
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentIntervalMinutes, setAgentIntervalMinutes] = useState(1);
  const [agentStatus, setAgentStatus] = useState('Agent backend not connected.');
  const [agentReady, setAgentReady] = useState(false);
  const [backendAgentWallet, setBackendAgentWallet] = useState('');
  const [vaultMode, setVaultMode] = useState<'safe' | 'risk'>('safe');
  const [pendingVaultMode, setPendingVaultMode] = useState<'safe' | 'risk'>('safe');
  const [vaultEnabled, setVaultEnabled] = useState(false);
  const [vaultSolBalanceLamports, setVaultSolBalanceLamports] = useState(0);
  const [vaultAccountLamports, setVaultAccountLamports] = useState(0);
  const [vaultRentReserveLamports, setVaultRentReserveLamports] = useState(0);
  const [depositSolInput, setDepositSolInput] = useState('0.1');
  const [withdrawSolInput, setWithdrawSolInput] = useState('0.1');
  const [agentHealth, setAgentHealth] = useState<AgentHealth | null>(null);
  const [agentTrades, setAgentTrades] = useState<AgentTrade[]>([]);
  const [agentStrategy, setAgentStrategy] = useState<'auto' | 'llm' | 'rule'>('auto');
  const [marketAnalytics, setMarketAnalytics] = useState<TraderAnalytics | null>(null);
  const [marketSource, setMarketSource] = useState('loading');
  const [marketError, setMarketError] = useState('');
  const [marketHistory, setMarketHistory] = useState<MarketSnapshot[]>([]);

  const runningLocalFrontend = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const AGENT_API_URL = (import.meta.env.VITE_AGENT_API_URL || (runningLocalFrontend ? 'http://localhost:3001' : '')).trim();
  const agentBackendConfigured = AGENT_API_URL.length > 0;
  const runningHostedFrontend = !runningLocalFrontend;
  const backendLooksLocalhost = AGENT_API_URL.includes('localhost') || AGENT_API_URL.includes('127.0.0.1');
  const backendUrlMismatch = runningHostedFrontend && backendLooksLocalhost;

  const connection = useMemo(() => new Connection(endpoint), []);

  const provider = useMemo(() => {
    if (!anchorWallet) return null;
    return new AnchorProvider(connection, anchorWallet, {
      preflightCommitment: 'processed',
    });
  }, [anchorWallet, connection]);

  const program = useMemo(() => {
    return provider ? new Program(idl as Idl, PROGRAM_ID, provider) : null;
  }, [provider]);

  const walletMatchesVaultOwner = useMemo(() => {
    if (!vault || !anchorWallet) return false;
    return vault.owner.toBase58() === anchorWallet.publicKey!.toBase58();
  }, [vault, anchorWallet]);

  const computeAnalytics = useCallback((normalized: Record<string, MarketEntry>, history: MarketSnapshot[]) => {
    const changes = Object.values(normalized).map((entry) => Number(entry.usd_24hr_change ?? 0));
    if (changes.length === 0) {
      setMarketAnalytics(null);
      return;
    }

    const avg24hChange = changes.reduce((sum, value) => sum + value, 0) / changes.length;
    const breadthPct = (changes.filter((value) => value > 0).length / changes.length) * 100;
    const volatilityScore = Math.min(
      100,
      Math.max(0, changes.reduce((sum, value) => sum + Math.abs(value), 0) / changes.length * 4),
    );
    const momentumScore = Math.min(100, Math.max(0, 50 + avg24hChange * 2));

    const solSeries = history.map((item) => item.sol).filter((value) => Number.isFinite(value) && value > 0);
    const raySeries = history.map((item) => item.ray).filter((value) => Number.isFinite(value) && value > 0);
    const orcaSeries = history.map((item) => item.orca).filter((value) => Number.isFinite(value) && value > 0);

    const shortWindow = solSeries.slice(-3);
    const longWindow = solSeries.slice(-6);
    const shortAvg = shortWindow.length > 0 ? shortWindow.reduce((sum, value) => sum + value, 0) / shortWindow.length : 0;
    const longAvg = longWindow.length > 0 ? longWindow.reduce((sum, value) => sum + value, 0) / longWindow.length : 0;
    const trendDeltaPct = longAvg > 0 ? ((shortAvg - longAvg) / longAvg) * 100 : 0;
    const trendRegime: 'bullish' | 'bearish' | 'sideways' = trendDeltaPct > 0.4 ? 'bullish' : trendDeltaPct < -0.4 ? 'bearish' : 'sideways';

    const solRet = solSeries.length >= 2 ? ((solSeries[solSeries.length - 1] - solSeries[0]) / solSeries[0]) * 100 : 0;
    const rayRet = raySeries.length >= 2 ? ((raySeries[raySeries.length - 1] - raySeries[0]) / raySeries[0]) * 100 : 0;
    const orcaRet = orcaSeries.length >= 2 ? ((orcaSeries[orcaSeries.length - 1] - orcaSeries[0]) / orcaSeries[0]) * 100 : 0;
    const basketRet = (rayRet + orcaRet) / 2;
    const relativeStrengthPct = solRet - basketRet;

    const returns = solSeries.slice(1).map((value, index) => (value - solSeries[index]) / solSeries[index]).filter((value) => Number.isFinite(value));
    const meanReturn = returns.length > 0 ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
    const variance = returns.length > 1
      ? returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / returns.length
      : 0;
    const realizedVolPct = Math.sqrt(Math.max(variance, 0)) * 100;

    const riskComposite = momentumScore * 0.35
      + breadthPct * 0.25
      + Math.min(100, Math.max(0, 50 + relativeStrengthPct * 4)) * 0.25
      + Math.min(100, Math.max(0, 50 - realizedVolPct * 4)) * 0.15;
    const riskRegime: 'risk-on' | 'neutral' | 'risk-off' = riskComposite >= 58 ? 'risk-on' : riskComposite <= 42 ? 'risk-off' : 'neutral';

    setMarketAnalytics({
      breadthPct,
      avg24hChange,
      momentumScore,
      volatilityScore,
      trendRegime,
      relativeStrengthPct,
      realizedVolPct,
      riskRegime,
    });
  }, []);

  const fetchMarketData = useCallback(async () => {
    try {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana,raydium,orca&vs_currencies=usd&include_24hr_change=true',
      );
      if (!response.ok) {
        throw new Error(`CoinGecko HTTP ${response.status}`);
      }

      const data = await response.json();
      const normalized: Record<string, MarketEntry> = {
        solana: {
          usd: Number((data as any)?.solana?.usd),
          usd_24hr_change: Number((data as any)?.solana?.usd_24hr_change ?? 0),
        },
        raydium: {
          usd: Number((data as any)?.raydium?.usd),
          usd_24hr_change: Number((data as any)?.raydium?.usd_24hr_change ?? 0),
        },
        orca: {
          usd: Number((data as any)?.orca?.usd),
          usd_24hr_change: Number((data as any)?.orca?.usd_24hr_change ?? 0),
        },
      };

      const hasValidUsd = Object.values(normalized).some((entry) => Number.isFinite(entry.usd) && entry.usd > 0);
      if (!hasValidUsd) {
        throw new Error('CoinGecko returned no valid prices');
      }

      setMarket(normalized);
      const snapshot: MarketSnapshot = {
        ts: Date.now(),
        sol: normalized.solana.usd,
        ray: normalized.raydium.usd,
        orca: normalized.orca.usd,
      };
      setMarketHistory((prev) => {
        const next = [...prev, snapshot].slice(-120);
        computeAnalytics(normalized, next);
        return next;
      });
      setMarketSource('CoinGecko');
      setMarketError('');
      return normalized;
    } catch (error) {
      console.warn('Primary market feed failed, trying Jupiter fallback', error);

      try {
        const response = await fetch('https://price.jup.ag/v6/price?ids=SOL,RAY,ORCA');
        if (!response.ok) {
          throw new Error(`Jupiter HTTP ${response.status}`);
        }

        const data = await response.json();
        const normalized: Record<string, MarketEntry> = {
          solana: {
            usd: Number((data as any)?.data?.SOL?.price),
            usd_24hr_change: 0,
          },
          raydium: {
            usd: Number((data as any)?.data?.RAY?.price),
            usd_24hr_change: 0,
          },
          orca: {
            usd: Number((data as any)?.data?.ORCA?.price),
            usd_24hr_change: 0,
          },
        };

        const hasValidUsd = Object.values(normalized).some((entry) => Number.isFinite(entry.usd) && entry.usd > 0);
        if (!hasValidUsd) {
          throw new Error('Jupiter returned no valid prices');
        }

        setMarket(normalized);
        const snapshot: MarketSnapshot = {
          ts: Date.now(),
          sol: normalized.solana.usd,
          ray: normalized.raydium.usd,
          orca: normalized.orca.usd,
        };
        setMarketHistory((prev) => {
          const next = [...prev, snapshot].slice(-120);
          computeAnalytics(normalized, next);
          return next;
        });
        setMarketSource('Jupiter fallback (no 24h change)');
        setMarketError('CoinGecko unavailable; fallback feed active');
        return normalized;
      } catch (fallbackError) {
        console.error('All market feeds failed', fallbackError);
        setMarket({});
        setMarketAnalytics(null);
        setMarketHistory([]);
        setMarketSource('unavailable');
        setMarketError(String((fallbackError as any)?.message || 'Failed to load market feeds'));
        return {};
      }
    }
  }, [computeAnalytics]);

  const fetchVault = useCallback(async () => {
    if (!program || !anchorWallet) return;
    setLoading(true);
    setStatus('Loading vault state...');
    try {
      const [vaultPda] = await PublicKey.findProgramAddress(
        [Buffer.from('vault'), anchorWallet.publicKey!.toBuffer()],
        PROGRAM_ID,
      );
      const account = await program.account.vault.fetch(vaultPda);
      const vaultAccountInfo = await connection.getAccountInfo(vaultPda);
      const rentExemptMin = await connection.getMinimumBalanceForRentExemption(vaultAccountInfo?.data.length || 0);
      const vaultSolLamports = Math.max((vaultAccountInfo?.lamports || 0) - rentExemptMin, 0);
      setVaultAccountLamports(vaultAccountInfo?.lamports || 0);
      setVaultRentReserveLamports(rentExemptMin);
      const mode = account.mode === 0 ? 'safe' : 'risk';
      setVaultSolBalanceLamports(vaultSolLamports);
      setVault({
        owner: account.owner,
        agentAuthority: account.agentAuthority,
        totalValue: account.totalValue,
        riskScore: account.riskScore,
        mode: account.mode,
        enabled: account.enabled,
        holdings: account.holdings.map((item: any) => ({
          mint: item.mint,
          amount: item.amount,
          confidence: item.confidence,
        })),
        lastUpdated: account.lastUpdated,
      });
      setVaultMode(mode);
      setPendingVaultMode(mode);
      setVaultEnabled(account.enabled);
      setStatus('Vault loaded');
    } catch (error) {
      console.warn('Vault not found or failed to load', error);
      setVault(null);
      setVaultSolBalanceLamports(0);
      setVaultAccountLamports(0);
      setVaultRentReserveLamports(0);
      setStatus('Vault not created yet');
    } finally {
      setLoading(false);
    }
  }, [anchorWallet, program]);

  const createVault = useCallback(async () => {
    if (!program || !anchorWallet) {
      setStatus('Wallet or program not connected');
      return;
    }
    setLoading(true);
    setStatus('Initializing vault...');
    try {
      // Verify program is deployed
      const programAccount = await connection.getAccountInfo(PROGRAM_ID);
      if (!programAccount) {
        setStatus(
          `❌ Smart contract not deployed at ${PROGRAM_ID.toBase58()} on devnet. ` +
          `Please run: cd programs/vault-ai && anchor build && anchor deploy --provider.cluster devnet`
        );
        setLoading(false);
        return;
      }

      // Check wallet balance
      const balance = await connection.getBalance(anchorWallet.publicKey!);
      if (balance < 5000000) {
        setStatus(`⚠️ Low balance: ${(balance / 1e9).toFixed(2)} SOL. Need at least 0.005 SOL for vault creation.`);
        setLoading(false);
        return;
      }

      const [vaultPda, bump] = await PublicKey.findProgramAddress(
        [Buffer.from('vault'), anchorWallet.publicKey!.toBuffer()],
        PROGRAM_ID,
      );

      // Vault PDA is deterministic. If it already exists, do not call initialize again.
      const existingVault = await connection.getAccountInfo(vaultPda);
      if (existingVault) {
        setStatus('Vault already exists for this wallet. Loading current vault state...');
        await fetchVault();
        setLoading(false);
        return;
      }

      console.log('Creating vault:', {
        wallet: anchorWallet.publicKey!.toBase58(),
        vaultPda: vaultPda.toBase58(),
        bump,
        program: PROGRAM_ID.toBase58(),
      });

      await program.rpc.initializeVault({
        accounts: {
          vault: vaultPda,
          authority: anchorWallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
      });
      setStatus('✅ Vault created successfully!');
      await fetchVault();
    } catch (error) {
      const err = error as any;
      console.error('Vault creation error:', err);

      const rawMessage = String(err?.message || '');
      const rawLogs = Array.isArray(err?.logs) ? err.logs.join(' | ') : '';
      const combined = `${rawMessage} ${rawLogs}`;

      if (/already in use|allocate: account address .* already in use/i.test(combined)) {
        setStatus('Vault already exists for this wallet. Loading current vault state...');
        await fetchVault();
        return;
      }
      
      let errorMsg = 'Failed to create vault';
      if (err.error?.message) {
        errorMsg = err.error.message;
      } else if (err.message) {
        errorMsg = err.message;
      } else if (err.logs) {
        errorMsg = `Transaction error: ${err.logs.join('; ')}`;
      }
      
      setStatus(`❌ ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  }, [anchorWallet, connection, fetchVault, program]);


  const toggleVaultMode = useCallback(async (newMode: 'safe' | 'risk', enabled: boolean) => {
    if (!program || !anchorWallet || !vault) return;

    if (vault.owner.toBase58() !== anchorWallet.publicKey!.toBase58()) {
      setStatus('Connected wallet is not the vault owner. Reconnect Phantom with the vault owner wallet.');
      return;
    }

    setLoading(true);
    setStatus(`Setting vault mode to ${newMode}...`);
    try {
      const balance = await connection.getBalance(anchorWallet.publicKey!);
      if (balance < MIN_LAMPORTS_FOR_TX) {
        setStatus(`Low wallet balance ${(balance / 1e9).toFixed(6)} SOL. Need SOL for transaction fees.`);
        setLoading(false);
        return;
      }

      const [vaultPda] = await PublicKey.findProgramAddress(
        [Buffer.from('vault'), anchorWallet.publicKey!.toBuffer()],
        PROGRAM_ID,
      );
      const modeValue = newMode === 'safe' ? 0 : 1;
      await program.rpc.setVaultMode(modeValue, enabled, {
        accounts: {
          vault: vaultPda,
          authority: anchorWallet.publicKey,
        },
      });
      setVaultMode(newMode);
      setVaultEnabled(enabled);
      setStatus(`Vault mode set to ${newMode} (${enabled ? 'enabled' : 'disabled'})`);
      await fetchVault();
    } catch (error) {
      console.error('Failed to set vault mode:', error);
      setStatus(`Failed to set vault mode: ${extractErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [program, anchorWallet, vault, fetchVault, connection]);

  const depositSol = useCallback(async () => {
    if (!program || !anchorWallet || !vault) return;
    if (!walletMatchesVaultOwner) {
      setStatus('Connected wallet is not the vault owner. Reconnect Phantom with the vault owner wallet.');
      return;
    }

    const amountSol = Number(depositSolInput);
    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      setStatus('Enter a valid SOL amount to deposit.');
      return;
    }

    const amountLamports = Math.floor(amountSol * 1e9);
    if (amountLamports <= 0) {
      setStatus('Deposit amount is too small.');
      return;
    }

    setLoading(true);
    setStatus(`Depositing ${amountSol} SOL to vault...`);
    try {
      const [vaultPda] = await PublicKey.findProgramAddress(
        [Buffer.from('vault'), anchorWallet.publicKey!.toBuffer()],
        PROGRAM_ID,
      );

      await program.rpc.depositSol(new anchor.BN(amountLamports), {
        accounts: {
          vault: vaultPda,
          authority: anchorWallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
      });

      setStatus(`Deposited ${amountSol} SOL to vault.`);
      await fetchVault();
    } catch (error) {
      setStatus(`Failed to deposit SOL: ${extractErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [program, anchorWallet, vault, walletMatchesVaultOwner, depositSolInput, fetchVault]);

  const withdrawSol = useCallback(async () => {
    if (!program || !anchorWallet || !vault) return;
    if (!walletMatchesVaultOwner) {
      setStatus('Connected wallet is not the vault owner. Reconnect Phantom with the vault owner wallet.');
      return;
    }

    const amountSol = Number(withdrawSolInput);
    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      setStatus('Enter a valid SOL amount to withdraw.');
      return;
    }

    const amountLamports = Math.floor(amountSol * 1e9);
    if (amountLamports <= 0) {
      setStatus('Withdraw amount is too small.');
      return;
    }

    setLoading(true);
    setStatus(`Withdrawing ${amountSol} SOL from vault...`);
    try {
      const [vaultPda] = await PublicKey.findProgramAddress(
        [Buffer.from('vault'), anchorWallet.publicKey!.toBuffer()],
        PROGRAM_ID,
      );

      await program.rpc.withdrawSol(new anchor.BN(amountLamports), {
        accounts: {
          vault: vaultPda,
          authority: anchorWallet.publicKey,
        },
      });

      setStatus(`Withdrew ${amountSol} SOL from vault.`);
      await fetchVault();
    } catch (error) {
      setStatus(`Failed to withdraw SOL: ${extractErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [program, anchorWallet, vault, walletMatchesVaultOwner, withdrawSolInput, fetchVault]);

  const setVaultAgentAuthority = useCallback(async (agentAuthorityBase58: string) => {
    if (!program || !anchorWallet || !vault) return false;

    if (vault.owner.toBase58() !== anchorWallet.publicKey!.toBase58()) {
      setStatus('Connected wallet is not the vault owner. Reconnect Phantom with the vault owner wallet.');
      return false;
    }

    let agentAuthority: PublicKey;
    try {
      agentAuthority = new PublicKey(agentAuthorityBase58);
    } catch {
      setStatus('Backend returned invalid agent authority public key');
      return false;
    }

    setLoading(true);
    setStatus('Syncing agent authority with backend wallet...');
    try {
      const balance = await connection.getBalance(anchorWallet.publicKey!);
      if (balance < MIN_LAMPORTS_FOR_TX) {
        setStatus(`Low wallet balance ${(balance / 1e9).toFixed(6)} SOL. Need SOL for transaction fees.`);
        setLoading(false);
        return false;
      }

      const [vaultPda] = await PublicKey.findProgramAddress(
        [Buffer.from('vault'), anchorWallet.publicKey!.toBuffer()],
        PROGRAM_ID,
      );

      await program.rpc.setAgentAuthority(agentAuthority, {
        accounts: {
          vault: vaultPda,
          authority: anchorWallet.publicKey,
        },
      });

      await fetchVault();
      return true;
    } catch (error) {
      console.error('Failed to set agent authority:', error);
      const message = extractErrorMessage(error);
      if (/fallback functions are not supported/i.test(message)) {
        setStatus(
          'Failed to sync agent authority: on-chain program is outdated (setAgentAuthority missing). ' +
          'Redeploy program and upgrade IDL on devnet, then retry.'
        );
      } else {
        setStatus(`Failed to sync agent authority: ${message}`);
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, [program, anchorWallet, vault, fetchVault, connection]);

  const callAgentApi = useCallback(async (path: string, method = 'GET', body?: any) => {
    if (!agentBackendConfigured) {
      setAgentStatus('Agent backend URL is not configured. Set VITE_AGENT_API_URL in frontend environment.');
      return null;
    }

    if (backendUrlMismatch) {
      setAgentStatus('Frontend is hosted, but backend URL points to localhost. Set VITE_AGENT_API_URL to a public HTTPS backend URL.');
      return null;
    }

    try {
      const response = await fetch(`${AGENT_API_URL}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status} ${response.statusText}: ${text}`);
      }
      return await response.json();
    } catch (error) {
      console.error('Agent API error', error);
      setAgentStatus(`Agent API error: ${(error as any).message}`);
      return null;
    }
  }, [AGENT_API_URL, agentBackendConfigured, backendUrlMismatch]);

  const refreshAgentStatus = useCallback(async () => {
    const result = await callAgentApi('/api/agent/status');
    if (result) {
      setAgentRunning(result.running);
      setAgentIntervalMinutes(result.intervalMinutes || agentIntervalMinutes);
      setAgentStatus(result.message || 'Agent status updated.');
      setAgentReady(true);
      if (result.agentPublicKey) {
        setBackendAgentWallet(result.agentPublicKey);
      }
      if (result.lastAction) {
        setRecommendation(result.lastAction);
      }
    }
  }, [agentIntervalMinutes, callAgentApi]);

  const refreshAgentHealth = useCallback(async () => {
    const result = await callAgentApi('/api/agent/health');
    if (result) {
      const health = result as AgentHealth;
      setAgentHealth(health);
      if (health.agentPublicKey) {
        setBackendAgentWallet(health.agentPublicKey);
      }
    }
  }, [callAgentApi]);

  const refreshAgentTrades = useCallback(async () => {
    const result = await callAgentApi('/api/agent/trades');
    if (result?.trades && Array.isArray(result.trades)) {
      setAgentTrades(result.trades as AgentTrade[]);
    }
  }, [callAgentApi]);

  const startRemoteAgent = useCallback(async () => {
    if (!anchorWallet || !program) {
      setAgentStatus('Connect wallet first to select your vault owner address.');
      return;
    }

    if (!agentBackendConfigured) {
      setStatus('Set VITE_AGENT_API_URL to your public backend agent service, then redeploy frontend.');
      return;
    }

    if (backendUrlMismatch) {
      setStatus('Backend URL is localhost but frontend is hosted. Use a public backend URL in VITE_AGENT_API_URL.');
      return;
    }

    if (!vault) {
      setStatus('Create vault first before starting the agent.');
      return;
    }

    let agentWallet = backendAgentWallet;
    if (!agentWallet) {
      const statusResult = await callAgentApi('/api/agent/status');
      if (statusResult?.agentPublicKey) {
        agentWallet = statusResult.agentPublicKey;
        setBackendAgentWallet(statusResult.agentPublicKey);
      }
    }

    if (!agentWallet) {
      setStatus('Unable to read backend agent wallet. Ensure backend is running.');
      return;
    }

    if (vault.agentAuthority.toBase58() !== agentWallet) {
      const synced = await setVaultAgentAuthority(agentWallet);
      if (!synced) {
        return;
      }
      setStatus('Agent authority synced. Starting agent...');
    }

    if (!vaultEnabled) {
      await toggleVaultMode(vaultMode, true);
    }

    const result = await callAgentApi('/api/agent/start', 'POST', {
      intervalMinutes: agentIntervalMinutes,
      vaultOwner: anchorWallet.publicKey.toBase58(),
      strategy: agentStrategy,
    });
    if (result) {
      setAgentRunning(result.running);
      setAgentStatus(result.message);
      setAgentReady(true);
      if (result.agentPublicKey) {
        setBackendAgentWallet(result.agentPublicKey);
      }
      if (result.lastAction) {
        setRecommendation(result.lastAction);
      }
      await refreshAgentTrades();
    }
  }, [agentIntervalMinutes, anchorWallet, program, vault, backendAgentWallet, callAgentApi, setVaultAgentAuthority, agentBackendConfigured, backendUrlMismatch, vaultEnabled, toggleVaultMode, vaultMode, agentStrategy, refreshAgentTrades]);

  const stopRemoteAgent = useCallback(async () => {
    const result = await callAgentApi('/api/agent/stop', 'POST');
    if (result) {
      setAgentRunning(result.running);
      setAgentStatus(result.message);
      if (vaultEnabled) {
        await toggleVaultMode(vaultMode, false);
      }
    }
  }, [callAgentApi, vaultEnabled, toggleVaultMode, vaultMode]);

  useEffect(() => {
    refreshAgentStatus();
    refreshAgentHealth();
    refreshAgentTrades();
  }, [refreshAgentStatus, refreshAgentHealth, refreshAgentTrades]);

  useEffect(() => {
    const interval = setInterval(() => {
      refreshAgentStatus();
      refreshAgentHealth();
      refreshAgentTrades();
    }, 30000);

    return () => clearInterval(interval);
  }, [refreshAgentStatus, refreshAgentHealth, refreshAgentTrades]);

  useEffect(() => {
    fetchMarketData();
  }, [fetchMarketData]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchMarketData();
    }, 45000);

    return () => clearInterval(interval);
  }, [fetchMarketData]);

  useEffect(() => {
    if (wallet.connected) {
      fetchVault();
    }
  }, [fetchVault, wallet.connected]);

  return (
    <main>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <h1>Saturn Vault AI</h1>
            <p>Solana vault managed by AI agents with market signals and risk-aware trading.</p>
          </div>
          <WalletMultiButton />
        </div>
      </div>

      <div className="section-grid">
        <section className="card">
          <h2>Market Overview</h2>
          <p style={{ marginTop: 0, color: '#9ca3af', fontSize: '0.9em' }}>Feed source: {marketSource}</p>
          {Object.keys(market).length === 0 ? (
            <p>Loading market indicators…</p>
          ) : (
            Object.entries(market).map(([symbol, data]) => (
              <div key={symbol} className="metric">
                <div>{symbol.toUpperCase()}</div>
                <div style={{ textAlign: 'right' }}>
                  <div>${(data as any).usd.toFixed(2)}</div>
                  <div style={{ fontSize: '0.85em', color: (data as any).usd_24hr_change >= 0 ? '#22c55e' : '#ef4444' }}>
                    {(data as any).usd_24hr_change?.toFixed?.(2) ?? '0.00'}%
                  </div>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="card">
          <h2>Trader Analytics</h2>
          <p style={{ marginTop: 0, color: '#9ca3af', fontSize: '0.9em' }}>
            Window: {marketHistory.length} snapshots
          </p>
          {marketAnalytics ? (
            <>
              <div className="metric">
                <span>Market breadth</span>
                <strong>{marketAnalytics.breadthPct.toFixed(1)}%</strong>
              </div>
              <div className="metric">
                <span>Average 24h change</span>
                <strong style={{ color: marketAnalytics.avg24hChange >= 0 ? '#22c55e' : '#ef4444' }}>
                  {marketAnalytics.avg24hChange.toFixed(2)}%
                </strong>
              </div>
              <div className="metric">
                <span>Momentum score</span>
                <strong>{marketAnalytics.momentumScore.toFixed(1)} / 100</strong>
              </div>
              <div className="metric">
                <span>Volatility score</span>
                <strong>{marketAnalytics.volatilityScore.toFixed(1)} / 100</strong>
              </div>
              <div className="metric">
                <span>Trend regime</span>
                <strong style={{
                  color: marketAnalytics.trendRegime === 'bullish'
                    ? '#22c55e'
                    : marketAnalytics.trendRegime === 'bearish'
                      ? '#ef4444'
                      : '#f59e0b',
                }}>
                  {marketAnalytics.trendRegime}
                </strong>
              </div>
              <div className="metric">
                <span>Relative strength (SOL vs RAY/ORCA)</span>
                <strong style={{ color: marketAnalytics.relativeStrengthPct >= 0 ? '#22c55e' : '#ef4444' }}>
                  {marketAnalytics.relativeStrengthPct.toFixed(2)}%
                </strong>
              </div>
              <div className="metric">
                <span>Realized volatility</span>
                <strong>{marketAnalytics.realizedVolPct.toFixed(2)}%</strong>
              </div>
              <div className="metric">
                <span>Risk regime</span>
                <strong style={{
                  color: marketAnalytics.riskRegime === 'risk-on'
                    ? '#22c55e'
                    : marketAnalytics.riskRegime === 'risk-off'
                      ? '#ef4444'
                      : '#f59e0b',
                }}>
                  {marketAnalytics.riskRegime}
                </strong>
              </div>
            </>
          ) : (
            <p>Analytics unavailable: {marketError || 'market feeds are currently unavailable.'}</p>
          )}
        </section>

        <section className="card vault-overview-card">
          <h2>Vault Overview</h2>
          {wallet.connected ? (
            loading ? (
              <p>Loading on-chain vault data…</p>
            ) : vault ? (
              <>
                <div className="metric">
                  <span>Total value</span>
                  <strong>{vault.totalValue.toString()}</strong>
                </div>
                <div className="metric">
                  <span>Vault SOL balance</span>
                  <strong>{(vaultSolBalanceLamports / 1e9).toFixed(6)} SOL</strong>
                </div>
                <div className="metric">
                  <span>Vault lamports (raw)</span>
                  <strong>{(vaultAccountLamports / 1e9).toFixed(6)} SOL</strong>
                </div>
                <div className="metric">
                  <span>Rent reserve (locked)</span>
                  <strong>{(vaultRentReserveLamports / 1e9).toFixed(6)} SOL</strong>
                </div>
                <div className="metric">
                  <span>Risk score</span>
                  <strong>{vault.riskScore}%</strong>
                </div>
                <div className="metric">
                  <span>Last updated</span>
                  <strong>{new Date(vault.lastUpdated.toNumber() * 1000).toLocaleString()}</strong>
                </div>
                <div style={{ marginTop: 16, padding: '12px', background: 'rgba(255,255,255,0.04)', borderRadius: 12 }}>
                  <h3>Mode Control</h3>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="radio"
                        name="vaultMode"
                        value="safe"
                        checked={pendingVaultMode === 'safe'}
                        disabled={loading || !walletMatchesVaultOwner}
                        onChange={() => setPendingVaultMode('safe')}
                      />
                      Safe Mode
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="radio"
                        name="vaultMode"
                        value="risk"
                        checked={pendingVaultMode === 'risk'}
                        disabled={loading || !walletMatchesVaultOwner}
                        onChange={() => setPendingVaultMode('risk')}
                      />
                      Risk Mode
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: '0.85em', color: '#cbd5e1', marginBottom: 8 }}>
                    <span>Selected mode: {pendingVaultMode}</span>
                    <span>Current mode: {vaultMode}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span>Agent Enabled:</span>
                    <strong style={{ color: vaultEnabled ? '#16a34a' : '#9ca3af' }}>
                      {vaultEnabled ? 'ON' : 'OFF'}
                    </strong>
                    <button
                      onClick={() => toggleVaultMode(pendingVaultMode, vaultEnabled)}
                      disabled={loading || !walletMatchesVaultOwner || pendingVaultMode === vaultMode}
                      style={{ background: '#0ea5e9', color: '#fff' }}
                    >
                      Apply Mode
                    </button>
                    <span style={{ fontSize: '0.9em', color: '#9ca3af' }}>
                      {pendingVaultMode === 'safe' ? '🛡️ Preserve balance' : '⚡ Active trading'}
                    </span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: '0.85em', color: '#cbd5e1' }}>
                    Enabled state is controlled automatically by Start/Stop Agent.
                  </div>
                  <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
                    <div className="long-value" style={{ fontSize: '0.9em', color: '#9ca3af' }}>
                      Agent authority for this vault: {vault.agentAuthority.toBase58()}
                    </div>
                    <div className="long-value" style={{ fontSize: '0.9em', color: '#9ca3af' }}>
                      Backend agent wallet: {backendAgentWallet || 'Waiting for backend status...'}
                    </div>
                    <div style={{ fontSize: '0.85em', color: '#cbd5e1' }}>
                      Authority sync is automatic when you press Start Agent.
                    </div>
                  </div>
                </div>
                <div style={{ marginTop: 16 }}>
                  <h3>Vault Funds (SOL)</h3>
                  <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        value={depositSolInput}
                        onChange={(event) => setDepositSolInput(event.target.value)}
                        placeholder="Amount SOL"
                        style={{
                          padding: '10px',
                          borderRadius: 10,
                          border: '1px solid rgba(255,255,255,0.16)',
                          background: 'rgba(255,255,255,0.06)',
                          color: '#fff',
                          minWidth: 130,
                        }}
                      />
                      <button
                        onClick={depositSol}
                        disabled={loading || !walletMatchesVaultOwner}
                        style={{ background: '#16a34a', color: '#fff' }}
                      >
                        Deposit SOL
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        value={withdrawSolInput}
                        onChange={(event) => setWithdrawSolInput(event.target.value)}
                        placeholder="Amount SOL"
                        style={{
                          padding: '10px',
                          borderRadius: 10,
                          border: '1px solid rgba(255,255,255,0.16)',
                          background: 'rgba(255,255,255,0.06)',
                          color: '#fff',
                          minWidth: 130,
                        }}
                      />
                      <button
                        onClick={withdrawSol}
                        disabled={loading || !walletMatchesVaultOwner}
                        style={{ background: '#dc2626', color: '#fff' }}
                      >
                        Withdraw SOL
                      </button>
                    </div>
                  </div>

                  <h3>Holdings</h3>
                  {vault.holdings.length === 0 ? (
                    <p>Vault has no token positions yet.</p>
                  ) : (
                    vault.holdings.map((token) => (
                      <div key={token.mint.toBase58()} className="token-chip">
                        <div>Mint: {token.mint.toBase58().slice(0, 8)}…</div>
                        <div>Amount: {token.amount.toString()}</div>
                        <div>Confidence: {token.confidence}%</div>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : (
              <>
                <p>Vault account not found for this wallet.</p>
                <button onClick={createVault} style={{ marginTop: 12, background: '#7c3aed', color: '#fff' }}>
                  Create Vault
                </button>
              </>
            )
          ) : (
            <p>Connect Phantom to see your vault.</p>
          )}
        </section>
      </div>

      <section className="card">
        <h2>AI Agent</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
          <button
            onClick={agentRunning ? stopRemoteAgent : startRemoteAgent}
            style={{
              background: agentRunning ? '#dc2626' : '#16a34a',
              color: '#fff',
              minWidth: 140,
            }}
          >
            {agentRunning ? 'Stop Agent' : 'Start Agent'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Interval:
            <select
              value={agentIntervalMinutes}
              onChange={(event) => setAgentIntervalMinutes(Number(event.target.value))}
              style={{ padding: '10px', borderRadius: 12, background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}
            >
              <option value={1}>1 minute</option>
              <option value={3}>3 minutes</option>
              <option value={5}>5 minutes</option>
              <option value={10}>10 minutes</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Strategy:
            <select
              value={agentStrategy}
              onChange={(event) => setAgentStrategy(event.target.value as 'auto' | 'llm' | 'rule')}
              style={{ padding: '10px', borderRadius: 12, background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}
            >
              <option value="auto">Auto (LLM + Rule fallback)</option>
              <option value="rule">Rule only</option>
              <option value="llm">LLM only</option>
            </select>
          </label>
        </div>
        <p>{recommendation}</p>
        <p>Agent status is controlled from this page and runs on your backend service.</p>
        <button
          onClick={() => {
            refreshAgentStatus();
            refreshAgentHealth();
            refreshAgentTrades();
          }}
          style={{ background: '#334155', color: '#fff', marginBottom: 12 }}
        >
          Refresh API Diagnostics
        </button>
        <pre style={{ background: 'rgba(255,255,255,0.04)', padding: 12, borderRadius: 12, whiteSpace: 'pre-wrap' }}>
          Agent interval: {agentIntervalMinutes} minute(s)
          {'\n'}Status: {agentStatus}
          {'\n'}Agent wallet: {backendAgentWallet || 'Unknown'}
          {'\n'}Backend URL: {AGENT_API_URL || 'Not configured'}
          {'\n'}OpenRouter: {agentHealth?.checks?.openrouter || 'unknown'}
          {'\n'}Model: {agentHealth?.env?.openrouterModel || 'unknown'}
          {'\n'}Helius: {agentHealth?.checks?.helius || 'unknown'}
          {'\n'}BirdEye: {agentHealth?.checks?.birdeye || 'unknown'}
          {'\n'}Agent SOL: {typeof agentHealth?.agentBalanceSol === 'number' ? agentHealth.agentBalanceSol.toFixed(4) : 'unknown'}
        </pre>
        <h3 style={{ marginTop: 18 }}>Recent Agent Trades</h3>
        {agentTrades.length === 0 ? (
          <p style={{ color: '#9ca3af' }}>No trade history yet. Start agent to see autonomous decisions.</p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {agentTrades.slice(0, 8).map((trade) => (
              <div key={`${trade.ts}-${trade.action}-${trade.symbol}-${trade.amount}`} style={{
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 12,
                padding: 10,
                background: 'rgba(255,255,255,0.03)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <strong style={{
                    color: trade.action === 'buy' ? '#22c55e' : trade.action === 'sell' ? '#ef4444' : trade.action === 'error' ? '#f59e0b' : '#9ca3af',
                  }}>
                    {trade.action.toUpperCase()} {trade.symbol} x{trade.amount}
                  </strong>
                  <span style={{ color: '#9ca3af', fontSize: '0.9em' }}>{new Date(trade.ts).toLocaleTimeString()}</span>
                </div>
                <div style={{ color: '#cbd5e1', fontSize: '0.9em' }}>Source: {trade.source} | Risk: {trade.riskScore} | Status: {trade.status}</div>
                <div className="long-value" style={{ color: '#9ca3af', fontSize: '0.88em' }}>{trade.reason}</div>
                {trade.tx && <div className="long-value" style={{ color: '#60a5fa', fontSize: '0.82em' }}>Tx: {trade.tx}</div>}
              </div>
            ))}
          </div>
        )}
        {(agentHealth?.errors?.openrouter || agentHealth?.errors?.helius || agentHealth?.errors?.birdeye || agentHealth?.lastError) && (
          <div style={{ marginTop: 10, color: '#f59e0b' }}>
            <div>API diagnostics:</div>
            {agentHealth?.errors?.openrouter && <div>OpenRouter error: {agentHealth.errors.openrouter}</div>}
            {agentHealth?.errors?.helius && <div>Helius error: {agentHealth.errors.helius}</div>}
            {agentHealth?.errors?.birdeye && <div>BirdEye error: {agentHealth.errors.birdeye}</div>}
            {agentHealth?.lastError && <div>Last agent run error: {agentHealth.lastError}</div>}
          </div>
        )}
        {!agentBackendConfigured && (
          <p style={{ color: '#f59e0b' }}>
            Set VITE_AGENT_API_URL in frontend environment (Vercel Project Settings → Environment Variables), then redeploy.
          </p>
        )}
        {backendUrlMismatch && (
          <p style={{ color: '#f59e0b' }}>
            Your hosted frontend cannot reach localhost backend. Use a public HTTPS URL for VITE_AGENT_API_URL.
          </p>
        )}
        {!agentReady && (
          <p style={{ color: '#f59e0b' }}>Make sure the AI agent backend is running at {AGENT_API_URL || '[VITE_AGENT_API_URL not set]'}</p>
        )}
      </section>

      <section className="card">
        <h2>Diagnostic Info</h2>
        <div style={{ fontSize: '0.9em', fontFamily: 'monospace', color: '#9ca3af' }}>
          <div>Network: Devnet</div>
          <div>Program: {PROGRAM_ID.toBase58().slice(0, 12)}...</div>
          <div>RPC: {endpoint.slice(0, 42)}...</div>
          <div>Wallet: {wallet.connected ? anchorWallet?.publicKey?.toBase58().slice(0, 12) + '...' : 'Not connected'}</div>
          <div>Vault withdrawable SOL: {(vaultSolBalanceLamports / 1e9).toFixed(6)}</div>
          {vault && (
            <div>Vault owner: {vault.owner.toBase58().slice(0, 12)}... {walletMatchesVaultOwner ? '(match)' : '(mismatch)'}</div>
          )}
          {wallet.connected && anchorWallet && (
            <div 
              style={{ cursor: 'pointer', marginTop: 8 }}
              onClick={async () => {
                const balance = await connection.getBalance(anchorWallet.publicKey!);
                setStatus(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);
              }}
            >
              💾 Click to check wallet balance
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <h2>Status</h2>
        <p>{status}</p>
      </section>
    </main>
  );
};

const ConnectionProviderAny = ConnectionProvider as unknown as ComponentType<{
  endpoint: string;
  children: ReactNode;
}>;
const WalletProviderAny = WalletProvider as unknown as ComponentType<any>;

const App = () => {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProviderAny endpoint={endpoint}>
      <WalletProviderAny wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          <AppContent />
        </WalletModalProvider>
      </WalletProviderAny>
    </ConnectionProviderAny>
  );
};

export default App;

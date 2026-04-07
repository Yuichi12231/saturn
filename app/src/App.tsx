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
import { TokenLogo } from './tokenLogos';

const PROGRAM_ID = new PublicKey('csiotTu5ChbPzzjnpbNyWkfAQmyRNqTvLw362xUkn8y');
const network = WalletAdapterNetwork.Devnet;
const endpoint = (import.meta.env.VITE_SOLANA_RPC_URL || 'https://solana-devnet.g.alchemy.com/v2/e2AbESRWvSs_pNNi7nal8').trim();

// These values are derived from env vars and hostname — never change at runtime,
// so we compute them once at module level instead of on every render.
const _runningLocalFrontend = typeof window !== 'undefined'
  && ['localhost', '127.0.0.1'].includes(window.location.hostname);
const AGENT_API_BASE_URL = (
  import.meta.env.VITE_AGENT_API_URL || (_runningLocalFrontend ? 'http://localhost:3001' : '')
).trim();
const AGENT_BACKEND_CONFIGURED = AGENT_API_BASE_URL.length > 0;
const BACKEND_LOOKS_LOCALHOST = AGENT_API_BASE_URL.includes('localhost') || AGENT_API_BASE_URL.includes('127.0.0.1');
const BACKEND_URL_MISMATCH = !_runningLocalFrontend && BACKEND_LOOKS_LOCALHOST;

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

interface VaultAccountRecord {
  owner: PublicKey;
  agentAuthority: PublicKey;
  totalValue: anchor.BN;
  riskScore: number;
  mode: number;
  enabled: boolean;
  holdings: Array<{
    mint: PublicKey;
    amount: anchor.BN;
    confidence: number;
  }>;
  lastUpdated: anchor.BN;
}

interface AgentHealth {
  ok: boolean;
  agentPublicKey?: string;
  vaultOwner?: string;
  agentBalanceSol?: number;
  env?: {
    openrouterConfigured?: boolean;
    openrouterKeySource?: string | null;
    openrouterModel?: string;
    demoMode?: boolean;
    executionMode?: string;
    marketLabMode?: boolean;
    heliusConfigured?: boolean;
    walletConfigured?: boolean;
  };
  checks?: {
    openrouter?: string;
    helius?: string;
    marketData?: string;
  };
  errors?: {
    openrouter?: string | null;
    helius?: string | null;
    marketData?: string | null;
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

interface AgentPosition {
  amountUnits: number;
  solSpent: number;
  entryPriceUsd: number;
  entryTs: string;
  entryTx?: string;
  swapMode: 'real' | 'paper';
}

interface AgentPortfolio {
  positions: Partial<Record<string, AgentPosition>>;
  realizedPnlSol: number;
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

interface TokenVisual {
  key: 'solana' | 'raydium' | 'orca';
  label: string;
  price: number;
  change24h: number;
  shortMovePct: number;
  rangePosPct: number;
  volPct: number;
  series: number[];
}

interface LabToken {
  symbol: string;
  name: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  volume24hUsd: number;
  momentum: number;
  fundamentals: number;
  sentiment: number;
  trend: 'bull' | 'bear' | 'sideways';
}

interface LabCandle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
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

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

const calcVolPct = (series: number[]): number => {
  if (series.length < 3) return 0;
  const returns = series.slice(1).map((v, i) => (v - series[i]) / series[i]).filter((v) => Number.isFinite(v));
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
  return Math.sqrt(Math.max(variance, 0)) * 100;
};

const buildSparklinePath = (series: number[], width = 160, height = 46): string => {
  if (series.length === 0) return '';
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const stepX = series.length > 1 ? width / (series.length - 1) : 0;
  return series
    .map((value, i) => {
      const x = i * stepX;
      const y = height - ((value - min) / span) * height;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const [agentPortfolio, setAgentPortfolio] = useState<AgentPortfolio | null>(null);
  const [marketAnalytics, setMarketAnalytics] = useState<TraderAnalytics | null>(null);
  const [marketSource, setMarketSource] = useState('loading');
  const [marketError, setMarketError] = useState('');
  const [marketHistory, setMarketHistory] = useState<MarketSnapshot[]>([]);
  const [labTokens, setLabTokens] = useState<LabToken[]>([]);
  const [selectedLabSymbol, setSelectedLabSymbol] = useState('SOLX');
  const [labCandleLimit, setLabCandleLimit] = useState(80);
  const [labCandles, setLabCandles] = useState<LabCandle[]>([]);
  const [labView, setLabView] = useState<'overview' | 'charts'>('overview');
  const [hoveredCandleIndex, setHoveredCandleIndex] = useState<number | null>(null);

  // Constants derived at module level — used as-is here.
  const AGENT_API_URL = AGENT_API_BASE_URL;
  const agentBackendConfigured = AGENT_BACKEND_CONFIGURED;
  const backendUrlMismatch = BACKEND_URL_MISMATCH;

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

  const tokenVisuals = useMemo<TokenVisual[]>(() => {
    const seriesByKey: Record<'solana' | 'raydium' | 'orca', number[]> = {
      solana: marketHistory.map((p) => p.sol).filter((v) => Number.isFinite(v) && v > 0),
      raydium: marketHistory.map((p) => p.ray).filter((v) => Number.isFinite(v) && v > 0),
      orca: marketHistory.map((p) => p.orca).filter((v) => Number.isFinite(v) && v > 0),
    };

    const labels: Record<'solana' | 'raydium' | 'orca', string> = {
      solana: 'SOL',
      raydium: 'RAY',
      orca: 'ORCA',
    };

    const keys: Array<'solana' | 'raydium' | 'orca'> = ['solana', 'raydium', 'orca'];
    return keys.map((key) => {
      const series = seriesByKey[key];
      const price = Number((market as any)?.[key]?.usd ?? 0);
      const change24h = Number((market as any)?.[key]?.usd_24hr_change ?? 0);

      const shortWindow = series.slice(-4);
      const shortMovePct = shortWindow.length >= 2
        ? ((shortWindow[shortWindow.length - 1] - shortWindow[0]) / shortWindow[0]) * 100
        : 0;

      const min = series.length > 0 ? Math.min(...series) : 0;
      const max = series.length > 0 ? Math.max(...series) : 0;
      const rangePosPct = max > min ? ((price - min) / (max - min)) * 100 : 50;
      const volPct = calcVolPct(series);

      return {
        key,
        label: labels[key],
        price,
        change24h,
        shortMovePct,
        rangePosPct: clampPercent(rangePosPct),
        volPct,
        series,
      };
    });
  }, [market, marketHistory]);

  const marketIndicators = useMemo(() => {
    if (tokenVisuals.length === 0) {
      return { pressure: 0, dispersion: 0, heat: 0 };
    }
    const deltas = tokenVisuals.map((t) => t.change24h);
    const up = deltas.filter((v) => v > 0).length;
    const down = deltas.filter((v) => v < 0).length;
    const pressure = clampPercent(50 + (up - down) * 16);
    const mean = deltas.reduce((s, v) => s + v, 0) / deltas.length;
    const dispersion = Math.sqrt(deltas.reduce((s, v) => s + (v - mean) ** 2, 0) / deltas.length);
    const heat = clampPercent(50 + mean * 5 - dispersion * 2);
    return { pressure, dispersion, heat };
  }, [tokenVisuals]);

  const selectedLabToken = useMemo(
    () => labTokens.find((t) => t.symbol === selectedLabSymbol) || null,
    [labTokens, selectedLabSymbol],
  );

  const candleChart = useMemo(() => {
    const width = 960;
    const height = labView === 'charts' ? 360 : 260;
    type CandleVisual = {
      x: number;
      wickTop: number;
      wickBottom: number;
      bodyTop: number;
      bodyHeight: number;
      up: boolean;
      bodyW: number;
      closeY: number;
    };
    if (labCandles.length === 0) {
      return {
        width,
        height,
        items: [] as CandleVisual[],
        min: 0,
        max: 0,
        padX: 18,
        step: 1,
      };
    }

    const min = Math.min(...labCandles.map((c) => c.l));
    const max = Math.max(...labCandles.map((c) => c.h));
    const span = Math.max(max - min, 1e-9);
    const padX = 18;
    const usableWidth = width - padX * 2;
    const step = usableWidth / Math.max(labCandles.length, 1);
    const bodyW = Math.max(2, Math.min(10, step * 0.58));

    const yOf = (price: number) => {
      const normalized = (price - min) / span;
      return height - 18 - normalized * (height - 36);
    };

    const items = labCandles.map((c, idx) => {
      const x = padX + idx * step + step / 2;
      const o = yOf(c.o);
      const cl = yOf(c.c);
      const h = yOf(c.h);
      const l = yOf(c.l);
      const bodyTop = Math.min(o, cl);
      const bodyBottom = Math.max(o, cl);
      return {
        x,
        wickTop: h,
        wickBottom: l,
        bodyTop,
        bodyHeight: Math.max(1.4, bodyBottom - bodyTop),
        up: c.c >= c.o,
        bodyW,
        closeY: cl,
      };
    });

    return { width, height, items, min, max, padX, step };
  }, [labCandles, labView]);

  const tradeMarkers = useMemo(() => {
    const symbolMap: Record<string, string> = { SOLX: 'SOL', RAYX: 'RAY', ORCX: 'ORCA' };
    const selectedAgentSymbol = symbolMap[selectedLabSymbol];
    if (!selectedAgentSymbol || candleChart.items.length === 0) return [] as Array<{ x: number; y: number; action: 'buy' | 'sell'; ts: string; tx?: string }>;

    const actionable = agentTrades
      .filter((t) => t.status === 'executed' && (t.action === 'buy' || t.action === 'sell') && t.symbol === selectedAgentSymbol)
      .slice(0, 12)
      .reverse();

    return actionable.map((trade) => {
      const tradeTs = new Date(trade.ts).getTime();
      let bestIdx = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < labCandles.length; i++) {
        const d = Math.abs(labCandles[i].ts - tradeTs);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      const candle = candleChart.items[bestIdx];
      if (!candle) {
        return { x: 0, y: 0, action: trade.action as 'buy' | 'sell', ts: trade.ts, tx: trade.tx };
      }
      const y = trade.action === 'buy' ? candle.wickBottom + 10 : candle.wickTop - 10;
      return { x: candle.x, y, action: trade.action as 'buy' | 'sell', ts: trade.ts, tx: trade.tx };
    });
  }, [agentTrades, candleChart.items, labCandles, selectedLabSymbol]);

  const hoveredCandle = useMemo(
    () => (hoveredCandleIndex === null ? null : labCandles[hoveredCandleIndex] || null),
    [hoveredCandleIndex, labCandles],
  );

  const onCandleMouseMove = useCallback((event: React.MouseEvent<SVGSVGElement>) => {
    if (labCandles.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * candleChart.width;
    const raw = (x - candleChart.padX) / (candleChart.step || 1);
    const idx = Math.max(0, Math.min(labCandles.length - 1, Math.round(raw)));
    setHoveredCandleIndex(idx);
  }, [candleChart.padX, candleChart.step, candleChart.width, labCandles.length]);

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
        const response = await fetch('https://lite-api.jup.ag/price/v2?ids=SOL,RAY,ORCA');
        if (!response.ok) {
          throw new Error(`Jupiter HTTP ${response.status}`);
        }

        const data = await response.json();
        const normalized: Record<string, MarketEntry> = {
          solana: {
            usd: Number((data as any)?.data?.SOL?.price ?? (data as any)?.data?.SOL?.usdPrice ?? 0),
            usd_24hr_change: 0,
          },
          raydium: {
            usd: Number((data as any)?.data?.RAY?.price ?? (data as any)?.data?.RAY?.usdPrice ?? 0),
            usd_24hr_change: 0,
          },
          orca: {
            usd: Number((data as any)?.data?.ORCA?.price ?? (data as any)?.data?.ORCA?.usdPrice ?? 0),
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
        } catch (jupiterError) {
          console.warn('Jupiter fallback failed, trying DexScreener', jupiterError);
          try {
            const dexRes = await fetch('https://api.dexscreener.com/latest/dex/search/?q=SOL%20RAY%20ORCA');
            if (!dexRes.ok) throw new Error(`DexScreener HTTP ${dexRes.status}`);
            const dexData = await dexRes.json();
            const pairs: any[] = Array.isArray(dexData?.pairs) ? dexData.pairs : [];
            const findPairPrice = (sym: string) => {
              const pair = pairs.find((p: any) => String(p?.baseToken?.symbol || '').toUpperCase() === sym);
              return Number(pair?.priceUsd ?? 0);
            };
            const normalized: Record<string, MarketEntry> = {
              solana: { usd: findPairPrice('SOL'), usd_24hr_change: 0 },
              raydium: { usd: findPairPrice('RAY'), usd_24hr_change: 0 },
              orca: { usd: findPairPrice('ORCA'), usd_24hr_change: 0 },
            };
            const hasValidUsd = Object.values(normalized).some(
              (e) => Number.isFinite(e.usd) && e.usd > 0,
            );
            if (!hasValidUsd) throw new Error('DexScreener returned no valid prices');
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
            setMarketSource('DexScreener fallback (no 24h change)');
            setMarketError('CoinGecko and Jupiter unavailable; DexScreener fallback active');
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
    }
  }, [computeAnalytics]);

  const fetchVault = useCallback(async () => {
    if (!program || !anchorWallet) return;
    setLoading(true);
    setStatus('Loading vault state...');
    try {
      const syncVaultState = async () => {
        const [vaultPda] = await PublicKey.findProgramAddress(
          [Buffer.from('vault'), anchorWallet.publicKey!.toBuffer()],
          PROGRAM_ID,
        );
        const rawAccount = await program.account.vault.fetch(vaultPda);
        const account = rawAccount as unknown as VaultAccountRecord;
        const vaultAccountInfo = await connection.getAccountInfo(vaultPda);
        const rentExemptMin = await connection.getMinimumBalanceForRentExemption(vaultAccountInfo?.data.length || 0);
        const vaultSolLamports = Math.max((vaultAccountInfo?.lamports || 0) - rentExemptMin, 0);
        const mode = account.mode === 0 ? 'safe' : 'risk';

        setVaultAccountLamports(vaultAccountInfo?.lamports || 0);
        setVaultRentReserveLamports(rentExemptMin);
        setVaultSolBalanceLamports(vaultSolLamports);
        setVault({
          owner: account.owner,
          agentAuthority: account.agentAuthority,
          totalValue: account.totalValue,
          riskScore: account.riskScore,
          mode: account.mode,
          enabled: account.enabled,
          holdings: account.holdings.map((item) => ({
            mint: item.mint,
            amount: item.amount,
            confidence: item.confidence,
          })),
          lastUpdated: account.lastUpdated,
        });
        setVaultMode(mode);
        setPendingVaultMode(mode);
        setVaultEnabled(account.enabled);
      };

      await syncVaultState();
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
  }, [anchorWallet, connection, program]);

  const syncVaultStateSilently = useCallback(async () => {
    if (!program || !anchorWallet) return false;
    try {
      const [vaultPda] = await PublicKey.findProgramAddress(
        [Buffer.from('vault'), anchorWallet.publicKey!.toBuffer()],
        PROGRAM_ID,
      );
      const rawAccount = await program.account.vault.fetch(vaultPda);
      const account = rawAccount as unknown as VaultAccountRecord;
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
      return true;
    } catch (error) {
      console.warn('Silent vault sync failed', error);
      return false;
    }
  }, [anchorWallet, connection, program]);

  const refreshVaultAfterMutation = useCallback(async (successMessage: string) => {
    setStatus(successMessage);
    for (const delayMs of [250, 800, 1600]) {
      await sleep(delayMs);
      const synced = await syncVaultStateSilently();
      if (synced) {
        setStatus(successMessage);
        return true;
      }
    }
    setStatus(`${successMessage} Chain state is updating; reload data in a moment if balances lag.`);
    return false;
  }, [syncVaultStateSilently]);

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
      await refreshVaultAfterMutation('✅ Vault created successfully!');
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
  }, [anchorWallet, connection, program, refreshVaultAfterMutation]);


  const toggleVaultMode = useCallback(async (newMode: 'safe' | 'risk', enabled: boolean): Promise<boolean> => {
    if (!program || !anchorWallet || !vault) return false;

    if (vault.owner.toBase58() !== anchorWallet.publicKey!.toBase58()) {
      setStatus('Connected wallet is not the vault owner. Reconnect Phantom with the vault owner wallet.');
      return false;
    }

    setLoading(true);
    setStatus(`Setting vault mode to ${newMode}...`);
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
      const modeValue = newMode === 'safe' ? 0 : 1;
      await program.rpc.setVaultMode(modeValue, enabled, {
        accounts: {
          vault: vaultPda,
          authority: anchorWallet.publicKey,
        },
      });
      setVaultMode(newMode);
      setVaultEnabled(enabled);
      await refreshVaultAfterMutation(`Vault mode set to ${newMode} (${enabled ? 'enabled' : 'disabled'})`);
      return true;
    } catch (error) {
      console.error('Failed to set vault mode:', error);
      setStatus(`Failed to set vault mode: ${extractErrorMessage(error)}`);
      return false;
    } finally {
      setLoading(false);
    }
  }, [program, anchorWallet, vault, refreshVaultAfterMutation, connection]);

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

      const tx = await program.rpc.depositSol(new anchor.BN(amountLamports), {
        accounts: {
          vault: vaultPda,
          authority: anchorWallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
      });

      await refreshVaultAfterMutation(`Deposited ${amountSol} SOL to vault. Tx: ${tx.slice(0, 8)}...`);
    } catch (error) {
      setStatus(`Failed to deposit SOL: ${extractErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [program, anchorWallet, vault, walletMatchesVaultOwner, depositSolInput, refreshVaultAfterMutation]);

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

      const tx = await program.rpc.withdrawSol(new anchor.BN(amountLamports), {
        accounts: {
          vault: vaultPda,
          authority: anchorWallet.publicKey,
        },
      });

      await refreshVaultAfterMutation(`Withdrew ${amountSol} SOL from vault. Tx: ${tx.slice(0, 8)}...`);
    } catch (error) {
      setStatus(`Failed to withdraw SOL: ${extractErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [program, anchorWallet, vault, walletMatchesVaultOwner, withdrawSolInput, refreshVaultAfterMutation]);

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

  const requestStartConsentSignature = useCallback(async (): Promise<boolean> => {
    if (!program || !anchorWallet) return false;
    try {
      const balance = await connection.getBalance(anchorWallet.publicKey!);
      if (balance < MIN_LAMPORTS_FOR_TX) {
        setAgentStatus(`Low wallet balance ${(balance / 1e9).toFixed(6)} SOL. Need SOL for transaction fees.`);
        return false;
      }

      const tx = new anchor.web3.Transaction().add(
        new anchor.web3.TransactionInstruction({
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          keys: [{ pubkey: anchorWallet.publicKey!, isSigner: true, isWritable: false }],
          data: Buffer.from(`saturn-start-consent:${Date.now()}`),
        }),
      );

      await (program.provider as AnchorProvider).sendAndConfirm(tx, []);
      return true;
    } catch (error) {
      setAgentStatus(`Start consent signature failed: ${extractErrorMessage(error)}`);
      return false;
    }
  }, [program, anchorWallet, connection]);

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
      const isRunning = Boolean(result.running);
      setAgentRunning(isRunning);
      if (isRunning && typeof result.intervalMinutes === 'number' && result.intervalMinutes > 0) {
        setAgentIntervalMinutes(result.intervalMinutes);
      }
      setAgentStatus(result.message || 'Agent status updated.');
      setAgentReady(true);
      if (result.agentPublicKey) {
        setBackendAgentWallet(result.agentPublicKey);
      }
      if (result.lastAction) {
        setRecommendation(result.lastAction);
      }
      if (result.portfolio) {
        setAgentPortfolio(result.portfolio as AgentPortfolio);
      }
    }
  }, [callAgentApi]);

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

  const refreshLabSnapshot = useCallback(async () => {
    const result = await callAgentApi('/api/lab/snapshot');
    if (result?.items && Array.isArray(result.items)) {
      const next = result.items as LabToken[];
      setLabTokens(next);
      if (next.length > 0 && !next.some((t) => t.symbol === selectedLabSymbol)) {
        setSelectedLabSymbol(next[0].symbol);
      }
    }
  }, [callAgentApi, selectedLabSymbol]);

  const refreshLabCandles = useCallback(async (symbol: string, limit = labCandleLimit) => {
    if (!symbol) return;
    const result = await callAgentApi(`/api/lab/candles/${symbol}?limit=${limit}`);
    if (result?.candles && Array.isArray(result.candles)) {
      setLabCandles(result.candles as LabCandle[]);
    }
  }, [callAgentApi, labCandleLimit]);

  const deleteAgentTrade = useCallback(async (index: number) => {
    // Optimistically remove from UI
    setAgentTrades((prev) => prev.filter((_, i) => i !== index));
    // Sync to backend so delete survives page reload
    const result = await callAgentApi(`/api/agent/trades/${index}`, 'DELETE');
    // Backend returns updated list — sync to avoid index drift
    if (result?.trades && Array.isArray(result.trades)) {
      setAgentTrades(result.trades as AgentTrade[]);
    }
  }, [callAgentApi]);

  const clearAllTrades = useCallback(async () => {
    setAgentTrades([]);
    await callAgentApi('/api/agent/trades/all', 'DELETE');
  }, [callAgentApi]);

  const startRemoteAgent = useCallback(async () => {
    if (!anchorWallet || !program) {
      setAgentStatus('Connect wallet first to confirm consent with a signed transaction.');
      return;
    }

    if (!agentBackendConfigured) {
      setAgentStatus('Set VITE_AGENT_API_URL to your public backend agent service, then redeploy frontend.');
      return;
    }

    if (backendUrlMismatch) {
      setAgentStatus('Backend URL is localhost but frontend is hosted. Use a public backend URL in VITE_AGENT_API_URL.');
      return;
    }

    // Start always requires explicit wallet consent via signed on-chain tx.
    if (!vault) {
      setAgentStatus('Create vault first before starting the agent.');
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
      setAgentStatus('Unable to read backend agent wallet. Ensure backend is running.');
      return;
    }
    const startWarnings: string[] = [];

    if (vault.agentAuthority.toBase58() !== agentWallet) {
      const synced = await setVaultAgentAuthority(agentWallet);
      if (!synced) {
        startWarnings.push('authority sync failed');
        setAgentStatus('Authority sync failed. Continuing with backend start attempt...');
      } else {
        setAgentStatus('Agent authority synced. Please sign to enable agent control.');
      }
    }
    setAgentStatus('Please sign wallet confirmation to start the agent.');
    const consented = await requestStartConsentSignature();
    if (!consented) {
      return;
    }

    if (!vaultEnabled) {
      const enabled = await toggleVaultMode(vaultMode, true);
      if (!enabled) {
        startWarnings.push('vault enable failed');
        setAgentStatus('Vault enable failed. Continuing with backend start attempt...');
      }
    }

    const vaultOwner = anchorWallet?.publicKey?.toBase58() ?? agentHealth?.vaultOwner ?? '';
    const result = await callAgentApi('/api/agent/start', 'POST', {
      intervalMinutes: agentIntervalMinutes,
      vaultOwner,
    });
    if (result) {
      setAgentRunning(Boolean(result.running));
      if (typeof result.intervalMinutes === 'number' && result.intervalMinutes > 0) {
        setAgentIntervalMinutes(result.intervalMinutes);
      }
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

    // Verify actual backend state explicitly after start attempt.
    const statusAfter = await callAgentApi('/api/agent/status');
    if (statusAfter) {
      setAgentRunning(Boolean(statusAfter.running));
      if (typeof statusAfter.intervalMinutes === 'number' && statusAfter.intervalMinutes > 0) {
        setAgentIntervalMinutes(statusAfter.intervalMinutes);
      }
      if (statusAfter.agentPublicKey) {
        setBackendAgentWallet(statusAfter.agentPublicKey);
      }
      if (statusAfter.lastAction) {
        setRecommendation(statusAfter.lastAction);
      }

      if (statusAfter.running) {
        setAgentStatus(startWarnings.length > 0
          ? `Agent started with warnings: ${startWarnings.join(', ')}.`
          : (statusAfter.message || 'Agent started.'));
      } else {
        const base = statusAfter.message || 'Backend did not switch to running state.';
        setAgentStatus(startWarnings.length > 0
          ? `Start failed: ${base} Warnings: ${startWarnings.join(', ')}.`
          : `Start failed: ${base}`);
      }
    }

    await refreshAgentHealth();
    await refreshAgentTrades();
  }, [agentIntervalMinutes, anchorWallet, program, vault, backendAgentWallet, callAgentApi, setVaultAgentAuthority, agentBackendConfigured, backendUrlMismatch, vaultEnabled, toggleVaultMode, vaultMode, refreshAgentTrades, requestStartConsentSignature, refreshAgentHealth]);

  const stopRemoteAgent = useCallback(async () => {
    const result = await callAgentApi('/api/agent/stop', 'POST');
    if (result) {
      setAgentRunning(result.running);
      setAgentStatus(result.message);
    }
  }, [callAgentApi]);

  useEffect(() => {
    refreshAgentStatus();
    refreshAgentHealth();
    refreshAgentTrades();
    refreshLabSnapshot();
    refreshLabCandles(selectedLabSymbol, labCandleLimit);
  }, [refreshAgentStatus, refreshAgentHealth, refreshAgentTrades, refreshLabSnapshot, refreshLabCandles, selectedLabSymbol, labCandleLimit]);

  useEffect(() => {
    // Poll faster when agent is running so new trades appear quickly
    const pollMs = agentRunning ? 5000 : 30000;
    const interval = setInterval(() => {
      refreshAgentStatus();
      refreshAgentHealth();
      refreshAgentTrades();
      refreshLabSnapshot();
      refreshLabCandles(selectedLabSymbol, labCandleLimit);
    }, pollMs);

    return () => clearInterval(interval);
  }, [agentRunning, refreshAgentStatus, refreshAgentHealth, refreshAgentTrades, refreshLabSnapshot, refreshLabCandles, selectedLabSymbol, labCandleLimit]);

  useEffect(() => {
    refreshLabCandles(selectedLabSymbol, labCandleLimit);
  }, [selectedLabSymbol, labCandleLimit, refreshLabCandles]);

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
          <h2>Devnet Market Lab</h2>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button
              onClick={() => setLabView('overview')}
              style={{
                padding: '7px 12px',
                borderRadius: 999,
                background: labView === 'overview' ? 'linear-gradient(90deg,#06b6d4,#22c55e)' : 'rgba(255,255,255,0.06)',
                color: '#fff',
              }}
            >
              Overview
            </button>
            <button
              onClick={() => setLabView('charts')}
              style={{
                padding: '7px 12px',
                borderRadius: 999,
                background: labView === 'charts' ? 'linear-gradient(90deg,#06b6d4,#22c55e)' : 'rgba(255,255,255,0.06)',
                color: '#fff',
              }}
            >
              Charts
            </button>
          </div>
          <p style={{ marginTop: 0, color: '#9ca3af', fontSize: '0.9em' }}>
            Synthetic devnet universe for demos: liquidity, trend regime, momentum and sentiment are updated live.
          </p>
          {labTokens.length === 0 ? (
            <p>Loading lab tokens...</p>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              <div className="lab-switcher">
                {labTokens.map((token) => {
                  const active = token.symbol === selectedLabSymbol;
                  return (
                    <button
                      key={token.symbol}
                      onClick={() => setSelectedLabSymbol(token.symbol)}
                      className={`lab-switch-btn ${active ? 'active' : ''}`}
                    >
                      <TokenLogo symbol={token.symbol} size={24} />
                      <span>{token.symbol}</span>
                    </button>
                  );
                })}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <div>
                  <strong style={{ fontSize: '1.05em', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    {selectedLabToken && <TokenLogo symbol={selectedLabToken.symbol} size={28} />}
                    <span>{selectedLabToken?.symbol} <span style={{ color: '#9ca3af', fontWeight: 500 }}>({selectedLabToken?.name})</span></span>
                  </strong>
                  <div style={{ color: '#cbd5e1', fontSize: '0.9em', marginTop: 3 }}>
                    Trend: {selectedLabToken?.trend || 'n/a'} | Momentum: {selectedLabToken ? (selectedLabToken.momentum * 100).toFixed(1) : '0.0'} | Fundamentals: {selectedLabToken ? (selectedLabToken.fundamentals * 100).toFixed(1) : '0.0'} | Sentiment: {selectedLabToken ? (selectedLabToken.sentiment * 100).toFixed(1) : '0.0'}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: selectedLabToken && selectedLabToken.momentum >= 0 ? '#22c55e' : '#ef4444', fontSize: '1.06em', fontWeight: 700 }}>
                    ${selectedLabToken?.priceUsd?.toFixed(4) || '0.0000'}
                  </div>
                  <div style={{ color: '#9ca3af', fontSize: '0.82em' }}>
                    Liquidity ${selectedLabToken?.liquidityUsd?.toFixed(0) || '0'}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[40, 80, 120].map((limit) => (
                  <button
                    key={limit}
                    onClick={() => setLabCandleLimit(limit)}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 999,
                      background: labCandleLimit === limit ? 'linear-gradient(90deg,#06b6d4,#22c55e)' : 'rgba(255,255,255,0.06)',
                      color: '#fff',
                    }}
                  >
                    {limit} candles
                  </button>
                ))}
              </div>

              <div className="candles-wrap">
                <svg
                  viewBox={`0 0 ${candleChart.width} ${candleChart.height}`}
                  width="100%"
                  height={labView === 'charts' ? '360' : '260'}
                  role="img"
                  aria-label="Lab token candlestick chart"
                  onMouseMove={onCandleMouseMove}
                  onMouseLeave={() => setHoveredCandleIndex(null)}
                >
                  {hoveredCandleIndex !== null && candleChart.items[hoveredCandleIndex] && (
                    <line
                      x1={candleChart.items[hoveredCandleIndex].x}
                      y1={12}
                      x2={candleChart.items[hoveredCandleIndex].x}
                      y2={candleChart.height - 12}
                      stroke="rgba(148,163,184,0.45)"
                      strokeDasharray="4 4"
                      strokeWidth="1"
                    />
                  )}
                  {candleChart.items.map((item, idx) => (
                    <g key={`c-${idx}`}>
                      <line
                        x1={item.x}
                        y1={item.wickTop}
                        x2={item.x}
                        y2={item.wickBottom}
                        stroke={item.up ? '#22c55e' : '#ef4444'}
                        strokeWidth="1.4"
                        opacity="0.92"
                      />
                      <rect
                        x={item.x - item.bodyW / 2}
                        y={item.bodyTop}
                        width={item.bodyW}
                        height={item.bodyHeight}
                        rx="1"
                        fill={item.up ? '#22c55e' : '#ef4444'}
                        opacity="0.92"
                      />
                    </g>
                  ))}
                  {tradeMarkers.map((marker, idx) => (
                    <g key={`m-${idx}-${marker.ts}`}>
                      <circle
                        cx={marker.x}
                        cy={marker.y}
                        r="5"
                        fill={marker.action === 'buy' ? '#22c55e' : '#ef4444'}
                        stroke="rgba(255,255,255,0.85)"
                        strokeWidth="1"
                      />
                      <text
                        x={marker.x + 7}
                        y={marker.y + 3}
                        fontSize="10"
                        fill={marker.action === 'buy' ? '#22c55e' : '#ef4444'}
                      >
                        {marker.action === 'buy' ? 'B' : 'S'}
                      </text>
                    </g>
                  ))}
                </svg>
              </div>

              {hoveredCandle && (
                <div style={{ fontSize: '0.83em', color: '#cbd5e1' }}>
                  {new Date(hoveredCandle.ts).toLocaleTimeString()} | O {hoveredCandle.o.toFixed(4)} | H {hoveredCandle.h.toFixed(4)} | L {hoveredCandle.l.toFixed(4)} | C {hoveredCandle.c.toFixed(4)} | V {hoveredCandle.v.toFixed(2)}
                </div>
              )}

              {labView === 'charts' && (
                <div style={{ fontSize: '0.82em', color: '#9ca3af' }}>
                  Markers: B = executed buy, S = executed sell from agent trade log.
                </div>
              )}

              <div style={{ fontSize: '0.84em', color: '#cbd5e1' }}>
                Vol(24h): ${selectedLabToken?.volume24hUsd?.toFixed(0) || '0'} | MCap: ${selectedLabToken?.marketCapUsd?.toFixed(0) || '0'}
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <h2>Market Overview</h2>
          <p style={{ marginTop: 0, color: '#9ca3af', fontSize: '0.9em' }}>Feed source: {marketSource}</p>
          {tokenVisuals.length === 0 ? (
            <p>Loading market indicators…</p>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {tokenVisuals.map((token) => (
                <div key={token.key} className="token-chip">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <strong>{token.label}</strong>
                    <div style={{ textAlign: 'right' }}>
                      <div>${token.price.toFixed(3)}</div>
                      <div style={{ fontSize: '0.85em', color: token.change24h >= 0 ? '#22c55e' : '#ef4444' }}>
                        {token.change24h.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                  <svg viewBox="0 0 160 46" width="100%" height="46" role="img" aria-label={`${token.label} sparkline`}>
                    <path
                      d={buildSparklinePath(token.series.slice(-24), 160, 46)}
                      fill="none"
                      stroke={token.change24h >= 0 ? '#5ee0ff' : '#ff5c7a'}
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 6, fontSize: '0.84em', color: '#9ca3af' }}>
                    <span>Short: {token.shortMovePct.toFixed(2)}%</span>
                    <span>Range: {token.rangePosPct.toFixed(0)}%</span>
                    <span>Vol: {token.volPct.toFixed(2)}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <h2>Trader Analytics</h2>
          <p style={{ marginTop: 0, color: '#9ca3af', fontSize: '0.9em' }}>
            Window: {marketHistory.length} snapshots
          </p>
          {marketHistory.length < 3 && (
            <p style={{ marginTop: 0, color: '#9ca3af', fontSize: '0.85em' }}>
              Collecting more data for stable analytics...
            </p>
          )}
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
              <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.84em', color: '#9ca3af' }}>
                    <span>Market pressure</span>
                    <span>{marketIndicators.pressure.toFixed(0)}%</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                    <div style={{ width: `${marketIndicators.pressure}%`, height: '100%', background: 'linear-gradient(90deg,#ff4fd8,#5ee0ff)' }} />
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.84em', color: '#9ca3af' }}>
                    <span>Market heat</span>
                    <span>{marketIndicators.heat.toFixed(0)}%</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                    <div style={{ width: `${marketIndicators.heat}%`, height: '100%', background: 'linear-gradient(90deg,#5ee0ff,#b6ff4e)' }} />
                  </div>
                </div>
                <div className="metric" style={{ paddingTop: 8 }}>
                  <span>Return dispersion</span>
                  <strong>{marketIndicators.dispersion.toFixed(2)}</strong>
                </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#cbd5e1', fontSize: '0.95em' }}>Interval:</span>
            {[1, 3, 5, 10].map((minutes) => (
              <button
                key={minutes}
                onClick={() => setAgentIntervalMinutes(minutes)}
                style={{
                  padding: '8px 12px',
                  borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.18)',
                  background: agentIntervalMinutes === minutes ? 'linear-gradient(90deg, #06b6d4, #22c55e)' : 'rgba(255,255,255,0.06)',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                {minutes}m
              </button>
            ))}
            <input
              type="number"
              min={1}
              max={60}
              value={agentIntervalMinutes}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value >= 1 && value <= 60) {
                  setAgentIntervalMinutes(Math.round(value));
                }
              }}
              style={{
                width: 74,
                padding: '8px 10px',
                borderRadius: 10,
                background: 'rgba(255,255,255,0.08)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.14)',
              }}
            />
          </div>
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
          {'\n'}Vault owner: {agentHealth?.vaultOwner || 'not_set'}
          {'\n'}Backend URL: {AGENT_API_URL || 'Not configured'}
          {'\n'}OpenRouter: {agentHealth?.checks?.openrouter || 'unknown'}
          {'\n'}OpenRouter key: {agentHealth?.env?.openrouterKeySource || 'not found'}
          {'\n'}Model: {agentHealth?.env?.openrouterModel || 'unknown'}
          {'\n'}Execution mode: {agentHealth?.env?.executionMode || 'unknown'}
          {'\n'}Market lab mode: {agentHealth?.env?.marketLabMode ? 'on' : 'off'}
          {'\n'}Demo mode: {agentHealth?.env?.demoMode ? 'on' : 'off'}
          {'\n'}Helius: {agentHealth?.checks?.helius || 'unknown'}
          {'\n'}MarketData: {agentHealth?.checks?.marketData || 'unknown'}
          {'\n'}Agent SOL: {typeof agentHealth?.agentBalanceSol === 'number' ? agentHealth.agentBalanceSol.toFixed(4) : 'unknown'}
        </pre>
        {/* ── Portfolio ─────────────────────────────────────────────────────── */}
        <h3 style={{ marginTop: 18 }}>Portfolio</h3>
        {agentPortfolio && Object.keys(agentPortfolio.positions).length > 0 ? (
          <div style={{ display: 'grid', gap: 8, marginBottom: 8 }}>
            {(Object.entries(agentPortfolio.positions) as [string, AgentPosition][]).map(([sym, pos]) => (
              <div key={sym} style={{ border: '1px solid rgba(34,197,94,0.3)', borderRadius: 10, padding: '8px 12px', background: 'rgba(34,197,94,0.06)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <strong style={{ color: '#22c55e' }}>{sym}</strong>
                  <span style={{ color: '#9ca3af', fontSize: '0.87em' }}>{pos.swapMode === 'real' ? '⛓ real swap' : '📄 paper'}</span>
                </div>
                <div style={{ color: '#cbd5e1', fontSize: '0.9em', marginTop: 4 }}>
                  {pos.amountUnits.toFixed(4)} units &nbsp;·&nbsp; spent {pos.solSpent.toFixed(4)} SOL &nbsp;·&nbsp; entry ${pos.entryPriceUsd.toFixed(4)}
                </div>
                {pos.entryTx && <div className="long-value" style={{ color: '#60a5fa', fontSize: '0.8em', marginTop: 2 }}>Tx: {pos.entryTx}</div>}
              </div>
            ))}
            <div style={{ color: agentPortfolio.realizedPnlSol >= 0 ? '#22c55e' : '#ef4444', fontSize: '0.92em', paddingLeft: 2 }}>
              Realized P&amp;L: {agentPortfolio.realizedPnlSol >= 0 ? '+' : ''}{agentPortfolio.realizedPnlSol.toFixed(6)} SOL
            </div>
          </div>
        ) : (
          <p style={{ color: '#9ca3af', marginBottom: 8 }}>
            No open positions. Agent will buy when it sees a good opportunity.
            {typeof agentPortfolio?.realizedPnlSol === 'number' && agentPortfolio.realizedPnlSol !== 0 && (
              <span style={{ color: agentPortfolio.realizedPnlSol >= 0 ? '#22c55e' : '#ef4444' }}>
                {' '}Realized P&amp;L: {agentPortfolio.realizedPnlSol >= 0 ? '+' : ''}{agentPortfolio.realizedPnlSol.toFixed(6)} SOL
              </span>
            )}
          </p>
        )}
        {/* ── Recent Trades ─────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>
            Recent Agent Trades
            {agentRunning && (
              <span style={{ marginLeft: 8, fontSize: '0.72em', background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.28)', borderRadius: 999, padding: '2px 8px', verticalAlign: 'middle' }}>
                ● live
              </span>
            )}
          </h3>
          {agentTrades.length > 0 && (
            <button
              onClick={clearAllTrades}
              style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', borderRadius: 8, padding: '4px 12px', cursor: 'pointer', fontSize: '0.85em' }}
            >
              Clear all
            </button>
          )}
        </div>
        {agentTrades.length === 0 ? (
          <p style={{ color: '#9ca3af' }}>
            No trade history yet. Start agent to see autonomous decisions. Note: history is in-memory and resets when backend restarts/redeploys.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {agentTrades.slice(0, 8).map((trade, idx) => (
              <div key={`${trade.ts}-${trade.action}-${trade.symbol}-${trade.amount}`} style={{
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 12,
                padding: 10,
                background: 'rgba(255,255,255,0.03)',
                position: 'relative',
              }}>
                <button
                  onClick={() => deleteAgentTrade(idx)}
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    background: 'rgba(239, 68, 68, 0.2)',
                    border: '1px solid rgba(239, 68, 68, 0.4)',
                    color: '#ef4444',
                    borderRadius: 6,
                    width: 28,
                    height: 28,
                    cursor: 'pointer',
                    fontSize: '1.1em',
                    fontWeight: 'bold',
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s ease',
                  }}
                  onMouseEnter={(e) => {
                    (e.target as HTMLButtonElement).style.background = 'rgba(239, 68, 68, 0.4)';
                    (e.target as HTMLButtonElement).style.borderColor = 'rgba(239, 68, 68, 0.6)';
                  }}
                  onMouseLeave={(e) => {
                    (e.target as HTMLButtonElement).style.background = 'rgba(239, 68, 68, 0.2)';
                    (e.target as HTMLButtonElement).style.borderColor = 'rgba(239, 68, 68, 0.4)';
                  }}
                  title="Delete this trade from history"
                >
                  ×
                </button>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', paddingRight: 40 }}>
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
        {(agentHealth?.errors?.openrouter || agentHealth?.errors?.helius || agentHealth?.errors?.marketData || agentHealth?.lastError) && (
          <div style={{ marginTop: 10, color: '#f59e0b' }}>
            <div>API diagnostics:</div>
            {agentHealth?.errors?.openrouter && <div>OpenRouter error: {agentHealth.errors.openrouter}</div>}
            {agentHealth?.errors?.helius && <div>Helius error: {agentHealth.errors.helius}</div>}
            {agentHealth?.errors?.marketData && <div>MarketData error: {agentHealth.errors.marketData}</div>}
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

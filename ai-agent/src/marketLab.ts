type Trend = 'bull' | 'bear' | 'sideways';

export interface LabToken {
  symbol: string;
  name: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  volume24hUsd: number;
  momentum: number; // -1..1
  fundamentals: number; // -1..1
  sentiment: number; // -1..1
  trend: Trend;
  updatedAt: number;
}

export interface LabCandle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface SwapResult {
  ok: boolean;
  symbolIn: string;
  symbolOut: string;
  amountIn: number;
  amountOut: number;
  priceImpactPct: number;
  feeUsd: number;
  reason?: string;
}

const MAX_CANDLES = 240;
const SNAPSHOT_TTL_MS = 5_000;
const SWAP_FEE_BPS = 30;

const tokenSeeds: Array<Pick<LabToken, 'symbol' | 'name' | 'priceUsd' | 'liquidityUsd' | 'marketCapUsd'>> = [
  { symbol: 'SOLX', name: 'Solara', priceUsd: 12.8, liquidityUsd: 180_000, marketCapUsd: 1_800_000 },
  { symbol: 'RAYX', name: 'Rayflux', priceUsd: 1.6, liquidityUsd: 130_000, marketCapUsd: 1_100_000 },
  { symbol: 'ORCX', name: 'Orcanet', priceUsd: 0.92, liquidityUsd: 95_000, marketCapUsd: 720_000 },
  { symbol: 'ATM', name: 'Atlas Momentum', priceUsd: 3.4, liquidityUsd: 160_000, marketCapUsd: 1_400_000 },
  { symbol: 'LQD', name: 'Liquidex', priceUsd: 0.42, liquidityUsd: 220_000, marketCapUsd: 980_000 },
  { symbol: 'NOVA', name: 'Nova Arc', priceUsd: 7.1, liquidityUsd: 140_000, marketCapUsd: 1_250_000 },
  { symbol: 'BETA', name: 'Beta Layer', priceUsd: 0.12, liquidityUsd: 75_000, marketCapUsd: 560_000 },
  { symbol: 'GAM', name: 'Gamma Link', priceUsd: 2.15, liquidityUsd: 88_000, marketCapUsd: 820_000 },
  { symbol: 'ALF', name: 'Alphafarm', priceUsd: 0.77, liquidityUsd: 102_000, marketCapUsd: 660_000 },
  { symbol: 'DEL', name: 'Delta Grid', priceUsd: 4.3, liquidityUsd: 110_000, marketCapUsd: 1_050_000 },
  { symbol: 'OME', name: 'Omega Stack', priceUsd: 0.21, liquidityUsd: 98_000, marketCapUsd: 700_000 },
  { symbol: 'SIG', name: 'Sigma Net', priceUsd: 1.04, liquidityUsd: 120_000, marketCapUsd: 910_000 },
];

const driftByTrend: Record<Trend, number> = {
  bull: 0.0017,
  bear: -0.0019,
  sideways: 0,
};

const tokens = new Map<string, LabToken>();
const candles = new Map<string, LabCandle[]>();
let lastGlobalUpdateAt = 0;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const randomIn = (min: number, max: number) => min + Math.random() * (max - min);

const pickTrend = (): Trend => {
  const r = Math.random();
  if (r < 0.33) return 'bear';
  if (r < 0.66) return 'sideways';
  return 'bull';
};

const pushCandle = (symbol: string, candle: LabCandle) => {
  const arr = candles.get(symbol) || [];
  arr.push(candle);
  if (arr.length > MAX_CANDLES) arr.splice(0, arr.length - MAX_CANDLES);
  candles.set(symbol, arr);
};

const bootstrap = () => {
  if (tokens.size > 0) return;

  const now = Date.now();
  for (const seed of tokenSeeds) {
    const token: LabToken = {
      ...seed,
      volume24hUsd: seed.liquidityUsd * randomIn(0.7, 2.0),
      momentum: randomIn(-0.3, 0.3),
      fundamentals: randomIn(-0.5, 0.5),
      sentiment: randomIn(-0.4, 0.4),
      trend: pickTrend(),
      updatedAt: now,
    };

    tokens.set(token.symbol, token);

    const history: LabCandle[] = [];
    let prev = token.priceUsd;
    for (let i = 80; i > 0; i--) {
      const ts = now - i * 60_000;
      const noise = randomIn(-0.01, 0.01);
      const close = Math.max(0.0001, prev * (1 + noise));
      const high = Math.max(prev, close) * (1 + randomIn(0, 0.005));
      const low = Math.min(prev, close) * (1 - randomIn(0, 0.005));
      history.push({ ts, o: prev, h: high, l: low, c: close, v: token.volume24hUsd / 1440 });
      prev = close;
    }
    candles.set(token.symbol, history);
  }

  lastGlobalUpdateAt = now;
};

const evolveToken = (token: LabToken, minutes: number) => {
  const oldPrice = token.priceUsd;

  // Fundamental and sentiment drift slowly over time.
  token.fundamentals = clamp(token.fundamentals + randomIn(-0.015, 0.015), -1, 1);
  token.sentiment = clamp(token.sentiment + randomIn(-0.03, 0.03), -1, 1);

  // Regime switch: occasional trend changes.
  if (Math.random() < 0.02 * minutes) {
    token.trend = pickTrend();
  }

  // Technical + fundamental return model.
  const trendDrift = driftByTrend[token.trend] * minutes;
  const momentumDrift = token.momentum * 0.0022 * minutes;
  const fundamentalDrift = token.fundamentals * 0.0016 * minutes;
  const sentimentDrift = token.sentiment * 0.0012 * minutes;

  const volBase = 0.006 + (120_000 / Math.max(token.liquidityUsd, 20_000)) * 0.003;
  const randomShock = randomIn(-1, 1) * volBase * Math.sqrt(minutes);

  const rawReturn = trendDrift + momentumDrift + fundamentalDrift + sentimentDrift + randomShock;
  const cappedReturn = clamp(rawReturn, -0.12, 0.12);

  const newPrice = Math.max(0.0001, oldPrice * (1 + cappedReturn));
  const high = Math.max(oldPrice, newPrice) * (1 + randomIn(0, 0.01));
  const low = Math.min(oldPrice, newPrice) * (1 - randomIn(0, 0.01));

  token.momentum = clamp(token.momentum * 0.75 + (cappedReturn * 4), -1, 1);
  token.priceUsd = newPrice;
  token.marketCapUsd = Math.max(5_000, token.marketCapUsd * (1 + cappedReturn * 0.9));
  token.liquidityUsd = Math.max(15_000, token.liquidityUsd * (1 + randomIn(-0.02, 0.02)));
  token.volume24hUsd = Math.max(2_000, token.volume24hUsd * (1 + Math.abs(cappedReturn) * randomIn(1.4, 4.2) + randomIn(-0.06, 0.06)));
  token.updatedAt = Date.now();

  pushCandle(token.symbol, {
    ts: token.updatedAt,
    o: oldPrice,
    h: high,
    l: low,
    c: newPrice,
    v: token.volume24hUsd / 1440,
  });
};

const tick = () => {
  bootstrap();
  const now = Date.now();
  const elapsedMs = now - lastGlobalUpdateAt;
  if (elapsedMs < SNAPSHOT_TTL_MS) return;

  const minutes = clamp(elapsedMs / 60_000, 0.1, 3);
  for (const token of tokens.values()) {
    evolveToken(token, minutes);
  }
  lastGlobalUpdateAt = now;
};

const getToken = (symbol: string): LabToken | null => {
  tick();
  return tokens.get(symbol.toUpperCase()) || null;
};

export const getLabSnapshot = () => {
  tick();
  const items = Array.from(tokens.values()).sort((a, b) => b.marketCapUsd - a.marketCapUsd);
  return {
    ts: Date.now(),
    count: items.length,
    items,
  };
};

export const getLabCandleSeries = (symbol: string, limit = 120) => {
  tick();
  const key = symbol.toUpperCase();
  const arr = candles.get(key) || [];
  return {
    symbol: key,
    candles: arr.slice(Math.max(0, arr.length - clamp(Math.floor(limit), 10, 240))),
  };
};

export const simulateLabSwap = (symbolIn: string, symbolOut: string, amountIn: number): SwapResult => {
  const inToken = getToken(symbolIn);
  const outToken = getToken(symbolOut);

  if (!inToken || !outToken) {
    return {
      ok: false,
      symbolIn,
      symbolOut,
      amountIn,
      amountOut: 0,
      priceImpactPct: 0,
      feeUsd: 0,
      reason: 'Unknown token symbol',
    };
  }

  if (!Number.isFinite(amountIn) || amountIn <= 0) {
    return {
      ok: false,
      symbolIn: inToken.symbol,
      symbolOut: outToken.symbol,
      amountIn,
      amountOut: 0,
      priceImpactPct: 0,
      feeUsd: 0,
      reason: 'amountIn must be positive',
    };
  }

  const amountInUsd = amountIn * inToken.priceUsd;
  const depth = Math.max(20_000, Math.min(inToken.liquidityUsd, outToken.liquidityUsd));
  const impact = clamp((amountInUsd / depth) * 100, 0.01, 25);
  const feeUsd = amountInUsd * (SWAP_FEE_BPS / 10_000);
  const effectiveUsd = Math.max(0, amountInUsd - feeUsd);
  const outUsdAfterImpact = effectiveUsd * (1 - impact / 100);
  const amountOut = outUsdAfterImpact / outToken.priceUsd;

  // Liquidity drifts after swap to emulate order flow.
  inToken.liquidityUsd = Math.max(15_000, inToken.liquidityUsd + amountInUsd * 0.25);
  outToken.liquidityUsd = Math.max(15_000, outToken.liquidityUsd - outUsdAfterImpact * 0.22);
  inToken.volume24hUsd += amountInUsd;
  outToken.volume24hUsd += outUsdAfterImpact;

  return {
    ok: true,
    symbolIn: inToken.symbol,
    symbolOut: outToken.symbol,
    amountIn,
    amountOut,
    priceImpactPct: impact,
    feeUsd,
  };
};

export const getAgentMarketSliceFromLab = () => {
  tick();

  const sol = tokens.get('SOLX');
  const ray = tokens.get('RAYX');
  const orc = tokens.get('ORCX');

  const mk = (token: LabToken | undefined) => {
    if (!token) {
      return { usd: 0, usd_24hr_change: 0 };
    }
    const cs = candles.get(token.symbol) || [];
    const back = cs.length > 24 ? cs[cs.length - 24] : cs[0];
    const base = back?.c || token.priceUsd;
    const change = base > 0 ? ((token.priceUsd - base) / base) * 100 : 0;
    return {
      usd: token.priceUsd,
      usd_24hr_change: Number.isFinite(change) ? change : 0,
    };
  };

  return {
    solana: mk(sol),
    raydium: mk(ray),
    orca: mk(orc),
  };
};

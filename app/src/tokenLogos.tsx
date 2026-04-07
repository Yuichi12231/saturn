import type { CSSProperties } from 'react';

type TokenLogoProps = {
  symbol: string;
  size?: number;
  style?: CSSProperties;
};

const palette: Record<string, { a: string; b: string; c: string }> = {
  SOLX: { a: '#22d3ee', b: '#0ea5e9', c: '#082f49' },
  RAYX: { a: '#f472b6', b: '#e879f9', c: '#4a044e' },
  ORCX: { a: '#34d399', b: '#10b981', c: '#052e2b' },
  ATM: { a: '#f59e0b', b: '#f97316', c: '#431407' },
  LQD: { a: '#06b6d4', b: '#22c55e', c: '#083344' },
  NOVA: { a: '#8b5cf6', b: '#6366f1', c: '#312e81' },
  BETA: { a: '#60a5fa', b: '#2563eb', c: '#172554' },
  GAM: { a: '#84cc16', b: '#22c55e', c: '#1a2e05' },
  ALF: { a: '#fb7185', b: '#f43f5e', c: '#4c0519' },
  DEL: { a: '#14b8a6', b: '#0d9488', c: '#042f2e' },
  OME: { a: '#a78bfa', b: '#7c3aed', c: '#2e1065' },
  SIG: { a: '#f97316', b: '#ef4444', c: '#431407' },
};

const glyphFor = (symbol: string) => {
  switch (symbol) {
    case 'SOLX':
      return <path d="M17 14h18l-4 4H13zM13 22h18l4 4H17zM17 6h18l-4 4H13z" fill="url(#g)" />;
    case 'RAYX':
      return <path d="M14 34 24 10l8 12 8-12 10 24h-9l-3-7h-8l-3 7zm19-13h4l-2-5z" fill="#fff" opacity="0.94" />;
    case 'ORCX':
      return <path d="M32 11c-9.4 0-17 7.6-17 17 0 4.1 1.5 7.9 4 11-5.2-2-9-7-9-12.9 0-7.7 6.6-14 14.7-14 5.4 0 10.1 2.8 12.7 6.9A16.9 16.9 0 0 0 32 11zm0 7.5c-5.2 0-9.5 4.3-9.5 9.5s4.3 9.5 9.5 9.5 9.5-4.3 9.5-9.5-4.3-9.5-9.5-9.5z" fill="#fff" opacity="0.95" />;
    case 'ATM':
      return <path d="M14 35 27 12h10l13 23h-9l-2.7-5H25.7L23 35zm15.4-11h5.2L32 19z" fill="#fff" opacity="0.95" />;
    case 'LQD':
      return <path d="M15 12h9v18h14v8H15zm17-2h9v26h-9z" fill="#fff" opacity="0.94" />;
    case 'NOVA':
      return <path d="M32 8 37 24 54 24 40 33 45 49 32 39 19 49 24 33 10 24 27 24z" fill="#fff" opacity="0.95" />;
    case 'BETA':
      return <path d="M16 11h16c7 0 11 3.5 11 8.5 0 3.6-2.1 6-5.6 7.1 4.3.9 6.9 3.9 6.9 8.3 0 6-4.9 9.1-12.4 9.1H16zm9 8h6.1c2.2 0 3.6-.9 3.6-2.7 0-1.7-1.4-2.6-3.6-2.6H25zm0 14h7.2c2.6 0 4.1-1 4.1-3s-1.6-2.9-4.1-2.9H25z" fill="#fff" opacity="0.95" />;
    case 'GAM':
      return <path d="M47 18c-3.3-4.1-8.5-6.8-14.3-6.8-10 0-18 8-18 18s8 18 18 18c8.6 0 15.9-6 17.6-14H33v-7h18c.2 1 .3 2.1.3 3.2 0 12-8.7 22.8-23.6 22.8C14.6 52 5 42.4 5 29S14.6 6 27.7 6c7.5 0 13.9 2.7 18.5 7.2z" fill="#fff" opacity="0.95" />;
    case 'ALF':
      return <path d="M32 8 11 48h10.2l4-8h13.6l4 8H53zM29.1 31 32 25l2.9 6z" fill="#fff" opacity="0.95" />;
    case 'DEL':
      return <path d="M16 10h15c12 0 20 7.4 20 18s-8 18-20 18H16zm10 9v18h4.1c6.6 0 10.4-3.3 10.4-9S36.7 19 30.1 19z" fill="#fff" opacity="0.95" />;
    case 'OME':
      return <path d="M14 39c4-3.5 6.4-8.3 6.4-13.6 0-7 5.2-12.4 11.6-12.4 6.4 0 11.6 5.3 11.6 12.4 0 5.3 2.4 10.1 6.4 13.6V47H38.5v-8.5h-13V47H14z" fill="#fff" opacity="0.95" />;
    case 'SIG':
      return <path d="M12 17c3.8-6 10.1-9.5 17.9-9.5 7.2 0 12.8 2 18.1 6.4l-5.6 7c-4-3-7.4-4.2-12-4.2-4.6 0-7 1.3-7 3.5 0 2.5 2.4 3.3 9.7 4.7 12 2.3 17 6.1 17 14.3 0 8.9-7 14.6-19.3 14.6-8.7 0-15.6-2.5-21-7.5l6.2-6.7c4.5 3.4 9.2 5 14.7 5 4.9 0 7.8-1.5 7.8-4.2 0-2.4-2-3.5-9.2-4.9-11.9-2.2-17.3-5.6-17.3-14.1 0-1.8.4-3.3 1-4.9z" fill="#fff" opacity="0.95" />;
    default:
      return <text x="32" y="37" textAnchor="middle" fill="#fff" fontSize="20" fontWeight="800">{symbol.slice(0, 2)}</text>;
  }
};

export const TokenLogo = ({ symbol, size = 24, style }: TokenLogoProps) => {
  const colors = palette[symbol] || { a: '#64748b', b: '#334155', c: '#0f172a' };
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ display: 'block', borderRadius: '50%', ...style }}
    >
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={colors.a} />
          <stop offset="100%" stopColor={colors.b} />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="31" fill={colors.c} />
      <circle cx="32" cy="32" r="28" fill="url(#g)" opacity="0.28" />
      {glyphFor(symbol)}
    </svg>
  );
};

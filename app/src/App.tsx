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

const PROGRAM_ID = new PublicKey('CF3muRPHbkS9T7Qfu7GRH7ZLGH1hvWeSNS2PjJpXJMNW');
const network = WalletAdapterNetwork.Devnet;
const endpoint = clusterApiUrl(network);

interface TokenHolding {
  mint: PublicKey;
  amount: anchor.BN;
  confidence: number;
}

interface VaultState {
  owner: PublicKey;
  totalValue: anchor.BN;
  riskScore: number;
  holdings: TokenHolding[];
  lastUpdated: anchor.BN;
}

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
  const [agentTimerId, setAgentTimerId] = useState<number | null>(null);

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

  const vaultAddress = useMemo(async () => {
    if (!anchorWallet) return null;
    const [vaultPda] = await PublicKey.findProgramAddress(
      [Buffer.from('vault'), anchorWallet.publicKey!.toBuffer()],
      PROGRAM_ID,
    );
    return vaultPda;
  }, [anchorWallet]);

  const fetchMarketData = useCallback(async () => {
    try {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana,raydium,orca&vs_currencies=usd&include_24hr_change=true',
      );
      const data = await response.json();
      setMarket(data);
      return data;
    } catch (error) {
      console.error(error);
      setMarket({});
      return {};
    }
  }, []);

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
      setVault({
        owner: account.owner,
        totalValue: account.totalValue,
        riskScore: account.riskScore,
        holdings: account.holdings.map((item: any) => ({
          mint: item.mint,
          amount: item.amount,
          confidence: item.confidence,
        })),
        lastUpdated: account.lastUpdated,
      });
      setStatus('Vault loaded');
    } catch (error) {
      console.warn('Vault not found or failed to load', error);
      setVault(null);
      setStatus('Vault not created yet');
    } finally {
      setLoading(false);
    }
  }, [anchorWallet, program]);

  const createVault = useCallback(async () => {
    if (!program || !anchorWallet) return;
    setLoading(true);
    setStatus('Initializing vault...');
    try {
      const [vaultPda, bump] = await PublicKey.findProgramAddress(
        [Buffer.from('vault'), anchorWallet.publicKey!.toBuffer()],
        PROGRAM_ID,
      );
      await program.rpc.initializeVault({
        accounts: {
          vault: vaultPda,
          authority: anchorWallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
      });
      setStatus('Vault created successfully');
      await fetchVault();
    } catch (error) {
      console.error(error);
      setStatus('Failed to create vault');
    } finally {
      setLoading(false);
    }
  }, [anchorWallet, fetchVault, program]);

  const runAgentTick = useCallback(async () => {
    const currentMarket = await fetchMarketData();
    const solChange = currentMarket.solana?.usd_24h_change ?? 0;
    const rayChange = currentMarket.raydium?.usd_24h_change ?? 0;
    const orcaChange = currentMarket.orca?.usd_24h_change ?? 0;
    let action = 'hold';
    let message = 'Agent is watching the market.';

    if (solChange < -2.5) {
      action = 'sell';
      message = `AI recommends reducing risk: sell or hedge SOL. 24h change ${solChange.toFixed(2)}%.`;
    } else if (rayChange > 2.5) {
      action = 'buy';
      message = `AI recommends buying RAY on momentum. 24h change ${rayChange.toFixed(2)}%.`;
    } else if (orcaChange > 1.8) {
      action = 'buy';
      message = `AI recommends buying ORCA on positive momentum. 24h change ${orcaChange.toFixed(2)}%.`;
    } else {
      message = `AI recommends holding for now. SOL ${solChange.toFixed(2)}%, RAY ${rayChange.toFixed(2)}%, ORCA ${orcaChange.toFixed(2)}%.`;
    }

    setRecommendation(message);
    setStatus(`Agent last ran at ${new Date().toLocaleTimeString()}`);
    return action;
  }, [fetchMarketData]);

  const stopAgent = useCallback(() => {
    if (agentTimerId !== null) {
      window.clearInterval(agentTimerId);
      setAgentTimerId(null);
    }
    setAgentRunning(false);
    setStatus('Agent stopped.');
  }, [agentTimerId]);

  const startAgent = useCallback(async () => {
    if (agentRunning) return;
    const action = await runAgentTick();
    setAgentRunning(true);
    setStatus(`Agent running every ${agentIntervalMinutes} minute(s). Last action: ${action}.`);
    const timer = window.setInterval(async () => {
      const nextAction = await runAgentTick();
      setStatus(`Agent ran at ${new Date().toLocaleTimeString()}. Last action: ${nextAction}.`);
    }, agentIntervalMinutes * 60 * 1000);
    setAgentTimerId(timer);
  }, [agentRunning, agentIntervalMinutes, runAgentTick]);

  useEffect(() => {
    return () => {
      if (agentTimerId !== null) {
        window.clearInterval(agentTimerId);
      }
    };
  }, [agentTimerId]);

  useEffect(() => {
    fetchMarketData();
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
          {Object.keys(market).length === 0 ? (
            <p>Loading market indicators…</p>
          ) : (
            Object.entries(market).map(([symbol, data]) => (
              <div key={symbol} className="metric">
                <div>{symbol.toUpperCase()}</div>
                <div>${(data as any).usd.toFixed(2)} </div>
              </div>
            ))
          )}
        </section>

        <section className="card">
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
                  <span>Risk score</span>
                  <strong>{vault.riskScore}%</strong>
                </div>
                <div className="metric">
                  <span>Last updated</span>
                  <strong>{new Date(vault.lastUpdated.toNumber() * 1000).toLocaleString()}</strong>
                </div>
                <div style={{ marginTop: 16 }}>
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
            onClick={agentRunning ? stopAgent : startAgent}
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
        </div>
        <p>{recommendation}</p>
        <p>Agent status is controlled from this page and runs locally in the browser.</p>
        <pre style={{ background: 'rgba(255,255,255,0.04)', padding: 12, borderRadius: 12, whiteSpace: 'pre-wrap' }}>
          Agent interval: {agentIntervalMinutes} minute(s)
          {'\n'}Status: {status}
        </pre>
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

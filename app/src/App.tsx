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
const endpoint = clusterApiUrl(network);

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
  const [vaultEnabled, setVaultEnabled] = useState(false);
  const [agentAuthorityInput, setAgentAuthorityInput] = useState('');

  const AGENT_API_URL = import.meta.env.VITE_AGENT_API_URL || 'http://localhost:3001';

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
      const mode = account.mode === 0 ? 'safe' : 'risk';
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
      setVaultEnabled(account.enabled);
      setAgentAuthorityInput(account.agentAuthority.toBase58());
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
    setLoading(true);
    setStatus(`Setting vault mode to ${newMode}...`);
    try {
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
      setStatus('Failed to set vault mode');
    } finally {
      setLoading(false);
    }
  }, [program, anchorWallet, vault, fetchVault]);

  const setVaultAgentAuthority = useCallback(async () => {
    if (!program || !anchorWallet || !vault) return;

    let agentAuthority: PublicKey;
    try {
      agentAuthority = new PublicKey(agentAuthorityInput.trim());
    } catch {
      setStatus('Invalid agent authority public key');
      return;
    }

    setLoading(true);
    setStatus('Updating agent authority...');
    try {
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

      setStatus('Agent authority updated successfully');
      await fetchVault();
    } catch (error) {
      console.error('Failed to set agent authority:', error);
      setStatus('Failed to update agent authority');
    } finally {
      setLoading(false);
    }
  }, [program, anchorWallet, vault, agentAuthorityInput, fetchVault]);

  const callAgentApi = useCallback(async (path: string, method = 'GET', body?: any) => {
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
  }, [AGENT_API_URL]);

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

  const startRemoteAgent = useCallback(async () => {
    if (!anchorWallet) {
      setAgentStatus('Connect wallet first to select your vault owner address.');
      return;
    }

    const result = await callAgentApi('/api/agent/start', 'POST', {
      intervalMinutes: agentIntervalMinutes,
      vaultOwner: anchorWallet.publicKey.toBase58(),
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
    }
  }, [agentIntervalMinutes, anchorWallet, callAgentApi]);

  const stopRemoteAgent = useCallback(async () => {
    const result = await callAgentApi('/api/agent/stop', 'POST');
    if (result) {
      setAgentRunning(result.running);
      setAgentStatus(result.message);
    }
  }, [callAgentApi]);

  useEffect(() => {
    refreshAgentStatus();
  }, [refreshAgentStatus]);

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
                <div style={{ marginTop: 16, padding: '12px', background: 'rgba(255,255,255,0.04)', borderRadius: 12 }}>
                  <h3>Mode Control</h3>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="radio"
                        name="vaultMode"
                        value="safe"
                        checked={vaultMode === 'safe'}
                        onChange={() => toggleVaultMode('safe', vaultEnabled)}
                      />
                      Safe Mode
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="radio"
                        name="vaultMode"
                        value="risk"
                        checked={vaultMode === 'risk'}
                        onChange={() => toggleVaultMode('risk', vaultEnabled)}
                      />
                      Risk Mode
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span>Agent Enabled:</span>
                    <button
                      onClick={() => toggleVaultMode(vaultMode, !vaultEnabled)}
                      style={{
                        background: vaultEnabled ? '#16a34a' : '#7c3aed',
                        color: '#fff',
                        border: 'none',
                        padding: '8px 16px',
                        borderRadius: 8,
                        cursor: 'pointer',
                      }}
                    >
                      {vaultEnabled ? 'ON' : 'OFF'}
                    </button>
                    <span style={{ fontSize: '0.9em', color: '#9ca3af' }}>
                      {vaultMode === 'safe' ? '🛡️ Preserve balance' : '⚡ Active trading'}
                    </span>
                  </div>
                  <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
                    <div style={{ fontSize: '0.9em', color: '#9ca3af' }}>
                      Agent authority for this vault: {vault.agentAuthority.toBase58()}
                    </div>
                    <input
                      value={agentAuthorityInput}
                      onChange={(event) => setAgentAuthorityInput(event.target.value)}
                      placeholder="Paste backend agent wallet public key"
                      style={{
                        padding: '10px',
                        borderRadius: 10,
                        border: '1px solid rgba(255,255,255,0.16)',
                        background: 'rgba(255,255,255,0.06)',
                        color: '#fff',
                      }}
                    />
                    <button
                      onClick={setVaultAgentAuthority}
                      disabled={loading || !agentAuthorityInput.trim()}
                      style={{ background: '#0ea5e9', color: '#fff' }}
                    >
                      Set Agent Authority
                    </button>
                  </div>
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
        </div>
        <p>{recommendation}</p>
        <p>Agent status is controlled from this page and runs on your backend service.</p>
        <pre style={{ background: 'rgba(255,255,255,0.04)', padding: 12, borderRadius: 12, whiteSpace: 'pre-wrap' }}>
          Agent interval: {agentIntervalMinutes} minute(s)
          {'\n'}Status: {agentStatus}
          {'\n'}Agent wallet: {backendAgentWallet || 'Unknown'}
          {'\n'}Backend URL: {AGENT_API_URL}
        </pre>
        {!agentReady && (
          <p style={{ color: '#f59e0b' }}>Make sure the AI agent backend is running at {AGENT_API_URL}</p>
        )}
      </section>

      <section className="card">
        <h2>Diagnostic Info</h2>
        <div style={{ fontSize: '0.9em', fontFamily: 'monospace', color: '#9ca3af' }}>
          <div>Network: Devnet</div>
          <div>Program: {PROGRAM_ID.toBase58().slice(0, 12)}...</div>
          <div>Wallet: {wallet.connected ? anchorWallet?.publicKey?.toBase58().slice(0, 12) + '...' : 'Not connected'}</div>
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

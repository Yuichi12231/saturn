# Saturn

An AI-powered Solana asset management demo with a Phantom-connected web interface, on-chain Vault state, and an off-chain AI agent that can execute trading decisions.

## Architecture

- `programs/vault-ai`: Anchor smart contract storing a Vault account, token holdings, risk score, and trade execution logic.
- `app`: Vite React frontend for Phantom wallet connection, market overview, and on-chain vault visualization.
- `ai-agent`: Off-chain agent that monitors market data and submits trading recommendations to the contract.

## Features

- Phantom wallet integration in the browser
- On-chain Vault account initialization and state tracking
- Real SOL deposit and withdrawal into the on-chain vault account
- Market indicator visualization from CoinGecko
- AI agent logic that decides whether to buy or sell based on market momentum and risk
- Demonstrates the AI -> on-chain transaction -> smart contract state flow

## Getting started

### Prerequisites

1. Install [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools)
2. Install [Node.js 16+](https://nodejs.org/)
3. Create a Devnet wallet:
   ```bash
   solana-keygen new --outfile ~/.config/solana/devnet-wallet.json
   solana config set --keypair ~/.config/solana/devnet-wallet.json
   solana config set --url devnet
   ```
4. Request devnet SOL (airdrop):
   ```bash
   solana airdrop 10
   ```

### Deploy smart contract to devnet

**Quick start (automated):**
```bash
./deploy-devnet.sh
```

Or **manual deployment**:
```bash
cd programs/vault-ai
anchor build
anchor deploy --provider.cluster devnet
```

After deployment, update the `PROGRAM_ID` constant in:
- `app/src/App.tsx` (line ~22)
- `ai-agent/src/agent.ts` (line ~10)

### Setup and run

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create `.env` in `ai-agent/` with your API keys (see `ai-agent/.env.example`).

3. Switch Phantom wallet to **Devnet** in wallet settings.

4. Run frontend:
   ```bash
   npm run dev
   ```

5. In another terminal, start the AI agent backend:
   ```bash
   cd ai-agent
   npm start
   ```

## How to use Saturn

1. **Connect wallet** — Click "Select Wallet" and connect Phantom (ensure devnet is selected).
2. **Create Vault** — Click "Create Vault" to initialize your on-chain vault for trading.
3. **Fund Vault (SOL)** — Deposit SOL into vault using the Deposit button in the UI.
4. **Choose Mode** — Select **Safe Mode** (preserve balance) or **Risk Mode** (active trading), then click **Apply Mode**.
5. **Start Backend Agent** — Click "Start Agent" to auto-sync authority and activate market monitoring for your vault.

The AI agent will:
- Monitor Solana market data via CoinGecko, Helius, and BirdEye APIs.
- Use OpenAI to generate trading decisions based on market signals.
- Execute buy/sell trades on-chain for SOL, RAY, and ORCA tokens.
- Update your Vault risk score and holdings on-chain.
- Respect your mode: Safe = minimal trades, Risk = active trading.

Important for full automation mode:
- The backend agent signs transactions with its own wallet.
- Your vault must delegate permission to that wallet via **Set Agent Authority** in the UI.
- Start Agent sends your connected wallet address as vault owner to backend scheduling.


## Environment variables

The AI agent uses the following variables:

- `AGENT_WALLET_SECRET_KEY` — your agent wallet secret key as a comma-separated 64-byte array or base58 string
- `OPENAI_API_KEY` — OpenAI API key for decision generation
- `HELIUS_API_KEY` — Helius API key for Solana on-chain signal data
- `BIRDEYE_API_KEY` — BirdEye API key for broader Solana market and DeFi metrics
- `VAULT_OWNER` — optional, only for `npm run run-once`; set the owner wallet public key

Do not commit your `.env` file to source control.

## Deployment

- Frontend: build the static site with `npm run deploy:app` and deploy the `app/dist` folder to your hosting platform (Vercel, Netlify, or any static site host).
- AI agent: deploy as a separate service or worker that runs `npm run deploy:agent` with the required environment variables configured as secrets.

### Permanent AI Agent URL (Render)

This repository includes a Render Blueprint in `render.yaml`.

1. Open:
   `https://render.com/deploy?repo=https://github.com/Yuichi12231/saturn`
2. Select service `saturn-ai-agent`.
3. Fill required secrets:
   - `OPENAI_API_KEY`
   - `HELIUS_API_KEY`
   - `BIRDEYE_API_KEY`
   - `AGENT_WALLET_SECRET_KEY`
4. Deploy.
5. Copy the Render service URL, e.g. `https://saturn-ai-agent.onrender.com`.
6. Set frontend env var in Vercel:
   - Name: `VITE_AGENT_API_URL`
   - Value: your Render URL
7. Redeploy Vercel frontend.

### Alternative: Railway Deployment

If Render asks for billing details in your region, you can deploy `ai-agent` on Railway.

1. Open Railway and create a new project from GitHub repo `Yuichi12231/saturn`.
2. If Railway UI supports **Root Directory**, set it to `ai-agent`.
3. If Railway UI does **not** show Root Directory (common in some layouts), just deploy from repo root:
   - The root `Dockerfile` is configured to run `ai-agent`.
   - Root `railway.json` sets healthcheck/restart policy.
4. Add required environment variables:
   - `OPENAI_API_KEY`
   - `HELIUS_API_KEY`
   - `BIRDEYE_API_KEY`
   - `AGENT_WALLET_SECRET_KEY`
5. Deploy and copy the generated Railway URL.
6. Verify backend:
   - `https://<your-railway-domain>/api/agent/status`   - `https://<your-railway-domain>/api/agent/health`7. Set `VITE_AGENT_API_URL` in Vercel to that Railway URL.
8. Redeploy Vercel frontend.

## Notes

- The smart contract uses a PDA vault account derived from `['vault', authority]`.
- The AI agent is a simplified automated component that can be extended with real ML models or API-driven decision logic.
- This scaffold demonstrates hybrid AI + Web3 functionality while keeping the core integration clear.

# Saturn

An AI-powered Solana asset management demo with a Phantom-connected web interface, on-chain Vault state, and an off-chain AI agent that can execute trading decisions.

## Architecture

- `programs/vault-ai`: Anchor smart contract storing a Vault account, token holdings, risk score, and trade execution logic.
- `app`: Vite React frontend for Phantom wallet connection, market overview, and on-chain vault visualization.
- `ai-agent`: Off-chain agent that monitors market data and submits trading recommendations to the contract.

## Features

- Phantom wallet integration in the browser
- On-chain Vault account initialization and state tracking
- Market indicator visualization from CoinGecko
- AI agent logic that decides whether to buy or sell based on market momentum and risk
- Demonstrates the AI → on-chain transaction → smart contract state flow

## Getting started

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file in `ai-agent` based on `ai-agent/.env.example`.

3. Run the frontend:

```bash
npm run dev
```

4. Run the AI agent:

```bash
npm run agent
```

## Environment variables

The AI agent uses the following variables:

- `AGENT_WALLET_SECRET_KEY` — your agent wallet secret key as a comma-separated 64-byte array or base58 string
- `OPENAI_API_KEY` — OpenAI API key for decision generation
- `HELIUS_API_KEY` — Helius API key for Solana on-chain signal data
- `BIRDEYE_API_KEY` — BirdEye API key for broader Solana market and DeFi metrics

Do not commit your `.env` file to source control.

## Deployment

- Frontend: build the static site with `npm run deploy:app` and deploy the `app/dist` folder to your hosting platform (Vercel, Netlify, or any static site host).
- AI agent: deploy as a separate service or worker that runs `npm run deploy:agent` with the required environment variables configured as secrets.

## Notes

- The smart contract uses a PDA vault account derived from `['vault', authority]`.
- The AI agent is a simplified automated component that can be extended with real ML models or API-driven decision logic.
- This scaffold demonstrates hybrid AI + Web3 functionality while keeping the core integration clear.

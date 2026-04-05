#!/bin/bash
set -e

echo "🚀 Saturn - Smart Contract Deployment to Devnet"
echo "================================================"
echo ""

# Check prerequisites
if ! command -v solana &> /dev/null; then
  echo "❌ Solana CLI not found. Install it: https://docs.solana.com/cli/install-solana-cli-tools"
  exit 1
fi

if ! command -v anchor &> /dev/null; then
  echo "❌ Anchor CLI not found. Install it: npm install -g @project-serum/anchor-cli"
  exit 1
fi

# Set cluster
echo "📡 Setting Solana CLI to devnet..."
solana config set --url devnet

# Check wallet balance
WALLET=$(solana config get | grep "Keypair Path" | awk '{print $3}')
BALANCE=$(solana balance)
echo "💾 Wallet: $WALLET"
echo "💰 Balance: $BALANCE"

if [[ "$BALANCE" == *"0 SOL"* ]]; then
  echo "⏳ Requesting airdrop..."
  solana airdrop 5
fi

# Build and deploy
echo ""
echo "🔨 Building smart contract..."
cd programs/vault-ai
anchor build

echo "🚀 Deploying to devnet..."
DEPLOY_OUTPUT=$(anchor deploy --provider.cluster devnet 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract program ID
PROGRAM_ID=$(echo "$DEPLOY_OUTPUT" | grep "Program Id:" | awk '{print $NF}' | tr -d '"')

if [ -z "$PROGRAM_ID" ]; then
  echo "⚠️  Could not extract Program ID from deployment output."
  echo "   Please find it in the output above and update:"
  echo "   - app/src/App.tsx (PROGRAM_ID constant)"
  echo "   - ai-agent/src/agent.ts (PROGRAM_ID constant)"
else
  echo ""
  echo "✅ Deployment successful!"
  echo "📍 Program ID: $PROGRAM_ID"
  echo ""
  echo "📝 Update these files with the new Program ID:"
  echo "   1. app/src/App.tsx (line ~22)"
  echo "   2. ai-agent/src/agent.ts (line ~10)"
  echo ""
  echo "Then run:"
  echo "   npm run dev        # Frontend"
  echo "   cd ai-agent && npm start  # Backend agent"
fi

cd ../..

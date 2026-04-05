#!/bin/bash
set -e

echo "🚀 Manual Solana CLI Installation for WSL"
echo "=========================================="

# Create temp directory
mkdir -p /tmp/solana-install
cd /tmp/solana-install

echo "📥 Downloading Solana CLI v1.18.0..."
wget -O solana-release.tar.bz2 https://github.com/solana-labs/solana/releases/download/v1.18.0/solana-release-x86_64-unknown-linux-gnu.tar.bz2

echo "📦 Extracting..."
tar jxf solana-release.tar.bz2

echo "🔧 Installing to /usr/local/solana..."
sudo mkdir -p /usr/local/solana
sudo cp -r solana-release/* /usr/local/solana/

echo "🔗 Adding to PATH..."
echo 'export PATH="/usr/local/solana/bin:$PATH"' >> ~/.bashrc
export PATH="/usr/local/solana/bin:$PATH"

echo "✅ Solana CLI installed!"
echo "🔄 Restart your shell or run: source ~/.bashrc"
echo ""
echo "Test installation:"
solana --version

echo ""
echo "Next steps:"
echo "1. solana config set --url devnet"
echo "2. solana-keygen new --outfile ~/.config/solana/devnet-wallet.json"
echo "3. solana airdrop 5"
echo "4. cd /path/to/saturn/programs/vault-ai"
echo "5. anchor build"
echo "6. anchor deploy --provider.cluster devnet"
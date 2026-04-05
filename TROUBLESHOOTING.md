# Saturn - Troubleshooting Guide

## "Failed to create vault" on Phantom wallet

### Root causes and solutions:

**1. Program not deployed on devnet**
- **Error**: "Program not deployed at CF3m...SJ2Pj on devnet"
- **Solution**: 
  ```bash
  ./deploy-devnet.sh
  ```
  Then update `PROGRAM_ID` in `app/src/App.tsx` line 22

**2. Wallet balance too low**
- **Error**: "Low balance: 0.0001 SOL. Need at least 0.005 SOL"
- **Solution**:
  ```bash
  solana airdrop 5
  ```

**3. Phantom wallet on Mainnet instead of Devnet**
- **Solution**: Open Phantom wallet → Click network name (top) → Select "Devnet"

**4. Anchor/wallet provider not initialized**
- **Error**: "Wallet or program not connected"
- **Solution**: 
  - Make sure Phantom is connected (click "Select Wallet")
  - Wallet must be on devnet
  - Refresh the page

**5. Network RPC error**
- **Error**: Transaction failed with RPC error
- **Solution**:
  - Check internet connection
  - Verify `clusterApiUrl('devnet')` is responding
  - Try again in 30 seconds

## "Agent backend not connected"

**Solution**: Make sure AI agent backend is running:
```bash
cd ai-agent
npm start
```

Backend should output: `AI agent backend listening on http://localhost:3001`

## Checking wallet balance on-site

Click "💾 Click to check wallet balance" in the Diagnostic Info section to see current balance without leaving the app.

## Debugging commands

```bash
# Check Solana wallet and balance
solana config get
solana balance

# Verify program is deployed
solana program show csiotTu5ChbPzzjnpbNyWkfAQmyRNqTvLw362xUkn8y

# Test backend agent
curl http://localhost:3001/api/agent/status
```

## Still stuck?

Check browser console (F12) for error details and share:
- Network type (mainnet/devnet)
- Phantom wallet address
- Full error message from console

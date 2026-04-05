use anchor_lang::prelude::*;

declare_id!("CF3muRPHbkS9T7Qfu7GRH7ZLGH1hvWeSNS2PjJpXJMNW");

#[program]
pub mod vault_ai {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = *ctx.accounts.authority.key;
        vault.total_value = 0;
        vault.risk_score = 50;
        vault.holdings = Vec::new();
        vault.last_updated = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn execute_trade(
        ctx: Context<ExecuteTrade>,
        mint: Pubkey,
        amount: u64,
        buy: bool,
        new_risk_score: u8,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.owner == *ctx.accounts.authority.key, VaultError::Unauthorized);
        vault.risk_score = new_risk_score;
        vault.last_updated = Clock::get()?.unix_timestamp;

        if buy {
            if let Some(entry) = vault.holdings.iter_mut().find(|item| item.mint == mint) {
                entry.amount = entry.amount.saturating_add(amount);
            } else {
                vault.holdings.push(TokenHolding {
                    mint,
                    amount,
                    confidence: 100,
                });
            }
        } else {
            if let Some(entry) = vault.holdings.iter_mut().find(|item| item.mint == mint) {
                entry.amount = entry.amount.saturating_sub(amount);
                if entry.amount == 0 {
                    vault.holdings.retain(|item| item.amount > 0);
                }
            }
        }

        vault.total_value = vault
            .holdings
            .iter()
            .map(|h| h.amount)
            .sum();

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = Vault::MAX_SIZE,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteTrade<'info> {
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}

#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub total_value: u64,
    pub risk_score: u8,
    pub holdings: Vec<TokenHolding>,
    pub last_updated: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TokenHolding {
    pub mint: Pubkey,
    pub amount: u64,
    pub confidence: u8,
}

impl Vault {
    pub const MAX_HOLDINGS: usize = 8;
    pub const MAX_SIZE: usize = 8 + 32 + 8 + 1 + 4 + Self::MAX_HOLDINGS * (32 + 8 + 1) + 8;
}

#[error_code]
pub enum VaultError {
    #[msg("Only the vault owner can execute this instruction.")]
    Unauthorized,
}

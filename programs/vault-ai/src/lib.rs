use anchor_lang::prelude::*;

declare_id!("csiotTu5ChbPzzjnpbNyWkfAQmyRNqTvLw362xUkn8y");

#[program]
pub mod vault_ai {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = *ctx.accounts.authority.key;
        vault.agent_authority = *ctx.accounts.authority.key;
        vault.vault_sol_balance = 0;
        vault.total_value = 0;
        vault.risk_score = 50;
        vault.mode = VaultMode::Safe as u8;
        vault.enabled = false;
        vault.holdings = Vec::new();
        vault.last_updated = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn set_agent_authority(ctx: Context<SetAgentAuthority>, agent_authority: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.owner == *ctx.accounts.authority.key, VaultError::Unauthorized);
        vault.agent_authority = agent_authority;
        vault.last_updated = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn set_vault_mode(ctx: Context<SetVaultMode>, mode: u8, enabled: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.owner == *ctx.accounts.authority.key, VaultError::Unauthorized);
        require!(mode <= 1, VaultError::InvalidMode);
        vault.mode = mode;
        vault.enabled = enabled;
        vault.last_updated = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        let vault = &mut ctx.accounts.vault;
        require!(vault.owner == *ctx.accounts.authority.key, VaultError::Unauthorized);

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: vault.to_account_info(),
                },
            ),
            amount,
        )?;

        vault.vault_sol_balance = vault.vault_sol_balance.saturating_add(amount);
        vault.total_value = vault
            .vault_sol_balance
            .saturating_add(vault.holdings.iter().map(|h| h.amount).sum());
        vault.last_updated = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        let vault = &mut ctx.accounts.vault;
        require!(vault.owner == *ctx.accounts.authority.key, VaultError::Unauthorized);
        require!(vault.vault_sol_balance >= amount, VaultError::InsufficientVaultBalance);

        let vault_info = vault.to_account_info();
        let authority_info = ctx.accounts.authority.to_account_info();
        let current_lamports = **vault_info.lamports.borrow();
        let rent_exempt_minimum = Rent::get()?.minimum_balance(vault_info.data_len());
        require!(
            current_lamports.saturating_sub(amount) >= rent_exempt_minimum,
            VaultError::InsufficientVaultBalance
        );

        **vault_info.try_borrow_mut_lamports()? = current_lamports
            .checked_sub(amount)
            .ok_or(VaultError::InsufficientVaultBalance)?;

        let authority_lamports = **authority_info.lamports.borrow();
        **authority_info.try_borrow_mut_lamports()? = authority_lamports
            .checked_add(amount)
            .ok_or(VaultError::InvalidAmount)?;

        vault.vault_sol_balance = vault.vault_sol_balance.saturating_sub(amount);
        vault.total_value = vault
            .vault_sol_balance
            .saturating_add(vault.holdings.iter().map(|h| h.amount).sum());
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
        let signer = *ctx.accounts.authority.key;
        require!(
            vault.owner == signer || vault.agent_authority == signer,
            VaultError::Unauthorized
        );
        require!(vault.enabled, VaultError::VaultNotEnabled);
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
            .vault_sol_balance
            .saturating_add(vault.holdings.iter().map(|h| h.amount).sum());

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
pub struct SetVaultMode<'info> {
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetAgentAuthority<'info> {
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteTrade<'info> {
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub agent_authority: Pubkey,
    pub vault_sol_balance: u64,
    pub total_value: u64,
    pub risk_score: u8,
    pub mode: u8,
    pub enabled: bool,
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
    pub const MAX_SIZE: usize = 8 + 32 + 32 + 8 + 8 + 1 + 1 + 1 + 4 + Self::MAX_HOLDINGS * (32 + 8 + 1) + 8;
}

#[repr(u8)]
pub enum VaultMode {
    Safe = 0,
    Risk = 1,
}

#[error_code]
pub enum VaultError {
    #[msg("Only the vault owner can execute this instruction.")]
    Unauthorized,
    #[msg("Invalid vault mode.")]
    InvalidMode,
    #[msg("Vault is not enabled for trading.")]
    VaultNotEnabled,
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Vault does not have enough SOL balance for this operation.")]
    InsufficientVaultBalance,
}

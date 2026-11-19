//! Spike S2 (throwaway): can a PDA of another program be a pm-AMM market authority?
//!
//! `Authority` (`["authority"]`, no data, System-owned) signs `initialize_market`,
//! `deposit_liquidity` and `resolve_market` through `invoke_signed`. It pays the market's
//! rent and funds the seed from its own collateral ATA (the treasury). No access control:
//! this program never runs outside the spike.
use anchor_lang::prelude::*;

declare_id!("9CLcuW2xyrNUMCrXKP54uWgSMWz5TEgFYfmG8vWGYTTE");

declare_program!(pm_amm);

use pm_amm::cpi::accounts::{DepositLiquidity, InitializeMarket, ResolveMarket};
use pm_amm::program::PmAmm;
use pm_amm::types::Side;

pub const AUTHORITY_SEED: &[u8] = b"authority";

#[program]
pub mod horagon_spike {
    use super::*;

    /// CPI `initialize_market`, then CPI `deposit_liquidity(seed_amount)` from the treasury.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u64,
        end_ts: i64,
        name: String,
        initial_price_bps: u16,
        seed_amount: u64,
    ) -> Result<()> {
        let bump = [ctx.bumps.authority];
        let seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        let a = &ctx.accounts;

        pm_amm::cpi::initialize_market(
            CpiContext::new_with_signer(
                a.pm_amm_program.key(),
                InitializeMarket {
                    authority: a.authority.to_account_info(),
                    market: a.market.to_account_info(),
                    collateral_mint: a.collateral_mint.to_account_info(),
                    yes_mint: a.yes_mint.to_account_info(),
                    no_mint: a.no_mint.to_account_info(),
                    vault: a.vault.to_account_info(),
                    yes_metadata: a.yes_metadata.to_account_info(),
                    no_metadata: a.no_metadata.to_account_info(),
                    token_metadata_program: a.token_metadata_program.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                    rent: a.rent.to_account_info(),
                },
                seeds,
            ),
            market_id,
            end_ts,
            name,
            initial_price_bps,
        )?;

        pm_amm::cpi::deposit_liquidity(
            CpiContext::new_with_signer(
                a.pm_amm_program.key(),
                DepositLiquidity {
                    signer: a.authority.to_account_info(),
                    market: a.market.to_account_info(),
                    collateral_mint: a.collateral_mint.to_account_info(),
                    vault: a.vault.to_account_info(),
                    user_collateral: a.treasury.to_account_info(),
                    lp_position: a.lp_position.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                },
                seeds,
            ),
            seed_amount,
        )
    }

    /// CPI `resolve_market`, signed by the Authority PDA.
    pub fn resolve(ctx: Context<Resolve>, yes_wins: bool) -> Result<()> {
        let bump = [ctx.bumps.authority];
        let seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        let side = if yes_wins { Side::Yes } else { Side::No };
        pm_amm::cpi::resolve_market(
            CpiContext::new_with_signer(
                ctx.accounts.pm_amm_program.key(),
                ResolveMarket {
                    signer: ctx.accounts.authority.to_account_info(),
                    market: ctx.accounts.market.to_account_info(),
                },
                seeds,
            ),
            side,
        )
    }
}

// Account order is part of the spike's wire format: spikes/src/s2-cpi.ts lists them in this order.
#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut, seeds = [AUTHORITY_SEED], bump)]
    pub authority: SystemAccount<'info>,
    /// CHECK: pm-AMM creates and validates it (PDA `["market", market_id]` of pm-AMM).
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: pm-AMM validates the collateral mint.
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: pm-AMM creates and validates it.
    #[account(mut)]
    pub yes_mint: UncheckedAccount<'info>,
    /// CHECK: pm-AMM creates and validates it.
    #[account(mut)]
    pub no_mint: UncheckedAccount<'info>,
    /// CHECK: pm-AMM creates and validates it.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Metaplex creates and validates it.
    #[account(mut)]
    pub yes_metadata: UncheckedAccount<'info>,
    /// CHECK: Metaplex creates and validates it.
    #[account(mut)]
    pub no_metadata: UncheckedAccount<'info>,
    /// CHECK: the Authority's collateral ATA; pm-AMM checks owner and mint.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: pm-AMM creates it (PDA `["lp", market, authority]` of pm-AMM).
    #[account(mut)]
    pub lp_position: UncheckedAccount<'info>,
    /// CHECK: pm-AMM checks the Metaplex program address.
    pub token_metadata_program: UncheckedAccount<'info>,
    pub pm_amm_program: Program<'info, PmAmm>,
    pub system_program: Program<'info, System>,
    /// CHECK: pm-AMM checks the SPL Token program address.
    pub token_program: UncheckedAccount<'info>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: SystemAccount<'info>,
    /// CHECK: pm-AMM checks that `authority` is this market's authority.
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    pub pm_amm_program: Program<'info, PmAmm>,
}

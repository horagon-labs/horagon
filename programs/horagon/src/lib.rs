//! Horagon (spec section 5). One PDA, `Authority` (`["authority"]`, no data, System-owned),
//! is the authority and sole LP of every Horagon pm-AMM market and signs every CPI into
//! pm-AMM. `GameMarket` records each market; results go propose -> (challenge) -> finalize,
//! and `recycle` brings the leftover mUSDC back to the treasury.
//!
//! Account order and argument layout are a wire format: `@horagon/sdk/program` encodes them
//! by hand, and its tests compare against the IDL this crate generates.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

pub mod errors;
pub mod events;
pub mod state;

use errors::HoragonError;
use events::*;
use state::*;

// Placeholder: the first `anchor build` creates target/deploy/horagon-keypair.json and
// `anchor keys sync` writes its address here and into Anchor.toml.
declare_id!("HtDJ3vfx8vtFSmskm2Ks39kBMuDmFZH3H2B173BB9qHF");

declare_program!(pm_amm);

use pm_amm::cpi::accounts::{
    ClaimLpResiduals, ClaimWinnings, DepositLiquidity, InitializeMarket, ResolveMarket,
    WithdrawLiquidity,
};
use pm_amm::program::PmAmm;
use pm_amm::types::Side as PmSide;

pub const CONFIG_SEED: &[u8] = b"config";
pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const GAME_MARKET_SEED: &[u8] = b"game_market";
/// pm-AMM's PDAs (idls/pm_amm.json): `["lp", market, owner]`, `["yes_mint", market]`,
/// `["no_mint", market]`. Pinning them keeps a caller from steering halt and recycle.
pub const PM_LP_SEED: &[u8] = b"lp";
pub const PM_YES_MINT_SEED: &[u8] = b"yes_mint";
pub const PM_NO_MINT_SEED: &[u8] = b"no_mint";
/// pm-AMM refuses end_ts closer than 300 s (InvalidMarketDuration); fail earlier and clearer.
pub const MIN_MARKET_SECS: i64 = 300;
pub const MIN_PRICE_BPS: u16 = 500;
pub const MAX_PRICE_BPS: u16 = 9_500;
/// finalize reads the window at call time, so a floor keeps every proposal challengeable.
pub const MIN_DISPUTE_WINDOW_SECS: u32 = 60;
pub const MAX_DISPUTE_WINDOW_SECS: u32 = 7 * 24 * 3600;
/// `shares: u128` in a pm-AMM LpPosition follows the discriminator, `owner` and `market`.
const LP_SHARES_OFFSET: usize = 8 + 32 + 32;

fn pm_side(outcome: Outcome) -> PmSide {
    match outcome {
        Outcome::Yes => PmSide::Yes,
        Outcome::No => PmSide::No,
    }
}

/// Shares of the Authority's LpPosition, or None when a full withdrawal closed it.
fn lp_shares(lp: &AccountInfo, market: &Pubkey, owner: &Pubkey) -> Result<Option<u128>> {
    if lp.data_is_empty() {
        return Ok(None);
    }
    require_keys_eq!(*lp.owner, pm_amm::ID, HoragonError::BadLpPosition);
    let data = lp.try_borrow_data()?;
    require!(data.len() >= LP_SHARES_OFFSET + 16, HoragonError::BadLpPosition);
    require!(
        data[8..40] == owner.to_bytes() && data[40..72] == market.to_bytes(),
        HoragonError::BadLpPosition
    );
    let mut shares = [0u8; 16];
    shares.copy_from_slice(&data[LP_SHARES_OFFSET..LP_SHARES_OFFSET + 16]);
    Ok(Some(u128::from_le_bytes(shares)))
}

#[program]
pub mod horagon {
    use super::*;

    /// Once, by the program's upgrade authority, who becomes `admin`.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        require!(
            (MIN_DISPUTE_WINDOW_SECS..=MAX_DISPUTE_WINDOW_SECS).contains(&args.dispute_window_secs),
            HoragonError::InvalidArgument
        );
        ctx.accounts.config.set_inner(Config {
            admin: ctx.accounts.admin.key(),
            attestor: args.attestor,
            guardians: args.guardians,
            dispute_window_secs: args.dispute_window_secs,
            collateral_mint: args.collateral_mint,
            creation_paused: false,
            bump: ctx.bumps.config,
        });
        Ok(())
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(attestor) = args.attestor {
            config.attestor = attestor;
        }
        if let Some(guardians) = args.guardians {
            config.guardians = guardians;
        }
        if let Some(window) = args.dispute_window_secs {
            require!(
                (MIN_DISPUTE_WINDOW_SECS..=MAX_DISPUTE_WINDOW_SECS).contains(&window),
                HoragonError::InvalidArgument
            );
            config.dispute_window_secs = window;
        }
        if let Some(paused) = args.creation_paused {
            config.creation_paused = paused;
        }
        Ok(())
    }

    /// CPI `initialize_market` (the Authority signs and pays the rent), then CPI
    /// `deposit_liquidity(seed_amount)` from the treasury, then record the GameMarket.
    pub fn create_game_market(
        ctx: Context<CreateGameMarket>,
        args: CreateGameMarketArgs,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.config.creation_paused, HoragonError::CreationPaused);
        require!(args.kind <= 1, HoragonError::InvalidArgument);
        require!(
            !args.external_game_id.is_empty() && args.external_game_id.len() <= MAX_EXTERNAL_ID_LEN,
            HoragonError::InvalidArgument
        );
        require!(
            !args.name.is_empty() && args.name.len() <= MAX_MARKET_NAME_LEN,
            HoragonError::InvalidArgument
        );
        require!(
            (MIN_PRICE_BPS..=MAX_PRICE_BPS).contains(&args.initial_price_bps),
            HoragonError::PriceOutOfRange
        );
        require!(
            args.end_ts.saturating_sub(now) >= MIN_MARKET_SECS,
            HoragonError::EndTooSoon
        );
        require!(
            args.seed_amount > 0 && ctx.accounts.treasury.amount >= args.seed_amount,
            HoragonError::InsufficientTreasury
        );

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
            args.market_id,
            args.end_ts,
            args.name.clone(),
            args.initial_price_bps,
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
            args.seed_amount,
        )?;

        let market = ctx.accounts.market.key();
        let game_market_key = ctx.accounts.game_market.key();
        ctx.accounts.game_market.set_inner(GameMarket {
            market,
            market_id: args.market_id,
            kind: args.kind,
            league: args.league,
            external_game_id: args.external_game_id,
            home: args.home,
            away: args.away,
            scheduled_tipoff: args.scheduled_tipoff,
            end_ts: args.end_ts,
            seed_amount: args.seed_amount,
            status: MarketStatus::Open,
            proposed_outcome: None,
            evidence_hash: [0u8; 32],
            evidence_uri: String::new(),
            proposed_at: 0,
            proposer: Pubkey::default(),
            challenge_count: 0,
            finalized_at: 0,
            bump: ctx.bumps.game_market,
        });
        emit!(GameMarketCreated {
            game_market: game_market_key,
            market,
            market_id: args.market_id,
            kind: args.kind,
            end_ts: args.end_ts,
            seed_amount: args.seed_amount,
            initial_price_bps: args.initial_price_bps,
        });
        Ok(())
    }

    /// The only kill switch: withdraw all of the Authority's liquidity, so swaps fail with
    /// InsufficientLiquidity. YES and NO land in the Authority's ATAs. An external LP's share
    /// stays in the pool (spec section 5.2).
    pub fn halt(ctx: Context<Halt>) -> Result<()> {
        let a = &ctx.accounts;
        require!(
            a.config.is_attestor_or_guardian(&a.signer.key()),
            HoragonError::Unauthorized
        );
        require!(a.game_market.status == MarketStatus::Open, HoragonError::BadStatus);
        // While Open, the Authority's LpPosition holds the seed's shares. Setting Halted without
        // a withdrawal would leave trading on, and halt could never run again.
        let shares =
            lp_shares(&a.lp_position.to_account_info(), &a.market.key(), &a.authority.key())?
                .unwrap_or(0);
        require!(shares > 0, HoragonError::BadLpPosition);
        let bump = [ctx.bumps.authority];
        let seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        pm_amm::cpi::withdraw_liquidity(
            CpiContext::new_with_signer(
                a.pm_amm_program.key(),
                WithdrawLiquidity {
                    signer: a.authority.to_account_info(),
                    market: a.market.to_account_info(),
                    collateral_mint: a.collateral_mint.to_account_info(),
                    yes_mint: a.yes_mint.to_account_info(),
                    no_mint: a.no_mint.to_account_info(),
                    lp_position: a.lp_position.to_account_info(),
                    user_yes: a.authority_yes.to_account_info(),
                    user_no: a.authority_no.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                },
                seeds,
            ),
            shares,
        )?;
        let by = a.signer.key();
        let game_market = &mut ctx.accounts.game_market;
        game_market.status = MarketStatus::Halted;
        emit!(MarketHalted {
            game_market: game_market.key(),
            market: game_market.market,
            by,
            shares,
        });
        Ok(())
    }

    /// Record the result and its evidence. Guardians may propose too, so that after a
    /// challenge the right result goes in at once (spec section 5.2).
    pub fn propose_result(ctx: Context<ProposeResult>, args: ProposeResultArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let signer = ctx.accounts.signer.key();
        require!(
            ctx.accounts.config.is_attestor_or_guardian(&signer),
            HoragonError::Unauthorized
        );
        require!(
            args.evidence_hash != [0u8; 32]
                && !args.evidence_uri.is_empty()
                && args.evidence_uri.len() <= MAX_EVIDENCE_URI_LEN,
            HoragonError::InvalidArgument
        );
        let game_market = &mut ctx.accounts.game_market;
        require!(now >= game_market.end_ts, HoragonError::TooEarly);
        require!(
            matches!(
                game_market.status,
                MarketStatus::Open | MarketStatus::Halted | MarketStatus::Challenged
            ),
            HoragonError::BadStatus
        );
        game_market.proposed_outcome = Some(args.outcome);
        game_market.evidence_hash = args.evidence_hash;
        game_market.evidence_uri = args.evidence_uri;
        game_market.proposed_at = now;
        game_market.proposer = signer;
        game_market.status = MarketStatus::Proposed;
        emit!(ResultProposed {
            game_market: game_market.key(),
            market: game_market.market,
            outcome: args.outcome,
            evidence_hash: args.evidence_hash,
            proposer: signer,
            proposed_at: now,
        });
        Ok(())
    }

    /// A guardian strikes the proposal while the window is open.
    pub fn challenge(ctx: Context<Challenge>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let signer = ctx.accounts.signer.key();
        require!(ctx.accounts.config.is_guardian(&signer), HoragonError::Unauthorized);
        let window = i64::from(ctx.accounts.config.dispute_window_secs);
        let game_market = &mut ctx.accounts.game_market;
        require!(game_market.status == MarketStatus::Proposed, HoragonError::BadStatus);
        require!(
            now < game_market.proposed_at.saturating_add(window),
            HoragonError::WindowClosed
        );
        game_market.proposed_outcome = None;
        game_market.evidence_hash = [0u8; 32];
        game_market.evidence_uri = String::new();
        game_market.proposed_at = 0;
        game_market.proposer = Pubkey::default();
        game_market.challenge_count = game_market.challenge_count.saturating_add(1);
        game_market.status = MarketStatus::Challenged;
        emit!(ResultChallenged {
            game_market: game_market.key(),
            market: game_market.market,
            by: signer,
            challenge_count: game_market.challenge_count,
        });
        Ok(())
    }

    /// Anyone, once the window has passed: CPI `resolve_market` signed by the Authority.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let window = i64::from(ctx.accounts.config.dispute_window_secs);
        let a = &ctx.accounts;
        require!(a.game_market.status == MarketStatus::Proposed, HoragonError::BadStatus);
        require!(
            now >= a.game_market.proposed_at.saturating_add(window),
            HoragonError::WindowOpen
        );
        let outcome = a.game_market.proposed_outcome.ok_or(HoragonError::BadStatus)?;
        let bump = [ctx.bumps.authority];
        let seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        pm_amm::cpi::resolve_market(
            CpiContext::new_with_signer(
                a.pm_amm_program.key(),
                ResolveMarket {
                    signer: a.authority.to_account_info(),
                    market: a.market.to_account_info(),
                },
                seeds,
            ),
            pm_side(outcome),
        )?;
        let game_market = &mut ctx.accounts.game_market;
        game_market.status = MarketStatus::Finalized;
        game_market.finalized_at = now;
        emit!(MarketFinalized {
            game_market: game_market.key(),
            market: game_market.market,
            outcome,
            finalized_at: now,
        });
        Ok(())
    }

    /// Anyone, after finalize: claim the Authority's LP residuals (if its LpPosition still
    /// exists), then claim its winning tokens; the mUSDC lands in the treasury.
    pub fn recycle(ctx: Context<Recycle>) -> Result<()> {
        require!(
            ctx.accounts.game_market.status == MarketStatus::Finalized,
            HoragonError::BadStatus
        );
        let bump = [ctx.bumps.authority];
        let seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        let before = ctx.accounts.treasury.amount;

        // lp_position is pinned to `["lp", market, authority]`, so None can only mean halt's
        // full withdrawal closed it (docs/spikes.md, S1).
        let a = &ctx.accounts;
        if lp_shares(&a.lp_position.to_account_info(), &a.market.key(), &a.authority.key())?
            .is_some()
        {
            pm_amm::cpi::claim_lp_residuals(CpiContext::new_with_signer(
                a.pm_amm_program.key(),
                ClaimLpResiduals {
                    signer: a.authority.to_account_info(),
                    market: a.market.to_account_info(),
                    yes_mint: a.yes_mint.to_account_info(),
                    no_mint: a.no_mint.to_account_info(),
                    lp_position: a.lp_position.to_account_info(),
                    user_yes: a.authority_yes.to_account_info(),
                    user_no: a.authority_no.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                },
                seeds,
            ))?;
        }

        ctx.accounts.authority_yes.reload()?;
        ctx.accounts.authority_no.reload()?;
        let a = &ctx.accounts;
        if a.authority_yes.amount > 0 || a.authority_no.amount > 0 {
            pm_amm::cpi::claim_winnings(
                CpiContext::new_with_signer(
                    a.pm_amm_program.key(),
                    ClaimWinnings {
                        signer: a.authority.to_account_info(),
                        market: a.market.to_account_info(),
                        collateral_mint: a.collateral_mint.to_account_info(),
                        yes_mint: a.yes_mint.to_account_info(),
                        no_mint: a.no_mint.to_account_info(),
                        vault: a.vault.to_account_info(),
                        user_yes: a.authority_yes.to_account_info(),
                        user_no: a.authority_no.to_account_info(),
                        user_collateral: a.treasury.to_account_info(),
                        token_program: a.token_program.to_account_info(),
                    },
                    seeds,
                ),
                // pm-AMM burns every YES and NO the signer holds and pays the winning side;
                // the amount is not read. 1 matches the vendored SDK (S1 claimed with it).
                1,
            )?;
        }

        ctx.accounts.treasury.reload()?;
        let recovered = ctx.accounts.treasury.amount.saturating_sub(before);
        let game_market = &mut ctx.accounts.game_market;
        game_market.status = MarketStatus::Recycled;
        emit!(MarketRecycled {
            game_market: game_market.key(),
            market: game_market.market,
            recovered,
        });
        Ok(())
    }

    /// Admin moves mUSDC out of the treasury (spec section 5.2).
    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, HoragonError::InvalidArgument);
        let bump = [ctx.bumps.authority];
        let seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.treasury.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
                seeds,
            ),
            amount,
        )
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeConfigArgs {
    pub attestor: Pubkey,
    pub guardians: [Pubkey; 2],
    pub dispute_window_secs: u32,
    pub collateral_mint: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateConfigArgs {
    pub attestor: Option<Pubkey>,
    pub guardians: Option<[Pubkey; 2]>,
    pub dispute_window_secs: Option<u32>,
    pub creation_paused: Option<bool>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateGameMarketArgs {
    pub market_id: u64,
    pub kind: u8,
    pub league: [u8; 8],
    pub external_game_id: String,
    pub home: [u8; 4],
    pub away: [u8; 4],
    pub scheduled_tipoff: i64,
    pub end_ts: i64,
    pub name: String,
    pub initial_price_bps: u16,
    pub seed_amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposeResultArgs {
    pub outcome: Outcome,
    pub evidence_hash: [u8; 32],
    pub evidence_uri: String,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ HoragonError::Unauthorized
    )]
    pub program: Program<'info, crate::program::Horagon>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ HoragonError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ HoragonError::Unauthorized
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(args: CreateGameMarketArgs)]
pub struct CreateGameMarket<'info> {
    #[account(mut)]
    pub attestor: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = attestor @ HoragonError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [AUTHORITY_SEED], bump)]
    pub authority: SystemAccount<'info>,
    #[account(
        init,
        payer = attestor,
        space = 8 + GameMarket::INIT_SPACE,
        seeds = [GAME_MARKET_SEED, &args.market_id.to_le_bytes()],
        bump
    )]
    pub game_market: Box<Account<'info, GameMarket>>,
    /// CHECK: pm-AMM creates it at its PDA `["market", market_id]` and checks the address.
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: must be the configured collateral; pm-AMM validates the mint itself.
    #[account(address = config.collateral_mint @ HoragonError::InvalidArgument)]
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: pm-AMM creates it at `["yes_mint", market]`.
    #[account(
        mut,
        seeds = [PM_YES_MINT_SEED, market.key().as_ref()],
        bump,
        seeds::program = pm_amm_program.key()
    )]
    pub yes_mint: UncheckedAccount<'info>,
    /// CHECK: pm-AMM creates it at `["no_mint", market]`.
    #[account(
        mut,
        seeds = [PM_NO_MINT_SEED, market.key().as_ref()],
        bump,
        seeds::program = pm_amm_program.key()
    )]
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
    #[account(
        mut,
        constraint = treasury.mint == config.collateral_mint @ HoragonError::InvalidArgument,
        constraint = treasury.owner == authority.key() @ HoragonError::InvalidArgument
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,
    /// CHECK: pm-AMM creates it at `["lp", market, authority]`.
    #[account(
        mut,
        seeds = [PM_LP_SEED, market.key().as_ref(), authority.key().as_ref()],
        bump,
        seeds::program = pm_amm_program.key()
    )]
    pub lp_position: UncheckedAccount<'info>,
    /// CHECK: pm-AMM checks the Metaplex program address.
    pub token_metadata_program: UncheckedAccount<'info>,
    pub pm_amm_program: Program<'info, PmAmm>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Halt<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [AUTHORITY_SEED], bump)]
    pub authority: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [GAME_MARKET_SEED, &game_market.market_id.to_le_bytes()],
        bump = game_market.bump,
        has_one = market @ HoragonError::InvalidArgument
    )]
    pub game_market: Box<Account<'info, GameMarket>>,
    /// CHECK: equals `game_market.market`; pm-AMM validates it.
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: must be the configured collateral.
    #[account(address = config.collateral_mint @ HoragonError::InvalidArgument)]
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: pm-AMM's `["yes_mint", market]`.
    #[account(
        mut,
        seeds = [PM_YES_MINT_SEED, market.key().as_ref()],
        bump,
        seeds::program = pm_amm_program.key()
    )]
    pub yes_mint: UncheckedAccount<'info>,
    /// CHECK: pm-AMM's `["no_mint", market]`.
    #[account(
        mut,
        seeds = [PM_NO_MINT_SEED, market.key().as_ref()],
        bump,
        seeds::program = pm_amm_program.key()
    )]
    pub no_mint: UncheckedAccount<'info>,
    /// CHECK: the Authority's LpPosition at `["lp", market, authority]`; read by `lp_shares`.
    #[account(
        mut,
        seeds = [PM_LP_SEED, market.key().as_ref(), authority.key().as_ref()],
        bump,
        seeds::program = pm_amm_program.key()
    )]
    pub lp_position: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = yes_mint,
        associated_token::authority = authority
    )]
    pub authority_yes: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = no_mint,
        associated_token::authority = authority
    )]
    pub authority_no: Box<Account<'info, TokenAccount>>,
    pub pm_amm_program: Program<'info, PmAmm>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ProposeResult<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [GAME_MARKET_SEED, &game_market.market_id.to_le_bytes()],
        bump = game_market.bump,
        has_one = market @ HoragonError::InvalidArgument
    )]
    pub game_market: Account<'info, GameMarket>,
    /// CHECK: read-only, never used; listed so that the proposal appears in
    /// `getSignaturesForAddress(market)`, which is what the indexer scans.
    pub market: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Challenge<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [GAME_MARKET_SEED, &game_market.market_id.to_le_bytes()],
        bump = game_market.bump,
        has_one = market @ HoragonError::InvalidArgument
    )]
    pub game_market: Account<'info, GameMarket>,
    /// CHECK: read-only, listed for the indexer (see ProposeResult).
    pub market: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [GAME_MARKET_SEED, &game_market.market_id.to_le_bytes()],
        bump = game_market.bump,
        has_one = market @ HoragonError::InvalidArgument
    )]
    pub game_market: Account<'info, GameMarket>,
    /// CHECK: equals `game_market.market`; pm-AMM validates it.
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    pub pm_amm_program: Program<'info, PmAmm>,
}

#[derive(Accounts)]
pub struct Recycle<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [AUTHORITY_SEED], bump)]
    pub authority: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [GAME_MARKET_SEED, &game_market.market_id.to_le_bytes()],
        bump = game_market.bump,
        has_one = market @ HoragonError::InvalidArgument
    )]
    pub game_market: Box<Account<'info, GameMarket>>,
    /// CHECK: equals `game_market.market`; pm-AMM validates it.
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: must be the configured collateral.
    #[account(address = config.collateral_mint @ HoragonError::InvalidArgument)]
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: pm-AMM's `["yes_mint", market]`.
    #[account(
        mut,
        seeds = [PM_YES_MINT_SEED, market.key().as_ref()],
        bump,
        seeds::program = pm_amm_program.key()
    )]
    pub yes_mint: UncheckedAccount<'info>,
    /// CHECK: pm-AMM's `["no_mint", market]`.
    #[account(
        mut,
        seeds = [PM_NO_MINT_SEED, market.key().as_ref()],
        bump,
        seeds::program = pm_amm_program.key()
    )]
    pub no_mint: UncheckedAccount<'info>,
    /// CHECK: pm-AMM validates it.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the Authority's LpPosition at `["lp", market, authority]`, possibly closed.
    #[account(
        mut,
        seeds = [PM_LP_SEED, market.key().as_ref(), authority.key().as_ref()],
        bump,
        seeds::program = pm_amm_program.key()
    )]
    pub lp_position: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = yes_mint,
        associated_token::authority = authority
    )]
    pub authority_yes: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = no_mint,
        associated_token::authority = authority
    )]
    pub authority_no: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = treasury.mint == config.collateral_mint @ HoragonError::InvalidArgument,
        constraint = treasury.owner == authority.key() @ HoragonError::InvalidArgument
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,
    pub pm_amm_program: Program<'info, PmAmm>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ HoragonError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: SystemAccount<'info>,
    #[account(
        mut,
        constraint = treasury.mint == config.collateral_mint @ HoragonError::InvalidArgument,
        constraint = treasury.owner == authority.key() @ HoragonError::InvalidArgument
    )]
    pub treasury: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = destination.mint == config.collateral_mint @ HoragonError::InvalidArgument
    )]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

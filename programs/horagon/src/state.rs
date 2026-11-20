use anchor_lang::prelude::*;

/// Program-wide settings, one account at `["config"]`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Changes the config and withdraws the treasury. The program's upgrade authority at init.
    pub admin: Pubkey,
    /// The keeper's key: creates markets, proposes results, halts.
    pub attestor: Pubkey,
    /// Guardian 1 is the operator; guardian 2 is the watcher bot (Tier 2).
    pub guardians: [Pubkey; 2],
    /// How long a proposal stays open to a challenge (spec default 900 s).
    pub dispute_window_secs: u32,
    /// mUSDC on devnet; a local mint on Surfpool.
    pub collateral_mint: Pubkey,
    pub creation_paused: bool,
    pub bump: u8,
}

impl Config {
    pub fn is_guardian(&self, key: &Pubkey) -> bool {
        *key != Pubkey::default() && self.guardians.contains(key)
    }

    pub fn is_attestor_or_guardian(&self, key: &Pubkey) -> bool {
        *key == self.attestor || self.is_guardian(key)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MarketStatus {
    Open,
    Halted,
    Proposed,
    Challenged,
    Finalized,
    Recycled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum Outcome {
    Yes,
    No,
}

pub const MAX_EXTERNAL_ID_LEN: usize = 16;
pub const MAX_EVIDENCE_URI_LEN: usize = 128;
/// Metaplex limits a token name to 32 bytes; pm-AMM passes the market name through.
pub const MAX_MARKET_NAME_LEN: usize = 32;

/// Horagon's record of one pm-AMM market, at `["game_market", market_id (u64 LE)]`.
/// Field order is the wire format `@horagon/sdk/program` decodes.
#[account]
#[derive(InitSpace)]
pub struct GameMarket {
    /// The pm-AMM market (`["market", market_id]` of pm-AMM).
    pub market: Pubkey,
    pub market_id: u64,
    /// 0 = game winner, 1 = second half.
    pub kind: u8,
    /// ASCII, zero-padded, e.g. "NBA".
    pub league: [u8; 8],
    /// The feed's game id (ESPN event id in Tier 1).
    #[max_len(16)]
    pub external_game_id: String,
    /// Team tricodes, ASCII, zero-padded.
    pub home: [u8; 4],
    pub away: [u8; 4],
    pub scheduled_tipoff: i64,
    pub end_ts: i64,
    pub seed_amount: u64,
    pub status: MarketStatus,
    pub proposed_outcome: Option<Outcome>,
    /// sha256 of the RFC 8785 evidence JSON; zero until proposed.
    pub evidence_hash: [u8; 32],
    #[max_len(128)]
    pub evidence_uri: String,
    pub proposed_at: i64,
    pub proposer: Pubkey,
    pub challenge_count: u8,
    pub finalized_at: i64,
    pub bump: u8,
}

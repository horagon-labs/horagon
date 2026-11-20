use anchor_lang::prelude::*;

use crate::state::Outcome;

// Every event names the GameMarket and the pm-AMM market, so the indexer can attribute it
// without reading the instruction's accounts.

#[event]
pub struct GameMarketCreated {
    pub game_market: Pubkey,
    pub market: Pubkey,
    pub market_id: u64,
    pub kind: u8,
    pub end_ts: i64,
    pub seed_amount: u64,
    pub initial_price_bps: u16,
}

#[event]
pub struct MarketHalted {
    pub game_market: Pubkey,
    pub market: Pubkey,
    pub by: Pubkey,
    pub shares: u128,
}

#[event]
pub struct ResultProposed {
    pub game_market: Pubkey,
    pub market: Pubkey,
    pub outcome: Outcome,
    pub evidence_hash: [u8; 32],
    pub proposer: Pubkey,
    pub proposed_at: i64,
}

#[event]
pub struct ResultChallenged {
    pub game_market: Pubkey,
    pub market: Pubkey,
    pub by: Pubkey,
    pub challenge_count: u8,
}

#[event]
pub struct MarketFinalized {
    pub game_market: Pubkey,
    pub market: Pubkey,
    pub outcome: Outcome,
    pub finalized_at: i64,
}

#[event]
pub struct MarketRecycled {
    pub game_market: Pubkey,
    pub market: Pubkey,
    /// mUSDC that came back to the treasury in this instruction.
    pub recovered: u64,
}

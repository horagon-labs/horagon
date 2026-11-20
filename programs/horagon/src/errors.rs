use anchor_lang::prelude::*;

/// Codes start at 6000 (Anchor's custom range). `@horagon/sdk/program` mirrors this order.
#[error_code]
pub enum HoragonError {
    #[msg("Signer is not allowed to call this instruction")]
    Unauthorized,
    #[msg("Market creation is paused")]
    CreationPaused,
    #[msg("initial_price_bps must be in [500, 9500]")]
    PriceOutOfRange,
    #[msg("end_ts must be at least 300 seconds away")]
    EndTooSoon,
    #[msg("Treasury holds less than the seed amount")]
    InsufficientTreasury,
    #[msg("Market status does not allow this instruction")]
    BadStatus,
    #[msg("Too early: the market has not reached end_ts")]
    TooEarly,
    #[msg("The dispute window is still open")]
    WindowOpen,
    #[msg("The dispute window has closed")]
    WindowClosed,
    #[msg("Invalid argument")]
    InvalidArgument,
    #[msg("LP position account is not a pm-AMM LpPosition of the Authority")]
    BadLpPosition,
}

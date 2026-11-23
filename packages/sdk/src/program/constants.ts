import { PublicKey } from '@solana/web3.js'

/**
 * The `horagon` program. Hard-coded so the IDL JSON stays out of web bundles; the test
 * 'uses the IDL address as the program id' pins it to `packages/sdk/idl/horagon.json`, so a
 * redeploy to a new address changes this line and that file.
 */
export const HORAGON_PROGRAM_ID = new PublicKey('HtDJ3vfx8vtFSmskm2Ks39kBMuDmFZH3H2B173BB9qHF')

export const CONFIG_SEED = 'config'
export const AUTHORITY_SEED = 'authority'
export const GAME_MARKET_SEED = 'game_market'

// Mirrors of the program's limits (programs/horagon/src/lib.rs, state.rs).
export const MIN_MARKET_SECS = 300
export const MIN_PRICE_BPS = 500
export const MAX_PRICE_BPS = 9_500
export const MIN_DISPUTE_WINDOW_SECS = 60
export const MAX_DISPUTE_WINDOW_SECS = 7 * 24 * 3600
export const DEFAULT_DISPUTE_WINDOW_SECS = 900
export const MAX_EXTERNAL_ID_LEN = 16
export const MAX_EVIDENCE_URI_LEN = 128
export const MAX_MARKET_NAME_LEN = 32

/**
 * Spec section 5.2: create = initialize_market + deposit_liquidity + Horagon. Measured on
 * Surfpool, whole transaction: 718k to 773k CU.
 */
export const CREATE_MARKET_COMPUTE_UNITS = 1_400_000
/**
 * halt CPIs withdraw_liquidity: 457k to 473k CU, and 666k once a swap has pushed the YES price
 * to 0.02%. recycle CPIs claim_lp_residuals + claim_winnings: 69k to 122k CU. Measured on
 * Surfpool, whole transaction.
 */
export const HEAVY_IX_COMPUTE_UNITS = 1_400_000
/** propose, challenge, finalize (S2: resolve ~22k CU). */
export const LIGHT_IX_COMPUTE_UNITS = 200_000

export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
)

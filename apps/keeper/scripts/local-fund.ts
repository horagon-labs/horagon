// Localnet only (the local end-to-end run on Surfpool): the pm-AMM faucet mints on devnet, so
// locally a stand-in collateral mint is created with the deployer as mint authority, and
// mUSDC is minted to the wallets that need it (keeper wallet, burner wallets).
//   HORAGON_RPC_URL=http://127.0.0.1:8899 pnpm --filter @horagon/keeper local:fund \
//     [--mint <mint>] <wallet>:<usdc> ...
// Prints the mint; pass it back with --mint to fund more wallets later.
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import { loadKeypair, REPO_DIR } from '../src/config'

const { values, positionals } = parseArgs({
  options: { mint: { type: 'string' } },
  allowPositionals: true,
})
const rpc = process.env.HORAGON_RPC_URL ?? 'http://127.0.0.1:8899'
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(rpc)) {
  throw new Error(`local:fund runs against a local validator only, not ${rpc}`)
}
const connection = new Connection(rpc, 'confirmed')
const deployer = loadKeypair(join(REPO_DIR, '.keys/deployer.json'))
const mint = values.mint
  ? new PublicKey(values.mint)
  : await createMint(connection, deployer, deployer.publicKey, null, 6)
console.log(`mint ${mint.toBase58()}`)
for (const arg of positionals) {
  const [wallet, usdc] = arg.split(':')
  if (!wallet || !usdc || !/^\d+$/.test(usdc))
    throw new Error(`expected <wallet>:<usdc>, got ${arg}`)
  const owner = new PublicKey(wallet)
  // allowOwnerOffCurve: the treasury belongs to the Authority PDA.
  const ata = await getOrCreateAssociatedTokenAccount(connection, deployer, mint, owner, true)
  await mintTo(connection, deployer, mint, ata.address, deployer, BigInt(usdc) * 1_000_000n)
  console.log(`${owner.toBase58()} +${usdc} mUSDC`)
}

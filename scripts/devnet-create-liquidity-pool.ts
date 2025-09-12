import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { wrapSolToWSOL } from './devnet-wsol-wrapper-v2';
import { DEVNET_PROGRAM_ID, getCpmmPdaAmmConfigId, getAssociatedPoolKeys } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';

import { Raydium, CREATE_CPMM_POOL_PROGRAM, CREATE_CPMM_POOL_FEE_ACC } from '@raydium-io/raydium-sdk-v2';

/**
 * Creates a Raydium liquidity pool on Devnet.
 *
 * @param connection The Solana connection object.
 * @param walletKp The Keypair of the wallet creating the pool.
 * @param mintAddress The mint address of the custom token to pair with WSOL.
 * @param tokenAccount The associated token account holding the custom tokens.
 * @param programId The OpenBook market ID for the token pair.
 * @param decimals The number of decimals for the custom token.
 */
export async function createLiquidityPool(
  connection: Connection,
  walletKp: Keypair,
  mintAddress: PublicKey,
  decimals: number,
) {
  // Create a Raydium Liquidity Pool ---
  console.log('\nℹ️ Liquidity pool creation...');

  // 1. Load raydium SDK
  const raydium = await Raydium.load({
    connection,
    owner: walletKp,
    cluster: 'devnet',
  });

  // prepare mints (example: WSOL + your token)
  const mintA = {
    address: NATIVE_MINT.toBase58(),
    decimals: 9,
    programId: TOKEN_PROGRAM_ID.toBase58(),
  }; // WSOL
  const mintB = await raydium.token.getTokenInfo(mintAddress.toBase58());
  const mintAAmount = new BN(0.1 * LAMPORTS_PER_SOL);
  const mintBAmount = new BN(100 * 10 ** decimals);

  // 2. Fetch available fee configs
  const feeConfigs = await raydium.api.getCpmmConfigs();

  // 3. (if on devnet) adjust them: usually, set `config.id` appropriately (e.g. via a PDA) so that the id aligns with devnet program settings
  if (raydium.cluster === 'devnet') {
    feeConfigs.forEach((config) => {
      config.id = getCpmmPdaAmmConfigId(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, config.index).publicKey.toBase58();
    });
  }

  // 4. Pick one feeConfig, e.g. feeConfigs[0]
  const myFeeConfig = feeConfigs[0];

  console.log('Program ID:', DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM.toBase58());
  console.log('Fee Account:', DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC.toBase58());
  console.log('Fee Config:', myFeeConfig);

  // build tx (params follow demo API)
  const { transaction, signers } = await raydium.cpmm.createPool({
    programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
    poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
    mintA,
    mintB,
    mintAAmount,
    mintBAmount,
    startTime: new BN(0),
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: 1,
    feeConfig: myFeeConfig,
  });

  // send
  const result = await sendAndConfirmTransaction(connection, transaction, [walletKp, ...(signers || [])], {
    commitment: 'confirmed',
  });

  console.log('✅ Liquidity pool created. Transaction ID:', result);
  return result;
}

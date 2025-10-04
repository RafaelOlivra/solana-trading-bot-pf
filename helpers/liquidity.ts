import { PublicKey } from '@solana/web3.js';
import { Liquidity, LiquidityPoolKeys, LiquidityStateV4, MAINNET_PROGRAM_ID, Market } from '@raydium-io/raydium-sdk';
import { ALL_PROGRAM_ID } from '@raydium-io/raydium-sdk-v2';
import { MinimalMarketLayoutV3 } from './market';

export function createPoolKeys(
  id: PublicKey,
  accountData: LiquidityStateV4,
  minimalMarketLayoutV3?: MinimalMarketLayoutV3 | null, // <-- optional
): LiquidityPoolKeys {
  return {
    id,
    baseMint: accountData.baseMint,
    quoteMint: accountData.quoteMint,
    lpMint: accountData.lpMint,
    baseDecimals:
      typeof accountData.baseDecimal === 'number' ? accountData.baseDecimal : accountData.baseDecimal.toNumber(),
    quoteDecimals:
      typeof accountData.quoteDecimal === 'number' ? accountData.quoteDecimal : accountData.quoteDecimal.toNumber(),
    lpDecimals: 5,
    version: 4,
    programId: MAINNET_PROGRAM_ID.AmmV4,
    authority: Liquidity.getAssociatedAuthority({
      programId: MAINNET_PROGRAM_ID.AmmV4,
    }).publicKey,
    openOrders: accountData.openOrders,
    targetOrders: accountData.targetOrders,
    baseVault: accountData.baseVault,
    quoteVault: accountData.quoteVault,
    marketVersion: 3,
    marketProgramId: accountData.marketProgramId,
    marketId: accountData.marketId,
    marketAuthority: accountData.marketId
      ? Market.getAssociatedAuthority({
          programId: accountData.marketProgramId,
          marketId: accountData.marketId,
        }).publicKey
      : PublicKey.default, // safe fallback
    marketBaseVault: accountData.baseVault,
    marketQuoteVault: accountData.quoteVault,
    marketBids: minimalMarketLayoutV3?.bids ?? PublicKey.default,
    marketAsks: minimalMarketLayoutV3?.asks ?? PublicKey.default,
    marketEventQueue: minimalMarketLayoutV3?.eventQueue ?? PublicKey.default,
    withdrawQueue: accountData.withdrawQueue,
    lpVault: accountData.lpVault,
    lookupTableAccount: PublicKey.default,
  };
}

export function createCpmmPoolKeys(id: PublicKey, accountData: LiquidityStateV4) {
  // map only the CPMM-relevant fields
  return {
    id,
    baseMint: accountData.baseMint,
    quoteMint: accountData.quoteMint,
    lpMint: accountData.lpMint,
    baseDecimals:
      typeof accountData.baseDecimal === 'number'
        ? accountData.baseDecimal
        : accountData.baseDecimal?.toNumber?.() ?? 0,
    quoteDecimals:
      typeof accountData.quoteDecimal === 'number'
        ? accountData.quoteDecimal
        : accountData.quoteDecimal?.toNumber?.() ?? 0,
    lpDecimals: 5,
    version: 5, // CPMM version (adjust if your SDK expects another)
    programId: ALL_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, // use CPMM program id!
    authority: Liquidity.getAssociatedAuthority({ programId: ALL_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM }).publicKey,
    baseVault: accountData.baseVault,
    quoteVault: accountData.quoteVault,
    lpVault: accountData.lpVault,
    withdrawQueue: accountData.withdrawQueue ?? PublicKey.default,
    observationId: PublicKey.default, // use correct field name from state if different
    lookupTableAccount: PublicKey.default,

    openOrders: PublicKey.default,
  };
}

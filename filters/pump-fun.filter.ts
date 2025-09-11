import { Filter, FilterResult } from './pool-filters';
import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4, getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { MetadataAccountData, MetadataAccountDataArgs } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { logger } from '../helpers';

// Known Pump.fun update authority (may change)
const PUMP_FUN_UPDATE_AUTHORITY = new PublicKey('pump111111111111111111111111111111111111111');

export class PumpFunFilter implements Filter {
  constructor(
    private readonly connection: Connection,
    private readonly metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>,
  ) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const metadataPDA = getPdaMetadataKey(poolKeys.baseMint);
      const accountInfo = await this.connection.getAccountInfo(metadataPDA.publicKey, this.connection.commitment);

      if (!accountInfo?.data) {
        return { ok: false, message: 'PumpFun -> Failed to fetch metadata account' };
      }

      const [metadata] = this.metadataSerializer.deserialize(accountInfo.data);

      const isPumpFun =
        metadata.uri.includes('pump.fun') || // URI contains pump.fun
        metadata.mint.endsWith('pump') || // Mint address ends with 'pump'
        metadata.updateAuthority.toString() === PUMP_FUN_UPDATE_AUTHORITY.toString();

      if (isPumpFun) {
        return { ok: true };
      }

      return {
        ok: false,
        message: 'PumpFun -> Token does not appear to be from Pump.fun',
      };
    } catch (e) {
      logger.error({ mint: poolKeys.baseMint }, `PumpFun -> Error checking Pump.fun token`);
      return { ok: false, message: 'PumpFun -> Failed to check token' };
    }
  }
}

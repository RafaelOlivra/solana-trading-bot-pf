import { Commitment, PublicKey } from '@solana/web3.js';
import { GetStructureSchema, MARKET_STATE_LAYOUT_V3, publicKey, struct } from '@raydium-io/raydium-sdk';
import { CustomConnection } from '../helpers';

export const MINIMAL_MARKET_STATE_LAYOUT_V3 = struct([publicKey('eventQueue'), publicKey('bids'), publicKey('asks')]);
export type MinimalMarketStateLayoutV3 = typeof MINIMAL_MARKET_STATE_LAYOUT_V3;
export type MinimalMarketLayoutV3 = GetStructureSchema<MinimalMarketStateLayoutV3>;

export async function getMinimalMarketV3(
  customConnection: CustomConnection,
  marketId: PublicKey,
): Promise<MinimalMarketLayoutV3> {
  const connection = customConnection.getConnection();
  const marketInfo = await connection.getAccountInfo(marketId, {
    commitment: connection.commitment,
    dataSlice: {
      offset: MARKET_STATE_LAYOUT_V3.offsetOf('eventQueue'),
      length: 32 * 3,
    },
  });

  if (!marketInfo) {
    console.error(`Market account ${marketId.toBase58()} not found.`);
    throw new Error('Market account not found');
  }

  const decodedMarketInfo = MINIMAL_MARKET_STATE_LAYOUT_V3.decode(marketInfo.data);
  return decodedMarketInfo;
}

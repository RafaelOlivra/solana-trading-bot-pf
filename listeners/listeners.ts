import {
  LIQUIDITY_STATE_LAYOUT_V4,
  MAINNET_PROGRAM_ID,
  MARKET_STATE_LAYOUT_V3,
  DEVNET_PROGRAM_ID,
  Token,
  ProgramId,
} from '@raydium-io/raydium-sdk';
import { DEVNET_PROGRAM_ID as DEVNET_PROGRAM_ID_V2, CpmmPoolInfoLayout } from '@raydium-io/raydium-sdk-v2';
import bs58 from 'bs58';
import { Connection, PublicKey, KeyedAccountInfo } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { EventEmitter } from 'events';
import { logger, USE_SNIPE_LIST } from '../helpers';

export class Listeners extends EventEmitter {
  private subscriptions: number[] = [];
  private MARKET_PROGRAM_ID: ProgramId = MAINNET_PROGRAM_ID;

  constructor(private readonly connection: Connection) {
    super();
  }

  public async start(config: {
    walletPublicKey: PublicKey;
    quoteToken: Token;
    autoSell: boolean;
    cacheNewMarkets: boolean;
    network: 'mainnet-beta' | 'devnet';
  }) {
    this.MARKET_PROGRAM_ID = config.network === 'devnet' ? DEVNET_PROGRAM_ID : MAINNET_PROGRAM_ID;

    if (config.cacheNewMarkets) {
      const openBookSubscription = await this.subscribeToOpenBookMarkets(config);
      this.subscriptions.push(openBookSubscription);
    }

    const raydiumSubscription = await this.subscribeToRaydiumPools(config);
    this.subscriptions.push(raydiumSubscription);

    // For CPMM pools (Devnet only - Requires USE_SNIPE_LIST=true)
    if (config.network === 'devnet' && USE_SNIPE_LIST) {
      const cpmmSubscription = await this.subscribeToCpmmPools(config);
      this.subscriptions.push(cpmmSubscription);
    }

    if (config.autoSell) {
      const walletSubscription = await this.subscribeToWalletChanges(config);
      this.subscriptions.push(walletSubscription);
    }
  }

  private async subscribeToOpenBookMarkets(config: { quoteToken: Token }) {
    return this.connection.onProgramAccountChange(
      this.MARKET_PROGRAM_ID.OPENBOOK_MARKET,
      async (updatedAccountInfo) => {
        this.emit('market', updatedAccountInfo);
      },
      this.connection.commitment,
      [
        { dataSize: MARKET_STATE_LAYOUT_V3.span },
        {
          memcmp: {
            offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
            bytes: config.quoteToken.mint.toBase58(),
          },
        },
      ],
    );
  }

  private async subscribeToRaydiumPools(config: { quoteToken: Token }) {
    return this.connection.onProgramAccountChange(
      this.MARKET_PROGRAM_ID.AmmV4,
      async (updatedAccountInfo) => {
        this.emit('pool', updatedAccountInfo);
      },
      this.connection.commitment,
      [
        { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
            bytes: config.quoteToken.mint.toBase58(),
          },
        },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
            bytes: this.MARKET_PROGRAM_ID.OPENBOOK_MARKET.toBase58(),
          },
        },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
            bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
          },
        },
      ],
    );
  }

  private async subscribeToCpmmPools(config: { quoteToken: Token }) {
    logger.info('🔔 Subscribing to CPMM pools (Devnet only)...');

    return this.connection.onProgramAccountChange(
      DEVNET_PROGRAM_ID_V2.CREATE_CPMM_POOL_PROGRAM,
      async (updatedAccountInfo, ctx) => {
        const poolId = updatedAccountInfo.accountId.toBase58();

        logger.trace(`CPMM pool update: ${poolId}`);

        try {
          // Decode CPMM pool state
          const decoded = CpmmPoolInfoLayout.decode(updatedAccountInfo.accountInfo.data);

          // Wrap into V4-like shape so existing listeners keep working
          // Not pretty but works for now
          const poolState = {
            accountId: updatedAccountInfo.accountId,
            baseMint: decoded.mintB,
            quoteMint: decoded.mintA,
            lpMint: decoded.mintLp,
            poolOpenTime: decoded.openTime,
            isCpmm: true,
          };

          this.emit('pool', poolState);
        } catch (e) {
          logger.error(`❌ Failed to decode CPMM pool: ${e}`);
          logger.info(`Raw data length: ${updatedAccountInfo.accountInfo.data.length}`);
        }
      },
      this.connection.commitment,
      [{ dataSize: CpmmPoolInfoLayout.span }],
    );
  }

  private async subscribeToWalletChanges(config: { walletPublicKey: PublicKey }) {
    return this.connection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (updatedAccountInfo) => {
        this.emit('wallet', updatedAccountInfo);
      },
      this.connection.commitment,
      [
        {
          dataSize: 165,
        },
        {
          memcmp: {
            offset: 32,
            bytes: config.walletPublicKey.toBase58(),
          },
        },
      ],
    );
  }

  public async stop() {
    for (let i = this.subscriptions.length; i >= 0; --i) {
      const subscription = this.subscriptions[i];
      await this.connection.removeAccountChangeListener(subscription);
      this.subscriptions.splice(i, 1);
    }
  }
}

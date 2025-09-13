import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache, SnipeListCache, AvoidListCache } from './cache';
import { Listeners } from './listeners';
import { PoolFilters } from './filters';
import { TransactionExecutor } from './transactions';
import { createPoolKeys, logger, NETWORK, sleep } from './helpers';
import { Mutex } from 'async-mutex';
import BN from 'bn.js';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';

export interface BotConfig {
  wallet: Keypair;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  checkFromPumpFun: boolean;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  useAvoidList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
}

export class Bot {
  private readonly poolFilters: PoolFilters;

  // snipe list
  private readonly snipeListCache?: SnipeListCache;

  // avoid list
  private readonly avoidListCache?: AvoidListCache;

  // one token at the time
  private readonly mutex: Mutex;
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.mutex = new Mutex();
    this.poolFilters = new PoolFilters(connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }

    if (this.config.useAvoidList) {
      this.avoidListCache = new AvoidListCache();
      this.avoidListCache.init();
    }
  }

  async validate() {
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  // Helper to log SendTransactionError details when available
  private async logSendTransactionError(error: any, context: Record<string, any> = {}, msg = 'SendTransactionError') {
    try {
      // Some implementations provide getLogs() to get simulation logs
      if (typeof error?.getLogs === 'function') {
        const logs = await error.getLogs();
        logger.debug({ ...context, logs, error }, `${msg} (with simulation logs)`);
        return;
      }

      // Some libs put logs in error.transactionLogs or error.message
      if (error?.transactionLogs) {
        logger.debug({ ...context, transactionLogs: error.transactionLogs }, `${msg} (transactionLogs)`);
        return;
      }

      logger.debug({ ...context, error }, msg);
    } catch (e) {
      logger.debug({ ...context, error, innerError: e }, `${msg} (failed to fetch logs)`);
    }
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4, listeners: Listeners) {
    logger.trace({ mint: poolState.baseMint }, `Processing new pool...`);

    // Skip if snipe list is enabled and mint is not in the list
    if (this.config.useSnipeList && !this.snipeListCache?.isInList(poolState.baseMint.toString())) {
      logger.debug({ mint: poolState.baseMint.toString() }, `Skipping buy because token is not in a snipe list`);
      return;
    }

    // Skip if avoid list is enabled and mint is in the list
    if (this.config.useAvoidList && this.avoidListCache?.isInList(poolState.baseMint.toString())) {
      logger.debug({ mint: poolState.baseMint.toString() }, `Skipping buy because token is in an avoid list`);
      return;
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
      await sleep(this.config.autoBuyDelay);
    }

    // Flags to track what we actually changed so finally block can clean up correctly
    let acquiredMutex = false;
    let listenersStopped = false;

    if (this.config.oneTokenAtATime) {
      // Stop listeners while we hold the mutex to avoid piling up events
      // Only stop them when there's an ongoing sell execution (so we don't unnecessarily pause listeners)
      if (this.sellExecutionCount > 0) {
        try {
          await listeners.stop();
          listenersStopped = true;
          logger.debug(
            { mint: poolState.baseMint.toString() },
            `Stopped listeners while processing one token at a time`,
          );
        } catch (err) {
          logger.error({ err }, 'Failed to stop listeners before processing token; continuing anyway');
        }
      }

      // If someone else is already processing a token, skip
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug(
          { mint: poolState.baseMint.toString() },
          `Skipping buy because one token at a time is turned on and token is already being processed`,
        );
        // We didn't acquire mutex nor stop listeners here (unless we stopped them above),
        // so cleanup will only restart listeners if we stopped them.
        return;
      }

      // Acquire the mutex after listeners are stopped (if any)
      await this.mutex.acquire();
      acquiredMutex = true;
    }

    // Use a flag to indicate we must cleanup (release mutex + restart listeners) in finally
    const mustCleanup = this.config.oneTokenAtATime;

    // Buy only if market exists
    if (poolState.marketId) {
      try {
        const [market, mintAta] = await Promise.all([
          this.marketStorage.get(poolState.marketId.toString()),
          getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
        ]);

        const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

        if (!this.config.useSnipeList) {
          const match = await this.filterMatch(poolKeys);

          if (!match) {
            logger.trace({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
            return;
          }
        }

        for (let i = 0; i < this.config.maxBuyRetries; i++) {
          try {
            logger.info(
              { mint: poolState.baseMint.toString() },
              `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
            );

            // Try to see some common errors before buying
            const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);

            const result = await this.swap(
              poolKeys,
              this.config.quoteAta,
              mintAta,
              this.config.quoteToken,
              tokenOut,
              this.config.quoteAmount,
              this.config.buySlippage,
              this.config.wallet,
              'buy',
            );

            if (!result) {
              logger.warn({ mint: poolState.baseMint.toString() }, `Swap returned empty result, skipping`);
              break;
            }

            if (result.confirmed) {
              logger.info(
                {
                  mint: poolState.baseMint.toString(),
                  signature: result.signature,
                  url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
                },
                `Confirmed buy tx`,
              );
              break;
            }

            // If result exists but not confirmed, log details
            logger.info(
              {
                mint: poolState.baseMint.toString(),
                signature: result.signature,
                error: result.error,
              },
              `Error confirming buy tx`,
            );
          } catch (error) {
            // Better diagnostics for SendTransactionError
            await this.logSendTransactionError(
              error,
              { mint: poolState.baseMint.toString() },
              'Error confirming buy transaction',
            );
          }
        }
      } catch (error) {
        logger.error({ mint: poolState.baseMint.toString(), error }, `Failed to buy token`);
      } finally {
        if (mustCleanup) {
          if (acquiredMutex) {
            try {
              this.mutex.release();
            } catch (e) {
              logger.error({ e }, 'Error releasing mutex in buy finally');
            }
          }
          if (listenersStopped) {
            try {
              await listeners.start();
            } catch (e) {
              logger.error({ e }, 'Failed to restart listeners after buy; continuing');
            }
          }
        }
        return;
      }
    }
    // We got a CPMM pool without market id
    else {
      logger.debug({ mint: poolState.baseMint.toString() }, `Skipping buy because pool has no market (CPMM)`);
      if (this.config.oneTokenAtATime) {
        // Only release if we actually acquired it
        if (acquiredMutex) {
          try {
            this.mutex.release();
          } catch (e) {
            logger.error({ e }, 'Error releasing mutex after CPMM skip');
          }
        }
        // Only start listeners if we actually stopped them earlier
        if (listenersStopped) {
          try {
            await listeners.start();
          } catch (e) {
            logger.error({ e }, 'Failed to restart listeners after CPMM skip; continuing');
          }
        }
      }
      return;
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount, listeners: Listeners) {
    let listenersStopped = false;

    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
      try {
        // If listeners are still running while a sell is happening, stop them
        try {
          await listeners.stop();
          listenersStopped = true;
          logger.debug({ mint: rawAccount.mint.toString() }, `Stopped listeners while processing sell`);
        } catch (err) {
          logger.error({ err }, 'Failed to stop listeners before processing sell; continuing anyway');
        }
      } catch (e) {
        logger.error({ e }, 'Error preparing for oneTokenAtATime sell');
      }
    }

    try {
      logger.trace({ mint: rawAccount.mint }, `Processing new token...`);

      const poolData = await this.poolStorage.get(rawAccount.mint.toString());
      if (!poolData) {
        logger.trace({ mint: rawAccount.mint.toString() }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint: rawAccount.mint.toString() }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);

      await this.priceMatch(tokenAmountIn, poolKeys);

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          logger.info(
            { mint: rawAccount.mint },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          const result = await this.swap(
            poolKeys,
            accountId,
            this.config.quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn,
            this.config.sellSlippage,
            this.config.wallet,
            'sell',
          );

          if (!result) {
            logger.warn({ mint: rawAccount.mint.toString() }, `Swap returned empty result, skipping`);
            break;
          }

          if (result.confirmed) {
            logger.info(
              {
                dex: `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${this.config.wallet.publicKey}`,
                mint: rawAccount.mint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed sell tx`,
            );
            break; // Success, exit loop
          }

          logger.info(
            { mint: rawAccount.mint.toString(), signature: result.signature, error: result.error },
            `Error confirming sell tx`,
          );
        } catch (error) {
          await this.logSendTransactionError(
            error,
            { mint: rawAccount.mint.toString() },
            'Error confirming sell transaction',
          );
        }
      }
    } catch (error) {
      logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;

        // Only restart listeners if we actually stopped them earlier
        if (listenersStopped) {
          try {
            await listeners.start();
            logger.debug({ mint: rawAccount.mint.toString() }, 'Restarted listeners after sell');
          } catch (e) {
            logger.error({ e }, 'Failed to restart listeners after sell; continuing');
          }
        }
      }
    }
  }

  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);

    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    if (amountIn.isZero() || amountIn.raw.lte(new BN(0))) {
      logger.warn('AmountIn is zero, skipping swap');
      return;
    }

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });

    const latestBlockhash = await this.connection.getLatestBlockhash();

    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
            ]),
        ...(direction === 'buy'
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                ataOut,
                wallet.publicKey,
                tokenOut.mint,
              ),
            ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await this.poolFilters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;

          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
        logger.trace(`Filters checked ${timesChecked}/${timesToCheck} - Match count ${matchCount}`);
      }
    } while (timesChecked < timesToCheck);

    return false;
  }

  private async priceMatch(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return;
    }

    const timesToCheck = Math.floor(this.config.priceCheckDuration / this.config.priceCheckInterval);
    const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    const takeProfit = this.config.quoteAmount.add(profitAmount);

    const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
    const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
    const stopLoss = this.config.quoteAmount.subtract(lossAmount);
    const slippage = new Percent(this.config.sellSlippage, 100);
    let timesChecked = 0;

    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        });

        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: amountIn,
          currencyOut: this.config.quoteToken,
          slippage,
        }).amountOut;

        logger.debug(
          { mint: poolKeys.baseMint.toString() },
          `TP: ${takeProfit.toFixed()} | SL: ${stopLoss.toFixed()} | CP: ${amountOut.toFixed()} | CH: ${timesChecked}/${timesToCheck}`,
        );

        if (amountOut.lt(stopLoss)) {
          break;
        }

        if (amountOut.gt(takeProfit)) {
          break;
        }

        await sleep(this.config.priceCheckInterval);
      } catch (e) {
        logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);
  }
}

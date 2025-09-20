import {
  Keypair,
  PublicKey,
  clusterApiUrl,
  sendAndConfirmTransaction,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { createMint, getAssociatedTokenAddress, createAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity } from '@metaplex-foundation/umi';
import { fromWeb3JsKeypair, fromWeb3JsPublicKey, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters';
import { createMetadataAccountV3, findMetadataPda } from '@metaplex-foundation/mpl-token-metadata';
import { createLiquidityPool } from './devnet-create-liquidity-pool';
import { CustomConnection } from '../helpers';
import fs from 'fs';
import bs58 from 'bs58';
import { DEVNET_COMMITMENT_LEVEL, DEVNET_RPC_ENDPOINT, DEVNET_RPC_WEBSOCKET_ENDPOINT } from '../helpers';

const customConnection = new CustomConnection([
  {
    rpcEndpoint: DEVNET_RPC_ENDPOINT,
    rpcWsEndpoint: DEVNET_RPC_WEBSOCKET_ENDPOINT,
    commitmentLevel: DEVNET_COMMITMENT_LEVEL,
  },
]);

const connection = customConnection.getConnection();

// Path to the wallet file
const WALLET_FILE = './tmp/devnet-wallet.json';

/**
 * Loads a wallet from a file or generates a new one.
 * @returns The Solana Keypair.
 */
function loadOrGenerateWallet() {
  if (fs.existsSync(WALLET_FILE)) {
    const secret = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(secret));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(WALLET_FILE, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`✅ Generated new wallet at ${WALLET_FILE}`);
  console.log('⚠️ Private Key (as Base58 string):', bs58.encode(kp.secretKey));

  return kp;
}

/**
 * Prompts the user for input and returns a promise that resolves with the input.
 * @param query The prompt message.
 * @returns A promise that resolves with the user's input.
 */
function promptUser(query: string): Promise<string> {
  const stdin = process.openStdin();
  console.log(query);
  return new Promise<string>((resolve) => {
    stdin.addListener('data', function (d) {
      resolve(d.toString().trim());
      stdin.removeAllListeners('data');
    });
  });
}

async function main() {
  // Accept user input to create a new token or not
  console.log('--- Devnet Wallet and Token Creator ---');

  let mintAddress: PublicKey | null = null;
  let decimals = 6;

  // Setup wallet
  const walletKp = loadOrGenerateWallet();
  console.log('Wallet Public Key:', walletKp.publicKey.toBase58());
  console.log('Wallet Private Key:', bs58.encode(walletKp.secretKey));

  // Airdrop 2 SOL if low balance
  const balance = await connection.getBalance(walletKp.publicKey);
  console.log(`Current balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 1.5 * LAMPORTS_PER_SOL) {
    console.log('💸 Requesting airdrop...');
    try {
      const sig = await connection.requestAirdrop(walletKp.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log('✅ Airdrop confirmed');
    } catch (error) {
      console.log('❌ Airdrop failed:', error);
      return;
    }
  }

  const answer = await promptUser(`Do you want to create a new SPL token? (y/n) [default: y]`);
  if (answer === 'y' || answer === 'yes' || answer === '') {
    // --- Step 1: Create SPL Token ---
    console.log('\n🪙 Creating SPL token...');
    const mintAuthority = walletKp;
    const freezeAuthority = walletKp;
    decimals = 6;
    mintAddress = await createMint(
      connection,
      walletKp, // payer
      mintAuthority.publicKey, // mint authority
      freezeAuthority.publicKey, // freeze authority
      decimals,
    );
    console.log('✅ Created token mint:', mintAddress.toBase58());

    // Create associated token account (ATA)
    console.log('🏦 Creating ATA (Associated Token Account)...');
    const tokenAccount = await getAssociatedTokenAddress(mintAddress, walletKp.publicKey);
    await createAssociatedTokenAccount(
      connection,
      walletKp, // payer
      mintAddress, // mint
      walletKp.publicKey, // owner
    );
    console.log('Created ATA:', tokenAccount.toBase58());

    // Mint tokens into ATA
    console.log('🔨 Minting tokens...');
    await mintTo(
      connection,
      walletKp, // payer
      mintAddress, // mint
      tokenAccount, // destination
      walletKp, // mint authority
      1_000_000_000, // amount (1000 tokens with 6 decimals)
    );
    console.log('Minted 1000 tokens');

    // Create metadata using UMI (Pump.fun style)
    console.log('📝 Creating metadata...');
    const umi = createUmi(clusterApiUrl('devnet')).use(keypairIdentity(fromWeb3JsKeypair(walletKp)));
    const mintUmiPublicKey = fromWeb3JsPublicKey(mintAddress);
    const metadataPda = findMetadataPda(umi, { mint: mintUmiPublicKey });

    try {
      const metadataBuilder = createMetadataAccountV3(umi, {
        metadata: metadataPda,
        mint: mintUmiPublicKey,
        mintAuthority: umi.identity,
        payer: umi.identity,
        updateAuthority: fromWeb3JsPublicKey(walletKp.publicKey),
        data: {
          name: 'Devnet PumpFun Test Token',
          symbol: 'PUMPX',
          uri: 'https://raw.githubusercontent.com/RafaelOlivra/solana-trading-bot-pf/refs/heads/master/scripts/fake-metadata.json?pump',
          sellerFeeBasisPoints: 0,
          creators: [{ address: fromWeb3JsPublicKey(walletKp.publicKey), verified: false, share: 100 }],
          collection: null,
          uses: null,
        },
        isMutable: true,
        collectionDetails: null,
      });

      const ix: any = metadataBuilder.getInstructions()[0];
      ix.keys = ix.keys.map((key: any) => {
        const newKey = { ...key };
        newKey.pubkey = toWeb3JsPublicKey(key.pubkey);
        return newKey;
      });

      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [walletKp]);

      console.log('✅ Metadata created:', metadataPda[0], sig);
    } catch (error) {
      // Continue without metadata for now
      console.log('❌ Metadata creation failed:', error);
    }

    console.log('\n🎉 Coin creation complete!');
    console.log(`Mint Address: ${mintAddress.toBase58()}`);
    console.log(`Token Account: ${tokenAccount.toBase58()}`);
  }

  const lpAnswer = await promptUser(
    `Do you want to create a new liquidity pool for an existing token? (y/n) [default: n]`,
  );
  if (lpAnswer === 'y' || lpAnswer === 'yes') {
    // Proceed to create liquidity pool only
    console.log('Proceeding to create liquidity pool only.');

    if (!mintAddress) {
      const mintAddressInput = await promptUser(`Enter the existing token mint address:`);
      try {
        mintAddress = new PublicKey(mintAddressInput);
      } catch (error) {
        console.error('Invalid mint address. Exiting.');
        return;
      }
    }

    await createLiquidityPool(customConnection, walletKp, mintAddress, decimals);
    return;
  } else {
    console.log('Exiting without creating anything.');
    return;
  }
}

main().catch(console.error);

import { Connection, Keypair, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { createMint, getAssociatedTokenAddress, createAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity, generateSigner, signerIdentity } from '@metaplex-foundation/umi';
import { fromWeb3JsKeypair, fromWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters';
import { createMetadataAccountV3, findMetadataPda } from '@metaplex-foundation/mpl-token-metadata';
import fs from 'fs';
import bs58 from 'bs58';

import { COMMITMENT_LEVEL, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from '../helpers';

const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: COMMITMENT_LEVEL,
});

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

  console.log('⚠️ Private Key (as a string):', JSON.stringify(Array.from(kp.secretKey)));
  console.log('⚠️ Private Key (as Base58 string):', bs58.encode(kp.secretKey));

  return kp;
}

async function main() {
  // 1️⃣ Setup wallet
  const walletKp = loadOrGenerateWallet();
  console.log('Wallet:', walletKp.publicKey.toBase58());

  // 2️⃣ Airdrop 2 SOL if low balance
  const balance = await connection.getBalance(walletKp.publicKey);
  console.log(`Current balance: ${balance / 1e9} SOL`);

  if (balance < 1e9) {
    console.log('💸 Requesting airdrop...');
    try {
      const sig = await connection.requestAirdrop(walletKp.publicKey, 2e9);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log('✅ Airdrop confirmed');
    } catch (error) {
      console.log('❌ Airdrop failed:', error);
      return;
    }
  }

  // 3️⃣ Create a new mint (6 decimals)
  console.log('🪙 Creating mint...');
  const mintAddress = await createMint(
    connection,
    walletKp, // payer
    walletKp.publicKey, // mint authority
    walletKp.publicKey, // freeze authority
    6, // decimals
  );
  console.log('Created mint:', mintAddress.toBase58());

  // 4️⃣ Create associated token account (ATA)
  console.log('🏦 Creating ATA...');
  const ata = await getAssociatedTokenAddress(mintAddress, walletKp.publicKey);

  await createAssociatedTokenAccount(
    connection,
    walletKp, // payer
    mintAddress, // mint
    walletKp.publicKey, // owner
  );
  console.log('Created ATA:', ata.toBase58());

  // 5️⃣ Mint tokens into ATA
  console.log('🔨 Minting tokens...');
  await mintTo(
    connection,
    walletKp, // payer
    mintAddress, // mint
    ata, // destination
    walletKp, // mint authority
    1_000_000_000, // amount (1000 tokens with 6 decimals)
  );
  console.log('Minted 1000 tokens');

  // 6️⃣ Create metadata using UMI (Pump.fun style)
  console.log('📝 Creating metadata...');

  // Use keypairIdentity with the converted web3.js Keypair.
  const umi = createUmi(clusterApiUrl('devnet')).use(keypairIdentity(fromWeb3JsKeypair(walletKp)));

  const mintUmiPublicKey = fromWeb3JsPublicKey(mintAddress);
  const metadataPda = findMetadataPda(umi, { mint: mintUmiPublicKey });

  try {
    const tx = createMetadataAccountV3(umi, {
      metadata: metadataPda,
      mint: mintUmiPublicKey,
      mintAuthority: umi.identity,
      payer: umi.identity,
      updateAuthority: umi.identity,
      data: {
        name: 'Devnet PumpFun Test',
        symbol: 'PUMPX',
        uri: 'https://pump.fun/fake.json',
        sellerFeeBasisPoints: 0,
        creators: [],
        collection: null,
        uses: null,
      },
      isMutable: true,
      collectionDetails: null,
    });

    // The Umi TransactionBuilder now has a sendAndConfirm method
    await tx.sendAndConfirm(umi);
    console.log('✅ Metadata created at PDA:', metadataPda[0]);
  } catch (error) {
    console.log('❌ Metadata creation failed:', error);
    // Continue without metadata for now
  }

  console.log('\n🎉 Setup completed!');
  console.log(`Mint Address: ${mintAddress.toBase58()}`);
  console.log(`Token Account: ${ata.toBase58()}`);
}

main().catch(console.error);

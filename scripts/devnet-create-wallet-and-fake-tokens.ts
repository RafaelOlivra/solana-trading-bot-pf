import { Connection, Keypair, PublicKey, clusterApiUrl, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import { createMint, getAssociatedTokenAddress, createAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity, generateSigner, signerIdentity } from '@metaplex-foundation/umi';
import { fromWeb3JsKeypair, fromWeb3JsPublicKey, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters';
import { createMetadataAccountV3, findMetadataPda } from '@metaplex-foundation/mpl-token-metadata';
import { wrapSolToWSOL } from './devnet-wsol-wrapper';
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
  console.log('⚠️ Private Key (as Base58 string):', bs58.encode(kp.secretKey));

  return kp;
}

async function main() {
  // Setup wallet
  const walletKp = loadOrGenerateWallet();
  console.log('Wallet Public Key:', walletKp.publicKey.toBase58());
  console.log('Wallet Private Key:', bs58.encode(walletKp.secretKey));

  // Airdrop 2 SOL if low balance
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

  // Wrap SOL into WSOL
  // const wsolAta = await wrapSolToWSOL(connection, walletKp, 1);

  // Create a new mint (6 decimals)
  console.log('🪙 Creating mint...');
  const mintAddress = await createMint(
    connection,
    walletKp, // payer
    walletKp.publicKey, // mint authority
    walletKp.publicKey, // freeze authority
    6, // decimals
  );
  console.log('Created mint:', mintAddress.toBase58());

  // Create associated token account (ATA)
  console.log('🏦 Creating ATA...');
  const ata = await getAssociatedTokenAddress(mintAddress, walletKp.publicKey);

  await createAssociatedTokenAccount(
    connection,
    walletKp, // payer
    mintAddress, // mint
    walletKp.publicKey, // owner
  );
  console.log('Created ATA:', ata.toBase58());

  // Mint tokens into ATA
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

  // Create metadata using UMI (Pump.fun style)
  console.log('📝 Creating metadata...');

  // Use keypairIdentity with the converted web3.js Keypair.
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
        name: 'Devnet PumpFun Test',
        symbol: 'PUMPX',
        uri: 'https://raw.githubusercontent.com/RafaelOlivra/solana-trading-bot-pf/refs/heads/master/scripts/fake-metadata.json',
        sellerFeeBasisPoints: 0,
        creators: [{ address: fromWeb3JsPublicKey(walletKp.publicKey), verified: true, share: 100 }],
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
    console.log('❌ Metadata creation failed:', error);
    // Continue without metadata for now
  }

  console.log('\n🎉 Setup completed!');
  console.log(`Mint Address: ${mintAddress.toBase58()}`);
  console.log(`Token Account: ${ata.toBase58()}`);
}

main().catch(console.error);

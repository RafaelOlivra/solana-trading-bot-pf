import { Connection, Keypair } from '@solana/web3.js';
import { createWrappedNativeAccount } from '@solana/spl-token';

export async function wrapSolToWSOL(connection: Connection, wallet: Keypair, amountSOL: number) {
  const lamportsToWrap = amountSOL * 1e9;

  // This handles both ATA creation and SOL wrapping
  const wsolAta = await createWrappedNativeAccount(
    connection,
    wallet,          // payer for transaction
    wallet.publicKey, // owner of the WSOL tokens
    lamportsToWrap
  );

  console.log(`💧 Wrapped ${amountSOL} SOL into WSOL at ATA:`, wsolAta.toBase58());

  return wsolAta;
}

import { Keypair, Transaction, sendAndConfirmTransaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { CustomConnection } from '../helpers';
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  createSyncNativeInstruction,
  NATIVE_MINT,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

/**
 * Wraps a specified amount of SOL into WSOL.
 * @param connection The Solana connection object.
 * @param payer The Keypair of the account paying for the transaction and receiving WSOL.
 * @param amount The amount of SOL to wrap (in SOL, not lamports).
 * @returns The PublicKey of the WSOL associated token account.
 */
export async function (customConnection: CustomConnection, payer: Keypair, amount: number) {
  const connection = customConnection.getConnection();
  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);

  // Create the associated token account for WSOL if it doesn't exist
  const createAtaTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      wsolAta,
      payer.publicKey,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );

  await sendAndConfirmTransaction(connection, createAtaTx, [payer]);

  // Send the SOL to the WSOL ATA
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: wsolAta,
      lamports: amount * LAMPORTS_PER_SOL,
    }),
  );

  // Sync the wrapped SOL
  wrapTx.add(createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID));

  await sendAndConfirmTransaction(connection, wrapTx, [payer]);

  console.log(`✅ Wrapped ${amount} SOL into WSOL at account: ${wsolAta.toBase58()}`);
  return wsolAta;
}

import { PublicKey, Transaction } from "@solana/web3.js";
import { createCloseAccountInstruction } from "@solana/spl-token";
import { connection } from "./solana.js";
import { scanWalletForCleanup, type ScannedTokenAccount } from "./scanner.js";

export const MAX_CLOSE_IX_PER_TX = 10;

const UNSIGNED_TX_WARNING =
  "Unsigned transaction. User wallet must review and sign client-side.";

export interface BuildCloseEmptyTxResult {
  wallet: string;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  maxInstructionsPerTx: number;
  includedAccounts: ScannedTokenAccount[];
  totalEmpty: number;
  skippedAccounts: number;
  estimatedReclaimSol: number;
  transactionBase64: string | null;
  warning: string;
}

export async function buildCloseEmptyAccountsTx(
  address: string,
): Promise<BuildCloseEmptyTxResult> {
  const owner = new PublicKey(address);
  const ownerStr = owner.toBase58();
  const scan = await scanWalletForCleanup(ownerStr);

  const safeEmpty = scan.emptyTokenAccounts.filter(
    (acc) => acc.amount === "0" && acc.owner === ownerStr,
  );
  const included = safeEmpty.slice(0, MAX_CLOSE_IX_PER_TX);
  const skippedAccounts = safeEmpty.length - included.length;

  const base = {
    wallet: ownerStr,
    transactionVersion: "legacy" as const,
    feePayer: ownerStr,
    requiresSignatureFrom: ownerStr,
    maxInstructionsPerTx: MAX_CLOSE_IX_PER_TX,
    totalEmpty: safeEmpty.length,
    skippedAccounts,
    warning: UNSIGNED_TX_WARNING,
  };

  if (included.length === 0) {
    return {
      ...base,
      includedAccounts: [],
      estimatedReclaimSol: 0,
      transactionBase64: null,
    };
  }

  const tx = new Transaction();
  for (const acc of included) {
    tx.add(
      createCloseAccountInstruction(
        new PublicKey(acc.tokenAccount),
        owner,
        owner,
        [],
        new PublicKey(acc.programId),
      ),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = owner;

  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

  return {
    ...base,
    includedAccounts: included,
    estimatedReclaimSol: included.reduce((sum, a) => sum + a.estimatedReclaimSol, 0),
    transactionBase64: serialized.toString("base64"),
  };
}

"use client";

// Lightweight Phantom-compatible wallet helper. We talk to `window.solana`
// directly to avoid pulling in a full wallet-adapter stack. Phantom and
// Solflare both inject a Phantom-shaped provider on this object.
//
// We never touch private keys; we only request the user's public key and
// delegate signing to the extension. Transactions are deserialized from
// base64 strings the backend produced.

import { Transaction } from "@solana/web3.js";

export interface PhantomLikeProvider {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string } | null;
  isConnected?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{
    publicKey: { toBase58(): string };
  }>;
  disconnect: () => Promise<void>;
  signAndSendTransaction: (
    tx: Transaction,
  ) => Promise<{ signature: string; publicKey?: { toBase58(): string } }>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    solana?: PhantomLikeProvider;
  }
}

export function getProvider(): PhantomLikeProvider | null {
  if (typeof window === "undefined") return null;
  return window.solana ?? null;
}

export function decodeBase64Transaction(b64: string): Transaction {
  if (typeof window === "undefined") {
    throw new Error("decodeBase64Transaction is browser-only");
  }
  // atob returns a binary string; convert to Uint8Array byte-by-byte.
  const bin = window.atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Transaction.from(bytes);
}

export function solscanTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

// SPL Token program IDs. CloseAccount works against both classic SPL Token and
// Token-2022; we accept either. Burning would have a different opcode, but we
// also explicitly reject any non-CloseAccount instruction from these programs.
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
// SPL Token instruction layout discriminator. CloseAccount = 9.
// See @solana/spl-token TokenInstruction enum.
const CLOSE_ACCOUNT_OPCODE = 9;

// ComputeBudget program. The cleaner tx prepends two instructions from this
// program — SetComputeUnitLimit (2) and SetComputeUnitPrice (3) — to keep
// fees predictable and prevent wallet-side priority-fee inflation. These
// instructions are inert from a safety standpoint (they only configure the
// CU budget; they don't move funds or change account state) and are
// explicitly allowed by the audit below. Other compute-budget opcodes
// (RequestUnits / RequestHeapFrame) are rejected — we don't emit them.
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const SET_COMPUTE_UNIT_LIMIT_OPCODE = 2;
const SET_COMPUTE_UNIT_PRICE_OPCODE = 3;

export interface InstructionAuditResult {
  ok: boolean;
  total: number;
  closeAccountCount: number;
  reason?: string;
}

// Deserializes a base64 legacy transaction and verifies that every instruction
// is either:
//   - SPL Token / Token-2022 CloseAccount, or
//   - ComputeBudget SetComputeUnitLimit / SetComputeUnitPrice.
// Anything else (including SPL Token Burn) is rejected. Also requires at
// least one CloseAccount instruction so we don't pass a tx that only sets
// budget. Returns ok=true only if all checks pass.
export function auditCloseEmptyTx(b64: string): InstructionAuditResult {
  try {
    const tx = decodeBase64Transaction(b64);
    const ixs = tx.instructions;
    if (ixs.length === 0) {
      return { ok: false, total: 0, closeAccountCount: 0, reason: "Transaction has no instructions" };
    }
    let closeAccountCount = 0;
    for (let i = 0; i < ixs.length; i++) {
      const ix = ixs[i];
      const pid = ix.programId.toBase58();
      const opcode = ix.data[0];

      if (pid === COMPUTE_BUDGET_PROGRAM_ID) {
        if (
          opcode !== SET_COMPUTE_UNIT_LIMIT_OPCODE &&
          opcode !== SET_COMPUTE_UNIT_PRICE_OPCODE
        ) {
          return {
            ok: false,
            total: ixs.length,
            closeAccountCount,
            reason: `Instruction #${i} ComputeBudget opcode is ${opcode ?? "empty"}, only SetComputeUnitLimit (2) and SetComputeUnitPrice (3) are allowed`,
          };
        }
        continue;
      }

      if (pid === SPL_TOKEN_PROGRAM_ID || pid === TOKEN_2022_PROGRAM_ID) {
        if (ix.data.length === 0 || opcode !== CLOSE_ACCOUNT_OPCODE) {
          return {
            ok: false,
            total: ixs.length,
            closeAccountCount,
            reason: `Instruction #${i} opcode is ${opcode ?? "empty"}, not CloseAccount (${CLOSE_ACCOUNT_OPCODE})`,
          };
        }
        closeAccountCount++;
        continue;
      }

      return {
        ok: false,
        total: ixs.length,
        closeAccountCount,
        reason: `Instruction #${i} program is ${pid.slice(0, 6)}…, not SPL Token or ComputeBudget`,
      };
    }

    if (closeAccountCount === 0) {
      return {
        ok: false,
        total: ixs.length,
        closeAccountCount: 0,
        reason: "Transaction has no CloseAccount instructions",
      };
    }
    return { ok: true, total: ixs.length, closeAccountCount };
  } catch (err) {
    return {
      ok: false,
      total: 0,
      closeAccountCount: 0,
      reason: err instanceof Error ? err.message : "Failed to deserialize transaction",
    };
  }
}

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

// ============================================================================
// Burn-and-close audit. Stricter than the close-empty audit because burns
// are irreversible. Verifies:
//   1. Programs are limited to ComputeBudget + SPL Token / Token-2022.
//   2. Token instructions are only Burn (8) or CloseAccount (9). Transfer (3)
//      under SPL Token is explicitly rejected — the backend never emits one,
//      so a tx containing it would be off-spec and dangerous.
//   3. Each Burn is immediately followed by CloseAccount on the same token
//      account (matches backend emission order; deviation is a red flag).
//   4. At least 1 Burn and 1 CloseAccount.
// ============================================================================

const BURN_OPCODE = 8;
const TRANSFER_OPCODE = 3;

export interface BurnAuditResult {
  ok: boolean;
  totalInstructions: number;
  burnCount: number;
  closeCount: number;
  hasTransfers: boolean;
  hasUnknownProgram: boolean;
  hasInvalidTokenOpcode: boolean;
  burnsPaired: boolean;
  reason?: string;
}

export function auditBurnAndCloseTx(b64: string): BurnAuditResult {
  // Defaults — the various early returns below override the relevant fields.
  const result: BurnAuditResult = {
    ok: false,
    totalInstructions: 0,
    burnCount: 0,
    closeCount: 0,
    hasTransfers: false,
    hasUnknownProgram: false,
    hasInvalidTokenOpcode: false,
    burnsPaired: true,
  };

  let tx;
  try {
    tx = decodeBase64Transaction(b64);
  } catch (err) {
    result.reason = err instanceof Error ? err.message : "Failed to deserialize transaction";
    return result;
  }

  const ixs = tx.instructions;
  result.totalInstructions = ixs.length;
  if (ixs.length === 0) {
    result.reason = "Transaction has no instructions";
    return result;
  }

  // First pass: classify each instruction. Walk only the token-program ones
  // for the pairing check below.
  type TokenIx = { opcode: number; firstKey: string };
  const tokenIxs: TokenIx[] = [];
  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    const pid = ix.programId.toBase58();
    const opcode = ix.data[0];

    if (pid === COMPUTE_BUDGET_PROGRAM_ID) {
      if (
        opcode !== SET_COMPUTE_UNIT_LIMIT_OPCODE &&
        opcode !== SET_COMPUTE_UNIT_PRICE_OPCODE
      ) {
        result.reason = `Instruction #${i} ComputeBudget opcode is ${opcode ?? "empty"}, only SetComputeUnitLimit (2) and SetComputeUnitPrice (3) are allowed`;
        return result;
      }
      continue;
    }

    if (pid === SPL_TOKEN_PROGRAM_ID || pid === TOKEN_2022_PROGRAM_ID) {
      // Transfer in the SPL Token namespace is opcode 3. Different from
      // ComputeBudget's opcode 3 (SetComputeUnitPrice) — the namespace check
      // above already routed budget ixs out, so any opcode 3 here is a
      // Token Transfer instruction.
      if (opcode === TRANSFER_OPCODE) {
        result.hasTransfers = true;
        result.reason = `Instruction #${i} is a Token Transfer — burn-and-close transactions must not move tokens`;
        return result;
      }
      if (opcode !== BURN_OPCODE && opcode !== CLOSE_ACCOUNT_OPCODE) {
        result.hasInvalidTokenOpcode = true;
        result.reason = `Instruction #${i} token opcode is ${opcode ?? "empty"}, only Burn (${BURN_OPCODE}) and CloseAccount (${CLOSE_ACCOUNT_OPCODE}) are allowed`;
        return result;
      }
      // Track the first key of the instruction (the token account being
      // acted on) for the pairing check.
      const firstKey = ix.keys[0]?.pubkey?.toBase58();
      if (!firstKey) {
        result.reason = `Instruction #${i} has no token account key`;
        return result;
      }
      tokenIxs.push({ opcode, firstKey });
      if (opcode === BURN_OPCODE) result.burnCount++;
      else result.closeCount++;
      continue;
    }

    result.hasUnknownProgram = true;
    result.reason = `Instruction #${i} program is ${pid.slice(0, 6)}…, not ComputeBudget / SPL Token / Token-2022`;
    return result;
  }

  // Second pass: every Burn must be IMMEDIATELY followed by a CloseAccount on
  // the same token account. This matches the backend's emission order; a tx
  // that has any other token-program ix between a burn and its close, or that
  // closes without a preceding burn, fails the audit.
  let pending: string | null = null;
  for (const tIx of tokenIxs) {
    if (tIx.opcode === BURN_OPCODE) {
      if (pending !== null) {
        result.burnsPaired = false;
        result.reason = `Burn ${pending.slice(0, 6)}… not followed by its CloseAccount`;
        return result;
      }
      pending = tIx.firstKey;
    } else {
      if (pending === null) {
        result.burnsPaired = false;
        result.reason = `CloseAccount ${tIx.firstKey.slice(0, 6)}… without a preceding Burn`;
        return result;
      }
      if (tIx.firstKey !== pending) {
        result.burnsPaired = false;
        result.reason = `Burn ${pending.slice(0, 6)}… closed by a different account ${tIx.firstKey.slice(0, 6)}…`;
        return result;
      }
      pending = null;
    }
  }
  if (pending !== null) {
    result.burnsPaired = false;
    result.reason = `Burn ${pending.slice(0, 6)}… has no following CloseAccount`;
    return result;
  }

  if (result.burnCount === 0) {
    result.reason = "No Burn instructions found";
    return result;
  }
  if (result.closeCount === 0) {
    result.reason = "No CloseAccount instructions found";
    return result;
  }

  result.ok = true;
  return result;
}

// ============================================================================
// Legacy Metaplex NFT BurnV1 audit.
//
// Scope at the *top level* of the transaction (CPIs from BurnV1 into SPL
// Token / System Program don't count — they're implementation details of
// the Metaplex program). We require:
//   1. Top-level instructions are only ComputeBudget or Metaplex Token
//      Metadata program. SPL Token / System Program appear as account keys
//      inside the BurnV1 ix; that's fine.
//   2. Every Metaplex Token Metadata instruction is BurnV1 (opcode 41).
//   3. No SPL Token Burn (opcode 8) at top level.
//   4. No SPL Token Transfer (opcode 3) at top level.
//   5. At least 1 BurnV1 instruction.
// ============================================================================

const TOKEN_METADATA_PROGRAM_ID =
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const BURN_V1_DISCRIMINATOR = 41;

export interface LegacyNftAuditResult {
  ok: boolean;
  totalInstructions: number;
  burnV1Count: number;
  hasSplTokenBurn: boolean;
  hasTransfers: boolean;
  hasUnknownProgram: boolean;
  reason?: string;
}

export function auditLegacyNftBurnTx(b64: string): LegacyNftAuditResult {
  const result: LegacyNftAuditResult = {
    ok: false,
    totalInstructions: 0,
    burnV1Count: 0,
    hasSplTokenBurn: false,
    hasTransfers: false,
    hasUnknownProgram: false,
  };

  let tx;
  try {
    tx = decodeBase64Transaction(b64);
  } catch (err) {
    result.reason =
      err instanceof Error ? err.message : "Failed to deserialize transaction";
    return result;
  }

  const ixs = tx.instructions;
  result.totalInstructions = ixs.length;
  if (ixs.length === 0) {
    result.reason = "Transaction has no instructions";
    return result;
  }

  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    const pid = ix.programId.toBase58();
    const opcode = ix.data[0];

    if (pid === COMPUTE_BUDGET_PROGRAM_ID) {
      if (
        opcode !== SET_COMPUTE_UNIT_LIMIT_OPCODE &&
        opcode !== SET_COMPUTE_UNIT_PRICE_OPCODE
      ) {
        result.reason = `Instruction #${i} ComputeBudget opcode is ${opcode ?? "empty"}, only SetComputeUnitLimit (2) and SetComputeUnitPrice (3) are allowed`;
        return result;
      }
      continue;
    }

    if (pid === TOKEN_METADATA_PROGRAM_ID) {
      if (opcode !== BURN_V1_DISCRIMINATOR) {
        result.reason = `Instruction #${i} Metaplex opcode is ${opcode ?? "empty"}, only BurnV1 (${BURN_V1_DISCRIMINATOR}) is allowed`;
        return result;
      }
      result.burnV1Count++;
      continue;
    }

    if (pid === SPL_TOKEN_PROGRAM_ID || pid === TOKEN_2022_PROGRAM_ID) {
      // Top-level SPL Token instructions are NOT allowed in a legacy NFT
      // burn — the burn must go through Metaplex BurnV1 so the Metadata +
      // Master Edition rent is also reclaimed. Any direct token-program ix
      // at this level is a red flag; flag the specific Burn / Transfer
      // opcodes by name so the checklist can render them as discrete
      // failures.
      if (opcode === BURN_OPCODE) {
        result.hasSplTokenBurn = true;
        result.reason = `Instruction #${i} is a direct SPL Token Burn — legacy NFT burns must go through Metaplex BurnV1`;
        return result;
      }
      if (opcode === TRANSFER_OPCODE) {
        result.hasTransfers = true;
        result.reason = `Instruction #${i} is a Token Transfer — legacy NFT burn must not move tokens`;
        return result;
      }
      result.hasUnknownProgram = true;
      result.reason = `Instruction #${i} is a top-level SPL Token instruction (opcode ${opcode}); only Metaplex BurnV1 / ComputeBudget are allowed at top level`;
      return result;
    }

    result.hasUnknownProgram = true;
    result.reason = `Instruction #${i} program is ${pid.slice(0, 6)}…, not ComputeBudget or Metaplex Token Metadata`;
    return result;
  }

  if (result.burnV1Count === 0) {
    result.reason = "No Metaplex BurnV1 instructions found";
    return result;
  }

  result.ok = true;
  return result;
}

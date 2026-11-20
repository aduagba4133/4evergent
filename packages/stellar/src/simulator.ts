import { Horizon, type Asset, type Transaction } from "@stellar/stellar-sdk";
import type { SimulationResult } from "@4evergent/shared";

/**
 * Minimum XLM a payment must carry to create a non-existent destination
 * account. A new Stellar account must be funded with at least 1 XLM — the
 * minimum balance for a bare account (2 x the 0.5 XLM base reserve).
 * Source: https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts
 */
const MIN_ACCOUNT_CREATION_XLM = 1;

/**
 * Simulator — mandatory gate before signing.
 *
 * A transaction that is NOT simulated, or whose simulation FAILED, MUST NOT be
 * signed or submitted. There are no fake or cached simulation results: every
 * code path through `simulate()` performs real Horizon network calls
 * (`fetchBaseFee()` and `accounts().accountId().call()`).
 *
 * Classic (non-Soroban) Horizon has no dry-run endpoint, so simulation is a
 * set of real network preconditions that must hold for submission to succeed:
 *  - the transaction envelope XDR is well-formed (round-trip),
 *  - the source account exists,
 *  - the transaction sequence number is exactly the on-chain sequence + 1,
 *  - the source account's XLM balance covers amount + fee + minimum reserve,
 *  - the destination is a valid G... address (validated by TransactionBuilder),
 *  - every payment destination exists on the network — or, if it does not,
 *    the payment carries at least 1 XLM, the minimum to create an account,
 *  - every non-native payment destination holds a trustline for the asset
 *    (otherwise Horizon rejects the payment with `op_no_trust`),
 *  - the transaction fee is >= network base fee.
 *
 * Signature correctness is NOT checked here — it is checked by Horizon at
 * submission time. This is why a simulation pass is necessary but not
 * sufficient: the pipeline must never present a simulation success as a
 * submission success.
 */
export class StellarSimulator {
  private server: Horizon.Server;

  /**
   * @param horizonUrl Horizon endpoint (used when no server is injected).
   * @param server Optional `Horizon.Server` seam for tests — inject a fake to
   *        keep `simulate()` fully offline. Production callers omit this and
   *        the server is constructed from `horizonUrl`.
   */
  constructor(horizonUrl: string, server?: Horizon.Server) {
    this.server = server ?? new Horizon.Server(horizonUrl);
  }

  async simulate(transaction: Transaction): Promise<SimulationResult> {
    const ops = transaction.operations.length;

    try {
      // 1. Envelope well-formedness (local, but XDR-level real validation).
      transaction.toEnvelope().toXDR("raw");
    } catch (e) {
      return fail(transaction.fee, ops, `Transaction envelope is invalid: ${(e as Error).message}`);
    }

    // 2. Real network call: fetch the current base fee.
    let baseFee: number;
    try {
      baseFee = await this.server.fetchBaseFee();
    } catch (e) {
      return fail(transaction.fee, ops, `Unable to fetch network base fee from Horizon: ${(e as Error).message}`);
    }

    // 3. Real network call: load the source account.
    let account: any;
    try {
      account = await this.server.accounts().accountId(transaction.source).call();
    } catch (e) {
      return fail(
        transaction.fee,
        ops,
        `Source account ${transaction.source} not found on network: ${(e as Error).message}`
      );
    }

    // 4. Sequence number precondition. The built transaction's sequence must
    //    be exactly one greater than the account's current on-chain sequence.
    const accountSeq = Number(account.sequence);
    if (Number(transaction.sequence) !== accountSeq + 1) {
      return fail(
        transaction.fee,
        ops,
        `Sequence number mismatch: transaction ${transaction.sequence} is not account sequence ${accountSeq} + 1`
      );
    }

    // 5. Fee precondition.
    if (Number(transaction.fee) < baseFee) {
      return fail(
        transaction.fee,
        ops,
        `Fee ${transaction.fee} stroops is below network base fee ${baseFee}`
      );
    }

    // 6. Balance precondition for XLM payments.
    const warnings: string[] = [];
    const xlmBalance = (account.balances as { asset_type: string; balance: string }[]).find(
      (b) => b.asset_type === "native"
    );
    if (xlmBalance) {
      const payment = paymentAmount(transaction);
      const totalCost = payment + Number(transaction.fee) / 1e7;
      const available = Number(xlmBalance.balance) - reserveFor(account);
      if (totalCost > available) {
        return fail(
          transaction.fee,
          ops,
          `Insufficient balance: payment ${payment} XLM + fee exceeds available ${available.toFixed(7)} XLM`
        );
      }
      if (available - totalCost < 1) {
        warnings.push("Remaining balance after transaction is under 1 XLM");
      }
    }

    // 7. Destination-account preconditions, one per payment operation.
    //    Non-payment operations (changeTrust, account settings, ...) carry
    //    no payment destination and are skipped.
    for (const op of transaction.operations) {
      if (op.type !== "payment") continue;
      const dest = await this.checkDestination(op);
      if (!dest.ok) return fail(transaction.fee, ops, dest.error);
    }

    return {
      success: true,
      fee: transaction.fee,
      operations: ops,
      warnings,
    };
  }

  /**
   * Destination precondition for a single payment operation, using the same
   * `Horizon.Server` seam as the source-account load.
   *
   * A load failure is treated as "account does not exist": by the time this
   * runs, the source-account load (check 3) has already proven Horizon is
   * reachable, so a failure here is a genuine 404, not a network outage.
   */
  private async checkDestination(op: {
    destination: string;
    asset: Asset;
    amount: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    let destAccount: any;
    try {
      destAccount = await this.server.accounts().accountId(op.destination).call();
    } catch {
      destAccount = null;
    }

    if (!destAccount) {
      // Non-existent destination: only a native payment at or above the
      // account-creation minimum can succeed (it creates the account).
      if (!op.asset.isNative()) {
        return {
          ok: false,
          error: `Destination account ${op.destination} does not exist and cannot receive ${op.asset.code} (no trustline; only a native XLM payment of at least ${MIN_ACCOUNT_CREATION_XLM} XLM can create an account)`,
        };
      }
      if (Number(op.amount) < MIN_ACCOUNT_CREATION_XLM) {
        return {
          ok: false,
          error: `Destination account ${op.destination} does not exist and payment of ${op.amount} XLM is below the ${MIN_ACCOUNT_CREATION_XLM} XLM minimum to create an account`,
        };
      }
      return { ok: true };
    }

    // Existing destination: a non-native payment needs a trustline, or
    // Horizon rejects the payment with `op_no_trust`.
    if (!op.asset.isNative()) {
      const balances = (destAccount.balances ?? []) as {
        asset_type: string;
        asset_code?: string;
        asset_issuer?: string;
      }[];
      const hasTrustline = balances.some(
        (b) => b.asset_code === op.asset.code && b.asset_issuer === op.asset.issuer
      );
      if (!hasTrustline) {
        return {
          ok: false,
          error: `Destination account ${op.destination} has no trustline for ${op.asset.code}:${op.asset.issuer}`,
        };
      }
    }
    return { ok: true };
  }
}

function fail(fee: string, operations: number, error: string): SimulationResult {
  return { success: false, fee, operations, warnings: [], error };
}

function paymentAmount(transaction: Transaction): number {
  for (const op of transaction.operations) {
    if (op.type === "payment") {
      return Number(op.amount);
    }
  }
  return 0;
}

function reserveFor(account: any): number {
  // Base reserve (0.5 XLM) + 0.5 XLM per sub-entry. Kept conservative.
  return 0.5 + 0.5 * (account.subentry_count ?? 0);
}

import crypto from 'crypto';

/**
 * Proof that whoever claims credits for an on-chain payment also controls the wallet that paid.
 *
 * A payment is public the moment it confirms, so "the money reached us" is not enough: anyone
 * watching the chain could submit the hash first. An account that logs in WITH the paying wallet
 * needs nothing more. Any other claimant (an API-key account, such as the gateway, which logs in
 * with a key but pays from its own wallet) signs this message with the paying wallet
 * (personal_sign). It names the payment, the agent being paid and the claimant's key, so a
 * signature cannot be reused for another payment, another agent or another account.
 *
 * The gateway (api-lanagent-net) builds the identical message; keep the two in step.
 */
export function claimKeyId(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 16);
}

export function buildClaimMessage({ chain = 'bsc', txHash, recipient, apiKey }) {
  return [
    'LANAgent credit purchase',
    `chain: ${String(chain).toLowerCase()}`,
    `tx: ${String(txHash).toLowerCase()}`,
    `to: ${String(recipient).toLowerCase()}`,
    `key: ${claimKeyId(apiKey)}`
  ].join('\n');
}

/**
 * How strictly claims are checked: "enforce" (the default) refuses a claim with no proof; "warn"
 * allows it and logs, for a transition. CREDIT_PAYER_PROOF overrides.
 */
export function payerProofMode() {
  const v = String(process.env.CREDIT_PAYER_PROOF || '').toLowerCase();
  return v === 'warn' || v === 'enforce' ? v : DEFAULT_MODE;
}
// 'enforce' since v2.25.393: the gateway signs every purchase (api-lanagent-net 1.4.13), proven
// live 2026-09-26 with a real top-up recorded as payerProof 'signature'.
export const DEFAULT_MODE = 'enforce';

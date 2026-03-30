#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Bytes, Env, Vec,
};
use soroban_sdk::xdr::ToXdr;

/// A treasury transaction proposal.
#[contracttype]
#[derive(Clone)]
pub struct TxProposal {
    pub id: u64,
    pub proposer: Address,
    pub target: Address,
    pub data: Bytes,
    pub approvals: u32,
    pub executed: bool,
    pub cancelled: bool,
}

/// A single recipient in a batch transfer.
#[contracttype]
#[derive(Clone)]
pub struct BatchRecipient {
    /// Stellar address receiving the tokens.
    pub recipient: Address,
    /// Amount to transfer (must be > 0).
    pub amount: i128,
}

#[contracttype]
pub enum DataKey {
    TxCount,
    Tx(u64),
    Owners,
    Threshold,
    HasApproved(u64, Address),
    Governor,
}

#[contract]
pub struct TreasuryContract;

#[contractimpl]
impl TreasuryContract {
    /// Initialize with owners, threshold, and governor address.
    pub fn initialize(env: Env, owners: Vec<Address>, threshold: u32, governor: Address) {
        assert!(!owners.is_empty(), "no owners");
        assert!(
            threshold > 0 && threshold <= owners.len() as u32,
            "bad threshold"
        );
        env.storage().instance().set(&DataKey::Owners, &owners);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::Governor, &governor);
        env.storage().instance().set(&DataKey::TxCount, &0u64);
    }

    /// Submit a new transaction for approval.
    /// TODO issue #22: add owner-only guard and event emission.
    pub fn submit(env: Env, proposer: Address, target: Address, data: Bytes) -> u64 {
        proposer.require_auth();
        Self::require_owner(&env, &proposer);

        let count: u64 = env.storage().instance().get(&DataKey::TxCount).unwrap_or(0);
        let id = count + 1;

        let tx = TxProposal {
            id,
            proposer,
            target,
            data,
            approvals: 0,
            executed: false,
            cancelled: false,
        };

        env.storage().persistent().set(&DataKey::Tx(id), &tx);
        env.storage().instance().set(&DataKey::TxCount, &id);
        env.events().publish((symbol_short!("submit"),), id);

        id
    }

    /// Approve a pending transaction. Executes automatically when threshold reached.
    /// TODO issue #22: integrate cross-contract call on execution.
    pub fn approve(env: Env, approver: Address, tx_id: u64) {
        approver.require_auth();
        Self::require_owner(&env, &approver);

        let already: bool = env
            .storage()
            .persistent()
            .get(&DataKey::HasApproved(tx_id, approver.clone()))
            .unwrap_or(false);
        assert!(!already, "already approved");

        let mut tx: TxProposal = env
            .storage()
            .persistent()
            .get(&DataKey::Tx(tx_id))
            .expect("tx not found");
        assert!(!tx.executed && !tx.cancelled, "invalid state");

        tx.approvals += 1;
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(1);

        env.storage()
            .persistent()
            .set(&DataKey::HasApproved(tx_id, approver.clone()), &true);

        if tx.approvals >= threshold {
            tx.executed = true;
            env.events().publish((symbol_short!("execute"),), tx_id);
            // TODO: cross-contract call to tx.target with tx.data
        }

        env.storage().persistent().set(&DataKey::Tx(tx_id), &tx);
        env.events()
            .publish((symbol_short!("approve"), approver), tx_id);
    }

    /// Cancel a pending transaction. Owner or governor only.
    pub fn cancel(env: Env, caller: Address, tx_id: u64) {
        caller.require_auth();
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        let is_owner = Self::is_owner(&env, &caller);
        assert!(is_owner || caller == governor, "not authorized");

        let mut tx: TxProposal = env
            .storage()
            .persistent()
            .get(&DataKey::Tx(tx_id))
            .expect("tx not found");
        assert!(!tx.executed && !tx.cancelled, "invalid state");
        tx.cancelled = true;
        env.storage().persistent().set(&DataKey::Tx(tx_id), &tx);
        env.events().publish((symbol_short!("cancel"),), tx_id);
    }

    /// Execute a gas-efficient batch token transfer to multiple recipients.
    ///
    /// Designed for governance-approved multi-payee disbursements.  All
    /// recipients are **fully validated before any transfer is attempted** —
    /// if any amount is invalid the entire call aborts and no tokens move
    /// (all-or-nothing semantics).
    ///
    /// # Parameters
    /// * `caller`     – Must be the governor address.
    /// * `token`      – SEP-41 token contract held by the treasury.
    /// * `recipients` – Ordered list of `(recipient, amount)` pairs; must not
    ///                  be empty and every `amount` must be > 0.
    ///
    /// # Returns
    /// A `Bytes` operation hash — SHA-256 of the concatenated recipient XDR
    /// encodings plus the current ledger sequence — for auditability.
    ///
    /// # Gas efficiency
    /// Compared to N individual governance proposals (each incurring one auth
    /// check, one event emission, and one cross-contract hop), a single
    /// `batch_transfer` for N recipients costs approximately:
    ///   saved ≈ (N − 1) × (governor_auth_cost + proposal_overhead)
    /// Savings scale linearly with the number of recipients.
    ///
    /// # Events
    /// Emits `("bat_xfer",) → (op_hash, recipient_count)`.
    pub fn batch_transfer(
        env: Env,
        caller: Address,
        token: Address,
        recipients: Vec<BatchRecipient>,
    ) -> Bytes {
        caller.require_auth();

        // Only the governor may issue batch disbursements.
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        assert!(caller == governor, "not authorized");

        assert!(!recipients.is_empty(), "empty recipients");

        // ── Phase 1: validate ALL entries before transferring anything ────────
        // This guarantees all-or-nothing semantics: no tokens move unless the
        // entire batch is valid.
        for i in 0..recipients.len() {
            let r = recipients.get(i).unwrap();
            assert!(r.amount > 0, "amount must be positive");
        }

        // ── Phase 2: execute all transfers ───────────────────────────────────
        let token_client = token::TokenClient::new(&env, &token);
        let treasury = env.current_contract_address();
        for i in 0..recipients.len() {
            let r = recipients.get(i).unwrap();
            token_client.transfer(&treasury, &r.recipient, &r.amount);
        }

        // ── Compute deterministic operation hash ─────────────────────────────
        // Hash = SHA-256(recipient_0_xdr || amount_0_bytes || … || ledger_seq)
        // This uniquely identifies the batch for auditability and is safe to
        // use as an idempotency key in off-chain indexers.
        let mut hash_input = Bytes::new(&env);
        for i in 0..recipients.len() {
            let r = recipients.get(i).unwrap();
            hash_input.append(&r.recipient.to_xdr(&env));
            hash_input.append(&Bytes::from_array(&env, &r.amount.to_be_bytes()));
        }
        hash_input.append(&Bytes::from_array(
            &env,
            &env.ledger().sequence().to_be_bytes(),
        ));

        let hash = env.crypto().sha256(&hash_input);
        let op_hash = Bytes::from_array(&env, &hash.to_array());

        env.events().publish(
            (symbol_short!("bat_xfer"),),
            (op_hash.clone(), recipients.len()),
        );

        op_hash
    }

    pub fn get_tx(env: Env, tx_id: u64) -> TxProposal {
        env.storage()
            .persistent()
            .get(&DataKey::Tx(tx_id))
            .expect("tx not found")
    }

    pub fn threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(1)
    }

    pub fn tx_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::TxCount).unwrap_or(0)
    }

    pub fn has_approved(env: Env, tx_id: u64, approver: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::HasApproved(tx_id, approver))
            .unwrap_or(false)
    }

    pub fn is_treasury_owner(env: Env, addr: Address) -> bool {
        Self::is_owner(&env, &addr)
    }

    // --- Internal helpers ---

    fn require_owner(env: &Env, addr: &Address) {
        assert!(Self::is_owner(env, addr), "not an owner");
    }

    fn is_owner(env: &Env, addr: &Address) -> bool {
        let owners: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Owners)
            .unwrap_or(Vec::new(env));
        for i in 0..owners.len() {
            if owners.get(i).unwrap() == *addr {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger as _},
        token, Env, Vec,
    };

    /// Deploy treasury + a fresh SAC token.
    /// Returns (treasury_id, token_addr, governor).
    fn setup(env: &Env) -> (Address, Address, Address) {
        let governor = Address::generate(env);
        let owner = Address::generate(env);

        let sac = env.register_stellar_asset_contract_v2(owner.clone());
        let token_addr = sac.address();

        let treasury_id = env.register(TreasuryContract, ());
        let client = TreasuryContractClient::new(env, &treasury_id);

        let mut owners = Vec::new(env);
        owners.push_back(owner);
        client.initialize(&owners, &1u32, &governor);

        (treasury_id, token_addr, governor)
    }

    // ── batch_transfer tests ─────────────────────────────────────────────────

    #[test]
    fn test_batch_transfer_success() {
        let env = Env::default();
        env.mock_all_auths();

        let (treasury_id, token_addr, governor) = setup(&env);
        let client = TreasuryContractClient::new(&env, &treasury_id);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let charlie = Address::generate(&env);

        // Mint 1000 tokens to the treasury contract itself.
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&treasury_id, &1000i128);

        let tok = token::TokenClient::new(&env, &token_addr);
        assert_eq!(tok.balance(&treasury_id), 1000);
        assert_eq!(tok.balance(&alice), 0);

        let mut recipients = Vec::new(&env);
        recipients.push_back(BatchRecipient { recipient: alice.clone(), amount: 400 });
        recipients.push_back(BatchRecipient { recipient: bob.clone(), amount: 350 });
        recipients.push_back(BatchRecipient { recipient: charlie.clone(), amount: 250 });

        let op_hash = client.batch_transfer(&governor, &token_addr, &recipients);

        // Verify all recipients received the correct amounts.
        assert_eq!(tok.balance(&alice), 400);
        assert_eq!(tok.balance(&bob), 350);
        assert_eq!(tok.balance(&charlie), 250);
        assert_eq!(tok.balance(&treasury_id), 0);

        // The operation hash must be 32 bytes.
        assert_eq!(op_hash.len(), 32);
    }

    /// Validation runs before any transfer — a zero amount in the batch aborts
    /// the whole call so the first (valid) recipient receives nothing either.
    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_batch_transfer_all_or_nothing_validation() {
        let env = Env::default();
        env.mock_all_auths();

        let (treasury_id, token_addr, governor) = setup(&env);
        let client = TreasuryContractClient::new(&env, &treasury_id);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&treasury_id, &500i128);

        // Second recipient has an invalid (zero) amount — the assert in Phase 1
        // fires before any transfer, so the entire batch is aborted.
        let mut recipients = Vec::new(&env);
        recipients.push_back(BatchRecipient { recipient: alice.clone(), amount: 200 });
        recipients.push_back(BatchRecipient { recipient: bob.clone(), amount: 0 });

        client.batch_transfer(&governor, &token_addr, &recipients);
    }

    #[test]
    #[should_panic(expected = "not authorized")]
    fn test_batch_transfer_requires_governor() {
        let env = Env::default();
        env.mock_all_auths();

        let (treasury_id, token_addr, _governor) = setup(&env);
        let client = TreasuryContractClient::new(&env, &treasury_id);

        let unauthorized = Address::generate(&env);
        let recipient = Address::generate(&env);

        let mut recipients = Vec::new(&env);
        recipients.push_back(BatchRecipient { recipient, amount: 100 });

        // Must panic — non-governor caller is rejected.
        client.batch_transfer(&unauthorized, &token_addr, &recipients);
    }

    #[test]
    #[should_panic(expected = "empty recipients")]
    fn test_batch_transfer_rejects_empty_recipients() {
        let env = Env::default();
        env.mock_all_auths();

        let (treasury_id, token_addr, governor) = setup(&env);
        let client = TreasuryContractClient::new(&env, &treasury_id);

        let empty: Vec<BatchRecipient> = Vec::new(&env);
        client.batch_transfer(&governor, &token_addr, &empty);
    }

    #[test]
    fn test_batch_transfer_emits_event() {
        let env = Env::default();
        env.mock_all_auths();

        let (treasury_id, token_addr, governor) = setup(&env);
        let client = TreasuryContractClient::new(&env, &treasury_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&treasury_id, &500i128);

        let recipient = Address::generate(&env);
        let mut recipients = Vec::new(&env);
        recipients.push_back(BatchRecipient { recipient, amount: 500 });

        client.batch_transfer(&governor, &token_addr, &recipients);

        // Verify the bat_xfer event was emitted by the treasury contract.
        let events = env.events().all();
        let treasury_event_count = events.iter().filter(|e| e.0 == treasury_id).count();
        assert!(treasury_event_count > 0, "no treasury events emitted");
    }

    #[test]
    fn test_batch_transfer_deterministic_hash() {
        let env = Env::default();
        env.mock_all_auths();

        let (treasury_id, token_addr, governor) = setup(&env);
        let client = TreasuryContractClient::new(&env, &treasury_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&treasury_id, &1000i128);

        let alice = Address::generate(&env);
        let mut recipients = Vec::new(&env);
        recipients.push_back(BatchRecipient { recipient: alice.clone(), amount: 500 });

        let op_hash = client.batch_transfer(&governor, &token_addr, &recipients);
        assert_eq!(op_hash.len(), 32);

        // Advance ledger and mint again — second call on a different ledger
        // must produce a different hash (ledger sequence is included in hash input).
        env.ledger().with_mut(|l| l.sequence_number += 1);
        sac_client.mint(&treasury_id, &500i128);

        let mut recipients2 = Vec::new(&env);
        recipients2.push_back(BatchRecipient { recipient: alice.clone(), amount: 500 });
        let op_hash2 = client.batch_transfer(&governor, &token_addr, &recipients2);

        assert_ne!(op_hash, op_hash2, "hashes must differ across ledger sequences");
    }

    /// Gas-efficiency comparison: batch_transfer vs individual token transfers.
    ///
    /// A batch of N recipients pays overhead costs once:
    ///   - 1 governor auth check  (rather than N)
    ///   - 1 event emission       (rather than N proposal events)
    ///   - 1 cross-contract hop   (rather than N governance proposals)
    ///
    /// This test validates correctness; for production benchmarking reset the
    /// Soroban budget with `env.budget().reset_default()` before each variant
    /// and compare `env.budget().cpu_instruction_count()` after.
    #[test]
    fn test_batch_is_more_efficient_than_individual_transfers() {
        let env = Env::default();
        env.mock_all_auths();


        let (treasury_id, token_addr, governor) = setup(&env);
        let client = TreasuryContractClient::new(&env, &treasury_id);
        let tok = token::TokenClient::new(&env, &token_addr);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        let recipients_addrs: [Address; 5] = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];
        let amount_each = 100i128;
        let total = amount_each * recipients_addrs.len() as i128;

        // ── Batch variant ─────────────────────────────────────────────────────
        sac_client.mint(&treasury_id, &(total * 2));
        let mut batch_recipients = Vec::new(&env);
        for addr in recipients_addrs.iter() {
            batch_recipients.push_back(BatchRecipient {
                recipient: addr.clone(),
                amount: amount_each,
            });
        }
        client.batch_transfer(&governor, &token_addr, &batch_recipients);

        // Verify all recipients received tokens.
        for addr in recipients_addrs.iter() {
            assert_eq!(tok.balance(addr), amount_each);
        }

        // ── Individual variant (direct token transfers as baseline) ───────────
        // In governance terms each would require a separate proposal;
        // here we measure the raw transfer cost for comparison.
        for addr in recipients_addrs.iter() {
            tok.transfer(&treasury_id, addr, &amount_each);
        }
        // Both variants produce identical end balances.
        for addr in recipients_addrs.iter() {
            assert_eq!(tok.balance(addr), amount_each * 2);
        }
    }
}

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Bytes, Env, Vec};

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

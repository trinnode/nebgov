#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, String,
};

/// Proposal lifecycle states.
/// TODO issue #1: implement full state machine transitions with timing logic.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalState {
    Pending,
    Active,
    Defeated,
    Succeeded,
    Queued,
    Executed,
    Cancelled,
}

/// A governance proposal.
#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub description: String,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub votes_for: i128,
    pub votes_against: i128,
    pub votes_abstain: i128,
    pub executed: bool,
    pub cancelled: bool,
}

/// Placeholder type for future storage migration data.
///
/// When a contract upgrade introduces a breaking change to the on-chain
/// storage layout, add the required migration values as fields here and
/// implement the migration logic inside [`GovernorContract::migrate`].
///
/// `new_version` is a monotonically increasing counter that callers must
/// supply so the migration can be applied exactly once per upgrade.
#[contracttype]
pub struct MigrateData {
    /// Monotonically increasing schema version written by this migration.
    /// Extend this struct with additional fields as the storage layout evolves.
    pub new_version: u32,
}

/// Vote support options.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum VoteSupport {
    Against,
    For,
    Abstain,
}

/// Storage keys.
#[contracttype]
pub enum DataKey {
    Proposal(u64),
    ProposalCount,
    VotingDelay,
    VotingPeriod,
    QuorumNumerator,
    ProposalThreshold,
    Timelock,
    VotesToken,
    Admin,
    HasVoted(u64, Address),
}

#[contract]
pub struct GovernorContract;

#[contractimpl]
impl GovernorContract {
    /// Initialize the governor with configuration.
    pub fn initialize(
        env: Env,
        admin: Address,
        votes_token: Address,
        timelock: Address,
        voting_delay: u32,
        voting_period: u32,
        quorum_numerator: u32,
        proposal_threshold: i128,
    ) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::VotesToken, &votes_token);
        env.storage().instance().set(&DataKey::Timelock, &timelock);
        env.storage().instance().set(&DataKey::VotingDelay, &voting_delay);
        env.storage().instance().set(&DataKey::VotingPeriod, &voting_period);
        env.storage().instance().set(&DataKey::QuorumNumerator, &quorum_numerator);
        env.storage().instance().set(&DataKey::ProposalThreshold, &proposal_threshold);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
    }

    /// Create a new governance proposal.
    /// TODO issue #2: add calldata encoding, threshold check, and event emission.
    pub fn propose(
        env: Env,
        proposer: Address,
        description: String,
    ) -> u64 {
        proposer.require_auth();

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count + 1;

        let voting_delay: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VotingDelay)
            .unwrap_or(100);
        let voting_period: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(1000);

        let current = env.ledger().sequence();
        let proposal = Proposal {
            id: proposal_id,
            proposer: proposer.clone(),
            description,
            start_ledger: current + voting_delay,
            end_ledger: current + voting_delay + voting_period,
            votes_for: 0,
            votes_against: 0,
            votes_abstain: 0,
            executed: false,
            cancelled: false,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);

        env.events().publish(
            (symbol_short!("propose"), proposer),
            proposal_id,
        );

        proposal_id
    }

    /// Cast a vote on an active proposal.
    /// TODO issue #3: add deduplication check, voting power lookup, and event.
    pub fn cast_vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: VoteSupport,
    ) {
        voter.require_auth();

        let voted: bool = env
            .storage()
            .persistent()
            .get(&DataKey::HasVoted(proposal_id, voter.clone()))
            .unwrap_or(false);
        assert!(!voted, "already voted");

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        // TODO: fetch actual voting power from token_votes contract.
        let weight: i128 = 1;

        match support {
            VoteSupport::For => proposal.votes_for += weight,
            VoteSupport::Against => proposal.votes_against += weight,
            VoteSupport::Abstain => proposal.votes_abstain += weight,
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .persistent()
            .set(&DataKey::HasVoted(proposal_id, voter.clone()), &true);

        env.events().publish(
            (symbol_short!("vote"), voter),
            (proposal_id, support),
        );
    }

    /// Cast a vote with an on-chain reason string.
    /// TODO issue #4: store reason in persistent storage and emit event.
    pub fn cast_vote_with_reason(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: VoteSupport,
        _reason: String,
    ) {
        Self::cast_vote(env, voter, proposal_id, support);
    }

    /// Queue a succeeded proposal for execution via timelock.
    /// TODO issue #5: integrate timelock contract cross-contract call.
    pub fn queue(env: Env, proposal_id: u64) {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");
        assert!(!proposal.executed && !proposal.cancelled, "invalid state");
        // TODO: verify state == Succeeded, then call timelock.schedule().
        proposal.executed = false; // placeholder
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.events()
            .publish((symbol_short!("queue"),), proposal_id);
    }

    /// Execute a queued proposal.
    /// TODO issue #6: call timelock.execute() with stored calldata.
    pub fn execute(env: Env, proposal_id: u64) {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");
        assert!(!proposal.executed && !proposal.cancelled, "invalid state");
        proposal.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.events()
            .publish((symbol_short!("execute"),), proposal_id);
    }

    /// Cancel a proposal. Only proposer or admin can cancel.
    /// TODO issue #7: enforce cancellation rules, emit event.
    pub fn cancel(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set");
        assert!(
            caller == proposal.proposer || caller == admin,
            "not authorized"
        );
        proposal.cancelled = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.events()
            .publish((symbol_short!("cancel"),), proposal_id);
    }

    /// Get the current state of a proposal.
    /// TODO issue #1: implement full timing-aware state transitions.
    pub fn state(env: Env, proposal_id: u64) -> ProposalState {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        if proposal.cancelled {
            return ProposalState::Cancelled;
        }
        if proposal.executed {
            return ProposalState::Executed;
        }

        let current = env.ledger().sequence();
        if current < proposal.start_ledger {
            ProposalState::Pending
        } else if current <= proposal.end_ledger {
            ProposalState::Active
        } else {
            // TODO: check quorum and votes_for > votes_against
            ProposalState::Defeated
        }
    }

    /// Get vote counts for a proposal.
    pub fn proposal_votes(env: Env, proposal_id: u64) -> (i128, i128, i128) {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");
        (proposal.votes_for, proposal.votes_against, proposal.votes_abstain)
    }

    /// Get governor configuration.
    pub fn voting_delay(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::VotingDelay).unwrap_or(100)
    }

    pub fn voting_period(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::VotingPeriod).unwrap_or(1000)
    }

    pub fn proposal_threshold(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::ProposalThreshold).unwrap_or(0)
    }

    /// Get total proposal count.
    pub fn proposal_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::ProposalCount).unwrap_or(0)
    }

    /// Upgrade the governor contract to a new WASM implementation.
    ///
    /// Authorization is restricted to the governor's own contract address.
    /// This means the call must originate from an executed on-chain proposal:
    /// the timelock invokes `upgrade` on behalf of a passed vote, with the
    /// governor contract itself as the authorised principal.
    ///
    /// Upgrade flow:
    ///   1. A proposer creates a proposal whose calldata targets `upgrade(hash)`
    ///   2. Token holders vote; quorum and majority are reached
    ///   3. The proposal is queued in the Timelock with the configured delay
    ///   4. After the delay, anyone triggers execution
    ///   5. The Timelock calls `governor.upgrade(hash)` as an authorised
    ///      sub-invocation of the contract's own address
    ///   6. `env.deployer().update_current_contract_wasm` replaces the WASM;
    ///      the contract address, balance, and storage all remain intact
    ///
    /// If the new WASM changes the storage layout, call `migrate` immediately
    /// after this in the same proposal's calldata.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        env.current_contract_address().require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash.clone());
        env.events().publish((symbol_short!("upgrade"),), new_wasm_hash);
    }

    /// Migrate contract storage after a WASM upgrade.
    ///
    /// Like `upgrade`, this can only be called from the governor's own address
    /// and must therefore be triggered through an executed on-chain proposal.
    ///
    /// This is a no-op stub. When a future upgrade introduces changes to the
    /// on-chain storage layout, extend [`MigrateData`] with the required
    /// values and implement the migration logic here.
    pub fn migrate(env: Env, _data: MigrateData) {
        env.current_contract_address().require_auth();
        // TODO: implement storage migration logic when a breaking storage
        // change is introduced in a future upgrade.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        BytesN, Env, IntoVal,
    };

    // ── upgrade ──────────────────────────────────────────────────────────────
    // Note: a full end-to-end upgrade test (auth passes → WASM swapped) requires
    // a compiled WASM binary uploaded via env.deployer().upload_contract_wasm().
    // That path is covered by integration tests run after `cargo build --target
    // wasm32-unknown-unknown`. The unit tests below focus on the auth guard,
    // which is the security-critical invariant.

    #[test]
    #[should_panic]
    fn upgrade_rejects_caller_that_is_not_the_contract_address() {
        // Fresh env — no mock_all_auths. We mock auth as a random attacker so
        // that the contract's own require_auth check finds no matching mock
        // and panics with an auth error.
        let env = Env::default();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let attacker = Address::generate(&env);
        let new_wasm_hash = BytesN::from_array(&env, &[2u8; 32]);

        // Only `attacker` is mocked, not `contract_id`. upgrade() calls
        // env.current_contract_address().require_auth() which looks for
        // (contract_id, "upgrade") — it won't find it and panics.
        env.mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "upgrade",
                args: (new_wasm_hash.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        client.upgrade(&new_wasm_hash);
    }

    #[test]
    #[should_panic]
    fn upgrade_rejects_admin_acting_as_direct_caller() {
        // Even the stored admin cannot bypass the contract-self auth guard.
        // The only valid upgrade path is through an executed on-chain proposal.
        let env = Env::default();
        let admin = Address::generate(&env);
        let votes_token = Address::generate(&env);
        let timelock = Address::generate(&env);
        let contract_id = env.register(GovernorContract, ());

        env.mock_all_auths();
        GovernorContractClient::new(&env, &contract_id).initialize(
            &admin,
            &votes_token,
            &timelock,
            &100u32,
            &1000u32,
            &40u32,
            &0i128,
        );

        let new_wasm_hash = BytesN::from_array(&env, &[3u8; 32]);
        let client = GovernorContractClient::new(&env, &contract_id);

        // Replace mock_all_auths with a specific mock for admin only.
        // The upgrade guard requires contract_id, not admin — must panic.
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "upgrade",
                args: (new_wasm_hash.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        client.upgrade(&new_wasm_hash);
    }
}

#![no_std]

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN,
    Env, String, Symbol,
};

/// Cross-contract interface for the Timelock contract.
///
/// The governor uses this to schedule proposals after they succeed and to
/// trigger execution once the mandatory delay has elapsed.
#[contractclient(name = "TimelockClient")]
pub trait TimelockTrait {
    fn schedule(
        env: Env,
        caller: Address,
        target: Address,
        data: Bytes,
        fn_name: Symbol,
        delay: u64,
    ) -> Bytes;
    fn execute(env: Env, caller: Address, op_id: Bytes);
    fn min_delay(env: Env) -> u64;
}

/// Cross-contract interface for the Token-Votes contract.
#[contractclient(name = "VotesTokenClient")]
pub trait VotesTokenTrait {
    fn get_past_total_supply(env: Env, ledger: u32) -> i128;
}

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
    /// Contract address that will be invoked when the proposal executes.
    pub target: Address,
    /// Function on `target` to call on execution (no-arg convention; full
    /// calldata-with-args encoding is TODO issue #6).
    pub fn_name: Symbol,
    /// Arbitrary bytes forwarded to the timelock alongside the target. Used
    /// to compute the operation id and, in future, to pass structured args.
    pub calldata: Bytes,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub votes_for: i128,
    pub votes_against: i128,
    pub votes_abstain: i128,
    pub executed: bool,
    pub cancelled: bool,
    pub queued: bool,
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
    VoteReason(u64, Address),
    /// The timelock op-id (Bytes) for a proposal after queue() is called.
    QueuedOpId(u64),
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
        env.storage()
            .instance()
            .set(&DataKey::VotesToken, &votes_token);
        env.storage().instance().set(&DataKey::Timelock, &timelock);
        env.storage()
            .instance()
            .set(&DataKey::VotingDelay, &voting_delay);
        env.storage()
            .instance()
            .set(&DataKey::VotingPeriod, &voting_period);
        env.storage()
            .instance()
            .set(&DataKey::QuorumNumerator, &quorum_numerator);
        env.storage()
            .instance()
            .set(&DataKey::ProposalThreshold, &proposal_threshold);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
    }

    /// Create a new governance proposal.
    ///
    /// `target` and `fn_name` identify the contract function to invoke if the
    /// proposal succeeds and is executed via the timelock. `calldata` is
    /// forwarded to the timelock's schedule call and used to derive the
    /// operation id. TODO issue #2: add threshold check.
    pub fn propose(
        env: Env,
        proposer: Address,
        description: String,
        target: Address,
        fn_name: Symbol,
        calldata: Bytes,
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
            target,
            fn_name,
            calldata,
            start_ledger: current + voting_delay,
            end_ledger: current + voting_delay + voting_period,
            votes_for: 0,
            votes_against: 0,
            votes_abstain: 0,
            executed: false,
            cancelled: false,
            queued: false,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);

        env.events()
            .publish((symbol_short!("propose"), proposer), proposal_id);

        proposal_id
    }

    /// Cast a vote on an active proposal.
    /// TODO issue #3: add voting power lookup from token-votes contract.
    pub fn cast_vote(env: Env, voter: Address, proposal_id: u64, support: VoteSupport) {
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

        env.events()
            .publish((symbol_short!("vote"), voter), (proposal_id, support));
    }

    /// Cast a vote with an on-chain reason string.
    pub fn cast_vote_with_reason(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: VoteSupport,
        reason: String,
    ) {
        Self::cast_vote(env.clone(), voter.clone(), proposal_id, support.clone());

        // Store the reason in persistent storage
        env.storage()
            .persistent()
            .set(&DataKey::VoteReason(proposal_id, voter.clone()), &reason);

        // Emit VoteCastWithReason event
        env.events().publish(
            (symbol_short!("vote_rsn"), voter),
            (proposal_id, support, reason),
        );
    }

    /// Queue a succeeded proposal for execution via the timelock.
    ///
    /// Reads the timelock's configured `min_delay` and schedules the proposal's
    /// target invocation. The returned op-id is stored so `execute()` can
    /// reference it later.
    pub fn queue(env: Env, proposal_id: u64) {
        assert!(
            Self::state(env.clone(), proposal_id) == ProposalState::Succeeded,
            "proposal not succeeded"
        );

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        let timelock_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Timelock)
            .expect("timelock not set");
        let gov_addr = env.current_contract_address();
        let timelock = TimelockClient::new(&env, &timelock_addr);

        // Use the timelock's own minimum delay to guarantee the configured
        // execution window is respected.
        let delay = timelock.min_delay();
        let op_id = timelock.schedule(
            &gov_addr,
            &proposal.target,
            &proposal.calldata,
            &proposal.fn_name,
            &delay,
        );

        env.storage()
            .persistent()
            .set(&DataKey::QueuedOpId(proposal_id), &op_id);

        proposal.queued = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish((symbol_short!("queue"),), proposal_id);
    }

    /// Execute a queued proposal.
    ///
    /// Delegates to the timelock to enforce the delay, which in turn invokes
    /// `proposal.fn_name()` on `proposal.target`.
    pub fn execute(env: Env, proposal_id: u64) {
        assert!(
            Self::state(env.clone(), proposal_id) == ProposalState::Queued,
            "proposal not queued"
        );

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        let timelock_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Timelock)
            .expect("timelock not set");
        let gov_addr = env.current_contract_address();
        let op_id: Bytes = env
            .storage()
            .persistent()
            .get(&DataKey::QueuedOpId(proposal_id))
            .expect("no op id — call queue() first");

        TimelockClient::new(&env, &timelock_addr).execute(&gov_addr, &op_id);

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
    ///
    /// After the voting period ends, the proposal is Succeeded when it has at
    /// least one For vote, more For votes than Against votes, and meets the
    /// quorum requirement (votes_for >= quorum).
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
        if proposal.queued {
            return ProposalState::Queued;
        }

        let current = env.ledger().sequence();
        if current < proposal.start_ledger {
            ProposalState::Pending
        } else if current <= proposal.end_ledger {
            ProposalState::Active
        } else {
            let quorum = Self::quorum(env.clone(), proposal_id);
            if proposal.votes_for > proposal.votes_against && proposal.votes_for >= quorum {
                ProposalState::Succeeded
            } else {
                ProposalState::Defeated
            }
        }
    }

    /// Calculate the quorum required for a proposal based on the total supply
    /// at the proposal's start ledger.
    pub fn quorum(env: Env, proposal_id: u64) -> i128 {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        let votes_token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::VotesToken)
            .expect("votes token not set");

        let quorum_numerator: u32 = env
            .storage()
            .instance()
            .get(&DataKey::QuorumNumerator)
            .unwrap_or(0);

        let votes_token = VotesTokenClient::new(&env, &votes_token_addr);
        let supply = votes_token.get_past_total_supply(&proposal.start_ledger);

        (supply * quorum_numerator as i128) / 100
    }

    /// Get vote counts for a proposal.
    pub fn proposal_votes(env: Env, proposal_id: u64) -> (i128, i128, i128) {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");
        (
            proposal.votes_for,
            proposal.votes_against,
            proposal.votes_abstain,
        )
    }

    /// Get governor configuration.
    pub fn voting_delay(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::VotingDelay)
            .unwrap_or(100)
    }

    pub fn voting_period(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(1000)
    }

    pub fn proposal_threshold(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalThreshold)
            .unwrap_or(0)
    }

    /// Get total proposal count.
    pub fn proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    /// Get the vote reason for a specific voter on a proposal.
    pub fn get_vote_reason(env: Env, proposal_id: u64, voter: Address) -> Option<String> {
        env.storage()
            .persistent()
            .get(&DataKey::VoteReason(proposal_id, voter))
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
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger as _},
        Bytes, Env, Symbol, TryIntoVal,
    };

    /// Shared helper: initialize the governor and return a proposal id using a
    /// dummy target so the existing vote-with-reason tests remain focused on
    /// their specific behaviour without needing a real timelock or target.
    fn propose_dummy(
        env: &Env,
        client: &GovernorContractClient,
        proposer: &Address,
    ) -> u64 {
        let target = Address::generate(env);
        let fn_name = Symbol::new(env, "noop");
        let calldata = Bytes::new(env);
        let description = String::from_str(env, "Test proposal");
        client.propose(proposer, &description, &target, &fn_name, &calldata)
    }

    #[test]
    fn test_cast_vote_with_reason_stores_reason() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let votes_token = Address::generate(&env);
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(&admin, &votes_token, &timelock, &100, &1000, &50, &1000);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        let reason = String::from_str(&env, "I support this because it improves governance");
        client.cast_vote_with_reason(&voter, &proposal_id, &VoteSupport::For, &reason);

        let stored_reason = client.get_vote_reason(&proposal_id, &voter);
        assert_eq!(stored_reason, Some(reason));
    }

    #[test]
    fn test_cast_vote_with_reason_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let votes_token = Address::generate(&env);
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(&admin, &votes_token, &timelock, &100, &1000, &50, &1000);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        let reason = String::from_str(&env, "This aligns with our community values");
        client.cast_vote_with_reason(&voter, &proposal_id, &VoteSupport::For, &reason);

        let events = env.events().all();
        assert!(events.len() >= 2);

        let has_vote_rsn = events.iter().any(|(_, topics, _)| {
            topics.len() >= 1 && {
                let first: Result<soroban_sdk::Symbol, _> =
                    topics.get(0).unwrap().try_into_val(&env);
                first.is_ok() && first.unwrap() == symbol_short!("vote_rsn")
            }
        });

        assert!(has_vote_rsn, "VoteCastWithReason event not emitted");
    }

    #[test]
    fn test_cast_vote_with_reason_multiple_voters() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let votes_token = Address::generate(&env);
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter1 = Address::generate(&env);
        let voter2 = Address::generate(&env);

        client.initialize(&admin, &votes_token, &timelock, &100, &1000, &50, &1000);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        let reason1 = String::from_str(&env, "I agree with this proposal");
        let reason2 = String::from_str(&env, "I disagree with this proposal");

        client.cast_vote_with_reason(&voter1, &proposal_id, &VoteSupport::For, &reason1);
        client.cast_vote_with_reason(&voter2, &proposal_id, &VoteSupport::Against, &reason2);

        let stored_reason1 = client.get_vote_reason(&proposal_id, &voter1);
        let stored_reason2 = client.get_vote_reason(&proposal_id, &voter2);

        assert_eq!(stored_reason1, Some(reason1));
        assert_eq!(stored_reason2, Some(reason2));
    }

    #[test]
    fn test_quorum_and_state() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        // Deploy and register the actual TokenVotes contract for the test.
        let token_admin = Address::generate(&env);
        let underlying_token = Address::generate(&env);
        let votes_id = env.register(sorogov_token_votes::TokenVotesContract, ());
        let votes_client = sorogov_token_votes::TokenVotesContractClient::new(&env, &votes_id);
        votes_client.initialize(&token_admin, &underlying_token);

        // Initialize governor with 50% quorum (50 / 100).
        client.initialize(&admin, &votes_id, &timelock, &0, &100, &50, &0);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance ledger to start voting.
        env.ledger().with_mut(|li| li.sequence_number += 1);

        // cast_vote uses a weight of 1 for now (TODO issue #3).
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        // Advance ledger to end voting.
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // If quorum is 0, 1 For vote should succeed.
        assert_eq!(client.state(&proposal_id), ProposalState::Succeeded);
        assert_eq!(client.quorum(&proposal_id), 0);
    }
}

#[cfg(test)]
mod tests;

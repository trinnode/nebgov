//! End-to-end integration test for the full NebGov proposal lifecycle.
//!
//! Exercises the complete flow across all three contracts:
//!   Governor → Timelock → Token-Votes
//!
//! Flow under test:
//!   1. Deploy all contracts and a mock execution target
//!   2. Mint governance tokens and delegate to voter accounts
//!   3. Create a proposal that targets the mock contract
//!   4. Advance the ledger past `start_ledger`; cast votes to achieve a
//!      simple majority
//!   5. Advance past `end_ledger`; verify the proposal is in Succeeded state
//!   6. Call `queue()` and verify the timelock operation is scheduled
//!   7. Advance the timestamp past the timelock delay
//!   8. Call `execute()` and verify the mock target function was invoked
//!   9. Verify final governor state is Executed

use crate::{
    GovernorContract, GovernorContractClient, Proposal, ProposalState, VoteSupport, VoteType,
    VotingStrategy, WeightedToken,
};

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events, Ledger as _},
    token, Address, Bytes, Env, Symbol, TryIntoVal,
};

// ---------------------------------------------------------------------------
// MockTarget — a minimal contract whose sole purpose is to record that it was
// called by the governance execution path.
// ---------------------------------------------------------------------------

#[contract]
pub struct MockTarget;

#[contractimpl]
impl MockTarget {
    /// Called by the timelock when the proposal executes.
    /// Stores a flag so the test can verify the invocation happened.
    pub fn exec_gov(env: Env) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("called"), &true);
    }

    /// Returns whether `exec_gov` has been called at least once.
    pub fn was_called(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("called"))
            .unwrap_or(false)
    }
}

#[contracttype]
#[derive(Clone)]
enum ConfigurableVotesDataKey {
    Votes(Address),
    TotalSupply,
}

#[contract]
pub struct ConfigurableVotesContract;

#[contractimpl]
impl ConfigurableVotesContract {
    pub fn set_votes(env: Env, account: Address, votes: i128) {
        env.storage()
            .instance()
            .set(&ConfigurableVotesDataKey::Votes(account), &votes);
    }

    pub fn set_total_supply(env: Env, supply: i128) {
        env.storage()
            .instance()
            .set(&ConfigurableVotesDataKey::TotalSupply, &supply);
    }

    pub fn get_votes(env: Env, account: Address) -> i128 {
        env.storage()
            .instance()
            .get(&ConfigurableVotesDataKey::Votes(account))
            .unwrap_or(0)
    }

    pub fn get_past_votes(env: Env, account: Address, _ledger: u32) -> i128 {
        Self::get_votes(env, account)
    }

    pub fn get_past_total_supply(env: Env, _ledger: u32) -> i128 {
        env.storage()
            .instance()
            .get(&ConfigurableVotesDataKey::TotalSupply)
            .unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// TimelockContract reference — we call the deployed timelock via its generated
// client, which is available because both crates share the same test binary.
// ---------------------------------------------------------------------------

use sorogov_timelock::{TimelockContract, TimelockContractClient};
use sorogov_token_votes::{TokenVotesContract, TokenVotesContractClient};

fn count_topic(env: &Env, topic_name: &str) -> usize {
    let topic_symbol = Symbol::new(env, topic_name);
    env.events()
        .all()
        .iter()
        .filter(|(_, topics, _)| {
            topics.len() > 0 && {
                let first: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(env);
                first.is_ok() && first.unwrap() == topic_symbol
            }
        })
        .count()
}

fn make_multi_token_strategy(env: &Env, entries: &[(Address, u32)]) -> VotingStrategy {
    let mut weighted_tokens = soroban_sdk::Vec::new(env);
    for (token, weight_bps) in entries.iter() {
        weighted_tokens.push_back(WeightedToken {
            token: token.clone(),
            weight_bps: *weight_bps,
        });
    }
    VotingStrategy::MultiToken(weighted_tokens)
}

fn propose_exec_gov(
    env: &Env,
    governor_client: &GovernorContractClient,
    proposer: &Address,
    target: &Address,
    proposal_seed: &[u8],
) -> u64 {
    let description = soroban_sdk::String::from_str(env, "Multi-token integration proposal");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(env, proposal_seed))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(env, "ipfs://multi-token");

    let mut targets = soroban_sdk::Vec::new(env);
    targets.push_back(target.clone());

    let mut fn_names = soroban_sdk::Vec::new(env);
    fn_names.push_back(Symbol::new(env, "exec_gov"));

    let mut calldatas = soroban_sdk::Vec::new(env);
    let _ = proposal_seed;
    calldatas.push_back(Bytes::new(env));

    governor_client.propose(
        proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    )
}

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

#[test]
fn test_full_proposal_lifecycle() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // ------------------------------------------------------------------
    // 1. Deploy all contracts.
    // ------------------------------------------------------------------

    // Underlying SEP-41 governance token (stellar asset contract).
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    // Token-Votes contract wraps the governance token.
    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    // MockTarget — the contract the proposal will call on execution.
    let mock_target_id = env.register(MockTarget, ());
    let mock_client = MockTargetClient::new(&env, &mock_target_id);

    // Timelock and Governor need to reference each other. We register both
    // first, then initialize in order: timelock (needs governor address),
    // governor (needs timelock address).
    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    // 1-second minimum delay — keeps the test fast while still exercising
    // the delay enforcement path.
    let min_delay: u64 = 1;
    timelock_client.initialize(&admin, &governor_id, &min_delay, &1_209_600);

    // voting_delay = 10 ledgers, voting_period = 20 ledgers, quorum 50 %.
    let guardian = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32, // voting_delay
        &20_u32, // voting_period
        &0_u32,  // quorum_numerator (set to 0 for this simple majority test)
        &0_i128, // proposal_threshold
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    // ------------------------------------------------------------------
    // 2. Mint governance tokens and delegate to voter accounts.
    // ------------------------------------------------------------------

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    token_admin.mint(&alice, &500_i128);
    token_admin.mint(&bob, &500_i128);

    // Both voters self-delegate so their balances count toward total supply.
    votes_client.delegate(&alice, &alice);
    votes_client.delegate(&bob, &bob);

    // ------------------------------------------------------------------
    // 3. Create a proposal targeting MockTarget::exec_gov.
    // ------------------------------------------------------------------

    let proposer = Address::generate(&env);
    let fn_name = Symbol::new(&env, "exec_gov");
    // The calldata uniquely identifies this operation in the timelock.
    // We encode the proposal topic as its bytes; no structured args needed
    // for the no-arg exec_gov function (full arg encoding is TODO issue #6).
    let calldata = Bytes::new(&env);
    let description = soroban_sdk::String::from_str(&env, "Execute mock governance action");

    // Create Vec with single target, fn_name, and calldata
    let mut targets = soroban_sdk::Vec::new(&env);
    targets.push_back(mock_target_id.clone());

    let mut fn_names = soroban_sdk::Vec::new(&env);
    fn_names.push_back(fn_name);

    let mut calldatas = soroban_sdk::Vec::new(&env);
    calldatas.push_back(calldata);

    // Ledger starts at 0; start_ledger = 0 + 10 = 10, end_ledger = 0 + 30.
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"Upgrade protocol fee to 0.3%"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://QmExample");
    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );
    assert_eq!(proposal_id, 1);

    // Immediately after proposal creation the state is Pending.
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Pending,
        "expected Pending right after propose()"
    );

    // ------------------------------------------------------------------
    // 4. Advance ledger past start_ledger; cast votes to achieve quorum.
    // ------------------------------------------------------------------

    // Jump to ledger 11 — inside the voting window [10, 30].
    env.ledger().with_mut(|l| l.sequence_number = 11);

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Active,
        "expected Active during voting window"
    );

    // Both Alice and Bob vote For. cast_vote() now reads snapshot voting
    // power from token-votes; Alice has 500 and Bob has 500, totalling 1000.
    governor_client.cast_vote(&alice, &proposal_id, &VoteSupport::For);
    governor_client.cast_vote(&bob, &proposal_id, &VoteSupport::For);

    let (votes_for, votes_against, votes_abstain) = governor_client.proposal_votes(&proposal_id);
    assert_eq!(
        votes_for, 1000,
        "votes should reflect token-weighted power (500 + 500)"
    );
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 0);

    // ------------------------------------------------------------------
    // 5. Advance ledger past end_ledger; verify Succeeded state.
    // ------------------------------------------------------------------

    // Jump to ledger 31 — past the end of the voting window.
    env.ledger().with_mut(|l| l.sequence_number = 31);

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Succeeded,
        "expected Succeeded after voting period with majority For"
    );

    // ------------------------------------------------------------------
    // 6. Queue the proposal; verify the timelock operation is scheduled.
    // ------------------------------------------------------------------

    // Capture the current timestamp before queue() so we can compute the
    // expected ready_at for the timelock operation.
    let ts_before_queue = env.ledger().timestamp();

    governor_client.queue(&proposal_id);

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Queued,
        "expected Queued after queue()"
    );

    // Confirm the timelock received the schedule() call. The operation is
    // pending because the delay has not yet elapsed.
    let op_id: Bytes = env.as_contract(&governor_id, || {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&crate::DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        proposal.op_ids.get(0).unwrap()
    });

    // is_pending: scheduled but delay not yet elapsed.
    assert!(
        timelock_client.is_pending(&op_id),
        "timelock operation should be pending immediately after queue()"
    );
    assert!(
        !timelock_client.is_ready(&op_id),
        "timelock operation should not be ready before delay elapses"
    );

    // ------------------------------------------------------------------
    // 7. Advance the timestamp past the timelock delay.
    // ------------------------------------------------------------------

    // Move wall-clock time forward by min_delay + 1 second so the timelock
    // considers the operation ready.
    env.ledger()
        .with_mut(|l| l.timestamp = ts_before_queue + min_delay + 1);

    assert!(
        timelock_client.is_ready(&op_id),
        "timelock operation should be ready after delay has elapsed"
    );
    assert!(
        !timelock_client.is_pending(&op_id),
        "timelock operation should no longer be pending once ready"
    );

    // MockTarget should not have been called yet.
    assert!(
        !mock_client.was_called(),
        "mock target must not be called before execute()"
    );

    // ------------------------------------------------------------------
    // 8. Execute the proposal; verify the mock target function was called.
    // ------------------------------------------------------------------

    governor_client.execute(&proposal_id);

    // The timelock invoked MockTarget::exec_gov during the execute() flow.
    assert!(
        mock_client.was_called(),
        "MockTarget::exec_gov should have been called by the timelock"
    );

    // ------------------------------------------------------------------
    // 9. Verify final governor state is Executed.
    // ------------------------------------------------------------------

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Executed,
        "expected Executed after execute()"
    );
}

/// Test the veto window functionality.
///
/// This test verifies that:
/// 1. Guardian can cancel a queued proposal during the veto window
/// 2. Cancellation prevents execution of the proposal
/// 3. Timelock operations are properly cancelled
/// 4. After the veto window closes, cancellation is blocked
#[test]
fn test_cancel_queued_during_veto_window() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // ------------------------------------------------------------------
    // Setup: Deploy all contracts
    // ------------------------------------------------------------------

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let mock_target_id = env.register(MockTarget, ());
    let mock_client = MockTargetClient::new(&env, &mock_target_id);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    let min_delay: u64 = 100; // 100 seconds
    timelock_client.initialize(&admin, &governor_id, &min_delay, &1_209_600);

    let guardian = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    // ------------------------------------------------------------------
    // Create tokens, delegate, and create proposal
    // ------------------------------------------------------------------

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    token_admin.mint(&alice, &500_i128);
    token_admin.mint(&bob, &500_i128);

    votes_client.delegate(&alice, &alice);
    votes_client.delegate(&bob, &bob);

    let proposer = Address::generate(&env);
    let fn_name = Symbol::new(&env, "exec_gov");
    let calldata = Bytes::from_slice(&env, b"governance-proposal-veto-test");
    let description = soroban_sdk::String::from_str(&env, "Test veto window");

    let mut targets = soroban_sdk::Vec::new(&env);
    targets.push_back(mock_target_id.clone());

    let mut fn_names = soroban_sdk::Vec::new(&env);
    fn_names.push_back(fn_name);

    let mut calldatas = soroban_sdk::Vec::new(&env);
    calldatas.push_back(calldata);

    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"test"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://test");
    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    // ------------------------------------------------------------------
    // Vote and queue the proposal
    // ------------------------------------------------------------------

    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&alice, &proposal_id, &VoteSupport::For);
    governor_client.cast_vote(&bob, &proposal_id, &VoteSupport::For);

    env.ledger().with_mut(|l| l.sequence_number = 31);
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Succeeded
    );

    let ts_before_queue = env.ledger().timestamp();
    let queue_ledger_before = env.ledger().sequence();

    governor_client.queue(&proposal_id);
    assert_eq!(governor_client.state(&proposal_id), ProposalState::Queued);

    // Get the operation ID
    let op_id: Bytes = env.as_contract(&governor_id, || {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&crate::DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        proposal.op_ids.get(0).unwrap()
    });

    assert!(
        timelock_client.is_pending(&op_id),
        "operation should be pending after queue()"
    );

    // ------------------------------------------------------------------
    // Guardian cancels the proposal during veto window
    // ------------------------------------------------------------------

    governor_client.cancel_queued(&guardian, &proposal_id);

    // Proposal should now be Cancelled
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Cancelled,
        "proposal should be Cancelled after cancel_queued()"
    );

    // Timelock operation should also be cancelled
    // is_pending should return false because the operation is cancelled
    assert!(
        !timelock_client.is_pending(&op_id),
        "operation should not be pending after cancel"
    );

    // Advance time past the timelock delay
    env.ledger()
        .with_mut(|l| l.timestamp = ts_before_queue + min_delay + 1);

    // MockTarget should not be called
    assert!(
        !mock_client.was_called(),
        "cancelled proposal should not execute"
    );
}

/// Test that cancel_queued fails after the veto window closes
#[test]
#[should_panic]
fn test_cancel_queued_after_window_closes() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // Setup
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let mock_target_id = env.register(MockTarget, ());

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    let min_delay: u64 = 100;
    timelock_client.initialize(&admin, &governor_id, &min_delay, &1_209_600);

    let guardian = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    // Create and queue a proposal
    let alice = Address::generate(&env);
    token_admin.mint(&alice, &500_i128);
    votes_client.delegate(&alice, &alice);

    let proposer = Address::generate(&env);
    let fn_name = Symbol::new(&env, "exec_gov");
    let calldata = Bytes::from_slice(&env, b"test");
    let description = soroban_sdk::String::from_str(&env, "Test");

    let mut targets = soroban_sdk::Vec::new(&env);
    targets.push_back(mock_target_id);
    let mut fn_names = soroban_sdk::Vec::new(&env);
    fn_names.push_back(fn_name);
    let mut calldatas = soroban_sdk::Vec::new(&env);
    calldatas.push_back(calldata);

    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"test"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://test");
    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&alice, &proposal_id, &VoteSupport::For);

    env.ledger().with_mut(|l| l.sequence_number = 31);
    governor_client.queue(&proposal_id);

    // Advance ledger far past the veto window (min_delay is 100 seconds, roughly 10-20 ledgers)
    // Use a very large advance to ensure we're well past the veto window
    env.ledger()
        .with_mut(|l| l.sequence_number = l.sequence_number + 1000);

    // Try to cancel after veto window closes — should fail
    governor_client.cancel_queued(&guardian, &proposal_id);
}

#[test]
fn test_multi_token_weight_arithmetic_zero_balance_and_edge_tokens() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    let zero_voter = Address::generate(&env);

    let token_a = env.register(ConfigurableVotesContract, ());
    let token_b = env.register(ConfigurableVotesContract, ());
    let token_c = env.register(ConfigurableVotesContract, ());
    let token_e = env.register(ConfigurableVotesContract, ());
    let missing_token = Address::generate(&env);

    let token_a_client = ConfigurableVotesContractClient::new(&env, &token_a);
    let token_b_client = ConfigurableVotesContractClient::new(&env, &token_b);
    let token_c_client = ConfigurableVotesContractClient::new(&env, &token_c);
    let token_e_client = ConfigurableVotesContractClient::new(&env, &token_e);

    token_a_client.set_votes(&voter, &100);
    token_b_client.set_votes(&voter, &40);
    token_c_client.set_votes(&voter, &0);
    token_e_client.set_votes(&voter, &10);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    timelock_client.initialize(&admin, &governor_id, &0, &1_209_600);
    governor_client.initialize(
        &admin,
        &token_a,
        &timelock_id,
        &10,
        &20,
        &0,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let strategy = make_multi_token_strategy(
        &env,
        &[
            (token_a.clone(), 10_000),
            (token_b.clone(), 15_000),
            (token_c.clone(), 5_000),
            (missing_token, 20_000),
            (token_e.clone(), 2_500),
        ],
    );
    governor_client.set_voting_strategy(&strategy);

    let mock_target_id = env.register(MockTarget, ());
    let proposal_id = propose_exec_gov(
        &env,
        &governor_client,
        &proposer,
        &mock_target_id,
        b"multi-token-weighted",
    );

    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    let (votes_for, votes_against, votes_abstain) = governor_client.proposal_votes(&proposal_id);
    // 100*1.0 + 40*1.5 + 0*0.5 + missing*2.0 + 10*0.25 = 100 + 60 + 0 + 0 + 2
    assert_eq!(votes_for, 162);
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 0);

    governor_client.cast_vote(&zero_voter, &proposal_id, &VoteSupport::Against);
    let receipt = governor_client.get_receipt(&proposal_id, &zero_voter);
    assert!(receipt.has_voted);
    assert_eq!(receipt.weight, 0);
}

#[test]
fn test_multi_token_quorum_uses_weighted_total_supply_sum() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);

    let token_a = env.register(ConfigurableVotesContract, ());
    let token_b = env.register(ConfigurableVotesContract, ());
    let token_c = env.register(ConfigurableVotesContract, ());

    let token_a_client = ConfigurableVotesContractClient::new(&env, &token_a);
    let token_b_client = ConfigurableVotesContractClient::new(&env, &token_b);
    let token_c_client = ConfigurableVotesContractClient::new(&env, &token_c);

    token_a_client.set_total_supply(&1_000);
    token_b_client.set_total_supply(&2_000);
    token_c_client.set_total_supply(&3_000);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);
    let mock_target_id = env.register(MockTarget, ());

    timelock_client.initialize(&admin, &governor_id, &0, &1_209_600);
    governor_client.initialize(
        &admin,
        &token_a,
        &timelock_id,
        &10,
        &20,
        &20,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let strategy = make_multi_token_strategy(
        &env,
        &[
            (token_a.clone(), 10_000),
            (token_b.clone(), 5_000),
            (token_c.clone(), 20_000),
        ],
    );
    governor_client.set_voting_strategy(&strategy);

    let proposal_id = propose_exec_gov(
        &env,
        &governor_client,
        &proposer,
        &mock_target_id,
        b"multi-token-quorum",
    );

    assert_eq!(governor_client.quorum(&proposal_id), 1_600);
}

#[test]
#[should_panic(expected = "Error(Contract, #27)")]
fn test_multi_token_overflow_is_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);

    let token_a = env.register(ConfigurableVotesContract, ());
    let token_b = env.register(ConfigurableVotesContract, ());
    let token_c = env.register(ConfigurableVotesContract, ());
    let token_d = env.register(ConfigurableVotesContract, ());
    let token_e = env.register(ConfigurableVotesContract, ());

    for token in [&token_a, &token_b, &token_c, &token_d, &token_e] {
        let client = ConfigurableVotesContractClient::new(&env, token);
        client.set_votes(&voter, &i128::MAX);
    }

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);
    let mock_target_id = env.register(MockTarget, ());

    timelock_client.initialize(&admin, &governor_id, &0, &1_209_600);
    governor_client.initialize(
        &admin,
        &token_a,
        &timelock_id,
        &10,
        &20,
        &0,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let strategy = make_multi_token_strategy(
        &env,
        &[
            (token_a.clone(), 20_000),
            (token_b.clone(), 20_000),
            (token_c.clone(), 20_000),
            (token_d.clone(), 20_000),
            (token_e.clone(), 20_000),
        ],
    );
    governor_client.set_voting_strategy(&strategy);

    let proposal_id = propose_exec_gov(
        &env,
        &governor_client,
        &proposer,
        &mock_target_id,
        b"multi-token-overflow",
    );

    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
}

#[test]
fn test_multi_token_full_lifecycle_with_three_tokens_and_quorum_gate() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let token_a = env.register(ConfigurableVotesContract, ());
    let token_b = env.register(ConfigurableVotesContract, ());
    let token_c = env.register(ConfigurableVotesContract, ());

    let token_a_client = ConfigurableVotesContractClient::new(&env, &token_a);
    let token_b_client = ConfigurableVotesContractClient::new(&env, &token_b);
    let token_c_client = ConfigurableVotesContractClient::new(&env, &token_c);

    token_a_client.set_total_supply(&1_000);
    token_b_client.set_total_supply(&1_000);
    token_c_client.set_total_supply(&1_000);

    token_a_client.set_votes(&alice, &300);
    token_b_client.set_votes(&bob, &200);
    token_c_client.set_votes(&bob, &200);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let mock_target_id = env.register(MockTarget, ());
    let mock_target_pass_id = env.register(MockTarget, ());
    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);
    let mock_client = MockTargetClient::new(&env, &mock_target_pass_id);

    timelock_client.initialize(&admin, &governor_id, &1, &1_209_600);
    governor_client.initialize(
        &admin,
        &token_a,
        &timelock_id,
        &10,
        &20,
        &20,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let strategy = make_multi_token_strategy(
        &env,
        &[
            (token_a.clone(), 10_000),
            (token_b.clone(), 10_000),
            (token_c.clone(), 10_000),
        ],
    );
    governor_client.set_voting_strategy(&strategy);

    let proposal_low = propose_exec_gov(
        &env,
        &governor_client,
        &proposer,
        &mock_target_id,
        b"multi-token-lifecycle-low",
    );
    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&alice, &proposal_low, &VoteSupport::For);
    env.ledger().with_mut(|l| l.sequence_number = 31);
    assert_eq!(
        governor_client.state(&proposal_low),
        ProposalState::Defeated
    );

    let proposer_pass = Address::generate(&env);
    let proposal_pass = propose_exec_gov(
        &env,
        &governor_client,
        &proposer_pass,
        &mock_target_pass_id,
        b"multi-token-lifecycle-pass",
    );
    env.ledger().with_mut(|l| l.sequence_number = 42);
    governor_client.cast_vote(&alice, &proposal_pass, &VoteSupport::For);
    governor_client.cast_vote(&bob, &proposal_pass, &VoteSupport::For);

    let (votes_for, votes_against, votes_abstain) = governor_client.proposal_votes(&proposal_pass);
    assert_eq!(votes_for, 700);
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 0);

    env.ledger().with_mut(|l| l.sequence_number = 62);
    assert_eq!(
        governor_client.state(&proposal_pass),
        ProposalState::Succeeded
    );

    let ts_before_queue = env.ledger().timestamp();
    governor_client.queue(&proposal_pass);
    assert_eq!(governor_client.state(&proposal_pass), ProposalState::Queued);

    env.ledger().with_mut(|l| l.timestamp = ts_before_queue + 2);
    governor_client.execute(&proposal_pass);

    assert!(mock_client.was_called());
    assert_eq!(
        governor_client.state(&proposal_pass),
        ProposalState::Executed
    );
}

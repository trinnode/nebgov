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
};

use soroban_sdk::{
    contract, contractimpl,
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

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

#[test]
fn test_full_proposal_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

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
    let calldata = Bytes::from_slice(&env, b"governance-proposal-1");
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

    assert_eq!(count_topic(&env, "ProposalCreated"), 1);
    assert_eq!(count_topic(&env, "VoteCast"), 2);
    assert_eq!(count_topic(&env, "ProposalQueued"), 1);
    assert_eq!(count_topic(&env, "ProposalExecuted"), 1);
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
    env.mock_all_auths();

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
    env.mock_all_auths();

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

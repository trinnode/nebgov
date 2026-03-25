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

use crate::{GovernorContract, GovernorContractClient, ProposalState, VoteSupport};

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    token, Address, Bytes, Env, Symbol,
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
    timelock_client.initialize(&admin, &governor_id, &min_delay);

    // voting_delay = 10 ledgers, voting_period = 20 ledgers, quorum 50 %.
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,  // voting_delay
        &20_u32,  // voting_period
        &0_u32,   // quorum_numerator (set to 0 for this simple majority test)
        &0_i128,  // proposal_threshold
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
    let proposal_id =
        governor_client.propose(&proposer, &description, &targets, &fn_names, &calldatas);
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

    // Both Alice and Bob vote For. The governor currently counts each vote
    // as weight=1 (TODO issue #3 will wire in token-votes); two For votes
    // satisfy the simple majority check.
    governor_client.cast_vote(&alice, &proposal_id, &VoteSupport::For);
    governor_client.cast_vote(&bob, &proposal_id, &VoteSupport::For);

    let (votes_for, votes_against, votes_abstain) = governor_client.proposal_votes(&proposal_id);
    assert_eq!(votes_for, 2, "both voters should have cast For votes");
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
        env.storage()
            .persistent()
            .get(&crate::DataKey::QueuedOpId(proposal_id))
            .expect("QueuedOpId not stored after queue()")
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

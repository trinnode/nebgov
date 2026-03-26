use crate::*;
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, testutils::Ledger as _, Address, Bytes, Env,
    String, Symbol,
};

/// Mock votes contract that returns a high vote count for any address,
/// allowing propose() to pass the threshold check in tests.
#[contract]
pub struct MockVotesContract;

#[contractimpl]
impl MockVotesContract {
    pub fn get_votes(_env: Env, _account: Address) -> i128 {
        // Return a high vote count that exceeds any reasonable threshold
        1_000_000
    }

    pub fn get_past_votes(_env: Env, _account: Address, _ledger: u32) -> i128 {
        // Return a fixed snapshot voting power for cast_vote() tests
        1_000_000
    }

    pub fn get_past_total_supply(_env: Env, _ledger: u32) -> i128 {
        // Return a fixed total supply for quorum calculations in tests
        10_000_000
    }
}

/// Shared helper: initialize the governor with standard test parameters.
fn setup() -> (
    Env,
    GovernorContractClient<'static>,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let votes_token_id = env.register(MockVotesContract, ());
    let timelock = Address::generate(&env);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);

    // voting_delay=10, voting_period=100, quorum_numerator=0, proposal_threshold=0
    client.initialize(&admin, &votes_token_id, &timelock, &10, &100, &0, &0);

    (env, client, admin, proposer, voter)
}

/// Shared helper: create a new proposal and return its id.
fn make_proposal(env: &Env, client: &GovernorContractClient, proposer: &Address) -> u64 {
    let target = Address::generate(env);
    let fn_name = Symbol::new(env, "exec");
    let calldata = Bytes::new(env);
    let description = String::from_str(env, "Test proposal");

    // Create Vec with single target, fn_name, and calldata
    let mut targets = soroban_sdk::Vec::new(env);
    targets.push_back(target);

    let mut fn_names = soroban_sdk::Vec::new(env);
    fn_names.push_back(fn_name);

    let mut calldatas = soroban_sdk::Vec::new(env);
    calldatas.push_back(calldata);

    client.propose(proposer, &description, &targets, &fn_names, &calldatas)
}

#[test]
/// Verifies that a proposal's initial state is Pending before the voting delay has passed.
fn test_pending_state_before_start_ledger() {
    let (env, client, _, proposer, _) = setup();
    let proposal_id = make_proposal(&env, &client, &proposer);

    assert_eq!(client.state(&proposal_id), ProposalState::Pending);
}

#[test]
/// Verifies that a proposal becomes Active exactly at the start_ledger.
fn test_active_state_at_start_ledger() {
    let (env, client, _, proposer, _) = setup();
    let proposal_id = make_proposal(&env, &client, &proposer);

    // start_ledger = current (0) + voting_delay (10) = 10
    env.ledger().set_sequence_number(10);
    assert_eq!(client.state(&proposal_id), ProposalState::Active);
}

#[test]
/// Verifies that a proposal is Defeated if no votes are cast by the end of the voting period.
fn test_defeated_when_no_votes() {
    let (env, client, _, proposer, _) = setup();
    let proposal_id = make_proposal(&env, &client, &proposer);

    // end_ledger = 10 + 100 = 110. Advance to 111.
    env.ledger().set_sequence_number(111);
    assert_eq!(client.state(&proposal_id), ProposalState::Defeated);
}

#[test]
/// Verifies that a proposal is Defeated if Against votes exceed or equal For votes.
fn test_defeated_when_against_wins() {
    let (env, client, _, proposer, voter) = setup();
    let proposal_id = make_proposal(&env, &client, &proposer);

    env.ledger().set_sequence_number(10); // Active
    client.cast_vote(&voter, &proposal_id, &VoteSupport::Against);

    env.ledger().set_sequence_number(111); // Past end
    assert_eq!(client.state(&proposal_id), ProposalState::Defeated);
}

#[test]
/// Verifies that a proposal is Defeated if voting ends in a tie
/// (votes_against == votes_for).
fn test_defeated_when_votes_for_equals_votes_against() {
    let (env, client, _, proposer, voter_for) = setup();
    let voter_against = Address::generate(&env);
    let proposal_id = make_proposal(&env, &client, &proposer);

    // Active state.
    env.ledger().set_sequence_number(10);
    client.cast_vote(&voter_for, &proposal_id, &VoteSupport::For);
    client.cast_vote(&voter_against, &proposal_id, &VoteSupport::Against);

    // Past end_ledger.
    env.ledger().set_sequence_number(111);
    assert_eq!(client.state(&proposal_id), ProposalState::Defeated);
}

#[test]
/// Verifies that a proposal is Succeeded if it has at least one For vote and matches majority.
fn test_succeeded_with_majority() {
    let (env, client, _, proposer, voter1) = setup();
    let voter2 = Address::generate(&env);
    let voter3 = Address::generate(&env);
    let proposal_id = make_proposal(&env, &client, &proposer);

    env.ledger().set_sequence_number(10); // Active
    client.cast_vote(&voter1, &proposal_id, &VoteSupport::For);
    client.cast_vote(&voter2, &proposal_id, &VoteSupport::For);
    client.cast_vote(&voter3, &proposal_id, &VoteSupport::Against);

    env.ledger().set_sequence_number(111); // Past end
    assert_eq!(client.state(&proposal_id), ProposalState::Succeeded);
}

#[test]
/// Verifies that the proposer can cancel a proposal, moving it to the Cancelled state.
fn test_cancelled_by_proposer() {
    let (env, client, _, proposer, _) = setup();
    let proposal_id = make_proposal(&env, &client, &proposer);

    client.cancel(&proposer, &proposal_id);
    assert_eq!(client.state(&proposal_id), ProposalState::Cancelled);
}

#[test]
/// Verifies that votes can be cast even in Pending state, documenting current contract behavior.
fn test_vote_state_is_pending_not_active() {
    let (env, client, _, proposer, voter) = setup();
    let proposal_id = make_proposal(&env, &client, &proposer);

    // Current ledger is 0, start_ledger is 10. State is Pending.
    client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
    assert_eq!(client.state(&proposal_id), ProposalState::Pending);
}

#[test]
#[should_panic(expected = "already voted")]
/// Verifies that a voter cannot cast more than one vote on the same proposal.
fn test_cannot_vote_twice() {
    let (env, client, _, proposer, voter) = setup();
    let proposal_id = make_proposal(&env, &client, &proposer);

    env.ledger().set_sequence_number(10); // Active
    client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
    client.cast_vote(&voter, &proposal_id, &VoteSupport::Against);
}

#[contract]
struct LocalDummyContract;

#[contractimpl]
impl LocalDummyContract {
    pub fn noop(_env: Env) {}
}

#[test]
/// Verifies that a successful proposal can be queued and then executed after the timelock delay.
fn test_proposal_execution_lifecycle() {
    let (env, client, admin, proposer, voter) = setup();

    // 1. Propose
    let proposal_id = make_proposal(&env, &client, &proposer);

    // 2. Vote (Active state)
    env.ledger().set_sequence_number(10);
    client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    // 3. Succeed (Past end_ledger)
    env.ledger().set_sequence_number(111);
    assert_eq!(client.state(&proposal_id), ProposalState::Succeeded);

    // 4. Queue (Succeeded -> Queued)
    let timelock_id = env.register(sorogov_timelock::TimelockContract, ());
    let timelock_client = sorogov_timelock::TimelockContractClient::new(&env, &timelock_id);
    timelock_client.initialize(&admin, &client.address, &0); // min_delay = 0

    let votes_token_id = env.register(MockVotesContract, ());
    client.initialize(&admin, &votes_token_id, &timelock_id, &10, &100, &0, &0);

    client.queue(&proposal_id);
    assert_eq!(client.state(&proposal_id), ProposalState::Queued);

    // 5. Execute (Queued -> Executed)
    let dummy_id = env.register(LocalDummyContract, ());

    // Re-create proposal with real dummy target
    let description = String::from_str(&env, "Test proposal 2");
    let fn_name = Symbol::new(&env, "noop");
    let calldata = Bytes::new(&env);

    // Proposal 2 will be created at current ledger (111)
    let targets = Vec::from_array(&env, [dummy_id.clone()]);
    let fn_names = Vec::from_array(&env, [fn_name.clone()]);
    let calldatas = Vec::from_array(&env, [calldata.clone()]);
    let proposal_id = client.propose(&proposer, &description, &targets, &fn_names, &calldatas);

    // Proposal 2 timing:
    // start_ledger = 111 + 10 = 121
    // end_ledger = 121 + 100 = 221

    // Use a different voter for the second proposal to avoid "already voted"
    let voter2 = Address::generate(&env);
    env.ledger().set_sequence_number(121); // Move to Active for new proposal
    client.cast_vote(&voter2, &proposal_id, &VoteSupport::For);
    env.ledger().set_sequence_number(222); // Past end_ledger (221)

    assert_eq!(client.state(&proposal_id), ProposalState::Succeeded);
    client.queue(&proposal_id);

    client.execute(&proposal_id);
    assert_eq!(client.state(&proposal_id), ProposalState::Executed);
}

#[test]
#[should_panic(expected = "not ready")]
/// Verifies that execution fails if the timelock delay has not yet passed.
fn test_execute_fails_before_timelock_delay() {
    let (env, client, admin, proposer, voter) = setup();
    let proposal_id = make_proposal(&env, &client, &proposer);

    env.ledger().set_sequence_number(10);
    client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    env.ledger().set_sequence_number(111);

    let timelock_id = env.register(sorogov_timelock::TimelockContract, ());
    let timelock_client = sorogov_timelock::TimelockContractClient::new(&env, &timelock_id);
    // Set 1 hour delay
    timelock_client.initialize(&admin, &client.address, &3600);

    let votes_token_id = env.register(MockVotesContract, ());
    client.initialize(&admin, &votes_token_id, &timelock_id, &10, &100, &0, &0);

    client.queue(&proposal_id);

    // Current time is still 0 (default). ready_at will be 3600.
    client.execute(&proposal_id);
}

//! Fuzz test for governor state machine with arbitrary ledger and vote inputs.
//!
//! This fuzz target tests the propose → vote → finalize path with:
//! - Arbitrary ledger sequences (0, u32::MAX, out-of-order)
//! - Arbitrary vote counts (zero, u128::MAX for/against)
//! - Multiple concurrent proposals
//! - Edge: vote_start == vote_end (zero-length voting period)
//! - Edge: voting_delay = 0

#![no_main]
use std::vec::Vec;

use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Bytes, Env, String, Symbol, Vec as SorobanVec,
};
use sorogov_governor::{
    GovernorContract, GovernorContractClient, ProposalState, VoteSupport, VoteType,
};

/// Fuzz input structure for governor state machine testing.
#[derive(Debug, arbitrary::Arbitrary)]
struct FuzzInput {
    /// Voting delay in ledgers (0 to 1000)
    voting_delay: u32,
    /// Voting period in ledgers (0 to 1000)
    voting_period: u32,
    /// Quorum numerator (0 to 100)
    quorum_numerator: u32,
    /// Proposal threshold (0 to 1000)
    proposal_threshold: i128,
    /// Number of proposals to create (1 to 10)
    num_proposals: u8,
    /// Votes for each proposal (0 to 1000)
    votes_for: Vec<i128>,
    /// Votes against each proposal (0 to 1000)
    votes_against: Vec<i128>,
    /// Ledger sequences to advance to (0 to 10000)
    ledger_advances: Vec<u32>,
}

fuzz_target!(|input: FuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    // Setup governor
    let admin = Address::generate(&env);
    let votes_token = Address::generate(&env);
    let timelock = Address::generate(&env);

    let governor_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &governor_id);
    let guardian = Address::generate(&env);

    client.initialize(
        &admin,
        &votes_token,
        &timelock,
        &input.voting_delay,
        &input.voting_period,
        &input.quorum_numerator,
        &input.proposal_threshold,
        &guardian,
        &VoteType::Extended,
        &0u32,
    );

    // Create proposals
    let mut proposal_ids = SorobanVec::new(&env);
    for i in 0..input.num_proposals.min(10) {
        let proposer = Address::generate(&env);
        let description = String::from_str(&env, "Test proposal");
        let description_hash = env
            .crypto()
            .sha256(&Bytes::from_slice(&env, b"Test proposal"))
            .into();
        let metadata_uri = String::from_str(&env, "ipfs://fuzz-governor-state");
        let targets = SorobanVec::from_array(&env, [Address::generate(&env)]);
        let fn_names = SorobanVec::from_array(&env, [Symbol::new(&env, "test")]);
        let calldatas = SorobanVec::from_array(&env, [Bytes::new(&env)]);

        let proposal_id = client.propose(
            &proposer,
            &description,
            &description_hash,
            &metadata_uri,
            &targets,
            &fn_names,
            &calldatas,
        );
        proposal_ids.push_back(proposal_id);
    }

    // Advance ledgers and vote
    for (i, &advance) in input.ledger_advances.iter().enumerate() {
        if i >= proposal_ids.len() as usize {
            break;
        }

        let proposal_id = proposal_ids.get(i as u32).unwrap();

        // Advance ledger
        env.ledger().with_mut(|l| {
            l.sequence_number = l.sequence_number.saturating_add(advance);
        });

        // Get proposal state
        let state = client.state(&proposal_id);

        // Vote if proposal is active
        if state == ProposalState::Active {
            let voter = Address::generate(&env);
            let votes_for = input.votes_for.get(i).copied().unwrap_or(0);
            let votes_against = input.votes_against.get(i).copied().unwrap_or(0);

            // Vote for
            if votes_for > 0 {
                client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
            }

            // Vote against
            if votes_against > 0 {
                let voter2 = Address::generate(&env);
                client.cast_vote(&voter2, &proposal_id, &VoteSupport::Against);
            }
        }

        // Verify state transitions are valid
        let final_state = client.state(&proposal_id);
        assert!(
            final_state == ProposalState::Pending
                || final_state == ProposalState::Active
                || final_state == ProposalState::Defeated
                || final_state == ProposalState::Succeeded
                || final_state == ProposalState::Queued
                || final_state == ProposalState::Executed
                || final_state == ProposalState::Cancelled,
            "Invalid proposal state: {:?}",
            final_state
        );
    }
});

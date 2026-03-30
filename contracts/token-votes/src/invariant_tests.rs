//! Property-based tests for token-votes checkpointing correctness.
//!
//! These tests verify critical invariants that must hold for all possible
//! delegation operation sequences.

extern crate std;

#[cfg(test)]
mod invariant_tests {
    use super::*;
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        token, Env,
    };

    /// Setup a token-votes contract with a test token.
    fn setup(env: &Env) -> (Address, Address) {
        let admin = Address::generate(env);
        let token_addr = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let contract_id = env.register(TokenVotesContract, ());
        let client = TokenVotesContractClient::new(env, &contract_id);
        client.initialize(&admin, &token_addr);
        (contract_id, token_addr)
    }

    proptest! {
        /// Invariant 1: Monotonicity — checkpoint ledgers are strictly non-decreasing.
        #[test]
        fn checkpoint_ledgers_are_monotonic(
            balances in proptest::collection::vec(1i128..1000, 1..20usize)
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (contract_id, token_addr) = setup(&env);
            let client = TokenVotesContractClient::new(&env, &contract_id);
            let sac_client = token::StellarAssetClient::new(&env, &token_addr);
            let delegatee = Address::generate(&env);

            for balance in &balances {
                let delegator = Address::generate(&env);
                sac_client.mint(&delegator, balance);
                client.delegate(&delegator, &delegatee);
                env.ledger().with_mut(|l| l.sequence_number += 1);
            }

            let checkpoints: soroban_sdk::Vec<Checkpoint> = env.as_contract(&contract_id, || {
                env.storage()
                    .persistent()
                    .get(&DataKey::TotalCheckpoints)
                    .unwrap_or(soroban_sdk::Vec::new(&env))
            });

            let mut prev_ledger = 0u32;
            for i in 0..checkpoints.len() {
                let cp = checkpoints.get(i).unwrap();
                prop_assert!(
                    cp.ledger >= prev_ledger,
                    "Checkpoint ledger must be non-decreasing: {} < {}",
                    cp.ledger,
                    prev_ledger
                );
                prev_ledger = cp.ledger;
            }
        }

        /// Invariant 2: Conservation — total delegated supply = sum of all minted balances.
        #[test]
        fn total_supply_equals_sum_of_delegated_balances(
            balances in proptest::collection::vec(1i128..1000, 1..20usize)
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (contract_id, token_addr) = setup(&env);
            let client = TokenVotesContractClient::new(&env, &contract_id);
            let sac_client = token::StellarAssetClient::new(&env, &token_addr);
            let delegatee = Address::generate(&env);

            let expected_total: i128 = balances.iter().sum();

            for balance in &balances {
                let delegator = Address::generate(&env);
                sac_client.mint(&delegator, balance);
                client.delegate(&delegator, &delegatee);
                env.ledger().with_mut(|l| l.sequence_number += 1);
            }

            let total_supply = client.get_past_total_supply(&env.ledger().sequence());
            prop_assert_eq!(
                total_supply,
                expected_total,
                "Total supply must equal sum of delegated balances"
            );
        }

        /// Invariant 3: Snapshot isolation — get_past_votes(addr, L) is immutable once ledger L has passed.
        #[test]
        fn snapshot_isolation(
            balances in proptest::collection::vec(1i128..1000, 1..10usize)
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (contract_id, token_addr) = setup(&env);
            let client = TokenVotesContractClient::new(&env, &contract_id);
            let sac_client = token::StellarAssetClient::new(&env, &token_addr);
            let delegatee = Address::generate(&env);

            // Collect (ledger, expected_votes) pairs as delegations happen.
            let mut snapshots: std::vec::Vec<(u32, i128)> = std::vec::Vec::new();
            let mut cumulative: i128 = 0;

            for balance in &balances {
                let delegator = Address::generate(&env);
                sac_client.mint(&delegator, balance);
                let snap_ledger = env.ledger().sequence();
                client.delegate(&delegator, &delegatee);
                cumulative += balance;
                snapshots.push((snap_ledger, cumulative));
                env.ledger().with_mut(|l| l.sequence_number += 1);
            }

            // Re-query every snapshot after all operations — must match recorded value.
            for (ledger, expected) in &snapshots {
                let actual = client.get_past_votes(&delegatee, ledger);
                prop_assert_eq!(
                    actual,
                    *expected,
                    "Snapshot at ledger {} must be immutable",
                    ledger
                );
            }
        }

        /// Invariant 4: Zero before delegation — result is 0 for any ledger before first delegation.
        #[test]
        fn zero_before_delegation(
            balances in proptest::collection::vec(1i128..1000, 1..10usize)
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (contract_id, token_addr) = setup(&env);
            let client = TokenVotesContractClient::new(&env, &contract_id);
            let sac_client = token::StellarAssetClient::new(&env, &token_addr);

            for balance in &balances {
                let delegator = Address::generate(&env);
                let delegatee = Address::generate(&env);
                sac_client.mint(&delegator, balance);
                let before_ledger = env.ledger().sequence();

                // Votes must be 0 before this account is ever delegated to.
                let votes_before = client.get_past_votes(&delegatee, &before_ledger);
                prop_assert_eq!(votes_before, 0, "Votes must be 0 before first delegation");

                client.delegate(&delegator, &delegatee);
                env.ledger().with_mut(|l| l.sequence_number += 1);
            }
        }

        /// Invariant 5: Self-delegation — gives voting power equal to token balance.
        #[test]
        fn self_delegation_gives_voting_power(
            balances in proptest::collection::vec(1i128..1000, 1..10usize)
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (contract_id, token_addr) = setup(&env);
            let client = TokenVotesContractClient::new(&env, &contract_id);
            let sac_client = token::StellarAssetClient::new(&env, &token_addr);

            for balance in &balances {
                let delegator = Address::generate(&env);
                sac_client.mint(&delegator, balance);
                client.delegate(&delegator, &delegator); // self-delegate

                let votes = client.get_votes(&delegator);
                prop_assert_eq!(
                    votes,
                    *balance,
                    "Self-delegation must give voting power equal to token balance"
                );

                env.ledger().with_mut(|l| l.sequence_number += 1);
            }
        }
    }
}

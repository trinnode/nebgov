#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, token, Address, Bytes, BytesN, Env};
use soroban_sdk::xdr::ToXdr;

#[cfg(test)]
mod load_tests;

/// A voting power checkpoint at a specific ledger sequence.
#[contracttype]
#[derive(Clone)]
pub struct Checkpoint {
    pub ledger: u32,
    pub votes: i128,
}

#[contracttype]
pub enum DataKey {
    Delegate(Address),    // delegator -> delegatee
    Checkpoints(Address), // account -> Vec<Checkpoint>
    TotalCheckpoints,     // Vec<Checkpoint> for total supply
    Token,                // underlying SEP-41 token address
    Admin,
    Nonce(Address),           // owner -> nonce for delegate_by_sig
}

#[contract]
pub struct TokenVotesContract;

#[contractimpl]
impl TokenVotesContract {
    /// Initialize with the underlying SEP-41 token.
    pub fn initialize(env: Env, admin: Address, token: Address) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
    }

    /// Delegate voting power from caller to delegatee.
    ///
    /// Reads the delegator's current token balance from the underlying SEP-41
    /// contract and records it in the total supply checkpoint the first time
    /// they delegate. Re-delegation between accounts does not change the total
    /// — voting power simply moves from the old delegatee to the new one
    /// without altering how much supply is actively delegated.
    pub fn delegate(env: Env, delegator: Address, delegatee: Address) {
        delegator.require_auth();

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("token not set");
        let balance = token::TokenClient::new(&env, &token_addr).balance(&delegator);

        // Determine whether this is a first-time delegation or a re-delegation.
        let previous_delegate: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Delegate(delegator.clone()));

        if let Some(old_delegatee) = previous_delegate.clone() {
            if old_delegatee != delegatee {
                Self::update_account_votes(&env, old_delegatee.clone(), -balance);
                Self::update_account_votes(&env, delegatee.clone(), balance);
            }
        } else {
            // First time delegation adds to total supply
            if balance > 0 {
                Self::update_total_supply_checkpoint(&env, balance);
            }
            Self::update_account_votes(&env, delegatee.clone(), balance);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Delegate(delegator.clone()), &delegatee);

        env.events().publish(
            (symbol_short!("del_chsh"), delegator.clone()),
            (previous_delegate, delegatee),
        );
    }

    /// Get the current delegatee of an account.
    pub fn delegates(env: Env, account: Address) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Delegate(account))
    }

    /// Get current voting power of an account.
    /// TODO issue #8: sum power from all delegators pointing to account.
    pub fn get_votes(env: Env, account: Address) -> i128 {
        let checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account))
            .unwrap_or(soroban_sdk::Vec::new(&env));
        if checkpoints.is_empty() {
            return 0;
        }
        checkpoints.last().unwrap().votes
    }

    /// Get the underlying token address.
    pub fn token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .expect("not initialized")
    }

    /// Get the admin address.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Get voting power at a past ledger sequence (snapshot).
    pub fn get_past_votes(env: Env, account: Address, ledger: u32) -> i128 {
        let checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account))
            .unwrap_or(soroban_sdk::Vec::new(&env));

        Self::binary_search(&checkpoints, ledger)
    }

    /// Get total delegated supply at a past ledger sequence.
    ///
    /// Performs a binary search over the total supply checkpoint log, returning
    /// the value recorded at or just before `ledger`. This is used by the
    /// governor to compute quorum as a fraction of the historical total supply.
    pub fn get_past_total_supply(env: Env, ledger: u32) -> i128 {
        let checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCheckpoints)
            .unwrap_or(soroban_sdk::Vec::new(&env));
        Self::binary_search(&checkpoints, ledger)
    }

    /// Write a checkpoint for an account. Called internally after balance changes.
    pub fn checkpoint(env: Env, account: Address, votes: i128) {
        let mut checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account.clone()))
            .unwrap_or(soroban_sdk::Vec::new(&env));

        let current_ledger = env.ledger().sequence();
        if !checkpoints.is_empty() && checkpoints.last().unwrap().ledger == current_ledger {
            let last_idx = checkpoints.len() - 1;
            checkpoints.set(
                last_idx,
                Checkpoint {
                    ledger: current_ledger,
                    votes,
                },
            );
        } else {
            checkpoints.push_back(Checkpoint {
                ledger: current_ledger,
                votes,
            });
        }

        env.storage()
            .persistent()
            .set(&DataKey::Checkpoints(account), &checkpoints);
    }

    // --- Internal helpers ---

    /// Append or update the total supply checkpoint by `delta` at the current ledger.
    ///
    /// If the most recent checkpoint is at the same ledger sequence, it is
    /// overwritten (same-block merge) to avoid duplicate entries. Otherwise a
    /// new checkpoint is appended, keeping the log strictly ordered by ledger.
    fn update_total_supply_checkpoint(env: &Env, delta: i128) {
        let mut checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCheckpoints)
            .unwrap_or(soroban_sdk::Vec::new(env));

        let current_ledger = env.ledger().sequence();
        let old_votes = if checkpoints.is_empty() {
            0
        } else {
            checkpoints.last().unwrap().votes
        };
        let new_total = old_votes + delta;

        if !checkpoints.is_empty() && checkpoints.last().unwrap().ledger == current_ledger {
            let last_idx = checkpoints.len() - 1;
            checkpoints.set(
                last_idx,
                Checkpoint {
                    ledger: current_ledger,
                    votes: new_total,
                },
            );
        } else {
            checkpoints.push_back(Checkpoint {
                ledger: current_ledger,
                votes: new_total,
            });
        }

        env.storage()
            .persistent()
            .set(&DataKey::TotalCheckpoints, &checkpoints);
    }

    /// Update an account's voting power checkpoints by `delta`.
    fn update_account_votes(env: &Env, account: Address, delta: i128) {
        let mut checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account.clone()))
            .unwrap_or(soroban_sdk::Vec::new(env));

        let current_ledger = env.ledger().sequence();
        let old_votes = if checkpoints.is_empty() {
            0
        } else {
            checkpoints.last().unwrap().votes
        };
        let new_votes = old_votes + delta;

        if !checkpoints.is_empty() && checkpoints.last().unwrap().ledger == current_ledger {
            let last_idx = checkpoints.len() - 1;
            checkpoints.set(
                last_idx,
                Checkpoint {
                    ledger: current_ledger,
                    votes: new_votes,
                },
            );
        } else {
            checkpoints.push_back(Checkpoint {
                ledger: current_ledger,
                votes: new_votes,
            });
        }

        env.storage()
            .persistent()
            .set(&DataKey::Checkpoints(account.clone()), &checkpoints);

        env.events()
            .publish((symbol_short!("v_active"), account), (old_votes, new_votes));
    }

    /// Binary search over an ordered checkpoint list.
    ///
    /// Returns the `votes` value of the latest checkpoint whose `ledger` field
    /// is ≤ `target_ledger`, or 0 if no such checkpoint exists. The input Vec
    /// must be sorted in ascending ledger order (guaranteed by
    /// `update_total_supply_checkpoint`).
    fn binary_search(checkpoints: &soroban_sdk::Vec<Checkpoint>, target_ledger: u32) -> i128 {
        if checkpoints.is_empty() {
            return 0;
        }

        let len = checkpoints.len();
        let mut low: u32 = 0;
        let mut high: u32 = len;

        // Invariant: the answer lies at checkpoints[low - 1] after convergence.
        while low < high {
            let mid = low + (high - low) / 2;
            let cp = checkpoints.get(mid).unwrap();
            if cp.ledger <= target_ledger {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        if low == 0 {
            return 0;
        }
        checkpoints.get(low - 1).unwrap().votes
    }

    /// Delegate voting power by signature (gasless for the token holder).
    ///
    /// A relayer submits this on behalf of a token holder who signed a message
    /// off-chain. The holder only needs to sign, no gas required.
    ///
    /// # Arguments
    /// * `owner` - The token holder who signed the delegation message
    /// * `delegatee` - The address to delegate voting power to
    /// * `nonce` - Unique nonce to prevent replay attacks
    /// * `expiry` - Unix timestamp after which the signature is invalid
    /// * `signature` - Ed25519 signature over (owner, delegatee, nonce, expiry)
    pub fn delegate_by_sig(
        env: Env,
        owner: Address,
        delegatee: Address,
        nonce: u64,
        expiry: u64,
        signature: BytesN<64>,
    ) {
        // Verify expiry against current ledger timestamp
        let current_time = env.ledger().timestamp();
        assert!(current_time <= expiry, "signature expired");

        // Verify and increment nonce (prevent replay)
        let nonce_key = DataKey::Nonce(owner.clone());
        let stored_nonce: u64 = env
            .storage()
            .persistent()
            .get(&nonce_key)
            .unwrap_or(0);
        assert!(nonce == stored_nonce, "invalid nonce");
        env.storage().persistent().set(&nonce_key, &(stored_nonce + 1));

        // Build message to verify: (owner, delegatee, nonce, expiry)
        let mut message = Bytes::new(&env);
        message.append(&owner.to_xdr(&env));
        message.append(&delegatee.to_xdr(&env));
        message.append(&nonce.to_xdr(&env));
        message.append(&expiry.to_xdr(&env));

        // Verify ed25519 signature
        let message_hash = env.crypto().sha256(&message);
        env.crypto().ed25519_verify(&owner, &message_hash, &signature);

        // Get token balance
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("token not set");
        let balance = token::TokenClient::new(&env, &token_addr).balance(&owner);

        // Determine whether this is a first-time delegation or a re-delegation.
        let previous_delegate: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Delegate(owner.clone()));

        if let Some(old_delegatee) = previous_delegate.clone() {
            if old_delegatee != delegatee {
                Self::update_account_votes(&env, old_delegatee.clone(), -balance);
                Self::update_account_votes(&env, delegatee.clone(), balance);
            }
        } else {
            // First time delegation adds to total supply
            if balance > 0 {
                Self::update_total_supply_checkpoint(&env, balance);
            }
            Self::update_account_votes(&env, delegatee.clone(), balance);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Delegate(owner.clone()), &delegatee);

        env.events().publish(
            (symbol_short!("del_chsh"), owner.clone()),
            (previous_delegate, delegatee),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger as _},
        token, Env,
    };

    /// Deploy a fresh token-votes contract backed by a real stellar asset contract.
    /// Returns (contract_id, token_address).
    fn setup(env: &Env, admin: &Address) -> (Address, Address) {
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let contract_id = env.register(TokenVotesContract, ());
        let client = TokenVotesContractClient::new(env, &contract_id);
        client.initialize(admin, &token_addr);
        (contract_id, token_addr)
    }

    #[test]
    fn test_first_delegation_adds_balance_to_total_supply() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        // Mint 1000 tokens to the delegator.
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator, &1000i128);

        // First delegation — total supply checkpoint should record the balance.
        client.delegate(&delegator, &delegatee);

        let total = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(total, 1000);
    }

    #[test]
    fn test_redelegation_does_not_change_total_supply() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee1 = Address::generate(&env);
        let delegatee2 = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator, &500i128);

        // First delegation: activates voting power.
        client.delegate(&delegator, &delegatee1);
        let after_first = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(after_first, 500);

        // Advance ledger so the re-delegation lands on a different slot.
        env.ledger().with_mut(|l| l.sequence_number += 1);

        // Re-delegation: power moves between delegatees; total must not change.
        client.delegate(&delegator, &delegatee2);
        let after_redelegate = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(after_redelegate, 500);
    }

    #[test]
    fn test_multiple_delegators_accumulate_in_total_supply() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator1 = Address::generate(&env);
        let delegator2 = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator1, &300i128);
        sac_client.mint(&delegator2, &700i128);

        // Each delegator activates on a different ledger to produce distinct checkpoints.
        client.delegate(&delegator1, &delegatee);
        let after_first = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(after_first, 300);

        env.ledger().with_mut(|l| l.sequence_number += 1);

        client.delegate(&delegator2, &delegatee);
        let after_second = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(after_second, 1000); // 300 + 700
    }

    #[test]
    fn test_same_ledger_delegations_produce_single_checkpoint() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator1 = Address::generate(&env);
        let delegator2 = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator1, &400i128);
        sac_client.mint(&delegator2, &600i128);

        // Both delegations happen on the same ledger sequence — they should be
        // merged into a single checkpoint rather than producing two entries.
        client.delegate(&delegator1, &delegatee);
        client.delegate(&delegator2, &delegatee);

        // The combined total must reflect both balances.
        let total = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(total, 1000); // 400 + 600

        // Only one checkpoint should exist because same-ledger entries are merged.
        let checkpoint_count = env.as_contract(&contract_id, || {
            let checkpoints: soroban_sdk::Vec<Checkpoint> = env
                .storage()
                .persistent()
                .get(&DataKey::TotalCheckpoints)
                .unwrap();
            checkpoints.len()
        });
        assert_eq!(checkpoint_count, 1);
    }

    #[test]
    fn test_binary_search_returns_correct_historical_value() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator1 = Address::generate(&env);
        let delegator2 = Address::generate(&env);
        let delegator3 = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator1, &100i128);
        sac_client.mint(&delegator2, &200i128);
        sac_client.mint(&delegator3, &300i128);

        // ledger 1: total = 100
        env.ledger().with_mut(|l| l.sequence_number = 1);
        client.delegate(&delegator1, &delegatee);

        // ledger 5: total = 300
        env.ledger().with_mut(|l| l.sequence_number = 5);
        client.delegate(&delegator2, &delegatee);

        // ledger 10: total = 600
        env.ledger().with_mut(|l| l.sequence_number = 10);
        client.delegate(&delegator3, &delegatee);

        // Exact ledger matches.
        assert_eq!(client.get_past_total_supply(&1), 100);
        assert_eq!(client.get_past_total_supply(&5), 300);
        assert_eq!(client.get_past_total_supply(&10), 600);

        // Between checkpoints: return the most recent value before the query.
        assert_eq!(client.get_past_total_supply(&3), 100); // between ledger 1 and 5
        assert_eq!(client.get_past_total_supply(&7), 300); // between ledger 5 and 10
        assert_eq!(client.get_past_total_supply(&99), 600); // after last checkpoint

        // Before any checkpoint: return 0.
        assert_eq!(client.get_past_total_supply(&0), 0);
    }

    #[test]
    fn test_delegation_transfers_voting_power() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee1 = Address::generate(&env);
        let delegatee2 = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator, &1000i128);

        // First delegation
        client.delegate(&delegator, &delegatee1);
        assert_eq!(client.get_votes(&delegatee1), 1000);
        assert_eq!(client.get_votes(&delegatee2), 0);

        env.ledger().with_mut(|l| l.sequence_number += 1);

        // Redelegation
        client.delegate(&delegator, &delegatee2);
        assert_eq!(client.get_votes(&delegatee1), 0);
        assert_eq!(client.get_votes(&delegatee2), 1000);
    }

    #[test]
    fn test_delegation_emits_events() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator, &1000i128);

        client.delegate(&delegator, &delegatee);

        let events = env.events().all();
        // Index 0: Mint
        // Index 1: Update total supply (v_active event might be used if I changed it, wait)
        // Actually, my current update_account_votes emits "v_active"
        // and delegate emits "del_chsh"

        let sub_events = events.iter().filter(|e| e.0 == contract_id);
        assert!(sub_events.count() >= 2);
    }

    #[test]
    fn test_account_binary_search_returns_correct_historical_value() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user1 = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&user1, &1000i128);

        // ledger 1: user1 delegations = 1000
        env.ledger().with_mut(|l| l.sequence_number = 1);
        client.delegate(&user1, &user1);
        assert_eq!(client.get_past_votes(&user1, &1), 1000);

        // ledger 10: user1 delegations = 1500
        env.ledger().with_mut(|l| l.sequence_number = 10);
        sac_client.mint(&user1, &500i128);
        // We must call checkpoint or delegate to update the voting power log.
        // In a real scenario, the token contract would call this.
        client.checkpoint(&user1, &1500i128);
        assert_eq!(client.get_votes(&user1), 1500);
        assert_eq!(client.get_past_votes(&user1, &10), 1500);

        // ledger 20: user1 delegations = 1300
        env.ledger().with_mut(|l| l.sequence_number = 20);
        client.checkpoint(&user1, &1300i128);
        assert_eq!(client.get_votes(&user1), 1300);
        assert_eq!(client.get_past_votes(&user1, &20), 1300);

        // Verify history
        assert_eq!(client.get_past_votes(&user1, &0), 0);
        assert_eq!(client.get_past_votes(&user1, &5), 1000);
        assert_eq!(client.get_past_votes(&user1, &10), 1500);
        assert_eq!(client.get_past_votes(&user1, &15), 1500);
        assert_eq!(client.get_past_votes(&user1, &20), 1300);
        assert_eq!(client.get_past_votes(&user1, &100), 1300);
    }

    // ── Edge-case tests (issue #192) ──────────────────────────────────────────

    /// Zero-balance delegators must not contribute to the total delegated supply
    /// because the on-chain guard skips `update_total_supply_checkpoint` when
    /// `balance == 0`.
    #[test]
    fn test_zero_balance_delegation_does_not_affect_total_supply() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let zero_holder = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, _token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        // zero_holder has no tokens — total supply must stay 0 after delegation.
        client.delegate(&zero_holder, &delegatee);

        assert_eq!(client.get_votes(&delegatee), 0);
        assert_eq!(client.get_past_total_supply(&env.ledger().sequence()), 0);
    }

    /// Self-delegation: delegating to your own address is a valid operation.
    /// The delegator's balance should appear as their own voting power.
    #[test]
    fn test_self_delegation_grants_own_voting_power() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&user, &2000i128);
        client.delegate(&user, &user); // delegate to self

        assert_eq!(client.get_votes(&user), 2000);
        assert_eq!(client.get_past_total_supply(&env.ledger().sequence()), 2000);
    }

    /// Re-delegating to the *same* delegatee is a no-op: voting power must not
    /// double-count and the total supply must remain unchanged.
    #[test]
    fn test_redelegation_to_same_delegatee_is_noop() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&delegator, &500i128);
        client.delegate(&delegator, &delegatee);

        env.ledger().with_mut(|l| l.sequence_number += 1);

        // Re-delegate to the same address — should be a no-op.
        client.delegate(&delegator, &delegatee);

        assert_eq!(client.get_votes(&delegatee), 500);
        assert_eq!(client.get_past_total_supply(&env.ledger().sequence()), 500);
    }

    /// `get_votes` on an account that has never been delegated to must return 0.
    #[test]
    fn test_get_votes_before_any_delegation_returns_zero() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let nobody = Address::generate(&env);

        let (contract_id, _token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        assert_eq!(client.get_votes(&nobody), 0);
        assert_eq!(client.get_past_votes(&nobody, &env.ledger().sequence()), 0);
    }

    /// Multiple sequential re-delegations: voting power must follow the chain
    /// A→B→C→D correctly — each previous delegatee loses and the new one gains.
    #[test]
    fn test_multiple_sequential_redelegations() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&delegator, &1000i128);

        env.ledger().with_mut(|l| l.sequence_number = 10);
        client.delegate(&delegator, &a);
        assert_eq!(client.get_votes(&a), 1000);

        env.ledger().with_mut(|l| l.sequence_number = 20);
        client.delegate(&delegator, &b);
        assert_eq!(client.get_votes(&a), 0);
        assert_eq!(client.get_votes(&b), 1000);

        env.ledger().with_mut(|l| l.sequence_number = 30);
        client.delegate(&delegator, &c);
        assert_eq!(client.get_votes(&b), 0);
        assert_eq!(client.get_votes(&c), 1000);

        // Total supply must remain 1000 throughout.
        assert_eq!(client.get_past_total_supply(&30), 1000);

        // Historical snapshots must be accurate for each step.
        assert_eq!(client.get_past_votes(&a, &15), 1000); // while delegated to a
        assert_eq!(client.get_past_votes(&a, &25), 0);    // after delegation moved to b
        assert_eq!(client.get_past_votes(&b, &25), 1000); // while delegated to b
        assert_eq!(client.get_past_votes(&b, &35), 0);    // after delegation moved to c
    }

    /// Checkpoint boundary conditions: querying at exactly the checkpoint ledger,
    /// one ledger before, and one ledger after must all return the correct value.
    #[test]
    fn test_checkpoint_boundary_conditions() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&delegator, &100i128);

        // Checkpoint is written at ledger 50.
        env.ledger().with_mut(|l| l.sequence_number = 50);
        client.delegate(&delegator, &delegatee);

        // Exactly at the checkpoint ledger — must return the recorded value.
        assert_eq!(client.get_past_votes(&delegatee, &50), 100);

        // One ledger before the checkpoint — no data yet, must return 0.
        assert_eq!(client.get_past_votes(&delegatee, &49), 0);

        // One ledger after the checkpoint — the last checkpoint still applies.
        assert_eq!(client.get_past_votes(&delegatee, &51), 100);
    }

    /// Voting power at the exact proposal start block mirrors the governor's
    /// quorum snapshot: `get_past_votes` at `proposal.start_ledger` must equal
    /// the delegatee's power at that point, unaffected by later delegations.
    #[test]
    fn test_voting_power_at_exact_proposal_start_ledger() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);
        let new_delegator = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&delegator, &800i128);
        sac_client.mint(&new_delegator, &200i128);

        // Snapshot ledger: delegatee has 800 power.
        let proposal_start: u32 = 100;
        env.ledger().with_mut(|l| l.sequence_number = proposal_start);
        client.delegate(&delegator, &delegatee);

        // After the snapshot, a new delegation adds 200 more power to delegatee.
        env.ledger().with_mut(|l| l.sequence_number = proposal_start + 10);
        client.delegate(&new_delegator, &delegatee);

        // Current votes now include both delegators.
        assert_eq!(client.get_votes(&delegatee), 1000);

        // Historical query at proposal_start must reflect only the 800 that
        // existed when the proposal was created — not the later 200.
        assert_eq!(client.get_past_votes(&delegatee, &proposal_start), 800);
    }

    /// Pseudo-fuzz: iterate over a range of token amounts and verify that the
    /// total delegated supply always equals the sum of all individual balances.
    #[test]
    fn test_fuzz_total_supply_equals_sum_of_delegated_balances() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        // Use prime-ish amounts to surface any off-by-one aggregation bugs.
        let amounts: [i128; 8] = [1, 7, 13, 97, 101, 503, 1009, 9973];
        let mut expected_total: i128 = 0;

        for (i, &amount) in amounts.iter().enumerate() {
            let delegator = Address::generate(&env);
            sac_client.mint(&delegator, &amount);

            // Advance ledger so each delegation lands on a distinct checkpoint.
            env.ledger().with_mut(|l| l.sequence_number = (i as u32 + 1) * 10);
            client.delegate(&delegator, &delegatee);

            expected_total += amount;
            let actual_total = client.get_past_total_supply(&env.ledger().sequence());
            assert_eq!(
                actual_total, expected_total,
                "total supply mismatch after delegating {} (step {})",
                amount, i
            );
        }

        // Delegatee's voting power must also equal the accumulated total.
        assert_eq!(client.get_votes(&delegatee), expected_total);
    }

    /// Same-ledger re-delegation must merge checkpoints — no duplicate entries
    /// and the final votes value must be accurate.
    #[test]
    fn test_same_ledger_redelegation_merges_checkpoints() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&delegator, &300i128);

        // First delegation to `a` at ledger 5.
        env.ledger().with_mut(|l| l.sequence_number = 5);
        client.delegate(&delegator, &a);

        // Re-delegate to `b` on the *same* ledger — `a` and `b` checkpoints at
        // ledger 5 must each be a single merged entry, not duplicate rows.
        client.delegate(&delegator, &b);

        assert_eq!(client.get_votes(&a), 0);
        assert_eq!(client.get_votes(&b), 300);

        // Verify checkpoint counts via direct storage inspection.
        let (a_count, b_count) = env.as_contract(&contract_id, || {
            let a_cps: soroban_sdk::Vec<Checkpoint> = env
                .storage()
                .persistent()
                .get(&DataKey::Checkpoints(a.clone()))
                .unwrap_or(soroban_sdk::Vec::new(&env));
            let b_cps: soroban_sdk::Vec<Checkpoint> = env
                .storage()
                .persistent()
                .get(&DataKey::Checkpoints(b.clone()))
                .unwrap_or(soroban_sdk::Vec::new(&env));
            (a_cps.len(), b_cps.len())
        });

        assert_eq!(a_count, 1, "a should have exactly one merged checkpoint");
        assert_eq!(b_count, 1, "b should have exactly one checkpoint");
    }
}

#[cfg(test)]
mod invariant_tests;

mod integration;
mod transitions;

// ── upgrade auth tests ────────────────────────────────────────────────────────
// Note: a full end-to-end upgrade test (auth passes → WASM swapped) requires
// a compiled WASM binary uploaded via env.deployer().upload_contract_wasm().
// That path is covered by integration tests run after `cargo build --target
// wasm32-unknown-unknown`. The unit tests below focus on the auth guard,
// which is the security-critical invariant.

use crate::{GovernorContract, GovernorContractClient};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal,
};

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

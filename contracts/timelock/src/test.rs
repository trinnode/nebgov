use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, Env, Symbol,
};

/// Mock target contract for testing execution.
#[contract]
pub struct MockTarget;

#[contractimpl]
impl MockTarget {
    pub fn exec(env: Env) {
        env.storage()
            .persistent()
            .set(&symbol_short!("executed"), &true);
    }

    pub fn was_executed(env: Env) -> bool {
        env.storage()
            .persistent()
            .get(&symbol_short!("executed"))
            .unwrap_or(false)
    }
}

#[test]
/// Test that operation ID generation includes all components.
fn test_compute_op_id() {
    let env = Env::default();
    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"test data");
    let predecessor = Bytes::from_slice(&env, b"pred");
    let salt = Bytes::from_slice(&env, b"salt");

    let op_id1 = TimelockContract::compute_op_id(
        env.clone(),
        target.clone(),
        data.clone(),
        Bytes::new(&env),
        Bytes::new(&env),
    );
    let op_id2 = TimelockContract::compute_op_id(
        env.clone(),
        target.clone(),
        data.clone(),
        predecessor.clone(),
        salt.clone(),
    );
    let op_id3 = TimelockContract::compute_op_id(
        env.clone(),
        target.clone(),
        data.clone(),
        predecessor.clone(),
        salt.clone(),
    );
    let op_id4 = TimelockContract::compute_op_id(
        env.clone(),
        target.clone(),
        data.clone(),
        Bytes::new(&env),
        salt.clone(),
    );

    // Different predecessor/salt produces different ID
    assert_ne!(op_id1, op_id2);
    // Same inputs produce same ID
    assert_eq!(op_id2, op_id3);
    // Different salt produces different ID
    assert_ne!(op_id2, op_id4);
}

#[test]
/// Test that schedule() stores predecessor and generates correct ID.
fn test_schedule_with_predecessor_and_salt() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"calldata");
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;
    let predecessor = Bytes::new(&env);
    let salt = Bytes::from_slice(&env, b"unique_salt");

    let op_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &predecessor,
        &salt,
    );

    // Verify operation is stored
    let op: Operation = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Operation(op_id.clone()))
            .unwrap()
    });
    assert_eq!(op.target, target);
    assert_eq!(op.data, data);
    assert_eq!(op.fn_name, fn_name);
    assert_eq!(op.predecessor, predecessor);
    assert!(!op.executed);
    assert!(!op.cancelled);
}

#[test]
/// Test that schedule() validates predecessor exists.
fn test_schedule_validates_predecessor() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"calldata");
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;
    let non_existent_pred = Bytes::from_slice(&env, b"nonexistent");

    // Should panic with "predecessor not found"
    let result = client.try_schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &non_existent_pred,
        &Bytes::new(&env),
    );
    assert!(result.is_err());
}

#[test]
/// Test that is_done() returns correct values.
fn test_is_done() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());
    let data = Bytes::from_slice(&env, b"calldata");
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;

    // Schedule an operation
    let op_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    // Not done yet
    assert!(!client.is_done(&op_id));

    // Execute it
    env.ledger().with_mut(|l| l.timestamp = 1001);
    client.execute(&governor, &op_id);

    // Now done
    assert!(client.is_done(&op_id));

    // Non-existent operation returns false
    let fake_id = Bytes::from_slice(&env, b"fakeopid12345678901234567890");
    assert!(!client.is_done(&fake_id));
}

#[test]
/// Test predecessor enforcement in execute().
fn test_predecessor_enforcement() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600); // 0 delay for speed

    let target = env.register(MockTarget, ());
    let data = Bytes::from_slice(&env, b"calldata");
    let fn_name = Symbol::new(&env, "exec");

    // Schedule operation A
    let op_a_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &0u64,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    // Schedule operation B with A as predecessor
    let op_b_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &0u64,
        &op_a_id.clone(),
        &Bytes::new(&env),
    );

    // Execute B should fail with PredecessorNotDone
    let result = client.try_execute(&governor, &op_b_id);
    assert!(result.is_err());

    // Execute A should succeed
    client.execute(&governor, &op_a_id);
    assert!(client.is_done(&op_a_id));

    // Now B should execute successfully
    client.execute(&governor, &op_b_id);
    assert!(client.is_done(&op_b_id));
}

#[test]
/// Test that predecessor blocking works even when both operations are ready.
fn test_predecessor_blocking_when_ready() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());
    let data = Bytes::from_slice(&env, b"calldata");
    let fn_name = Symbol::new(&env, "exec");

    // Schedule A and B with 0 delay (both ready immediately)
    let op_a_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &0u64,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );
    let op_b_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &0u64,
        &op_a_id.clone(),
        &Bytes::new(&env),
    );

    // Advance time to ensure both are ready
    env.ledger().with_mut(|l| l.timestamp = 1);

    // B should still fail because A not done
    let result = client.try_execute(&governor, &op_b_id);
    assert!(result.is_err());

    // Execute A
    client.execute(&governor, &op_a_id);

    // B should now succeed immediately (no additional delay)
    client.execute(&governor, &op_b_id);
}

#[test]
/// Test salt uniqueness: same target/data with different salts produce different IDs.
fn test_salt_uniqueness() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"same data");
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;

    let salt1 = Bytes::from_slice(&env, b"salt1");
    let salt2 = Bytes::from_slice(&env, b"salt2");

    let op_id1 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &salt1,
    );
    let op_id2 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &salt2,
    );

    assert_ne!(op_id1, op_id2);

    // Both operations should coexist in storage
    let (op1, op2): (Operation, Operation) = env.as_contract(&contract_id, || {
        (
            env.storage()
                .persistent()
                .get(&DataKey::Operation(op_id1.clone()))
                .unwrap(),
            env.storage()
                .persistent()
                .get(&DataKey::Operation(op_id2.clone()))
                .unwrap(),
        )
    });
    assert_eq!(op1.data, data);
    assert_eq!(op2.data, data);
}

#[test]
/// Test that same salt produces same ID (idempotent scheduling).
fn test_same_salt_same_id() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"same data");
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;
    let salt = Bytes::from_slice(&env, b"same_salt");

    let op_id1 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &salt,
    );
    let op_id2 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &salt,
    );

    assert_eq!(op_id1, op_id2);

    // The second schedule should overwrite the first (same storage key)
    let op: Operation = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Operation(op_id1.clone()))
            .unwrap()
    });
    // Both operations have same ID, so only one record exists
    assert_eq!(op.data, data);
}

#[test]
/// Test that different predecessors produce different IDs even with same salt.
fn test_predecessor_changes_id() {
    let env = Env::default();
    env.mock_all_auths();
    let _contract_id = env.register(TimelockContract, ());

    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"same data");
    let salt = Bytes::from_slice(&env, b"same_salt");
    let pred1 = Bytes::from_slice(&env, b"pred1");
    let pred2 = Bytes::from_slice(&env, b"pred2");

    let op_id1 = TimelockContract::compute_op_id(
        env.clone(),
        target.clone(),
        data.clone(),
        pred1,
        salt.clone(),
    );
    let op_id2 = TimelockContract::compute_op_id(env.clone(), target, data, pred2, salt);

    assert_ne!(op_id1, op_id2);
}

#[test]
/// Test that empty predecessor and empty salt produce consistent ID.
fn test_empty_predecessor_and_salt() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"calldata");
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;

    let op_id1 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );
    let op_id2 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    assert_eq!(op_id1, op_id2);
}

#[test]
/// Test that operation with no predecessor executes normally.
fn test_no_predecessor_executes() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());
    let data = Bytes::new(&env);
    let fn_name = Symbol::new(&env, "exec");
    let delay = 0u64;

    let op_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    // Should execute without predecessor check
    client.execute(&governor, &op_id);
    assert!(client.is_done(&op_id));

    // Verify MockTarget was called
    let mock_client = MockTargetClient::new(&env, &target);
    assert!(mock_client.was_executed());
}

#[test]
/// Test execution deadline functionality.
fn test_execution_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    let execution_window = 1000u64;
    client.initialize(&admin, &governor, &0, &execution_window);

    let target = env.register(MockTarget, ());
    let data = Bytes::new(&env);
    let fn_name = Symbol::new(&env, "exec");
    let delay = 500u64;

    let op_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    // Verify expires_at is set correctly
    let op: Operation = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Operation(op_id.clone()))
            .unwrap()
    });
    assert_eq!(op.ready_at, 500);
    assert_eq!(op.expires_at, 1500); // 500 + 1000

    // Should not be ready before delay
    assert!(!client.is_ready(&op_id));

    // Should be ready after delay but before expiration
    env.ledger().with_mut(|l| l.timestamp = 600);
    assert!(client.is_ready(&op_id));

    // Should execute successfully within window
    client.execute(&governor, &op_id);
    assert!(client.is_done(&op_id));
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
/// Test that execution fails after deadline.
fn test_execute_after_deadline_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    let execution_window = 1000u64;
    client.initialize(&admin, &governor, &0, &execution_window);

    let target = env.register(MockTarget, ());
    let data = Bytes::new(&env);
    let fn_name = Symbol::new(&env, "exec");
    let delay = 500u64;

    let op_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    // Advance past expiration time
    env.ledger().with_mut(|l| l.timestamp = 2000);

    // Should not be ready (expired)
    assert!(!client.is_ready(&op_id));

    // Should panic when trying to execute expired operation
    client.execute(&governor, &op_id);
}

#[test]
/// Test execution_window getter and setter.
fn test_execution_window_config() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    let execution_window = 5000u64;
    
    client.initialize(&admin, &governor, &100, &execution_window);
    
    // Check getter returns correct value
    assert_eq!(client.execution_window(), execution_window);
    
    // Update execution window
    let new_window = 10000u64;
    client.update_execution_window(&admin, &new_window);
    
    // Check updated value
    assert_eq!(client.execution_window(), new_window);
}

#[test]
#[should_panic(expected = "only admin")]
/// Test that only admin can update execution window.
fn test_update_execution_window_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    
    client.initialize(&admin, &governor, &100, &1000);
    
    // Should panic when unauthorized user tries to update
    client.update_execution_window(&unauthorized, &2000);
}

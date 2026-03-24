#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, Env, Symbol, Vec,
};

/// An operation scheduled in the timelock.
#[contracttype]
#[derive(Clone)]
pub struct Operation {
    pub target: Address,
    pub data: Bytes,
    pub fn_name: Symbol, // function to invoke on the target when executed
    pub ready_at: u64,   // Unix timestamp when executable
    pub executed: bool,
    pub cancelled: bool,
}

#[contracttype]
pub enum DataKey {
    Operation(Bytes), // keyed by operation hash
    MinDelay,
    Admin,
    Governor,
}

#[contract]
pub struct TimelockContract;

#[contractimpl]
impl TimelockContract {
    /// Initialize timelock with minimum delay (in seconds) and admin.
    pub fn initialize(env: Env, admin: Address, governor: Address, min_delay: u64) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Governor, &governor);
        env.storage().instance().set(&DataKey::MinDelay, &min_delay);
    }

    /// Schedule an operation with a delay.
    ///
    /// Only the governor may schedule operations. The `fn_name` parameter names
    /// the function that will be invoked on `target` when the operation executes.
    /// Returns a Bytes op-id equal to the SHA-256 hash of `data`.
    ///
    /// TODO issue #11: implement predecessor support and salt-based id generation.
    pub fn schedule(
        env: Env,
        caller: Address,
        target: Address,
        data: Bytes,
        fn_name: Symbol,
        delay: u64,
    ) -> Bytes {
        caller.require_auth();
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        assert!(caller == governor, "only governor");

        let min_delay: u64 = env
            .storage()
            .instance()
            .get(&DataKey::MinDelay)
            .unwrap_or(86400);
        assert!(delay >= min_delay, "delay too short");

        let ready_at = env.ledger().timestamp() + delay;
        let op_id = env.crypto().sha256(&data);
        let op_id_bytes = Bytes::from_array(&env, &op_id.to_array());

        let operation = Operation {
            target,
            data,
            fn_name,
            ready_at,
            executed: false,
            cancelled: false,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Operation(op_id_bytes.clone()), &operation);

        env.events()
            .publish((symbol_short!("schedule"),), op_id_bytes.clone());

        op_id_bytes
    }

    /// Execute a ready operation.
    ///
    /// Enforces the delay invariant, invokes `fn_name()` on `target` with no
    /// arguments (calldata-with-args support is in TODO issue #11), then marks
    /// the operation executed.
    pub fn execute(env: Env, caller: Address, op_id: Bytes) {
        caller.require_auth();
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        assert!(caller == governor, "only governor");

        let mut op: Operation = env
            .storage()
            .persistent()
            .get(&DataKey::Operation(op_id.clone()))
            .expect("operation not found");

        assert!(!op.executed && !op.cancelled, "invalid state");
        assert!(env.ledger().timestamp() >= op.ready_at, "not ready");

        op.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Operation(op_id.clone()), &op);

        // Invoke the target contract. Args beyond the function call are encoded
        // in op.data; passing them as structured args is in TODO issue #11.
        env.invoke_contract::<()>(&op.target, &op.fn_name, Vec::new(&env));

        env.events().publish((symbol_short!("execute"),), op_id);
    }

    /// Cancel a pending operation.
    pub fn cancel(env: Env, caller: Address, op_id: Bytes) {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        assert!(caller == admin || caller == governor, "not authorized");

        let mut op: Operation = env
            .storage()
            .persistent()
            .get(&DataKey::Operation(op_id.clone()))
            .expect("operation not found");
        assert!(!op.executed && !op.cancelled, "invalid state");
        op.cancelled = true;
        env.storage()
            .persistent()
            .set(&DataKey::Operation(op_id.clone()), &op);

        env.events().publish((symbol_short!("cancel"),), op_id);
    }

    /// Check if an operation is pending (scheduled, not yet ready).
    pub fn is_pending(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(o) => !o.executed && !o.cancelled && env.ledger().timestamp() < o.ready_at,
            None => false,
        }
    }

    /// Check if an operation is ready to execute.
    pub fn is_ready(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(o) => !o.executed && !o.cancelled && env.ledger().timestamp() >= o.ready_at,
            None => false,
        }
    }

    /// Get the minimum delay (in seconds).
    pub fn min_delay(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::MinDelay)
            .unwrap_or(86400)
    }

    /// Update minimum delay. Only admin.
    /// TODO issue #11: enforce timelock on delay changes themselves.
    pub fn update_delay(env: Env, caller: Address, new_delay: u64) {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(caller == admin, "only admin");
        env.storage().instance().set(&DataKey::MinDelay, &new_delay);
    }
}

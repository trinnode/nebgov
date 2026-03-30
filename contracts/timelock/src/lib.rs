#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, Env, Symbol,
    Vec,
};

/// Timelock error codes.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimelockError {
    /// Operation has not yet been executed but is required as a predecessor.
    PredecessorNotDone = 1,
    /// Predecessor operation does not exist.
    PredecessorNotFound = 2,
    /// Operation has expired and can no longer be executed.
    OperationExpired = 3,
}

/// An operation scheduled in the timelock.
#[contracttype]
#[derive(Clone)]
pub struct Operation {
    pub target: Address,
    pub data: Bytes,
    pub fn_name: Symbol, // function to invoke on the target when executed
    pub ready_at: u64,   // Unix timestamp when executable
    pub expires_at: u64, // Unix timestamp when operation expires
    pub executed: bool,
    pub cancelled: bool,
    /// Predecessor operation ID that must be executed before this one.
    /// Empty Bytes means no predecessor constraint.
    pub predecessor: Bytes,
}

#[contracttype]
pub enum DataKey {
    Operation(Bytes), // keyed by operation hash
    MinDelay,
    ExecutionWindow,
    Admin,
    Governor,
}

use soroban_sdk::xdr::ToXdr;

#[contract]
pub struct TimelockContract;

#[contractimpl]
impl TimelockContract {
    /// Initialize timelock with minimum delay (in seconds), execution window, and admin.
    pub fn initialize(env: Env, admin: Address, governor: Address, min_delay: u64, execution_window: u64) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Governor, &governor);
        env.storage().instance().set(&DataKey::MinDelay, &min_delay);
        env.storage().instance().set(&DataKey::ExecutionWindow, &execution_window);
    }

    /// Compute operation ID from target, data, predecessor, and salt.
    ///
    /// The ID is SHA-256(target_bytes || data_bytes || predecessor_bytes || salt_bytes).
    /// This deterministic concatenation ensures that varying any component produces
    /// a different operation ID, enabling salt-based uniqueness and predecessor tracking.
    pub fn compute_op_id(
        env: Env,
        target: Address,
        data: Bytes,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        let mut combined = Bytes::new(&env);
        combined.append(&target.to_xdr(&env));
        combined.append(&data);
        combined.append(&predecessor);
        combined.append(&salt);

        let hash = env.crypto().sha256(&combined);
        Bytes::from_array(&env, &hash.to_array())
    }

    /// Schedule an operation with a delay.
    ///
    /// Only the governor may schedule operations. The `fn_name` parameter names
    /// the function that will be invoked on `target` when the operation executes.
    /// Returns a Bytes op-id equal to the SHA-256 hash of `target || data || predecessor || salt`.
    ///
    /// If `predecessor` is non-empty, it must be the operation ID of an existing
    /// scheduled operation; otherwise PredecessorNotFound is returned.
    /// `salt` is consumed during ID generation and not stored; it provides uniqueness
    /// for otherwise identical operations.
    #[allow(clippy::too_many_arguments)]
    pub fn schedule(
        env: Env,
        caller: Address,
        target: Address,
        data: Bytes,
        fn_name: Symbol,
        delay: u64,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        caller.require_auth();
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        assert!(caller == governor, "only governor");

        // Validate predecessor exists if specified
        if !predecessor.is_empty() {
            let pred_exists = env
                .storage()
                .persistent()
                .has(&DataKey::Operation(predecessor.clone()));
            if !pred_exists {
                env.panic_with_error(TimelockError::PredecessorNotFound);
            }
        }

        let min_delay: u64 = env
            .storage()
            .instance()
            .get(&DataKey::MinDelay)
            .unwrap_or(86400);
        assert!(delay >= min_delay, "delay too short");

        let execution_window: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ExecutionWindow)
            .unwrap_or(1_209_600); // Default 14 days

        let ready_at = env.ledger().timestamp() + delay;
        let expires_at = ready_at + execution_window;
        let op_id = Self::compute_op_id(
            env.clone(),
            target.clone(),
            data.clone(),
            predecessor.clone(),
            salt,
        );

        let operation = Operation {
            target,
            data,
            fn_name,
            ready_at,
            expires_at,
            executed: false,
            cancelled: false,
            predecessor,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Operation(op_id.clone()), &operation);

        env.events()
            .publish((symbol_short!("schedule"),), op_id.clone());

        op_id
    }

    /// Execute a ready operation.
    ///
    /// Enforces the delay invariant, checks predecessor completion if one is set,
    /// invokes `fn_name()` on `target` with no arguments, then marks the operation executed.
    ///
    /// Panics with TimelockError::PredecessorNotDone if the operation has a non-empty predecessor
    /// that has not yet been executed.
    pub fn execute(env: Env, caller: Address, op_id: Bytes) {
        caller.require_auth();
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        assert!(caller == governor, "only governor");

        let op: Operation = env
            .storage()
            .persistent()
            .get(&DataKey::Operation(op_id.clone()))
            .expect("operation not found");

        assert!(!op.executed && !op.cancelled, "invalid state");
        assert!(env.ledger().timestamp() >= op.ready_at, "not ready");
        if env.ledger().timestamp() > op.expires_at {
            env.panic_with_error(TimelockError::OperationExpired);
        }

        // Check predecessor if present
        if !op.predecessor.is_empty() {
            let pred_done = Self::is_done(env.clone(), op.predecessor.clone());
            if !pred_done {
                env.panic_with_error(TimelockError::PredecessorNotDone);
            }
        }

        // Mark as executed before invocation to prevent reentrancy issues
        let mut op = op;
        op.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Operation(op_id.clone()), &op);

        // Invoke the target contract
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
            Some(o) => {
                !o.executed && !o.cancelled 
                && env.ledger().timestamp() >= o.ready_at 
                && env.ledger().timestamp() <= o.expires_at
            }
            None => false,
        }
    }

    /// Check if an operation has been executed.
    ///
    /// Returns true if the operation exists and has been executed.
    /// Returns false if the operation does not exist, is cancelled, or is still pending.
    pub fn is_done(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(o) => o.executed,
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

    /// Get the execution window (in seconds).
    pub fn execution_window(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ExecutionWindow)
            .unwrap_or(1_209_600) // Default 14 days
    }

    /// Get the governor address.
    pub fn governor(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized")
    }

    /// Get the admin address.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Update minimum delay. Only admin.
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

    /// Update execution window. Only admin.
    pub fn update_execution_window(env: Env, caller: Address, new_window: u64) {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(caller == admin, "only admin");
        env.storage().instance().set(&DataKey::ExecutionWindow, &new_window);
    }
}

#[cfg(test)]
mod test;

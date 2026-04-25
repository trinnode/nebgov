#![no_std]

use soroban_sdk::xdr::{FromXdr, ToXdr};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, Env, Symbol,
    Val, Vec,
};

/// Timelock error codes.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimelockError {
    /// Operation has not yet been executed but is required as a predecessor.
    PredecessorNotDone = 1,
    /// Operation references a predecessor operation that does not exist.
    PredecessorNotFound = 2,
    /// Operation can no longer be executed because its execution window elapsed.
    OperationExpired = 3,
}

/// A scheduled timelock operation.
#[contracttype]
#[derive(Clone)]
pub struct Operation {
    pub target: Address,
    pub data: Bytes,
    pub fn_name: Symbol,
    pub ready_at: u64,
    pub expires_at: u64,
    pub executed: bool,
    pub cancelled: bool,
    pub predecessor: Bytes,
}

#[contracttype]
pub enum DataKey {
    Operation(Bytes),
    MinDelay,
    ExecutionWindow,
    Admin,
    Governor,
}

#[contract]
pub struct TimelockContract;

#[contractimpl]
impl TimelockContract {
    /// Initialize timelock with minimum delay, execution window, admin, and governor.
    pub fn initialize(
        env: Env,
        admin: Address,
        governor: Address,
        min_delay: u64,
        execution_window: u64,
    ) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Governor, &governor);
        env.storage().instance().set(&DataKey::MinDelay, &min_delay);
        env.storage()
            .instance()
            .set(&DataKey::ExecutionWindow, &execution_window);
    }

    /// Compute operation ID from target, data, predecessor, and salt.
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

    /// Schedule a single operation.
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
        Self::require_governor(&env, &caller);
        Self::schedule_operation(env, target, data, fn_name, delay, predecessor, salt)
    }

    /// Schedule multiple operations in a single call.
    pub fn schedule_batch(
        env: Env,
        caller: Address,
        targets: Vec<Address>,
        data: Vec<Bytes>,
        fn_names: Vec<Symbol>,
        delay: u64,
        predecessors: Vec<Bytes>,
        salts: Vec<Bytes>,
    ) -> Vec<Bytes> {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let len = targets.len();
        assert!(len > 0, "empty batch");
        assert!(len == data.len(), "length mismatch");
        assert!(len == fn_names.len(), "length mismatch");
        assert!(len == predecessors.len(), "length mismatch");
        assert!(len == salts.len(), "length mismatch");

        let mut op_ids = Vec::new(&env);
        for i in 0..len {
            let op_id = Self::schedule_operation(
                env.clone(),
                targets.get(i).expect("target missing"),
                data.get(i).expect("data missing"),
                fn_names.get(i).expect("fn missing"),
                delay,
                predecessors.get(i).expect("predecessor missing"),
                salts.get(i).expect("salt missing"),
            );
            op_ids.push_back(op_id);
        }

        env.events()
            .publish((symbol_short!("schbatch"),), op_ids.clone());

        op_ids
    }

    /// Execute a ready operation.
    pub fn execute(env: Env, caller: Address, op_id: Bytes) {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let mut op: Operation = env
            .storage()
            .persistent()
            .get(&DataKey::Operation(op_id.clone()))
            .expect("operation not found");

        assert!(!op.executed && !op.cancelled, "invalid state");
        assert!(env.ledger().timestamp() >= op.ready_at, "not ready");
        if env.ledger().timestamp() > op.expires_at {
            env.panic_with_error(TimelockError::OperationExpired);
        }

        if !op.predecessor.is_empty() && !Self::is_done(env.clone(), op.predecessor.clone()) {
            env.panic_with_error(TimelockError::PredecessorNotDone);
        }

        op.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Operation(op_id.clone()), &op);

        let args = Self::decode_invocation_args(&env, &op.data);
        env.invoke_contract::<()>(&op.target, &op.fn_name, args);

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

    /// Check whether an operation is pending.
    pub fn is_pending(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(op) => !op.executed && !op.cancelled && env.ledger().timestamp() < op.ready_at,
            None => false,
        }
    }

    /// Check whether an operation is ready.
    pub fn is_ready(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(op) => {
                !op.executed
                    && !op.cancelled
                    && env.ledger().timestamp() >= op.ready_at
                    && env.ledger().timestamp() <= op.expires_at
            }
            None => false,
        }
    }

    /// Check whether an operation has been executed.
    pub fn is_done(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(op) => op.executed,
            None => false,
        }
    }

    /// Get the configured minimum delay in seconds.
    pub fn min_delay(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::MinDelay)
            .unwrap_or(86_400)
    }

    /// Get the configured execution window in seconds.
    pub fn execution_window(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ExecutionWindow)
            .unwrap_or(1_209_600)
    }

    /// Get the configured governor address.
    pub fn governor(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized")
    }

    /// Get the configured admin address.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Update the minimum delay. Only admin.
    pub fn update_delay(env: Env, caller: Address, new_delay: u64) {
        caller.require_auth();
        assert!(caller == Self::admin(env.clone()), "only admin");
        env.storage().instance().set(&DataKey::MinDelay, &new_delay);
    }

    /// Update the execution window. Only admin.
    pub fn update_execution_window(env: Env, caller: Address, new_window: u64) {
        caller.require_auth();
        assert!(caller == Self::admin(env.clone()), "only admin");
        env.storage()
            .instance()
            .set(&DataKey::ExecutionWindow, &new_window);
    }

    fn require_governor(env: &Env, caller: &Address) {
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        assert!(caller == &governor, "only governor");
    }

    fn schedule_operation(
        env: Env,
        target: Address,
        data: Bytes,
        fn_name: Symbol,
        delay: u64,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        Self::validate_predecessor(&env, &predecessor);

        let min_delay = Self::min_delay(env.clone());
        assert!(delay >= min_delay, "delay too short");

        let execution_window = Self::execution_window(env.clone());
        let ready_at = env.ledger().timestamp() + delay;
        let expires_at = ready_at + execution_window;
        let op_id = Self::compute_op_id(
            env.clone(),
            target.clone(),
            data.clone(),
            predecessor.clone(),
            salt,
        );

        let op = Operation {
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
            .set(&DataKey::Operation(op_id.clone()), &op);
        env.events()
            .publish((symbol_short!("schedule"),), op_id.clone());

        op_id
    }

    fn validate_predecessor(env: &Env, predecessor: &Bytes) {
        if predecessor.is_empty() {
            return;
        }

        let exists = env
            .storage()
            .persistent()
            .has(&DataKey::Operation(predecessor.clone()));
        if !exists {
            env.panic_with_error(TimelockError::PredecessorNotFound);
        }
    }

    fn decode_invocation_args(env: &Env, data: &Bytes) -> Vec<Val> {
        if data.is_empty() {
            return Vec::new(env);
        }

        if let Ok(args) = Vec::<Val>::from_xdr(env, data) {
            return args;
        }

        // Preserve compatibility with legacy callers that used opaque bytes for
        // no-arg calls before structured calldata decoding was implemented.
        Vec::new(env)
    }
}

#[cfg(test)]
mod test;

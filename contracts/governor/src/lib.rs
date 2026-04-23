#![no_std]

mod events;

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN,
    Env, String, Symbol, Vec,
};

/// Governor error codes.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GovernorError {
    UnauthorizedCancel = 1,
    InvalidSupport = 2,
    ProposalExpired = 3,
    CalldataTooLarge = 4,
    InvalidCalldata = 5,
    ProposalRateLimited = 6,
    ContractPaused = 7,
    UnauthorizedPause = 8,
    EmptyMetadataUri = 9,
    InvalidVotingDelay = 10,
    InvalidVotingPeriod = 11,
    InvalidQuorumNumerator = 12,
    InvalidProposalThreshold = 13,
    InvalidGasEstimationState = 14,
}

/// Cross-contract interface for the Timelock contract.
///
/// The governor uses this to schedule proposals after they succeed and to
/// trigger execution once the mandatory delay has elapsed.
#[contractclient(name = "TimelockClient")]
pub trait TimelockTrait {
    fn schedule(
        env: Env,
        caller: Address,
        target: Address,
        data: Bytes,
        fn_name: Symbol,
        delay: u64,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes;
    fn execute(env: Env, caller: Address, op_id: Bytes);
    fn cancel(env: Env, caller: Address, op_id: Bytes);
    fn min_delay(env: Env) -> u64;
    fn execution_window(env: Env) -> u64;
    fn is_done(env: Env, op_id: Bytes) -> bool;
}

/// Cross-contract interface for the TokenVotes contract.
///
/// The governor uses this to check voting power when creating proposals and
/// casting votes, and to query snapshot-based total supply for quorum.
#[contractclient(name = "VotesClient")]
pub trait VotesTrait {
    /// Get current voting power of an account.
    fn get_votes(env: Env, account: Address) -> i128;
    /// Get voting power at a past ledger sequence (snapshot).
    fn get_past_votes(env: Env, account: Address, ledger: u32) -> i128;
    /// Get the total token supply at a past ledger sequence (snapshot).
    fn get_past_total_supply(env: Env, ledger: u32) -> i128;
}

/// Cross-contract interface for the Reflector oracle.
///
/// Used for dynamic quorum calculations based on token USD price.
#[contractclient(name = "ReflectorOracleClient")]
pub trait ReflectorOracleTrait {
    fn lastprice(env: Env, asset: Address) -> Option<i128>;
}

/// A token address paired with its BPS weight (10000 = 1x).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct WeightedToken {
    pub token: Address,
    pub weight_bps: u32,
}

/// Voting strategy for the governor.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum VotingStrategy {
    /// Single token (default, backward compatible). Uses the VotesToken stored at init.
    Single,
    /// Weighted sum from up to 5 tokens. weight = sum(get_past_votes(t) * bps / 10000).
    MultiToken(Vec<WeightedToken>),
}

/// Proposal lifecycle states.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalState {
    Pending,
    Active,
    Defeated,
    Succeeded,
    Queued,
    Executed,
    Cancelled,
    Expired,
}

/// A governance proposal.
#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub description: String,
    /// SHA-256 hash of the off-chain proposal description for content integrity verification.
    pub description_hash: BytesN<32>,
    /// URI pointing to the full proposal description content (supports ipfs:// and https://).
    pub metadata_uri: String,
    /// Contract addresses that will be invoked when the proposal executes.
    pub targets: Vec<Address>,
    /// Function names invoked on each target. Each element corresponds to the
    /// target at the same index.
    pub fn_names: Vec<Symbol>,
    /// Calldata bytes for each target. Each element corresponds to the target
    /// at the same index.
    pub calldatas: Vec<Bytes>,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub votes_for: i128,
    pub votes_against: i128,
    pub votes_abstain: i128,
    pub executed: bool,
    pub cancelled: bool,
    pub queued: bool,
    /// Timelock operation ids created during queue().
    ///
    /// One op-id per (target, fn_name, calldata) tuple.
    pub op_ids: Vec<Bytes>,
}

/// Placeholder type for future storage migration data.
///
/// When a contract upgrade introduces a breaking change to the on-chain
/// storage layout, add the required migration values as fields here and
/// implement the migration logic inside [`GovernorContract::migrate`].
///
/// `new_version` is a monotonically increasing counter that callers must
/// supply so the migration can be applied exactly once per upgrade.
#[contracttype]
pub struct MigrateData {
    /// Monotonically increasing schema version written by this migration.
    /// Extend this struct with additional fields as the storage layout evolves.
    pub new_version: u32,
}

/// Governor configuration settings that can be updated via governance proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GovernorSettings {
    pub voting_delay: u32,
    pub voting_period: u32,
    pub quorum_numerator: u32,
    pub proposal_threshold: i128,
    pub guardian: Address,
    pub vote_type: VoteType,
    pub proposal_grace_period: u32,
    /// When true, quorum is the max of the static quorum and a USD-denominated floor.
    pub use_dynamic_quorum: bool,
    /// Address of the Reflector oracle used for dynamic quorum pricing.
    pub reflector_oracle: Option<Address>,
    /// Minimum quorum expressed in USD (6-decimal format, matching Reflector prices).
    pub min_quorum_usd: i128,
    /// Maximum calldata size per action in bytes.
    pub max_calldata_size: u32,
    /// Minimum ledgers between proposals from the same address (cooldown period).
    pub proposal_cooldown: u32,
    /// Maximum proposals per period (period measured in ledgers).
    pub max_proposals_per_period: u32,
    /// Period duration in ledgers for proposal rate limiting.
    pub proposal_period_duration: u32,
}

/// Estimated resource cost for executing a proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ExecutionGasEstimate {
    pub proposal_id: u64,
    pub action_count: u32,
    pub calldata_bytes: u32,
    pub estimated_cpu_insns: u64,
    pub estimated_mem_bytes: u64,
    pub estimated_fee_stroops: i128,
}

/// Vote support options.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum VoteSupport {
    Against,
    For,
    Abstain,
}

/// Voting receipt for a specific voter on a proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VotingReceipt {
    pub has_voted: bool,
    pub support: VoteSupport,
    pub weight: i128,
    pub reason: String,
}

/// Vote type configurations.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum VoteType {
    Simple,    // For / Against only
    Extended,  // For / Against / Abstain (current)
    Quadratic, // weight = sqrt(tokens)
}

/// Storage keys.
#[contracttype]
pub enum DataKey {
    Proposal(u64),
    ProposalCount,
    VotingDelay,
    VotingPeriod,
    QuorumNumerator,
    ProposalThreshold,
    Timelock,
    VotesToken,
    Admin,
    Guardian,
    VoteType,
    ProposalGracePeriod,
    HasVoted(u64, Address),
    VoteReason(u64, Address),
    VoteReceipt(u64, Address),
    /// The timelock op-id (Bytes) for a proposal after queue() is called.
    QueuedOpId(u64),
    /// The ledger sequence number when a proposal was queued (for veto window tracking).
    QueueTime(u64),
    ProposalExpiredEmitted(u64),
    CurrentWasmHash,
    /// Active voting strategy (Single or MultiToken).
    VotingStrategy,
    /// Whether dynamic quorum is enabled.
    UseDynamicQuorum,
    /// Address of the Reflector oracle for dynamic quorum.
    ReflectorOracle,
    /// Minimum quorum floor in USD (6-decimal format).
    MinQuorumUsd,
    /// Address authorized to pause/unpause the contract.
    Pauser,
    /// Whether the contract is currently paused.
    IsPaused,
    /// Last proposal ledger for an address (for cooldown).
    LastProposalLedger(Address),
    /// Proposal count for an address in current period.
    ProposalsInPeriod(Address, u32),
    /// Maximum calldata size per action in bytes.
    MaxCalldataSize,
    /// Minimum ledgers between proposals from the same address (cooldown period).
    ProposalCooldown,
    /// Maximum proposals per period (period measured in ledgers).
    MaxProposalsPerPeriod,
    /// Period duration in ledgers for proposal rate limiting.
    ProposalPeriodDuration,
}

const MAX_VOTING_DELAY: u32 = 1_209_600;
const MIN_VOTING_PERIOD: u32 = 1;
const EXECUTION_BASE_CPU_INSNS: u64 = 75_000;
const EXECUTION_CPU_INSNS_PER_ACTION: u64 = 50_000;
const EXECUTION_CPU_INSNS_PER_CALLDATA_BYTE: u64 = 20;
const EXECUTION_BASE_MEM_BYTES: u64 = 1_024;
const EXECUTION_MEM_BYTES_PER_ACTION: u64 = 512;
const EXECUTION_MEM_BYTES_PER_CALLDATA_BYTE: u64 = 2;
const EXECUTION_BASE_FEE_STROOPS: i128 = 100;
const EXECUTION_FEE_STROOPS_PER_ACTION: i128 = 10_000;
const EXECUTION_FEE_STROOPS_PER_CALLDATA_BYTE: i128 = 2;

#[contract]
pub struct GovernorContract;

#[contractimpl]
impl GovernorContract {
    fn validate_settings(env: &Env, settings: &GovernorSettings) {
        if settings.voting_delay > MAX_VOTING_DELAY {
            env.panic_with_error(GovernorError::InvalidVotingDelay);
        }
        if settings.voting_period < MIN_VOTING_PERIOD {
            env.panic_with_error(GovernorError::InvalidVotingPeriod);
        }
        if settings.quorum_numerator == 0 || settings.quorum_numerator > 100 {
            env.panic_with_error(GovernorError::InvalidQuorumNumerator);
        }
        if settings.proposal_threshold < 0 {
            env.panic_with_error(GovernorError::InvalidProposalThreshold);
        }
    }

    fn emit_proposal_expired_if_needed(env: &Env, proposal: &Proposal) {
        let expired_emitted: bool = env
            .storage()
            .persistent()
            .get(&DataKey::ProposalExpiredEmitted(proposal.id))
            .unwrap_or(false);

        if expired_emitted || proposal.cancelled || proposal.executed || proposal.queued {
            return;
        }

        let current = env.ledger().sequence();
        let quorum = Self::quorum(env.clone(), proposal.id);
        let quorum_met = proposal.votes_for >= quorum;
        let for_wins = proposal.votes_for > proposal.votes_against;

        if current > proposal.end_ledger && !(quorum_met && for_wins) {
            events::emit_proposal_expired(env, proposal.id, proposal.end_ledger);
            env.storage()
                .persistent()
                .set(&DataKey::ProposalExpiredEmitted(proposal.id), &true);
        }
    }

    /// Initialize the governor with configuration.
    pub fn initialize(
        env: Env,
        admin: Address,
        votes_token: Address,
        timelock: Address,
        voting_delay: u32,
        voting_period: u32,
        quorum_numerator: u32,
        proposal_threshold: i128,
        guardian: Address,
        vote_type: VoteType,
        proposal_grace_period: u32,
    ) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::VotesToken, &votes_token);
        env.storage().instance().set(&DataKey::Timelock, &timelock);
        env.storage()
            .instance()
            .set(&DataKey::VotingDelay, &voting_delay);
        env.storage()
            .instance()
            .set(&DataKey::VotingPeriod, &voting_period);
        env.storage()
            .instance()
            .set(&DataKey::QuorumNumerator, &quorum_numerator);
        env.storage()
            .instance()
            .set(&DataKey::ProposalThreshold, &proposal_threshold);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.storage().instance().set(&DataKey::VoteType, &vote_type);
        env.storage()
            .instance()
            .set(&DataKey::ProposalGracePeriod, &proposal_grace_period);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::CurrentWasmHash, &BytesN::from_array(&env, &[0u8; 32]));
        env.storage()
            .instance()
            .set(&DataKey::VotingStrategy, &VotingStrategy::Single);
        env.storage()
            .instance()
            .set(&DataKey::UseDynamicQuorum, &false);
        // Initialize new security settings with defaults
        env.storage()
            .instance()
            .set(&DataKey::MaxCalldataSize, &10_000u32); // 10KB max calldata
        env.storage()
            .instance()
            .set(&DataKey::ProposalCooldown, &100u32); // ~10 min cooldown
        env.storage()
            .instance()
            .set(&DataKey::MaxProposalsPerPeriod, &5u32); // 5 proposals per period
        env.storage()
            .instance()
            .set(&DataKey::ProposalPeriodDuration, &10_000u32); // ~24 hour period
        // Initialize pause state (not paused by default)
        env.storage().instance().set(&DataKey::IsPaused, &false);
        // Set admin as initial pauser
        env.storage().instance().set(&DataKey::Pauser, &admin);
    }

    /// Create a new governance proposal.
    ///
    /// `targets` and `calldatas` specify the on-chain actions to execute if
    /// the proposal passes. Each element in `targets` is a contract address,
    /// and the corresponding element in `calldatas` contains the encoded
    /// function call data.
    ///
    /// Before creating the proposal, this function verifies that the proposer
    /// has sufficient voting power to meet the `proposal_threshold`.
    pub fn propose(
        env: Env,
        proposer: Address,
        description: String,
        description_hash: BytesN<32>,
        metadata_uri: String,
        targets: Vec<Address>,
        fn_names: Vec<Symbol>,
        calldatas: Vec<Bytes>,
    ) -> u64 {
        proposer.require_auth();

        // Check if contract is paused
        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if is_paused {
            env.panic_with_error(GovernorError::ContractPaused);
        }

        // Validate all vectors have the same length
        assert!(
            targets.len() == fn_names.len() && targets.len() == calldatas.len(),
            "targets, fn_names, and calldatas length mismatch"
        );
        assert!(!targets.is_empty(), "must have at least one target");

        // Validate calldata size limits (Issue #186)
        let max_calldata_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxCalldataSize)
            .unwrap_or(10_000);
        for i in 0..calldatas.len() {
            let calldata = calldatas.get(i).unwrap();
            if calldata.len() > max_calldata_size {
                env.panic_with_error(GovernorError::CalldataTooLarge);
            }
        }

        // Rate limiting checks (Issue #188)
        let current_ledger = env.ledger().sequence();
        
        // Check cooldown period
        let cooldown: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCooldown)
            .unwrap_or(100);
        let last_proposal_ledger: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::LastProposalLedger(proposer.clone()))
            .unwrap_or(0);
        if current_ledger < last_proposal_ledger + cooldown {
            env.panic_with_error(GovernorError::ProposalRateLimited);
        }

        // Check max proposals per period
        let period_duration: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalPeriodDuration)
            .unwrap_or(10_000);
        let max_proposals: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxProposalsPerPeriod)
            .unwrap_or(5);
        
        let current_period = current_ledger / period_duration;
        let proposals_in_period: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::ProposalsInPeriod(proposer.clone(), current_period))
            .unwrap_or(0);
        
        if proposals_in_period >= max_proposals {
            env.panic_with_error(GovernorError::ProposalRateLimited);
        }

        // Get the voting power of the proposer (strategy-aware)
        let proposer_votes = Self::compute_proposer_votes(&env, &proposer);

        // Enforce proposal threshold
        let threshold: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalThreshold)
            .unwrap_or(0);

        assert!(
            proposer_votes >= threshold,
            "proposer votes below threshold"
        );

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count + 1;

        let voting_delay: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VotingDelay)
            .unwrap_or(100);
        let voting_period: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(1000);

        let current = env.ledger().sequence();
        let proposal = Proposal {
            id: proposal_id,
            proposer: proposer.clone(),
            description: description.clone(),
            description_hash: description_hash.clone(),
            metadata_uri: metadata_uri.clone(),
            targets: targets.clone(),
            fn_names: fn_names.clone(),
            calldatas: calldatas.clone(),
            start_ledger: current + voting_delay,
            end_ledger: current + voting_delay + voting_period,
            votes_for: 0,
            votes_against: 0,
            votes_abstain: 0,
            executed: false,
            cancelled: false,
            queued: false,
            op_ids: Vec::new(&env),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);

        // Update rate limiting storage
        env.storage()
            .persistent()
            .set(&DataKey::LastProposalLedger(proposer.clone()), &current);
        env.storage()
            .persistent()
            .set(&DataKey::ProposalsInPeriod(proposer.clone(), current_period), &(proposals_in_period + 1));

        // Emit ProposalCreated event with all proposal fields
        env.events().publish(
            (symbol_short!("prop_crtd"), proposer.clone()),
            (
                proposal_id,
                description,
                description_hash,
                metadata_uri,
                targets,
                fn_names,
                calldatas,
                current + voting_delay,
                current + voting_delay + voting_period,
            ),
        );

        proposal_id
    }

    /// Apply vote type weighting to raw voting power.
    fn apply_vote_type(vote_type: VoteType, raw_weight: i128) -> i128 {
        match vote_type {
            VoteType::Simple | VoteType::Extended => raw_weight,
            VoteType::Quadratic => {
                // Integer square root for quadratic voting
                let raw_u128 = raw_weight as u128;
                if raw_u128 == 0 {
                    return 0;
                }
                // Simple integer square root implementation
                let mut x = raw_u128;
                let mut y = (x + 1) / 2;
                while y < x {
                    x = y;
                    y = (x + raw_u128 / x) / 2;
                }
                x as i128
            }
        }
    }

    /// Validate vote support against configured vote type.
    fn validate_vote_support(env: &Env, support: &VoteSupport) -> Result<(), GovernorError> {
        let vote_type: VoteType = env
            .storage()
            .instance()
            .get(&DataKey::VoteType)
            .unwrap_or(VoteType::Extended);

        match vote_type {
            VoteType::Simple => {
                if matches!(support, VoteSupport::Abstain) {
                    Err(GovernorError::InvalidSupport)
                } else {
                    Ok(())
                }
            }
            VoteType::Extended | VoteType::Quadratic => Ok(()),
        }
    }

    /// Cast a vote on an active proposal.
    ///
    /// Reads the voter's snapshot voting power at `proposal.start_ledger` from
    /// the token-votes contract via a cross-contract call. Accounts with zero
    /// voting power are rejected.
    pub fn cast_vote(env: Env, voter: Address, proposal_id: u64, support: VoteSupport) {
        voter.require_auth();

        // Validate vote support against configured vote type
        Self::validate_vote_support(&env, &support)
            .unwrap_or_else(|e| env.panic_with_error(e));

        let voted: bool = env
            .storage()
            .persistent()
            .get(&DataKey::HasVoted(proposal_id, voter.clone()))
            .unwrap_or(false);
        assert!(!voted, "already voted");

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        // Look up the voter's snapshot voting power at the proposal's start ledger
        // using the active voting strategy (single token or multi-token weighted).
        let raw_weight: i128 = Self::compute_votes(&env, &voter, &proposal.start_ledger);

        assert!(raw_weight > 0, "zero voting power");

        // Apply vote type weighting
        let vote_type: VoteType = env
            .storage()
            .instance()
            .get(&DataKey::VoteType)
            .unwrap_or(VoteType::Extended);
        let weight = Self::apply_vote_type(vote_type, raw_weight);

        match support {
            VoteSupport::For => proposal.votes_for += weight,
            VoteSupport::Against => proposal.votes_against += weight,
            VoteSupport::Abstain => proposal.votes_abstain += weight,
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .persistent()
            .set(&DataKey::HasVoted(proposal_id, voter.clone()), &true);

        // Store voting receipt
        let receipt = VotingReceipt {
            has_voted: true,
            support: support.clone(),
            weight,
            reason: String::from_str(&env, ""),
        };
        env.storage()
            .persistent()
            .set(&DataKey::VoteReceipt(proposal_id, voter.clone()), &receipt);

        // Emit VoteCast event including the weighted vote power.
        env.events().publish(
            (symbol_short!("vote"), voter),
            (proposal_id, support, weight),
        );
    }

    /// Cast a vote with an on-chain reason string.
    pub fn cast_vote_with_reason(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: VoteSupport,
        reason: String,
    ) {
        voter.require_auth();

        // Validate vote support against configured vote type
        Self::validate_vote_support(&env, &support)
            .unwrap_or_else(|e| env.panic_with_error(e));

        let voted: bool = env
            .storage()
            .persistent()
            .get(&DataKey::HasVoted(proposal_id, voter.clone()))
            .unwrap_or(false);
        assert!(!voted, "already voted");

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        // Look up the voter's snapshot voting power at the proposal's start ledger
        let raw_weight: i128 = Self::compute_votes(&env, &voter, &proposal.start_ledger);
        assert!(raw_weight > 0, "zero voting power");

        // Apply vote type weighting
        let vote_type: VoteType = env
            .storage()
            .instance()
            .get(&DataKey::VoteType)
            .unwrap_or(VoteType::Extended);
        let weight = Self::apply_vote_type(vote_type, raw_weight);

        match support {
            VoteSupport::For => proposal.votes_for += weight,
            VoteSupport::Against => proposal.votes_against += weight,
            VoteSupport::Abstain => proposal.votes_abstain += weight,
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .persistent()
            .set(&DataKey::HasVoted(proposal_id, voter.clone()), &true);

        // Store the reason in persistent storage
        env.storage()
            .persistent()
            .set(&DataKey::VoteReason(proposal_id, voter.clone()), &reason);

        // Store voting receipt with reason
        let receipt = VotingReceipt {
            has_voted: true,
            support: support.clone(),
            weight,
            reason: reason.clone(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::VoteReceipt(proposal_id, voter.clone()), &receipt);

        // Emit VoteCastWithReason event
        env.events().publish(
            (symbol_short!("vote_rsn"), voter),
            (proposal_id, support, reason),
        );
    }

    /// Queue a succeeded proposal for execution via the timelock.
    ///
    /// Reads the timelock's configured `min_delay` and schedules the proposal's
    /// target invocation. The returned op-id is stored so `execute()` can
    /// reference it later.
    ///
    /// Schedules every action in the proposal via the Timelock contract.
    pub fn queue(env: Env, proposal_id: u64) {
        // Check if contract is paused
        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if is_paused {
            env.panic_with_error(GovernorError::ContractPaused);
        }

        let proposal_state = Self::state(env.clone(), proposal_id);

        if proposal_state == ProposalState::Expired {
            env.panic_with_error(GovernorError::ProposalExpired);
        }

        assert!(
            proposal_state == ProposalState::Succeeded,
            "proposal not succeeded"
        );

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        let timelock_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Timelock)
            .expect("timelock not set");
        let gov_addr = env.current_contract_address();
        let timelock = TimelockClient::new(&env, &timelock_addr);

        assert!(!proposal.targets.is_empty(), "no targets in proposal");

        // Use the timelock's own minimum delay to guarantee the configured
        // execution window is respected.
        let delay = timelock.min_delay();

        let ready_at = env.ledger().timestamp() + delay;

        // Schedule every action in the proposal (multi-action proposals).
        let mut op_ids: Vec<Bytes> = Vec::new(&env);
        let empty_bytes = Bytes::new(&env);
        for i in 0..proposal.targets.len() {
            let target = proposal.targets.get(i).unwrap();
            let fn_name = proposal.fn_names.get(i).unwrap();
            let calldata = proposal.calldatas.get(i).unwrap();
            let op_id = timelock.schedule(&gov_addr, &target, &calldata, &fn_name, &delay, &empty_bytes, &empty_bytes);
            op_ids.push_back(op_id);
        }

        proposal.op_ids = op_ids;
        proposal.queued = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        // Store the queue time (current ledger sequence) for veto window tracking
        let queue_time = env.ledger().sequence();
        env.storage()
            .persistent()
            .set(&DataKey::QueueTime(proposal_id), &queue_time);

        // Emit ProposalQueued event with the timelock ETA (`ready_at`) and veto window info.
        env.events().publish(
            (Symbol::new(&env, "ProposalQueued"),),
            (proposal_id, ready_at, queue_time),
        );
        let first_op_id = proposal.op_ids.get(0).unwrap();
        events::emit_proposal_queued(&env, proposal_id, &first_op_id, ready_at);
    }

    /// Execute a queued proposal.
    ///
    /// Delegates to the timelock to enforce the delay, which in turn invokes
    /// `proposal.fn_name()` on `proposal.target`.
    pub fn execute(env: Env, proposal_id: u64) {
        // Check if contract is paused
        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if is_paused {
            env.panic_with_error(GovernorError::ContractPaused);
        }

        assert!(
            Self::state(env.clone(), proposal_id) == ProposalState::Queued,
            "proposal not queued"
        );

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        assert!(!proposal.executed, "proposal already executed");

        let timelock_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Timelock)
            .expect("timelock not set");
        let gov_addr = env.current_contract_address();

        // Execute all timelock operations scheduled by queue().
        assert!(
            !proposal.op_ids.is_empty(),
            "no op ids — call queue() first"
        );

        let timelock = TimelockClient::new(&env, &timelock_addr);
        for i in 0..proposal.op_ids.len() {
            let op_id = proposal.op_ids.get(i).unwrap();
            // The timelock will verify if the operation is ready (delay passed).
            timelock.execute(&gov_addr, &op_id);
        }

        proposal.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        events::emit_proposal_executed(&env, proposal_id, &gov_addr);
    }

    /// Estimate the resource cost for executing a proposal.
    ///
    /// Soroban's authoritative fee comes from RPC transaction simulation. This
    /// view returns a deterministic contract-side estimate based on the number
    /// of actions and calldata size so clients can show a stable cost hint
    /// before submitting the execution transaction.
    pub fn estimate_execution_gas(env: Env, proposal_id: u64) -> ExecutionGasEstimate {
        let state = Self::state(env.clone(), proposal_id);
        if state == ProposalState::Executed
            || state == ProposalState::Cancelled
            || state == ProposalState::Expired
        {
            env.panic_with_error(GovernorError::InvalidGasEstimationState);
        }

        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        let action_count = proposal.targets.len();
        let mut calldata_bytes = 0u32;
        for i in 0..proposal.calldatas.len() {
            let calldata = proposal.calldatas.get(i).unwrap();
            calldata_bytes = calldata_bytes.saturating_add(calldata.len());
        }

        let estimated_cpu_insns = EXECUTION_BASE_CPU_INSNS
            .saturating_add((action_count as u64).saturating_mul(EXECUTION_CPU_INSNS_PER_ACTION))
            .saturating_add(
                (calldata_bytes as u64).saturating_mul(EXECUTION_CPU_INSNS_PER_CALLDATA_BYTE),
            );
        let estimated_mem_bytes = EXECUTION_BASE_MEM_BYTES
            .saturating_add((action_count as u64).saturating_mul(EXECUTION_MEM_BYTES_PER_ACTION))
            .saturating_add(
                (calldata_bytes as u64).saturating_mul(EXECUTION_MEM_BYTES_PER_CALLDATA_BYTE),
            );
        let estimated_fee_stroops = EXECUTION_BASE_FEE_STROOPS
            .saturating_add(
                (action_count as i128).saturating_mul(EXECUTION_FEE_STROOPS_PER_ACTION),
            )
            .saturating_add(
                (calldata_bytes as i128).saturating_mul(EXECUTION_FEE_STROOPS_PER_CALLDATA_BYTE),
            );

        ExecutionGasEstimate {
            proposal_id,
            action_count,
            calldata_bytes,
            estimated_cpu_insns,
            estimated_mem_bytes,
            estimated_fee_stroops,
        }
    }

    /// Cancel a proposal with proper authorization.
    /// Proposer can cancel their own proposal while it is Pending.
    /// Guardian can cancel any Active proposal as an emergency veto.
    pub fn cancel(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();

        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        let state = Self::state(env.clone(), proposal_id);
        let guardian: Address = env
            .storage()
            .instance()
            .get(&DataKey::Guardian)
            .expect("guardian not set");

        let can_cancel = (caller == proposal.proposer && state == ProposalState::Pending)
            || (caller == guardian && state == ProposalState::Active);

        if !can_cancel {
            env.panic_with_error(GovernorError::UnauthorizedCancel);
        }

        let mut proposal = proposal;
        proposal.cancelled = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        events::emit_proposal_cancelled(&env, proposal_id, &caller);
    }

    /// Cancel a queued proposal during the veto window.
    ///
    /// Only the guardian can cancel a queued proposal, and only within the veto
    /// window that expires at `queue_time + timelock_delay`. After the veto
    /// window closes, this function reverts.
    ///
    /// This cancellation also cancels all associated timelock operations via
    /// the timelock contract.
    pub fn cancel_queued(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();

        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        // Verify the proposal is queued
        assert!(proposal.queued && !proposal.cancelled, "proposal not queued");

        let guardian: Address = env
            .storage()
            .instance()
            .get(&DataKey::Guardian)
            .expect("guardian not set");

        // Only guardian can cancel queued proposals
        assert!(caller == guardian, "only guardian can cancel queued proposals");

        // Get the queue time for veto window check
        let queue_time: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::QueueTime(proposal_id))
            .expect("queue_time not found");

        // Get the timelock delay
        let timelock_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Timelock)
            .expect("timelock not set");
        let timelock = TimelockClient::new(&env, &timelock_addr);
        let delay = timelock.min_delay();

        // Check if we're still in the veto window
        let current_ledger = env.ledger().sequence();
        let veto_window_end = queue_time + (delay / 10u64) as u32; // Assuming ~10 seconds per ledger, roughly 1 ledger per second
        
        // For simplicity, use delay directly as ledger count (adjusting for typical Soroban block times)
        // The veto window should close after timelock_delay seconds
        // Conversion: assume timelock delay is in seconds and we need ledger conversion
        let veto_window_end_ledger = queue_time + ((delay / 10) as u32); // Roughly 1 ledger per 10 seconds
        
        assert!(
            current_ledger < veto_window_end_ledger,
            "veto window closed"
        );

        // Cancel the proposal
        let mut proposal_mut = proposal;
        proposal_mut.cancelled = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal_mut);

        // Cancel all timelock operations associated with this proposal
        let gov_addr = env.current_contract_address();
        for i in 0..proposal_mut.op_ids.len() {
            let op_id = proposal_mut.op_ids.get(i).unwrap();
            timelock.cancel(&gov_addr, &op_id);
        }

        // Emit ProposalCancelledFromQueue event
        env.events().publish(
            (symbol_short!("veto"), caller.clone()),
            (proposal_id, queue_time, current_ledger),
        );
    }

    /// Get the current state of a proposal.
    ///
    /// After the voting period ends, the proposal is Succeeded when it has at
    /// least one For vote, more For votes than Against votes, and meets the
    /// quorum requirement (votes_for >= quorum).
    pub fn state(env: Env, proposal_id: u64) -> ProposalState {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        if proposal.cancelled {
            return ProposalState::Cancelled;
        }
        if proposal.executed {
            return ProposalState::Executed;
        }
        if proposal.queued {
            return ProposalState::Queued;
        }

        let current = env.ledger().sequence();
        if current < proposal.start_ledger {
            return ProposalState::Pending;
        }

        if current <= proposal.end_ledger {
            return ProposalState::Active;
        }

        Self::emit_proposal_expired_if_needed(&env, &proposal);

        // Voting ended.
        let quorum = Self::quorum(env.clone(), proposal_id);
        let quorum_met = proposal.votes_for >= quorum;
        let for_wins = proposal.votes_for > proposal.votes_against;
        let against_wins_or_ties = proposal.votes_against >= proposal.votes_for;

        if quorum_met && for_wins {
            // Check if succeeded proposal has expired
            let grace_period: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ProposalGracePeriod)
                .unwrap_or(120_960); // Default ~7 days
            let grace_end = proposal.end_ledger + grace_period;
            if current > grace_end {
                ProposalState::Expired
            } else {
                ProposalState::Succeeded
            }
        } else if !quorum_met || against_wins_or_ties {
            ProposalState::Defeated
        } else {
            // Defensive fallback: with quorum_met=false or against_wins_or_ties=true,
            // we must have already returned Defeated above.
            ProposalState::Defeated
        }
    }

    /// Calculate the quorum required for a proposal based on the total supply
    /// at the proposal's start ledger.
    pub fn quorum(env: Env, proposal_id: u64) -> i128 {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        let votes_token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::VotesToken)
            .expect("votes token not set");

        let quorum_numerator: u32 = env
            .storage()
            .instance()
            .get(&DataKey::QuorumNumerator)
            .unwrap_or(0);

        // If quorum is configured as 0%, no need to query token supply from
        // the votes contract. This also keeps state()/queue() robust in
        // tests where the votes token might be a placeholder address.
        if quorum_numerator == 0 {
            return 0;
        }

        let votes_client = VotesClient::new(&env, &votes_token_addr);
        let supply = votes_client.get_past_total_supply(&proposal.start_ledger);

        let static_quorum = (supply * quorum_numerator as i128) / 100;

        let use_dynamic: bool = env
            .storage()
            .instance()
            .get(&DataKey::UseDynamicQuorum)
            .unwrap_or(false);
        if !use_dynamic {
            return static_quorum;
        }

        // Try to fetch token price from Reflector oracle.
        let oracle_opt: Option<Address> = env
            .storage()
            .instance()
            .get(&DataKey::ReflectorOracle);
        if let Some(oracle_addr) = oracle_opt {
            let min_quorum_usd: i128 = env
                .storage()
                .instance()
                .get(&DataKey::MinQuorumUsd)
                .unwrap_or(0);
            if min_quorum_usd > 0 {
                // Call oracle — fall back to static if it fails or returns None/zero.
                let oracle = ReflectorOracleClient::new(&env, &oracle_addr);
                let price_opt = oracle.try_lastprice(&votes_token_addr);
                if let Ok(Ok(Some(price))) = price_opt {
                    if price > 0 {
                        let usd_quorum = min_quorum_usd / price;
                        return static_quorum.max(usd_quorum);
                    }
                }
            }
        }
        static_quorum
    }

    /// Get vote counts for a proposal.
    pub fn proposal_votes(env: Env, proposal_id: u64) -> (i128, i128, i128) {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");
        (
            proposal.votes_for,
            proposal.votes_against,
            proposal.votes_abstain,
        )
    }

    /// Get governor configuration.
    pub fn voting_delay(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::VotingDelay)
            .unwrap_or(100)
    }

    pub fn voting_period(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(1000)
    }

    pub fn proposal_threshold(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalThreshold)
            .unwrap_or(0)
    }

    pub fn quorum_numerator(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::QuorumNumerator)
            .unwrap_or(0)
    }

    pub fn get_settings(env: Env) -> GovernorSettings {
        GovernorSettings {
            voting_delay: env
                .storage()
                .instance()
                .get(&DataKey::VotingDelay)
                .unwrap_or(100),
            voting_period: env
                .storage()
                .instance()
                .get(&DataKey::VotingPeriod)
                .unwrap_or(1000),
            quorum_numerator: env
                .storage()
                .instance()
                .get(&DataKey::QuorumNumerator)
                .unwrap_or(0),
            proposal_threshold: env
                .storage()
                .instance()
                .get(&DataKey::ProposalThreshold)
                .unwrap_or(0),
            guardian: env
                .storage()
                .instance()
                .get(&DataKey::Guardian)
                .expect("guardian not set"),
            vote_type: env
                .storage()
                .instance()
                .get(&DataKey::VoteType)
                .unwrap_or(VoteType::Extended),
            proposal_grace_period: env
                .storage()
                .instance()
                .get(&DataKey::ProposalGracePeriod)
                .unwrap_or(120_960),
            use_dynamic_quorum: env
                .storage()
                .instance()
                .get(&DataKey::UseDynamicQuorum)
                .unwrap_or(false),
            reflector_oracle: env
                .storage()
                .instance()
                .get(&DataKey::ReflectorOracle),
            min_quorum_usd: env
                .storage()
                .instance()
                .get(&DataKey::MinQuorumUsd)
                .unwrap_or(0),
            max_calldata_size: env
                .storage()
                .instance()
                .get(&DataKey::MaxCalldataSize)
                .unwrap_or(10_000),
            proposal_cooldown: env
                .storage()
                .instance()
                .get(&DataKey::ProposalCooldown)
                .unwrap_or(100),
            max_proposals_per_period: env
                .storage()
                .instance()
                .get(&DataKey::MaxProposalsPerPeriod)
                .unwrap_or(5),
            proposal_period_duration: env
                .storage()
                .instance()
                .get(&DataKey::ProposalPeriodDuration)
                .unwrap_or(10_000),
        }
    }

    /// Update governor configuration parameters.
    ///
    /// Authorization is restricted to the governor's own contract address.
    /// This means the call must originate from an executed on-chain proposal.
    pub fn update_config(env: Env, new_settings: GovernorSettings) {
        env.current_contract_address().require_auth();
        Self::validate_settings(&env, &new_settings);

        let old_settings = Self::get_settings(env.clone());

        env.storage()
            .instance()
            .set(&DataKey::VotingDelay, &new_settings.voting_delay);
        env.storage()
            .instance()
            .set(&DataKey::VotingPeriod, &new_settings.voting_period);
        env.storage()
            .instance()
            .set(&DataKey::QuorumNumerator, &new_settings.quorum_numerator);
        env.storage()
            .instance()
            .set(&DataKey::ProposalThreshold, &new_settings.proposal_threshold);
        env.storage()
            .instance()
            .set(&DataKey::Guardian, &new_settings.guardian);
        env.storage()
            .instance()
            .set(&DataKey::VoteType, &new_settings.vote_type);
        env.storage()
            .instance()
            .set(&DataKey::ProposalGracePeriod, &new_settings.proposal_grace_period);
        env.storage()
            .instance()
            .set(&DataKey::UseDynamicQuorum, &new_settings.use_dynamic_quorum);
        env.storage()
            .instance()
            .set(&DataKey::MinQuorumUsd, &new_settings.min_quorum_usd);
        env.storage()
            .instance()
            .set(&DataKey::MaxCalldataSize, &new_settings.max_calldata_size);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCooldown, &new_settings.proposal_cooldown);
        env.storage()
            .instance()
            .set(&DataKey::MaxProposalsPerPeriod, &new_settings.max_proposals_per_period);
        env.storage()
            .instance()
            .set(&DataKey::ProposalPeriodDuration, &new_settings.proposal_period_duration);
        match new_settings.reflector_oracle {
            Some(ref addr) => env
                .storage()
                .instance()
                .set(&DataKey::ReflectorOracle, addr),
            None => env
                .storage()
                .instance()
                .remove(&DataKey::ReflectorOracle),
        }

        events::emit_config_updated(&env, &old_settings, &new_settings);
    }

    /// Get total proposal count.
    pub fn proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    /// Get the vote reason for a specific voter on a proposal.
    pub fn get_vote_reason(env: Env, proposal_id: u64, voter: Address) -> Option<String> {
        env.storage()
            .persistent()
            .get(&DataKey::VoteReason(proposal_id, voter))
    }

    /// Get the voting receipt for a specific voter on a proposal.
    ///
    /// Returns a VotingReceipt containing whether the voter has voted, their
    /// support choice, the weight of their vote, and any reason provided.
    pub fn get_receipt(env: Env, proposal_id: u64, voter: Address) -> VotingReceipt {
        env.storage()
            .persistent()
            .get(&DataKey::VoteReceipt(proposal_id, voter))
            .unwrap_or(VotingReceipt {
                has_voted: false,
                support: VoteSupport::Against,
                weight: 0,
                reason: String::from_str(&env, ""),
            })
    }

    /// Get the active voting strategy.
    pub fn voting_strategy(env: Env) -> VotingStrategy {
        env.storage()
            .instance()
            .get(&DataKey::VotingStrategy)
            .unwrap_or(VotingStrategy::Single)
    }

    /// Set the voting strategy (governance-gated: must be called via proposal).
    ///
    /// For MultiToken strategy, a maximum of 5 tokens is enforced.
    pub fn set_voting_strategy(env: Env, strategy: VotingStrategy) {
        env.current_contract_address().require_auth();
        if let VotingStrategy::MultiToken(ref tokens) = strategy {
            assert!(tokens.len() <= 5, "max 5 tokens in MultiToken strategy");
        }
        env.storage()
            .instance()
            .set(&DataKey::VotingStrategy, &strategy);
    }

    /// Update Reflector oracle settings for dynamic quorum (governance-gated).
    pub fn update_oracle(
        env: Env,
        oracle: Option<Address>,
        min_quorum_usd: i128,
        use_dynamic: bool,
    ) {
        env.current_contract_address().require_auth();
        env.storage()
            .instance()
            .set(&DataKey::UseDynamicQuorum, &use_dynamic);
        env.storage()
            .instance()
            .set(&DataKey::MinQuorumUsd, &min_quorum_usd);
        match oracle {
            Some(addr) => env
                .storage()
                .instance()
                .set(&DataKey::ReflectorOracle, &addr),
            None => env
                .storage()
                .instance()
                .remove(&DataKey::ReflectorOracle),
        }
    }

    /// Compute snapshot vote weight for `voter` at `ledger` using the active strategy.
    fn compute_votes(env: &Env, voter: &Address, ledger: &u32) -> i128 {
        let strategy: VotingStrategy = env
            .storage()
            .instance()
            .get(&DataKey::VotingStrategy)
            .unwrap_or(VotingStrategy::Single);
        match strategy {
            VotingStrategy::Single => {
                let votes_token: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::VotesToken)
                    .expect("votes token not set");
                VotesClient::new(env, &votes_token).get_past_votes(voter, ledger)
            }
            VotingStrategy::MultiToken(tokens) => {
                let mut total: i128 = 0;
                for wt in tokens.iter() {
                    let votes =
                        VotesClient::new(env, &wt.token).get_past_votes(voter, ledger);
                    total += (votes * wt.weight_bps as i128) / 10_000;
                }
                total
            }
        }
    }

    /// Compute current vote weight for `proposer` using the active strategy.
    fn compute_proposer_votes(env: &Env, proposer: &Address) -> i128 {
        let strategy: VotingStrategy = env
            .storage()
            .instance()
            .get(&DataKey::VotingStrategy)
            .unwrap_or(VotingStrategy::Single);
        match strategy {
            VotingStrategy::Single => {
                let votes_token: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::VotesToken)
                    .expect("votes token not set");
                VotesClient::new(env, &votes_token).get_votes(proposer)
            }
            VotingStrategy::MultiToken(tokens) => {
                let mut total: i128 = 0;
                for wt in tokens.iter() {
                    let votes = VotesClient::new(env, &wt.token).get_votes(proposer);
                    total += (votes * wt.weight_bps as i128) / 10_000;
                }
                total
            }
        }
    }

    /// Upgrade the governor contract to a new WASM implementation.
    ///
    /// Authorization is restricted to the governor's own contract address.
    /// This means the call must originate from an executed on-chain proposal:
    /// the timelock invokes `upgrade` on behalf of a passed vote, with the
    /// governor contract itself as the authorised principal.
    ///
    /// Upgrade flow:
    ///   1. A proposer creates a proposal whose calldata targets `upgrade(hash)`
    ///   2. Token holders vote; quorum and majority are reached
    ///   3. The proposal is queued in the Timelock with the configured delay
    ///   4. After the delay, anyone triggers execution
    ///   5. The Timelock calls `governor.upgrade(hash)` as an authorised
    ///      sub-invocation of the contract's own address
    ///   6. `env.deployer().update_current_contract_wasm` replaces the WASM;
    ///      the contract address, balance, and storage all remain intact
    ///
    /// If the new WASM changes the storage layout, call `migrate` immediately
    /// after this in the same proposal's calldata.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        env.current_contract_address().require_auth();
        let old_wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::CurrentWasmHash)
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]));
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.storage()
            .instance()
            .set(&DataKey::CurrentWasmHash, &new_wasm_hash);
        events::emit_governor_upgraded(&env, &old_wasm_hash, &new_wasm_hash);
    }

    /// Migrate contract storage after a WASM upgrade.
    ///
    /// Like `upgrade`, this can only be called from the governor's own address
    /// and must therefore be triggered through an executed on-chain proposal.
    ///
    /// This is a no-op stub. When a future upgrade introduces changes to the
    /// on-chain storage layout, extend [`MigrateData`] with the required
    /// values and implement the migration logic here.
    pub fn migrate(env: Env, _data: MigrateData) {
        env.current_contract_address().require_auth();
        // TODO: implement storage migration logic when a breaking storage
        // change is introduced in a future upgrade.
    }

    // ============================================================================
    // Emergency Pause Mechanism (Issue #191)
    // ============================================================================

    /// Pause the contract to prevent critical operations during emergencies.
    /// Only the pauser role can call this function.
    pub fn pause(env: Env, caller: Address) {
        caller.require_auth();

        let pauser: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pauser)
            .expect("pauser not set");

        if caller != pauser {
            env.panic_with_error(GovernorError::UnauthorizedPause);
        }

        env.storage()
            .instance()
            .set(&DataKey::IsPaused, &true);

        env.events().publish(
            (symbol_short!("paused"),),
            (caller, env.ledger().sequence()),
        );
    }

    /// Unpause the contract to resume normal operations.
    /// Only callable via governance proposal (requires contract self-auth).
    pub fn unpause(env: Env) {
        env.current_contract_address().require_auth();

        env.storage()
            .instance()
            .set(&DataKey::IsPaused, &false);

        env.events().publish(
            (symbol_short!("unpaused"),),
            env.ledger().sequence(),
        );
    }

    /// Check if the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false)
    }

    /// Get the current pauser address.
    pub fn pauser(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Pauser)
            .expect("pauser not set")
    }

    /// Update the pauser address (governance-gated).
    pub fn set_pauser(env: Env, new_pauser: Address) {
        env.current_contract_address().require_auth();

        let old_pauser: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pauser)
            .expect("pauser not set");

        env.storage()
            .instance()
            .set(&DataKey::Pauser, &new_pauser);

        env.events().publish(
            (Symbol::new(&env, "PauserChanged"),),
            (old_pauser, new_pauser),
        );
    }

    // ============================================================================
    // UUPS Proxy Pattern (Issue #195)
    // ============================================================================

    /// Get the implementation address for UUPS proxy pattern.
    /// For native Soroban upgradeability, this returns the current contract address.
    pub fn implementation(env: Env) -> Address {
        env.current_contract_address()
    }

    /// Get the proxy admin address (for UUPS pattern compatibility).
    /// Returns the contract's own address since upgrades are governance-gated.
    pub fn proxy_admin(env: Env) -> Address {
        env.current_contract_address()
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Events, Ledger as _},
        Bytes, Env, Symbol, TryIntoVal,
    };

    /// Mock votes contract that returns a high vote count for any address,
    /// allowing propose() to pass the threshold check in unit tests.
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

    /// Shared helper: initialize the governor and return a proposal id using a
    /// dummy target so the existing vote-with-reason tests remain focused on
    /// their specific behaviour without needing a real timelock or target.
    fn propose_dummy(env: &Env, client: &GovernorContractClient, proposer: &Address) -> u64 {
        let target = Address::generate(env);
        let fn_name = Symbol::new(env, "exec");
        let calldata = Bytes::new(env);
        let description = String::from_str(env, "Test proposal");

        // Compute SHA-256 hash of the description
        let description_hash = env.crypto().sha256(&Bytes::from_slice(env, b"Test proposal")).into();

        // Dummy metadata URI (could be ipfs or https)
        let metadata_uri = String::from_str(env, "https://example.com/proposal/1");

        // Create Vec with single target, fn_name, and calldata
        let mut targets = soroban_sdk::Vec::new(env);
        targets.push_back(target);

        let mut fn_names = soroban_sdk::Vec::new(env);
        fn_names.push_back(fn_name);

        let mut calldatas = soroban_sdk::Vec::new(env);
        calldatas.push_back(calldata);

        client.propose(
            proposer,
            &description,
            &description_hash,
            &metadata_uri,
            &targets,
            &fn_names,
            &calldatas,
        )
    }

    #[test]
    fn test_cast_vote_with_reason_stores_reason() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let guardian = Address::generate(&env);
        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &1000, &guardian, &VoteType::Extended, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        let reason = String::from_str(&env, "I support this because it improves governance");
        client.cast_vote_with_reason(&voter, &proposal_id, &VoteSupport::For, &reason);

        let stored_reason = client.get_vote_reason(&proposal_id, &voter);
        assert_eq!(stored_reason, Some(reason));
    }

    #[test]
    fn test_cast_vote_with_reason_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let guardian = Address::generate(&env);
        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &1000, &guardian, &VoteType::Extended, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        let reason = String::from_str(&env, "This aligns with our community values");
        client.cast_vote_with_reason(&voter, &proposal_id, &VoteSupport::For, &reason);

        let events = env.events().all();
        
        let has_vote_rsn = events.iter().any(|(_, topics, _)| {
            topics.len() >= 1 && {
                let first: Result<soroban_sdk::Symbol, _> =
                    topics.get(0).unwrap().try_into_val(&env);
                first.is_ok() && first.unwrap() == symbol_short!("vote_rsn")
            }
        });

        assert!(has_vote_rsn, "VoteCastWithReason event not emitted");
    }

    #[test]
    fn test_cast_vote_with_reason_multiple_voters() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter1 = Address::generate(&env);
        let voter2 = Address::generate(&env);

        let guardian = Address::generate(&env);
        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &1000, &guardian, &VoteType::Extended, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        let reason1 = String::from_str(&env, "I agree with this proposal");
        let reason2 = String::from_str(&env, "I disagree with this proposal");

        client.cast_vote_with_reason(&voter1, &proposal_id, &VoteSupport::For, &reason1);
        client.cast_vote_with_reason(&voter2, &proposal_id, &VoteSupport::Against, &reason2);

        let stored_reason1 = client.get_vote_reason(&proposal_id, &voter1);
        let stored_reason2 = client.get_vote_reason(&proposal_id, &voter2);

        assert_eq!(stored_reason1, Some(reason1));
        assert_eq!(stored_reason2, Some(reason2));
    }

    #[test]
    fn test_quorum_and_state() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        // Deploy a real SEP-41 token and TokenVotes contract so the voter
        // has actual snapshot voting power for the cross-contract lookup.
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let sac_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_addr);

        let votes_id = env.register(sorogov_token_votes::TokenVotesContract, ());
        let votes_client = sorogov_token_votes::TokenVotesContractClient::new(&env, &votes_id);
        votes_client.initialize(&admin, &token_addr);

        // Mint tokens and self-delegate so the voter has snapshot voting power.
        sac_client.mint(&voter, &1000_i128);
        votes_client.delegate(&voter, &voter);

        // Initialize governor with 50% quorum (50 / 100).
        let guardian = Address::generate(&env);
        client.initialize(&admin, &votes_id, &timelock, &0, &100, &50, &0, &guardian, &VoteType::Extended, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance ledger to start voting.
        env.ledger().with_mut(|li| li.sequence_number += 1);

        // cast_vote now looks up snapshot voting power from token-votes.
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        // Advance ledger to end voting.
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Quorum is 0 (total supply at start_ledger=0 is 1000, 50% = 500,
        // but start_ledger checkpoint may be 0 depending on delegation timing).
        // With 1000 votes For, the proposal succeeds regardless.
        assert_eq!(client.state(&proposal_id), ProposalState::Succeeded);
    }

    #[test]
    fn test_propose_with_multiple_targets() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);

        // Set threshold to 100
        let guardian = Address::generate(&env);
        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &100, &guardian, &VoteType::Extended, &120_960);

        // Create proposal with multiple targets
        let target1 = Address::generate(&env);
        let target2 = Address::generate(&env);
        let fn_name1 = Symbol::new(&env, "action1");
        let fn_name2 = Symbol::new(&env, "action2");
        let calldata1 = Bytes::from_slice(&env, &[1, 2, 3]);
        let calldata2 = Bytes::from_slice(&env, &[4, 5, 6]);
        let description = String::from_str(&env, "Multi-target proposal");

        let mut targets = soroban_sdk::Vec::new(&env);
        targets.push_back(target1.clone());
        targets.push_back(target2.clone());

        let mut fn_names = soroban_sdk::Vec::new(&env);
        fn_names.push_back(fn_name1.clone());
        fn_names.push_back(fn_name2.clone());

        let mut calldatas = soroban_sdk::Vec::new(&env);
        calldatas.push_back(calldata1.clone());
        calldatas.push_back(calldata2.clone());

        let description_hash = env.crypto().sha256(&Bytes::from_slice(&env, b"Multi-target proposal")).into();
        let metadata_uri = String::from_str(&env, "ipfs://QmMulti");

        let proposal_id = client.propose(&proposer, &description, &description_hash, &metadata_uri, &targets, &fn_names, &calldatas);

        // Verify proposal was created
        assert_eq!(proposal_id, 1);
        assert_eq!(client.proposal_count(), 1);
    }

    #[test]
    #[should_panic(expected = "targets, fn_names, and calldatas length mismatch")]
    fn test_propose_rejects_mismatched_lengths() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);

        let guardian = Address::generate(&env);
        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &100, &guardian, &VoteType::Extended, &120_960);

        let target = Address::generate(&env);
        let fn_name = Symbol::new(&env, "exec");
        let calldata1 = Bytes::new(&env);
        let calldata2 = Bytes::new(&env);
        let description = String::from_str(&env, "Mismatched proposal");

        let mut targets = soroban_sdk::Vec::new(&env);
        targets.push_back(target);

        let mut fn_names = soroban_sdk::Vec::new(&env);
        fn_names.push_back(fn_name);

        let mut calldatas = soroban_sdk::Vec::new(&env);
        calldatas.push_back(calldata1);
        calldatas.push_back(calldata2); // Extra calldata

        let description_hash = env.crypto().sha256(&Bytes::from_slice(&env, b"Mismatched proposal")).into();
        let metadata_uri = String::from_str(&env, "ipfs://QmMismatch");

        // Should panic with "targets, fn_names, and calldatas length mismatch"
        client.propose(&proposer, &description, &description_hash, &metadata_uri, &targets, &fn_names, &calldatas);
    }

    #[test]
    #[should_panic(expected = "must have at least one target")]
    fn test_propose_rejects_empty_targets() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);

        let guardian = Address::generate(&env);
        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &100, &guardian, &VoteType::Extended, &120_960);

        let description = String::from_str(&env, "Empty proposal");
        let targets = soroban_sdk::Vec::new(&env);
        let fn_names = soroban_sdk::Vec::new(&env);
        let calldatas = soroban_sdk::Vec::new(&env);

        let description_hash = env.crypto().sha256(&Bytes::from_slice(&env, b"Empty proposal")).into();
        let metadata_uri = String::from_str(&env, "ipfs://QmEmpty");

        // Should panic with "must have at least one target"
        client.propose(&proposer, &description, &description_hash, &metadata_uri, &targets, &fn_names, &calldatas);
    }

    /// Mock oracle contract that returns a fixed price for dynamic quorum tests.
    #[contract]
    pub struct MockOracleContract;

    #[contractimpl]
    impl MockOracleContract {
        pub fn lastprice(_env: Env, _asset: Address) -> Option<i128> {
            Some(5_000_000) // $5.00 in 6-decimal format
        }
    }

    #[test]
    fn test_cancel_proposer_pending() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);

        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &1000, &guardian, &VoteType::Extended, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Proposer should be able to cancel pending proposal
        client.cancel(&proposer, &proposal_id);
        assert_eq!(client.state(&proposal_id), ProposalState::Cancelled);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_cancel_proposer_active_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);

        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &1000, &guardian, &VoteType::Extended, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Proposer should not be able to cancel active proposal
        client.cancel(&proposer, &proposal_id);
    }

    #[test]
    fn test_cancel_guardian_active() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);

        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &1000, &guardian, &VoteType::Extended, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Guardian should be able to cancel active proposal
        client.cancel(&guardian, &proposal_id);
        assert_eq!(client.state(&proposal_id), ProposalState::Cancelled);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_cancel_guardian_pending_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);

        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &1000, &guardian, &VoteType::Extended, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Guardian should not be able to cancel pending proposal
        client.cancel(&guardian, &proposal_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_vote_type_simple_rejects_abstain() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &1000, &guardian, &VoteType::Simple, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Should panic with InvalidSupport when trying to abstain in Simple mode
        client.cast_vote(&voter, &proposal_id, &VoteSupport::Abstain);
    }

    #[test]
    fn test_vote_type_quadratic_weighting() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &1000, &guardian, &VoteType::Quadratic, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Cast vote - raw weight is 1_000_000, quadratic should be sqrt(1_000_000) = 1000
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        let (votes_for, _, _) = client.proposal_votes(&proposal_id);
        assert_eq!(votes_for, 1000); // Quadratic weighting applied
    }

    #[test]
    fn test_proposal_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(&admin, &votes_token_id, &timelock, &0, &100, &0, &0, &guardian, &VoteType::Extended, &100); // Short grace period

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 1);

        // Vote to make it succeed
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        // Advance past voting period
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Should be Succeeded initially
        assert_eq!(client.state(&proposal_id), ProposalState::Succeeded);

        // Advance past grace period
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Should now be Expired
        assert_eq!(client.state(&proposal_id), ProposalState::Expired);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_queue_expired_proposal_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(&admin, &votes_token_id, &timelock, &0, &100, &0, &0, &guardian, &VoteType::Extended, &100); // Short grace period

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 1);

        // Vote to make it succeed
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        // Advance past voting period and grace period
        env.ledger().with_mut(|li| li.sequence_number += 201);

        // Should be Expired
        assert_eq!(client.state(&proposal_id), ProposalState::Expired);

        // Should panic when trying to queue expired proposal
        client.queue(&proposal_id);
    }

    #[test]
    fn test_multi_token_weighted_voting() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        // Register two mock token contracts.
        let token_a_id = env.register(MockVotesContract, ());
        let token_b_id = env.register(MockVotesContract, ());

        // Initialize governor with a single-token strategy first (standard init).
        client.initialize(&admin, &token_a_id, &timelock, &100, &1000, &0, &0, &guardian, &VoteType::Extended, &120_960);

        // Build MultiToken strategy: token_a at 1x (10000 bps), token_b at 2x (20000 bps).
        let mut weighted_tokens = soroban_sdk::Vec::new(&env);
        weighted_tokens.push_back(WeightedToken {
            token: token_a_id.clone(),
            weight_bps: 10_000,
        });
        weighted_tokens.push_back(WeightedToken {
            token: token_b_id.clone(),
            weight_bps: 20_000,
        });
        client.set_voting_strategy(&VotingStrategy::MultiToken(weighted_tokens));

        // Verify strategy is stored correctly.
        let stored = client.voting_strategy();
        assert!(
            matches!(stored, VotingStrategy::MultiToken(_)),
            "strategy should be MultiToken"
        );

        // Create a proposal.
        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance ledger into the voting window.
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Cast vote — each MockVotesContract returns 1_000_000 for get_past_votes.
        // Expected weight: 1_000_000 * 10000/10000 + 1_000_000 * 20000/10000 = 3_000_000
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        let (votes_for, _, _) = client.proposal_votes(&proposal_id);
        assert_eq!(votes_for, 3_000_000, "weighted votes should total 3_000_000");
    }

    #[test]
    fn test_dynamic_quorum_with_oracle() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);

        // 10% static quorum: supply=10_000_000, so static = 1_000_000.
        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &10, &0, &guardian, &VoteType::Extended, &120_960);

        // Create a proposal to get a proposal_id.
        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Without dynamic quorum, quorum == 10% of 10_000_000 = 1_000_000.
        let static_q = client.quorum(&proposal_id);
        assert_eq!(static_q, 1_000_000, "static quorum should be 1_000_000");

        // Register the mock oracle ($5.00 per token, 6-decimal format).
        let oracle_id = env.register(MockOracleContract, ());

        // Enable dynamic quorum: min_quorum_usd = 20_000_000 ($20 in 6-decimal),
        // price = 5_000_000 ($5), so usd_quorum = 20_000_000 / 5_000_000 = 4.
        // usd_quorum (4) < static_quorum (1_000_000), so static wins.
        client.update_oracle(&Some(oracle_id.clone()), &20_000_000_i128, &true);
        let dynamic_q = client.quorum(&proposal_id);
        assert_eq!(
            dynamic_q, 1_000_000,
            "dynamic quorum should equal static when static is larger"
        );

        // Now set a very high USD floor that translates to more tokens than static quorum.
        // usd_quorum = min_quorum_usd / price = 10_000_000_000_000 / 5_000_000 = 2_000_000.
        // 2_000_000 > static_quorum (1_000_000), so dynamic wins.
        client.update_oracle(&Some(oracle_id.clone()), &10_000_000_000_000_i128, &true);
        let high_dynamic_q = client.quorum(&proposal_id);
        assert_eq!(
            high_dynamic_q, 2_000_000,
            "dynamic quorum should use USD floor when larger than static"
        );

        // Test fallback: disable dynamic quorum and verify static quorum is used.
        client.update_oracle(&Some(oracle_id.clone()), &10_000_000_000_000_i128, &false);
        let fallback_q = client.quorum(&proposal_id);
        assert_eq!(
            fallback_q, 1_000_000,
            "should fall back to static quorum when dynamic is disabled"
        );
    }

    #[test]
    fn test_get_receipt_returns_voting_details() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &1000, &guardian, &VoteType::Extended, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Before voting, receipt should show has_voted = false
        let receipt_before = client.get_receipt(&proposal_id, &voter);
        assert!(!receipt_before.has_voted);
        assert_eq!(receipt_before.weight, 0);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Cast vote with reason
        let reason = String::from_str(&env, "I support this proposal");
        client.cast_vote_with_reason(&voter, &proposal_id, &VoteSupport::For, &reason);

        // After voting, receipt should contain all details
        let receipt_after = client.get_receipt(&proposal_id, &voter);
        assert!(receipt_after.has_voted);
        assert_eq!(receipt_after.support, VoteSupport::For);
        assert_eq!(receipt_after.weight, 1_000_000); // MockVotesContract returns 1_000_000
        assert_eq!(receipt_after.reason, reason);
    }

    #[test]
    #[should_panic(expected = "already voted")]
    fn test_cannot_vote_twice() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(&admin, &votes_token_id, &timelock, &100, &1000, &50, &1000, &guardian, &VoteType::Extended, &120_960);

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Cast first vote
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        // Attempt to vote again should panic
        client.cast_vote(&voter, &proposal_id, &VoteSupport::Against);
    }
}

#[cfg(test)]
mod tests;

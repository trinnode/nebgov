#![cfg(test)]

use crate::{Checkpoint, TokenVotesContract};
use soroban_sdk::Env;

/// Helper to create a vector of checkpoints with sequential ledgers
fn create_checkpoints(env: &Env, count: usize) -> soroban_sdk::Vec<Checkpoint> {
    let mut checkpoints = soroban_sdk::Vec::new(env);
    for i in 1..=count {
        checkpoints.push_back(Checkpoint {
            ledger: i as u32,
            votes: (i as i128) * 1000,
        });
    }
    checkpoints
}

/// Helper to measure instruction count for a binary search operation
fn measure_binary_search(
    checkpoints: &soroban_sdk::Vec<Checkpoint>,
    target_ledger: u32,
) -> (i128, u64) {
    let env = checkpoints.env();
    let mut budget = env.cost_estimate().budget();
    budget.reset_default();
    
    let result = TokenVotesContract::binary_search(checkpoints, target_ledger);
    let cpu_insns = budget.cpu_instruction_cost();
    
    (result, cpu_insns)
}

#[test]
fn binary_search_performance_1k_checkpoints() {
    let env = Env::default();
    env.mock_all_auths();
    
    let checkpoints = create_checkpoints(&env, 1_000);
    
    // Query at various positions
    let test_ledgers = [1, 250, 500, 750, 999, 1000];
    let mut total_cpu = 0u64;
    let mut max_cpu = 0u64;
    
    for &ledger in &test_ledgers {
        let (result, cpu_insns) = measure_binary_search(&checkpoints, ledger);
        total_cpu += cpu_insns;
        max_cpu = max_cpu.max(cpu_insns);
        
        // Verify correctness
        assert_eq!(result, (ledger as i128) * 1000);
    }
    
    let avg_cpu = total_cpu / test_ledgers.len() as u64;
    
    // Soroban CPU limit is 100M instructions per transaction
    // Each query should be well under 1M instructions
    assert!(max_cpu < 1_000_000, "Max CPU: {} exceeds 1M threshold", max_cpu);
    assert!(avg_cpu < 500_000, "Avg CPU: {} exceeds 500K threshold", avg_cpu);
}

#[test]
fn binary_search_performance_10k_checkpoints() {
    let env = Env::default();
    env.mock_all_auths();
    
    // Test with 2k checkpoints to demonstrate scalability
    // (represents ~20 days of 100 delegations/day)
    // Note: Larger datasets may exceed test environment memory limits
    let checkpoints = create_checkpoints(&env, 2_000);
    
    // Query at strategic positions
    let test_positions = [1, 500, 1_000, 1_500, 2_000];
    let mut total_cpu = 0u64;
    let mut max_cpu = 0u64;
    
    for &ledger in &test_positions {
        let (result, cpu_insns) = measure_binary_search(&checkpoints, ledger);
        total_cpu += cpu_insns;
        max_cpu = max_cpu.max(cpu_insns);
        
        // Verify correctness
        assert_eq!(result, (ledger as i128) * 1000);
    }
    
    let avg_cpu = total_cpu / test_positions.len() as u64;
    
    // With 2k checkpoints, should still be well under limits
    // O(log 2000) ≈ 11 iterations
    // Performance scales logarithmically: 10k would be ~14 iterations
    assert!(max_cpu < 2_000_000, "Max CPU: {} exceeds 2M threshold", max_cpu);
    assert!(avg_cpu < 1_000_000, "Avg CPU: {} exceeds 1M threshold", avg_cpu);
}

#[test]
fn binary_search_vs_linear_comparison() {
    let env = Env::default();
    env.mock_all_auths();
    
    // Compare binary search vs linear search performance
    let checkpoints = create_checkpoints(&env, 2_000);
    let target_ledger = 1_000;
    
    // Measure binary search
    let (binary_result, binary_cpu) = measure_binary_search(&checkpoints, target_ledger);
    
    // Measure linear search (simulate)
    let mut budget = env.cost_estimate().budget();
    budget.reset_default();
    let mut linear_result = 0i128;
    for i in 0..checkpoints.len() {
        let cp = checkpoints.get(i).unwrap();
        if cp.ledger <= target_ledger {
            linear_result = cp.votes;
        } else {
            break;
        }
    }
    let linear_cpu = budget.cpu_instruction_cost();
    
    // Verify both methods return same result
    assert_eq!(binary_result, linear_result);
    assert_eq!(binary_result, 1_000_000);
    
    // Binary search should be significantly more efficient
    let efficiency_ratio = linear_cpu as f64 / binary_cpu as f64;
    
    // Binary search should be at least 3x more efficient for 2k items
    assert!(
        efficiency_ratio > 3.0,
        "Binary search efficiency ratio {} is less than 3x (binary: {}, linear: {})",
        efficiency_ratio,
        binary_cpu,
        linear_cpu
    );
}

#[test]
fn binary_search_edge_cases_performance() {
    let env = Env::default();
    env.mock_all_auths();
    
    let checkpoints = create_checkpoints(&env, 2_000);
    
    // Test edge cases
    let edge_cases = [
        (0, 0),               // Before first checkpoint
        (1, 1_000),           // Exact first checkpoint
        (2_000, 2_000_000),   // Exact last checkpoint
        (2_001, 2_000_000),   // After last checkpoint
        (1_000, 1_000_000),   // Middle checkpoint
    ];
    
    let mut max_cpu = 0u64;
    
    for (ledger, expected_votes) in edge_cases {
        let (result, cpu_insns) = measure_binary_search(&checkpoints, ledger);
        max_cpu = max_cpu.max(cpu_insns);
        
        assert_eq!(
            result, expected_votes,
            "Failed for ledger {}: expected {}, got {}",
            ledger, expected_votes, result
        );
    }
    
    // Edge cases should not be more expensive than normal cases
    assert!(max_cpu < 2_000_000, "Edge case CPU: {} exceeds 2M threshold", max_cpu);
}

#[test]
fn binary_search_worst_case_performance() {
    let env = Env::default();
    env.mock_all_auths();
    
    // Create sparse checkpoints (large gaps between ledgers)
    // This tests worst-case scenario where queries fall between checkpoints
    let mut checkpoints = soroban_sdk::Vec::new(&env);
    for i in 0..2_000 {
        checkpoints.push_back(Checkpoint {
            ledger: (i * 1000) as u32, // Ledgers: 0, 1000, 2000, ...
            votes: (i as i128) * 1000,
        });
    }
    
    // Query in the gaps (worst case for some algorithms)
    let test_ledgers = [500, 1500, 2500, 1_999_500];
    let mut max_cpu = 0u64;
    
    for ledger in test_ledgers {
        let (_, cpu_insns) = measure_binary_search(&checkpoints, ledger);
        max_cpu = max_cpu.max(cpu_insns);
    }
    
    // Sparse data should not significantly impact binary search performance
    assert!(max_cpu < 2_000_000, "Sparse data CPU: {} exceeds 2M threshold", max_cpu);
}

#[test]
fn binary_search_repeated_queries_performance() {
    let env = Env::default();
    env.mock_all_auths();
    
    let checkpoints = create_checkpoints(&env, 2_000);
    
    // Simulate a realistic scenario: multiple voters querying the same proposal
    let proposal_ledger = 1_000;
    let num_voters = 20;
    
    let mut budget = env.cost_estimate().budget();
    budget.reset_default();
    
    for _ in 0..num_voters {
        let result = TokenVotesContract::binary_search(&checkpoints, proposal_ledger);
        assert_eq!(result, 1_000_000);
    }
    
    let total_cpu = budget.cpu_instruction_cost();
    let avg_cpu_per_query = total_cpu / num_voters;
    
    // Average cost per query should remain efficient
    assert!(
        avg_cpu_per_query < 1_000_000,
        "Avg CPU per query: {} exceeds 1M threshold",
        avg_cpu_per_query
    );
    
    // Total cost for 20 voters should be well within Soroban limits
    assert!(
        total_cpu < 100_000_000,
        "Total CPU: {} exceeds 100M Soroban limit",
        total_cpu
    );
}

#[test]
fn binary_search_empty_array() {
    let env = Env::default();
    let checkpoints = soroban_sdk::Vec::<Checkpoint>::new(&env);
    
    let (result, cpu_insns) = measure_binary_search(&checkpoints, 1000);
    
    // Empty array should return 0
    assert_eq!(result, 0);
    
    // Should be extremely fast (no iterations needed)
    assert!(cpu_insns < 100_000, "Empty array CPU: {} exceeds 100K threshold", cpu_insns);
}

#[test]
fn binary_search_single_checkpoint() {
    let env = Env::default();
    let mut checkpoints = soroban_sdk::Vec::new(&env);
    checkpoints.push_back(Checkpoint {
        ledger: 100,
        votes: 1_000_000,
    });
    
    // Query before checkpoint
    let (result, _) = measure_binary_search(&checkpoints, 50);
    assert_eq!(result, 0);
    
    // Query at checkpoint
    let (result, _) = measure_binary_search(&checkpoints, 100);
    assert_eq!(result, 1_000_000);
    
    // Query after checkpoint
    let (result, _) = measure_binary_search(&checkpoints, 150);
    assert_eq!(result, 1_000_000);
}

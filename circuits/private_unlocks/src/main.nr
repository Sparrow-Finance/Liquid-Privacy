use poseidon::poseidon::bn254::hash_2;

// Simplified private unlock circuit
// Matches deposit structure - contract handles time locks
// Circuit proves: ownership + nullifier

// Secret data the user keeps local (matches deposit note)
struct NoteWitness {
    secret: Field,
    shares: Field,
    deposit_time: Field,
    blinding: Field,
}

fn hash_commitment(w: NoteWitness) -> Field {
    // Same structure as deposit circuit
    // hash(secret, shares) -> hash(h1, deposit_time) -> hash(h2, blinding)
    let h1 = hash_2([w.secret, w.shares]);
    let h2 = hash_2([h1, w.deposit_time]);
    hash_2([h2, w.blinding])
}

fn hash_nullifier(w: NoteWitness) -> Field {
    // Nullifier = hash(secret, blinding) - unique per commitment
    hash_2([w.secret, w.blinding])
}

// Main function: prove ownership and compute nullifier
fn main(
    witness: NoteWitness,
    commitment: pub Field,
    nullifier: pub Field,
    shares: pub Field,
) {
    // 1. Verify commitment matches
    let computed_commitment = hash_commitment(witness);
    assert(computed_commitment == commitment);
    
    // 2. Verify nullifier is correct
    let computed_nullifier = hash_nullifier(witness);
    assert(computed_nullifier == nullifier);
    
    // 3. Verify shares match
    assert(witness.shares == shares);
    assert(shares != 0);
}
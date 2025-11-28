use poseidon::poseidon::bn254::hash_2;

// Public Inputs the Contract will see
struct PublicInputs {
    pub commitment: Field,
    pub nullifier: Field,
    pub assets: Field,
    pub shares: Field,
    pub total_assets: Field,
    pub total_supply: Field,
    pub current_time: u64,
    pub unlock_period: u64, 
    pub merkle_root: Field,
    pub note_index: u64,
}

// Secret data the user keeps local
struct NoteWitness {
    secret: Field,
    amount: Field,
    shares: Field,
    unlock_time: u64,
    request_time: u64,
    blinding: Field,
    merkle_path: [Field; 32],
}

fn hash_note(w: NoteWitness) -> Field {
    // Chain hash_2 calls to hash multiple elements
    // First: hash(secret, shares)
    let h1 = hash_2([w.secret, w.shares]);
    // Second: hash(h1, unlock_time)
    let h2 = hash_2([h1, w.unlock_time as Field]);
    // Third: hash(h2, request_time)
    let h3 = hash_2([h2, w.request_time as Field]);
    // Fourth: hash(h3, blinding)
    hash_2([h3, w.blinding])
}

fn hash_nullifier(w: NoteWitness) -> Field {
    // Hash secret and shares
    hash_2([w.secret, w.shares])
}

// Main function: prove owner matches the public inputs
fn main(
    witness: NoteWitness,
    commitment: pub Field,
    nullifier: pub Field,
    assets: pub Field,
    shares: pub Field,
    total_assets: pub Field,
    total_supply: pub Field,
    current_time: pub u64,
    unlock_period: pub u64,
    merkle_root: pub Field,
    note_index: pub u64,
) {
    // 1. Verify commitment (doesn't include amount)
    let computed_commitment = hash_note(witness);
    assert(computed_commitment == commitment);
    
    // 2. Verify nullifier (doesn't include amount either!)
    let computed_nullifier = hash_nullifier(witness);
    assert(computed_nullifier == nullifier);
    
    // 3. Verify amount matches public
    assert(witness.amount == assets);
    assert(witness.amount != 0);
    
    // 4. Verify exchange rate (THIS is where amount is validated!)
    if total_supply == 0 {
        assert(witness.amount == witness.shares);
        assert(shares == witness.shares);
    } else {
        // This ensures: amount = shares * total_assets / total_supply
        assert(witness.shares * total_assets == witness.amount * total_supply);
        assert(shares == witness.shares);
    }
    
    // 5. Time lock verification
    // Must wait until unlock_time has passed
    assert(current_time >= witness.unlock_time);
    // No expiry - can claim anytime after unlock!
    assert(nullifier != 0);

    // 6. Merkle proof verification
    let mut hash = hash_note(witness);
    let mut index = note_index;

    for sibling in witness.merkle_path {
        let (left, right) = if index % 2 == 0 {
            (hash, sibling)
        } else {
            (sibling, hash)
        };
        // Hash left and right for Merkle tree
        hash = hash_2([left, right]);
        index /= 2;
    }
    assert(hash == merkle_root);
}
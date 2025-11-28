// Simplified test circuit - no Poseidon, no loops
// Just basic Field operations to test

struct NoteWitness {
    secret: Field,
    amount: Field,
}

fn main(
    witness: NoteWitness,
    commitment: pub Field,
    assets: pub Field,
) {
    // Simple assertions
    assert(witness.amount == assets);
    assert(witness.secret == commitment);
}

// Compute Merkle root for withdrawal circuit
// Run with: node compute_merkle_root.js

const { buildPoseidon } = require("circomlibjs");

const commitment = BigInt("20339104115118547286586937318237485210353468888768989052475348673873475147254");
const note_index = 0;
const merkle_path = Array(32).fill(BigInt(0));

async function computeMerkleRoot() {
    const poseidon = await buildPoseidon();
    
    let hash = commitment;
    let index = note_index;
    
    for (let i = 0; i < merkle_path.length; i++) {
        const sibling = merkle_path[i];
        const left = (index % 2 === 0) ? hash : sibling;
        const right = (index % 2 === 0) ? sibling : hash;
        
        hash = poseidon.F.toString(poseidon([left, right]));
        index = Math.floor(index / 2);
    }
    
    console.log("Merkle root:", hash);
    console.log(`\nUpdate Prover.toml: merkle_root = "${hash}"`);
}

computeMerkleRoot().catch(console.error);
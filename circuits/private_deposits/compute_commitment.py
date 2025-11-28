#!/usr/bin/env python3
"""
Compute the deposit commitment hash using Poseidon
This matches the hash_deposit_note function in the Noir circuit
"""

# You'll need: pip install poseidon-hash
try:
    from poseidon_hash import poseidon_hash
except ImportError:
    print("ERROR: poseidon_hash not installed")
    print("Install with: pip install poseidon-hash")
    exit(1)

# Values from Prover.toml
secret = 98765432109876543210
shares = 100000000000000000000
deposit_time = 1700000000
blinding = 12345678901234567890

print("Computing commitment with:")
print(f"  secret: {secret}")
print(f"  shares: {shares}")
print(f"  deposit_time: {deposit_time}")
print(f"  blinding: {blinding}")
print()

# Hash according to circuit logic:
# h1 = hash_2([secret, shares])
h1 = poseidon_hash(secret, shares)
print(f"h1 = hash_2([secret, shares]) = {h1}")

# h2 = hash_2([h1, deposit_time])
h2 = poseidon_hash(h1, deposit_time)
print(f"h2 = hash_2([h1, deposit_time]) = {h2}")

# commitment = hash_2([h2, blinding])
commitment = poseidon_hash(h2, blinding)
print(f"commitment = hash_2([h2, blinding]) = {commitment}")
print()
print(f"Use this in Prover.toml:")
print(f'commitment = "{commitment}"')

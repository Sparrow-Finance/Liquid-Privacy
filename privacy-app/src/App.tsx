import { useState, useEffect, useRef } from 'react'
import './App.css'
import { ProofState, ProofStateData } from './types'
import { Noir } from "@noir-lang/noir_js";
import { DebugFileMap } from "@noir-lang/types";
import { UltraHonkBackend } from "@aztec/bb.js";
import { flattenFieldsAsArray } from "./helpers/proof";
import { getHonkCallData, init } from 'garaga';
import { bytecode, abi } from "./assets/circuit.json";
import { bytecode as unlockBytecode, abi as unlockAbi } from "../../circuits/private_unlocks/target/private_unlocks.json";
import depositVkUrl from './assets/deposit_vk.bin?url';
import unlockVkUrl from './assets/unlock_vk.bin?url';
import { RpcProvider, Contract, hash as starknetHash } from 'starknet';
import { abi as verifierAbi } from "./assets/verifier.json";
import { connect } from '@starknet-io/get-starknet';
import initNoirC from "@noir-lang/noirc_abi";
import initACVM from "@noir-lang/acvm_js";
import acvm from "@noir-lang/acvm_js/web/acvm_js_bg.wasm?url";
import noirc from "@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm?url";
// @ts-ignore - no types for circomlibjs
import { buildPoseidon } from 'circomlibjs';

// Contract addresses
const SPSTRK_ADDRESS = '0x05efc624f4f0afb75bd6a57b35a0d2fb270c6eb0cea0e3f7dc36aefe9681e509';
const DEPOSIT_VERIFIER_ADDRESS = '0x039fbb068b510e5528eeea74a51c5ffa6e7c8278acddcf3f6ad628bd9d16c0d5';
const STRK_TOKEN_ADDRESS = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'; // Sepolia STRK

// Merkle indexer URL (for fetching Merkle paths for unlock proofs)
const INDEXER_URL = 'http://65.108.206.214:4000'; // TODO: Update to your server IP

// Minimal ABI for spSTRK contract
const spStrkAbi = [
  {
    "name": "mark_deposit_intent",
    "type": "function",
    "inputs": [{ "name": "amount", "type": "core::integer::u256" }],
    "outputs": [],
    "state_mutability": "external"
  },
  {
    "name": "create_private_commitment",
    "type": "function", 
    "inputs": [
      { "name": "proof", "type": "core::array::Span::<core::felt252>" },
      { "name": "commitment", "type": "core::integer::u256" },
      { "name": "amount", "type": "core::integer::u256" },
      { "name": "shares", "type": "core::integer::u256" }
    ],
    "outputs": [],
    "state_mutability": "external"
  },
  {
    "name": "claim_spSTRK",
    "type": "function",
    "inputs": [
      { "name": "proof", "type": "core::array::Span::<core::felt252>" },
      { "name": "nullifier", "type": "core::integer::u256" },
      { "name": "recipient", "type": "core::starknet::contract_address::ContractAddress" }
    ],
    "outputs": [],
    "state_mutability": "external"
  },
  {
    "name": "request_private_unlock",
    "type": "function",
    "inputs": [
      { "name": "proof", "type": "core::array::Span::<core::felt252>" },
      { "name": "nullifier_hash", "type": "core::integer::u256" }
    ],
    "outputs": [],
    "state_mutability": "external"
  },
  {
    "name": "complete_private_withdraw",
    "type": "function",
    "inputs": [
      { "name": "proof", "type": "core::array::Span::<core::felt252>" },
      { "name": "nullifier", "type": "core::integer::u256" },
      { "name": "recipient", "type": "core::starknet::contract_address::ContractAddress" }
    ],
    "outputs": [],
    "state_mutability": "external"
  },
  {
    "name": "private_deposit",
    "type": "function",
    "inputs": [
      { "name": "amount", "type": "core::integer::u256" },
      { "name": "commitment", "type": "core::integer::u256" }
    ],
    "outputs": [],
    "state_mutability": "external"
  }
];

// Minimal ERC20 ABI for approve
const erc20Abi = [
  {
    "name": "approve",
    "type": "function",
    "inputs": [
      { "name": "spender", "type": "core::starknet::contract_address::ContractAddress" },
      { "name": "amount", "type": "core::integer::u256" }
    ],
    "outputs": [{ "type": "core::bool" }],
    "state_mutability": "external"
  }
];

function App() {
  const [proofState, setProofState] = useState<ProofStateData>({
    state: ProofState.Initial
  });
  const [vk, setVk] = useState<Uint8Array | null>(null);
  const [unlockVk, setUnlockVk] = useState<Uint8Array | null>(null);
  
  // Wallet state
  const [wallet, setWallet] = useState<any>(null);
  const [walletAddress, setWalletAddress] = useState<string>('');
  
  // Deposit flow step (1 = mark intent, 2 = create commitment)
  const [depositStep, setDepositStep] = useState<number>(0);
  const [intentMarked, setIntentMarked] = useState<boolean>(false);
  
  // Deposit mode: 'single' (secure) or 'two-step' (experimental privacy)
  const [depositMode, setDepositMode] = useState<'single' | 'two-step'>('single');
  
  // Private inputs (witness)
  const [secret, setSecret] = useState<string>('');
  const [amount, setAmount] = useState<string>('1000000000000000000'); // 1 STRK default
  const [shares, setShares] = useState<string>('1000000000000000000'); // 1:1 initially
  const [blinding, setBlinding] = useState<string>('');
  
  // Computed commitment (will be calculated from inputs)
  const [commitment, setCommitment] = useState<string>('');
  const [totalAssets, _setTotalAssets] = useState<string>('0');
  const [totalSupply, _setTotalSupply] = useState<string>('0');
  const [depositTime, setDepositTime] = useState<string>('');
  
  // Use a ref to reliably track the current state across asynchronous operations
  const currentStateRef = useRef<ProofState>(ProofState.Initial);
  
  // Generated proof data (stored between steps)
  const [_generatedProof, setGeneratedProof] = useState<bigint[] | null>(null);
  
  // Withdraw flow state
  const [withdrawMode, setWithdrawMode] = useState<boolean>(false);
  const [withdrawSecret, setWithdrawSecret] = useState<string>('');
  const [withdrawShares, setWithdrawShares] = useState<string>('');
  const [withdrawBlinding, setWithdrawBlinding] = useState<string>('');
  const [withdrawRecipient, setWithdrawRecipient] = useState<string>('');

  // Initialize WASM on component mount
  useEffect(() => {
    const initWasm = async () => {
      try {
        // This might have already been initialized in main.tsx,
        // but we're adding it here as a fallback
        if (typeof window !== 'undefined') {
          await Promise.all([initACVM(fetch(acvm)), initNoirC(fetch(noirc))]);
          console.log('WASM initialization in App component complete');
        }
      } catch (error) {
        console.error('Failed to initialize WASM in App component:', error);
      }
    };

    const loadVk = async () => {
      const response = await fetch(depositVkUrl);
      const arrayBuffer = await response.arrayBuffer();
      const binaryData = new Uint8Array(arrayBuffer);
      setVk(binaryData);
      console.log('Loaded deposit verifying key:', binaryData);
    };

    const loadUnlockVk = async () => {
      const response = await fetch(unlockVkUrl);
      const arrayBuffer = await response.arrayBuffer();
      const binaryData = new Uint8Array(arrayBuffer);
      setUnlockVk(binaryData);
      console.log('Loaded unlock verifying key:', binaryData);
    };
    
    initWasm();
    loadVk();
    loadUnlockVk();
  }, []);

  const resetState = () => {
    currentStateRef.current = ProofState.Initial;
    setProofState({ 
      state: ProofState.Initial,
      error: undefined 
    });
  };

  const handleError = (error: unknown) => {
    console.error('Error:', error);
    let errorMessage: string;
    
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (error !== null && error !== undefined) {
      // Try to convert any non-Error object to a string
      try {
        errorMessage = String(error);
      } catch {
        errorMessage = 'Unknown error (non-stringifiable object)';
      }
    } else {
      errorMessage = 'Unknown error occurred';
    }
    
    // Use the ref to get the most recent state
    setProofState({
      state: currentStateRef.current,
      error: errorMessage
    });
  };

  const updateState = (newState: ProofState) => {
    currentStateRef.current = newState;
    setProofState({ state: newState, error: undefined });
  };

  // Generate random values for secret and blinding
  const generateRandomValues = () => {
    // Generate cryptographically secure random values
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    const randomSecret = BigInt('0x' + Array.from(array.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('')).toString();
    
    crypto.getRandomValues(array);
    const randomBlinding = BigInt('0x' + Array.from(array.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('')).toString();
    
    setSecret(randomSecret);
    setBlinding(randomBlinding);
    setDepositTime(Math.floor(Date.now() / 1000).toString());
  };

  // Compute commitment using Poseidon hash (matching Noir circuit structure)
  const computeCommitment = async () => {
    if (!secret || !blinding || !amount) {
      alert('Please generate secret and blinding first');
      return;
    }
    
    try {
      const time = depositTime || Math.floor(Date.now() / 1000).toString();
      setDepositTime(time);
      
      // Build Poseidon hasher (uses BN254 field like Noir)
      const poseidon = await buildPoseidon();
      
      // Match the Noir circuit structure:
      // h1 = hash_2([secret, shares])
      // h2 = hash_2([h1, deposit_time])
      // commitment = hash_2([h2, blinding])
      
      const secretBigInt = BigInt(secret);
      const sharesBigInt = BigInt(shares);
      const timeBigInt = BigInt(time);
      const blindingBigInt = BigInt(blinding);
      
      console.log('Computing Poseidon hash with chained structure:');
      console.log('secret:', secretBigInt);
      console.log('shares:', sharesBigInt);
      console.log('time:', timeBigInt);
      console.log('blinding:', blindingBigInt);
      
      // Step 1: h1 = poseidon([secret, shares])
      const h1 = poseidon([secretBigInt, sharesBigInt]);
      const h1BigInt = BigInt(poseidon.F.toString(h1));
      console.log('h1 (secret, shares):', h1BigInt);
      
      // Step 2: h2 = poseidon([h1, deposit_time])
      const h2 = poseidon([h1BigInt, timeBigInt]);
      const h2BigInt = BigInt(poseidon.F.toString(h2));
      console.log('h2 (h1, time):', h2BigInt);
      
      // Step 3: commitment = poseidon([h2, blinding])
      const commitmentHash = poseidon([h2BigInt, blindingBigInt]);
      const commitmentStr = poseidon.F.toString(commitmentHash);
      
      console.log('Computed commitment:', commitmentStr);
      setCommitment(commitmentStr);
      
      alert(`Commitment computed!\n\n⚠️ SAVE YOUR NOTE before depositing!\n\nNow click "Private Deposit" to complete.`);
      
    } catch (error) {
      console.error('Error computing commitment:', error);
      alert('Error computing commitment: ' + (error as Error).message);
    }
  };

  // Generate note string for user to save
  const generateNote = (): string => {
    const time = depositTime || Math.floor(Date.now() / 1000).toString();
    return `sparrow:${amount}:${secret}:${blinding}:${time}:${shares}:${commitment}`;
  };

  // Fetch Merkle path from indexer for unlock proofs
  const fetchMerklePath = async (commitment: string): Promise<{leaf_index: number, siblings: string[], root: string}> => {
    const response = await fetch(`${INDEXER_URL}/path/commitment/${commitment}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`Failed to fetch Merkle path: ${error.error || response.statusText}`);
    }
    return response.json();
  };

  // Parse note string
  const parseNote = (note: string) => {
    const parts = note.split(':');
    if (parts[0] !== 'sparrow' || parts.length < 5) {
      alert('Invalid note format');
      return;
    }
    setAmount(parts[1]);
    setSecret(parts[2]);
    setBlinding(parts[3]);
    setDepositTime(parts[4]);
    if (parts[5]) setShares(parts[5]);
    if (parts[6]) setCommitment(parts[6]);
  };

  // Download note as file
  const downloadNote = () => {
    if (!secret || !blinding) {
      alert('Please generate secret and blinding first');
      return;
    }
    const note = generateNote();
    const blob = new Blob([note], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sparrow-deposit-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Copy note to clipboard
  const copyNote = () => {
    if (!secret || !blinding) {
      alert('Please generate secret and blinding first');
      return;
    }
    const note = generateNote();
    navigator.clipboard.writeText(note);
    alert('Note copied to clipboard!\n\n⚠️ SAVE THIS SECURELY - You need it to withdraw!\n\n' + note);
  };

  // Connect wallet
  const connectWallet = async () => {
    try {
      const starknet = await connect() as any;
      if (starknet) {
        await starknet.enable();
        setWallet(starknet);
        const address = starknet.account?.address || starknet.selectedAddress || '';
        setWalletAddress(address);
        console.log('Wallet connected:', address);
      }
    } catch (error) {
      handleError(error);
    }
  };

  // Step 1: Mark deposit intent (transfers STRK to contract)
  const markDepositIntent = async () => {
    if (!wallet) {
      alert('Please connect wallet first');
      return;
    }
    
    try {
      updateState(ProofState.ConnectingWallet);
      
      const strkToken = new Contract({ abi: erc20Abi, address: STRK_TOKEN_ADDRESS, providerOrAccount: wallet.account });
      const spStrkContract = new Contract({ abi: spStrkAbi, address: SPSTRK_ADDRESS, providerOrAccount: wallet.account });
      
      // Approve STRK spend
      updateState(ProofState.SendingTransaction);
      console.log('Approving STRK spend...');
      const approveTx = await strkToken.approve(SPSTRK_ADDRESS, { low: amount, high: '0' });
      await wallet.account.waitForTransaction(approveTx.transaction_hash);
      console.log('Approval confirmed');
      
      // Mark deposit intent
      console.log('Marking deposit intent...');
      const intentTx = await spStrkContract.mark_deposit_intent({ low: amount, high: '0' });
      await wallet.account.waitForTransaction(intentTx.transaction_hash);
      console.log('Deposit intent marked!');
      
      setIntentMarked(true);
      setDepositStep(1);
      setDepositTime(Math.floor(Date.now() / 1000).toString());
      
      alert('Step 1 complete! STRK transferred. Now generate proof and create commitment.');
      resetState();
    } catch (error) {
      handleError(error);
    }
  };

  // Single-step private deposit (RECOMMENDED - no front-running risk)
  const privateDeposit = async () => {
    if (!wallet) {
      alert('Please connect wallet first');
      return;
    }
    if (!secret || !blinding) {
      alert('Please generate secret and blinding first');
      return;
    }
    if (!commitment) {
      alert('Please compute commitment first');
      return;
    }
    
    try {
      updateState(ProofState.ConnectingWallet);
      
      const strkToken = new Contract({ abi: erc20Abi, address: STRK_TOKEN_ADDRESS, providerOrAccount: wallet.account });
      const spStrkContract = new Contract({ abi: spStrkAbi, address: SPSTRK_ADDRESS, providerOrAccount: wallet.account });
      
      // Helper to split BigInt into u256 (low, high)
      const toU256 = (value: string) => {
        const bigVal = BigInt(value);
        const low = bigVal % (2n ** 128n);
        const high = bigVal / (2n ** 128n);
        return { low: low.toString(), high: high.toString() };
      };
      
      // Approve STRK spend
      updateState(ProofState.SendingTransaction);
      console.log('Approving STRK spend...');
      const approveTx = await strkToken.approve(SPSTRK_ADDRESS, toU256(amount));
      await wallet.account.waitForTransaction(approveTx.transaction_hash);
      console.log('Approval confirmed');
      
      // Single-step deposit (no proof needed!)
      console.log('Calling private_deposit...');
      console.log('Amount:', toU256(amount));
      console.log('Commitment:', toU256(commitment));
      
      const depositTx = await spStrkContract.private_deposit(
        toU256(amount),
        toU256(commitment)
      );
      await wallet.account.waitForTransaction(depositTx.transaction_hash);
      console.log('Private deposit complete!');
      
      setDepositStep(2);
      updateState(ProofState.ProofVerified);
      
      alert('Success! Private deposit complete.\n\n⚠️ SAVE YOUR NOTE - You need it to withdraw!\n\nClick "Copy Note" or "Download Note" now.');
    } catch (error) {
      handleError(error);
    }
  };

  // Step 2: Generate proof and create private commitment (LEGACY - two-step flow)
  const createPrivateCommitment = async () => {
    if (!wallet) {
      alert('Please connect wallet first');
      return;
    }
    if (!intentMarked) {
      alert('Please mark deposit intent first (Step 1)');
      return;
    }
    
    try {
      // Generate proof
      updateState(ProofState.GeneratingWitness);
      
      // IMPORTANT: Use the SAME timestamp that was used to compute the commitment!
      // The circuit asserts: witness.deposit_time == current_time
      const proofTime = depositTime || Math.floor(Date.now() / 1000).toString();
      
      const input = {
        witness: {
          secret: secret,
          amount: amount,
          shares: shares,
          deposit_time: proofTime,
          blinding: blinding
        },
        commitment: commitment,
        shares: shares,
        amount: amount,
        total_assets: totalAssets,
        total_supply: totalSupply,
        current_time: proofTime  // Must match deposit_time!
      };
      console.log('Circuit input:', input);
      
      let noir = new Noir({ bytecode, abi: abi as any, debug_symbols: '', file_map: {} as DebugFileMap });
      let execResult = await noir.execute(input);
      console.log('Witness generated:', execResult);
      
      updateState(ProofState.GeneratingProof);
      let honk = new UltraHonkBackend(bytecode, { threads: 1 });
      let proof = await honk.generateProof(execResult.witness, { starknet: true });
      honk.destroy();
      console.log('Proof generated:', proof);
      
      updateState(ProofState.PreparingCalldata);
      await init();
      const callData = getHonkCallData(
        proof.proof,
        flattenFieldsAsArray(proof.publicInputs),
        vk as Uint8Array,
        1
      );
      console.log('Calldata prepared, length:', callData.length);
      setGeneratedProof(callData);
      
      // Send to contract
      updateState(ProofState.SendingTransaction);
      const spStrkContract = new Contract({ abi: spStrkAbi, address: SPSTRK_ADDRESS, providerOrAccount: wallet.account });
      
      // Convert calldata for contract call (remove length prefix, convert to felt252 array)
      const proofData = callData.slice(1).map(n => '0x' + n.toString(16));
      
      // Helper to split BigInt into u256 (low, high) - each 128 bits
      const toU256 = (value: string) => {
        const bigVal = BigInt(value);
        const low = bigVal % (2n ** 128n);
        const high = bigVal / (2n ** 128n);
        return { low: low.toString(), high: high.toString() };
      };
      
      // Test verifier directly before calling contract
      console.log('Testing verifier directly...');
      const testProvider = new RpcProvider({ nodeUrl: 'https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_8/LOIuv6FM2_iaC8ZCb1Omu' });
      const testVerifier = new Contract({ abi: verifierAbi, address: DEPOSIT_VERIFIER_ADDRESS, providerOrAccount: testProvider });
      try {
        const testResult = await testVerifier.verify_ultra_starknet_honk_proof(proofData);
        console.log('Verifier result:', testResult);
      } catch (e) {
        console.log('Verifier error:', e);
      }
      
      console.log('Calling create_private_commitment...');
      console.log('Commitment u256:', toU256(commitment));
      console.log('Amount u256:', toU256(amount));
      console.log('Shares u256:', toU256(shares));
      
      const tx = await spStrkContract.create_private_commitment(
        proofData,
        toU256(commitment),
        toU256(amount),
        toU256(shares)
      );
      await wallet.account.waitForTransaction(tx.transaction_hash);
      
      console.log('Private commitment created!');
      updateState(ProofState.ProofVerified);
      setDepositStep(2);
      
      alert('Success! Private deposit complete. Your commitment is stored on-chain.');
    } catch (error) {
      handleError(error);
    }
  };

  // Test verification only (no wallet needed)
  const testVerification = async () => {
    try {
      updateState(ProofState.GeneratingWitness);
      
      // Use test values
      const testTime = '1700000000';
      const testCommitment = '9957662587905725615748918040227477895405062759336297902018093777162112651173';
      const testSecret = '98765432109876543210';
      const testBlinding = '12345678901234567890';
      const testAmount = '100000000000000000000';
      
      const input = {
        witness: {
          secret: testSecret,
          amount: testAmount,
          shares: testAmount,
          deposit_time: testTime,
          blinding: testBlinding
        },
        commitment: testCommitment,
        shares: testAmount,
        amount: testAmount,
        total_assets: '0',
        total_supply: '0',
        current_time: testTime
      };
      
      let noir = new Noir({ bytecode, abi: abi as any, debug_symbols: '', file_map: {} as DebugFileMap });
      let execResult = await noir.execute(input);
      
      updateState(ProofState.GeneratingProof);
      let honk = new UltraHonkBackend(bytecode, { threads: 1 });
      let proof = await honk.generateProof(execResult.witness, { starknet: true });
      honk.destroy();
      
      updateState(ProofState.PreparingCalldata);
      await init();
      const callData = getHonkCallData(
        proof.proof,
        flattenFieldsAsArray(proof.publicInputs),
        vk as Uint8Array,
        1
      );
      
      updateState(ProofState.SendingTransaction);
      const provider = new RpcProvider({ nodeUrl: 'https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_7/LOIuv6FM2_iaC8ZCb1Omu' });
      const verifierContract = new Contract({ abi: verifierAbi, address: DEPOSIT_VERIFIER_ADDRESS, providerOrAccount: provider });
      
      const res = await verifierContract.verify_ultra_starknet_honk_proof(callData.slice(1));
      console.log('Verification result:', res);
      
      updateState(ProofState.ProofVerified);
    } catch (error) {
      handleError(error);
    }
  };

  // Claim spSTRK - exit privacy for liquidity
  const claimSpSTRK = async () => {
    if (!wallet || !withdrawSecret || !withdrawShares || !unlockVk) {
      alert('Please paste your note and connect wallet');
      return;
    }

    try {
      updateState(ProofState.GeneratingWitness);

      // Use UNLOCK circuit for claim (proves ownership + computes nullifier)
      const poseidon = await buildPoseidon();
      const F = poseidon.F;

      // Debug: log all note components
      console.log('=== CLAIM spSTRK NOTE DEBUG ===');
      console.log('withdrawSecret:', withdrawSecret);
      console.log('withdrawShares:', withdrawShares);
      console.log('depositTime:', depositTime);
      console.log('withdrawBlinding:', withdrawBlinding);

      // Compute commitment from note data (same as deposit)
      const h1 = poseidon([BigInt(withdrawSecret), BigInt(withdrawShares)]);
      const h2 = poseidon([h1, BigInt(depositTime)]);
      const computedCommitment = poseidon([h2, BigInt(withdrawBlinding)]);

      // Compute nullifier = hash(secret, blinding)
      const nullifier = poseidon([BigInt(withdrawSecret), BigInt(withdrawBlinding)]);

      const commitmentStr = F.toString(computedCommitment);
      const nullifierStr = F.toString(nullifier);
      
      console.log('h1 (hash of secret,shares):', F.toString(h1));
      console.log('h2 (hash of h1,time):', F.toString(h2));
      console.log('Computed commitment:', commitmentStr);
      console.log('Computed nullifier:', nullifierStr);

      // Fetch Merkle path from indexer
      console.log('Fetching Merkle path from indexer...');
      const merklePath = await fetchMerklePath(commitmentStr);
      console.log('Merkle path:', merklePath);

      // Generate proof using UNLOCK circuit with Merkle proof
      // NEW: commitment is computed privately inside circuit
      const input = {
        witness: {
          secret: withdrawSecret,
          shares: withdrawShares,
          deposit_time: depositTime,
          blinding: withdrawBlinding
        },
        leaf_index: merklePath.leaf_index,
        siblings: merklePath.siblings,
        // Public inputs only
        nullifier: nullifierStr,
        shares: withdrawShares,
        root: merklePath.root
      };

      console.log('Unlock circuit input:', input);

      updateState(ProofState.GeneratingProof);
      let noir = new Noir({ bytecode: unlockBytecode, abi: unlockAbi as any, debug_symbols: '', file_map: {} as DebugFileMap });
      let execResult = await noir.execute(input);
      
      updateState(ProofState.PreparingCalldata);
      const honk = new UltraHonkBackend(unlockBytecode);
      const proof = await honk.generateProof(execResult.witness, { starknet: true });
      honk.destroy();
      
      await init();
      
      // Debug: Log public inputs from the proof
      console.log('Proof public inputs:', proof.publicInputs);
      const flatInputs = flattenFieldsAsArray(proof.publicInputs);
      console.log('Flattened public inputs:', flatInputs);
      
      const callData = getHonkCallData(
        proof.proof,
        flatInputs,
        unlockVk as Uint8Array,
        1
      );

      // Send to contract
      updateState(ProofState.SendingTransaction);
      const spStrkContract = new Contract({ abi: spStrkAbi, address: SPSTRK_ADDRESS, providerOrAccount: wallet.account });

      const proofData = callData.slice(1).map(n => '0x' + n.toString(16));
      const toU256 = (value: string) => {
        const bigVal = BigInt(value);
        const low = bigVal % (2n ** 128n);
        const high = bigVal / (2n ** 128n);
        return { low: low.toString(), high: high.toString() };
      };

      const recipient = withdrawRecipient || walletAddress;
      // TRUE PRIVACY: Only nullifier is passed, commitment stays hidden!
      console.log('Calling claim_spSTRK to:', recipient);
      const tx = await spStrkContract.claim_spSTRK(
        proofData,
        toU256(nullifierStr),
        recipient
      );
      await wallet.account.waitForTransaction(tx.transaction_hash);

      console.log('spSTRK claimed successfully!');
      updateState(ProofState.ProofVerified);

      alert(`Success! ${withdrawShares} spSTRK tokens sent to ${recipient}`);
    } catch (error) {
      handleError(error);
    }
  };

  // Request private unlock - starts 60s timer to get STRK back
  const requestPrivateUnlock = async () => {
    if (!wallet || !withdrawSecret || !withdrawShares || !unlockVk) {
      alert('Please paste your note and connect wallet');
      return;
    }

    try {
      updateState(ProofState.GeneratingWitness);

      const poseidon = await buildPoseidon();
      const F = poseidon.F;

      // Compute commitment from note data (used for Merkle path lookup)
      const h1 = poseidon([BigInt(withdrawSecret), BigInt(withdrawShares)]);
      const h2 = poseidon([h1, BigInt(depositTime)]);
      const computedCommitment = poseidon([h2, BigInt(withdrawBlinding)]);

      // Compute nullifier and nullifier_hash
      const nullifier = poseidon([BigInt(withdrawSecret), BigInt(withdrawBlinding)]);
      const nullifierBigInt = BigInt(F.toString(nullifier));
      
      // nullifier_hash uses STARKNET Pedersen (not Poseidon!)
      // Contract computes: pedersen(nullifier.low, nullifier.high)
      const nullifierLow = nullifierBigInt & ((1n << 128n) - 1n);
      const nullifierHigh = nullifierBigInt >> 128n;
      console.log('=== NULLIFIER HASH DEBUG ===');
      console.log('nullifierBigInt:', nullifierBigInt.toString());
      console.log('nullifierLow:', nullifierLow.toString());
      console.log('nullifierHigh:', nullifierHigh.toString());
      const nullifierHashFelt = starknetHash.computePedersenHash(nullifierLow.toString(), nullifierHigh.toString());
      console.log('nullifierHashFelt:', nullifierHashFelt);

      const commitmentStr = F.toString(computedCommitment);
      const nullifierStr = F.toString(nullifier);
      const nullifierHashStr = nullifierHashFelt;
      
      console.log('Request unlock - Nullifier hash:', nullifierHashStr);
      console.log('Frontend computed commitment:', commitmentStr);

      // Fetch Merkle path from indexer
      console.log('Fetching Merkle path from indexer...');
      const merklePath = await fetchMerklePath(commitmentStr);
      console.log('Merkle path:', merklePath);
      console.log('Siblings length:', merklePath.siblings?.length);
      console.log('First 3 siblings:', merklePath.siblings?.slice(0, 3));
      console.log('Root from indexer:', merklePath.root);

      // Generate proof using UNLOCK circuit with Merkle proof
      // NEW: commitment is computed privately inside circuit
      const input = {
        witness: {
          secret: withdrawSecret,
          shares: withdrawShares,
          deposit_time: depositTime,
          blinding: withdrawBlinding
        },
        leaf_index: merklePath.leaf_index,
        siblings: merklePath.siblings,
        // Public inputs only
        nullifier: nullifierStr,
        shares: withdrawShares,
        root: merklePath.root
      };

      // DEBUG: Log exact circuit inputs
      console.log('=== CIRCUIT PUBLIC INPUTS ===');
      console.log('nullifier:', nullifierStr);
      console.log('shares:', withdrawShares);
      console.log('root:', merklePath.root);
      console.log('leaf_index:', merklePath.leaf_index);
      console.log('witness.secret:', withdrawSecret);
      console.log('witness.blinding:', withdrawBlinding);
      console.log('witness.deposit_time:', depositTime);

      updateState(ProofState.GeneratingProof);
      let noir = new Noir({ bytecode: unlockBytecode, abi: unlockAbi as any, debug_symbols: '', file_map: {} as DebugFileMap });
      let execResult = await noir.execute(input);
      
      updateState(ProofState.PreparingCalldata);
      const honk = new UltraHonkBackend(unlockBytecode);
      const proof = await honk.generateProof(execResult.witness, { starknet: true });
      honk.destroy();
      
      await init();
      
      // DEBUG: Log proof outputs
      console.log('=== PROOF PUBLIC INPUTS ===');
      console.log('proof.publicInputs:', proof.publicInputs);
      console.log('proof.publicInputs length:', proof.publicInputs.length);
      // Log each public input value
      proof.publicInputs.forEach((pi: any, i: number) => {
        console.log(`  publicInput[${i}]:`, pi, typeof pi);
      });
      
      const flatInputs = flattenFieldsAsArray(proof.publicInputs);
      console.log('flatInputs:', flatInputs);
      console.log('flatInputs length:', flatInputs.length);
      
      // Compare expected vs actual public inputs
      console.log('=== COMPARISON ===');
      console.log('Expected nullifier:', nullifierStr);
      console.log('Expected shares:', withdrawShares);
      console.log('Expected root:', merklePath.root);
      
      const callData = getHonkCallData(
        proof.proof,
        flatInputs,
        unlockVk as Uint8Array,
        1
      );
      
      console.log('callData length:', callData.length);
      console.log('VK size:', (unlockVk as Uint8Array).length);
      console.log('callData[0] (length prefix):', callData[0]);

      const proofData = callData.slice(1).map(n => '0x' + n.toString(16));
      console.log('proofData length after slice:', proofData.length);
      
      // Test unlock verifier directly before calling contract
      console.log('=== TESTING UNLOCK VERIFIER DIRECTLY ===');
      const testProvider = new RpcProvider({ nodeUrl: 'https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_8/LOIuv6FM2_iaC8ZCb1Omu' });
      const UNLOCK_VERIFIER_ADDRESS = '0x077aacdfef0ed6fb5d6a48894afe1d0a3bb5bbc41026c47276c3964c32622f7b';
      const testVerifier = new Contract({ 
        abi: [{ type: 'function', name: 'verify_ultra_starknet_honk_proof', inputs: [{ name: 'full_proof_with_hints', type: 'core::array::Span::<core::felt252>' }], outputs: [{ type: 'core::option::Option::<core::array::Span::<core::integer::u256>>' }], state_mutability: 'view' }],
        address: UNLOCK_VERIFIER_ADDRESS, 
        providerOrAccount: testProvider 
      });
      try {
        const testResult = await testVerifier.verify_ultra_starknet_honk_proof(proofData);
        console.log('Verifier result:', testResult);
      } catch (e) {
        console.log('Verifier direct test error:', e);
      }

      updateState(ProofState.SendingTransaction);
      const spStrkContract = new Contract({ abi: spStrkAbi, address: SPSTRK_ADDRESS, providerOrAccount: wallet.account });

      const toU256 = (value: string) => {
        const bigVal = BigInt(value);
        const low = bigVal % (2n ** 128n);
        const high = bigVal / (2n ** 128n);
        return { low: low.toString(), high: high.toString() };
      };

      // TRUE PRIVACY: Only nullifier_hash is passed (not commitment or nullifier)
      console.log('Calling request_private_unlock with nullifier_hash:', nullifierHashStr);
      const tx = await spStrkContract.request_private_unlock(
        proofData,
        toU256(nullifierHashStr)
      );
      await wallet.account.waitForTransaction(tx.transaction_hash);

      console.log('Unlock requested! Wait 60 seconds then complete withdraw.');
      updateState(ProofState.ProofVerified);

      alert('Unlock requested! Wait 60 seconds, then click "Complete STRK Withdraw"');
    } catch (error) {
      handleError(error);
    }
  };

  // Complete private withdraw - after 60s unlock period, get STRK back
  const completePrivateWithdraw = async () => {
    if (!wallet || !withdrawSecret || !withdrawShares || !unlockVk) {
      alert('Please paste your note and connect wallet');
      return;
    }

    try {
      updateState(ProofState.GeneratingWitness);

      const poseidon = await buildPoseidon();
      const F = poseidon.F;

      // Compute commitment and nullifier
      const h1 = poseidon([BigInt(withdrawSecret), BigInt(withdrawShares)]);
      const h2 = poseidon([h1, BigInt(depositTime)]);
      const computedCommitment = poseidon([h2, BigInt(withdrawBlinding)]);
      const nullifier = poseidon([BigInt(withdrawSecret), BigInt(withdrawBlinding)]);

      const commitmentStr = F.toString(computedCommitment);
      const nullifierStr = F.toString(nullifier);

      console.log('Complete withdraw - Commitment:', commitmentStr);
      console.log('Complete withdraw - Nullifier:', nullifierStr);

      // Fetch Merkle path from indexer
      console.log('Fetching Merkle path from indexer...');
      const merklePath = await fetchMerklePath(commitmentStr);
      console.log('Merkle path:', merklePath);

      // Generate proof using UNLOCK circuit with Merkle proof
      // NEW: commitment is computed privately inside circuit, not passed as public input
      const input = {
        witness: {
          secret: withdrawSecret,
          shares: withdrawShares,
          deposit_time: depositTime,
          blinding: withdrawBlinding
        },
        leaf_index: merklePath.leaf_index,
        siblings: merklePath.siblings,
        // Public inputs (only these are visible on-chain)
        nullifier: nullifierStr,
        shares: withdrawShares,
        root: merklePath.root
      };

      updateState(ProofState.GeneratingProof);
      let noir = new Noir({ bytecode: unlockBytecode, abi: unlockAbi as any, debug_symbols: '', file_map: {} as DebugFileMap });
      let execResult = await noir.execute(input);
      
      updateState(ProofState.PreparingCalldata);
      const honk = new UltraHonkBackend(unlockBytecode);
      const proof = await honk.generateProof(execResult.witness, { starknet: true });
      honk.destroy();
      
      await init();
      
      const flatInputs = flattenFieldsAsArray(proof.publicInputs);
      const callData = getHonkCallData(
        proof.proof,
        flatInputs,
        unlockVk as Uint8Array,
        1
      );

      updateState(ProofState.SendingTransaction);
      const spStrkContract = new Contract({ abi: spStrkAbi, address: SPSTRK_ADDRESS, providerOrAccount: wallet.account });

      const proofData = callData.slice(1).map(n => '0x' + n.toString(16));
      const toU256 = (value: string) => {
        const bigVal = BigInt(value);
        const low = bigVal % (2n ** 128n);
        const high = bigVal / (2n ** 128n);
        return { low: low.toString(), high: high.toString() };
      };

      const recipient = withdrawRecipient || walletAddress;
      const nullifierU256 = toU256(nullifierStr);

      // TRUE PRIVACY: Only nullifier is passed, commitment stays hidden!
      console.log('Calling complete_private_withdraw to:', recipient);
      const tx = await spStrkContract.complete_private_withdraw(
        proofData,
        nullifierU256,
        recipient
      );
      await wallet.account.waitForTransaction(tx.transaction_hash);

      console.log('STRK withdrawn successfully!');
      updateState(ProofState.ProofVerified);

      alert(`Success! STRK withdrawn to ${recipient}`);
    } catch (error) {
      handleError(error);
    }
  };

  const renderStateIndicator = (state: ProofState, current: ProofState) => {
    let status = 'pending';
    
    // If this stage is current with an error, show error state
    if (current === state && proofState.error) {
      status = 'error';
    } 
    // If this is the current stage, show active state
    else if (current === state) {
      status = 'active';
    } 
    // If we're past this stage, mark it completed
    else if (getStateIndex(current) > getStateIndex(state)) {
      status = 'completed';
    }
    
    return (
      <div className={`state-indicator ${status}`}>
        <div className="state-dot"></div>
        <div className="state-label">{state}</div>
      </div>
    );
  };

  const getStateIndex = (state: ProofState): number => {
    const states = [
      ProofState.Initial,
      ProofState.GeneratingWitness,
      ProofState.GeneratingProof,
      ProofState.PreparingCalldata,
      ProofState.ConnectingWallet,
      ProofState.SendingTransaction,
      ProofState.ProofVerified
    ];
    
    return states.indexOf(state);
  };

  return (
    <div className="container">
      <h1>Sparrow Finance - Private Deposits</h1>
      
      {/* Wallet Connection */}
      <div className="wallet-section">
        {!wallet ? (
          <button className="primary-button" onClick={connectWallet}>Connect Wallet</button>
        ) : (
          <div className="wallet-info">
            <span>Connected: {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</span>
          </div>
        )}
      </div>
      
      <div className="state-machine">
        <div className="input-section">
          <h3>Private Deposit {depositStep === 2 ? '✓ Complete' : ''}</h3>
          
          {/* Deposit Mode Toggle */}
          {!withdrawMode && depositStep !== 2 && (
            <div className="deposit-mode-toggle" style={{ marginBottom: '15px', padding: '10px', background: '#1a1a2e', borderRadius: '8px' }}>
              <label style={{ marginRight: '10px' }}>Deposit Mode:</label>
              <button 
                onClick={() => setDepositMode('single')}
                style={{ 
                  padding: '8px 16px', 
                  marginRight: '8px',
                  background: depositMode === 'single' ? '#4a9eff' : '#333',
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white',
                  cursor: 'pointer'
                }}
              >
                🔒 Single-Step (Secure)
              </button>
              <button 
                onClick={() => setDepositMode('two-step')}
                style={{ 
                  padding: '8px 16px',
                  background: depositMode === 'two-step' ? '#ff6b6b' : '#333',
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white',
                  cursor: 'pointer'
                }}
              >
                🧪 Two-Step (Experimental)
              </button>
              <p style={{ fontSize: '12px', color: '#888', marginTop: '8px' }}>
                {depositMode === 'single' 
                  ? '✅ Recommended: No front-running risk. Deposit is linkable, withdrawal is private.'
                  : '⚠️ Experimental: Attempts deposit anonymity but can be front-run. Use for demo only.'}
              </p>
            </div>
          )}
          
          <div className="input-group">
            <label>Amount (STRK wei):</label>
            <input 
              type="text" 
              value={amount} 
              onChange={(e) => { setAmount(e.target.value); setShares(e.target.value); }}
              disabled={proofState.state !== ProofState.Initial || depositStep === 2 || intentMarked}
              placeholder="1000000000000000000 = 1 STRK"
            />
          </div>
          
          {/* Show secret/blinding for single-step OR after intent marked for two-step */}
          {!withdrawMode && depositStep !== 2 && (depositMode === 'single' || intentMarked) && (
            <>
              <div className="input-group">
                <label>Secret:</label>
                <input 
                  type="text" 
                  value={secret} 
                  onChange={(e) => setSecret(e.target.value)} 
                  disabled={proofState.state !== ProofState.Initial}
                />
                <button onClick={generateRandomValues} disabled={proofState.state !== ProofState.Initial}>
                  Generate Random
                </button>
              </div>
              <div className="input-group">
                <label>Blinding:</label>
                <input 
                  type="text" 
                  value={blinding} 
                  onChange={(e) => setBlinding(e.target.value)} 
                  disabled={proofState.state !== ProofState.Initial}
                />
              </div>
              <div className="input-group">
                <label>Commitment:</label>
                <input 
                  type="text" 
                  value={commitment} 
                  onChange={(e) => setCommitment(e.target.value)} 
                  placeholder="Click Compute after generating secret/blinding"
                  readOnly
                />
                <button onClick={computeCommitment} disabled={!secret || !blinding}>
                  Compute
                </button>
              </div>
            </>
          )}
          
          {/* Note Management - show after commitment is computed */}
          {commitment && (
            <div className="note-section">
              <h4>⚠️ Save Your Note (Required for Withdrawal)</h4>
              <div className="note-buttons">
                <button onClick={copyNote} className="note-button">
                  📋 Copy Note
                </button>
                <button onClick={downloadNote} className="note-button">
                  💾 Download Note
                </button>
              </div>
              <div className="input-group">
                <label>Paste Note:</label>
                <input 
                  type="text" 
                  placeholder="sparrow:amount:secret:blinding:time:shares"
                  onChange={(e) => parseNote(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
        
        {renderStateIndicator(ProofState.GeneratingWitness, proofState.state)}
        {renderStateIndicator(ProofState.GeneratingProof, proofState.state)}
        {renderStateIndicator(ProofState.PreparingCalldata, proofState.state)}
        {renderStateIndicator(ProofState.ConnectingWallet, proofState.state)}
        {renderStateIndicator(ProofState.SendingTransaction, proofState.state)}
      </div>
      
      {proofState.error && (
        <div className="error-message">
          Error at stage '{proofState.state}': {proofState.error}
        </div>
      )}
      
      {/* Withdraw Section */}
      {withdrawMode && (
        <div className="section">
          <h3>🔓 Private Withdraw</h3>
          <p className="section-description">
            Paste your saved note to withdraw your STRK anonymously
          </p>
          
          <div className="input-group">
            <label>Your Saved Note:</label>
            <input 
              type="text" 
              placeholder="sparrow:amount:secret:blinding:time:shares:commitment"
              onChange={(e) => {
                const parts = e.target.value.split(':');
                // Format: sparrow:amount:secret:blinding:time:shares:commitment
                if (parts.length >= 6 && parts[0] === 'sparrow') {
                  setWithdrawShares(parts[5]);  // shares is at position 5
                  setWithdrawSecret(parts[2]);
                  setWithdrawBlinding(parts[3]);
                  setDepositTime(parts[4]);
                }
              }}
            />
          </div>
          
          {/* Note: leaf_index is fetched automatically from the indexer */}
          
          <div className="input-group">
            <label>Recipient Address (use fresh wallet for privacy!):</label>
            <input 
              type="text" 
              value={withdrawRecipient || walletAddress}
              onChange={(e) => setWithdrawRecipient(e.target.value)}
              placeholder="Enter fresh wallet for privacy!"
            />
          </div>
        </div>
      )}
      
      <div className="controls">
        {/* Mode Toggle */}
        {proofState.state === ProofState.Initial && (
          <div className="mode-toggle">
            <button 
              className={!withdrawMode ? 'mode-active' : 'mode-inactive'}
              onClick={() => setWithdrawMode(false)}
            >
              💰 Deposit
            </button>
            <button 
              className={withdrawMode ? 'mode-active' : 'mode-inactive'}
              onClick={() => setWithdrawMode(true)}
            >
              🔓 Withdraw
            </button>
          </div>
        )}
        
        {/* Deposit Flow Buttons */}
        {!withdrawMode && proofState.state === ProofState.Initial && depositStep !== 2 && (
          <>
            {/* Single-step deposit */}
            {depositMode === 'single' && (
              <button 
                className="primary-button" 
                onClick={privateDeposit} 
                disabled={!wallet || !commitment}
              >
                🔒 Private Deposit (Single-Step)
              </button>
            )}
            
            {/* Two-step deposit */}
            {depositMode === 'two-step' && !intentMarked && (
              <button 
                className="primary-button" 
                onClick={markDepositIntent} 
                disabled={!wallet}
                style={{ background: '#ff6b6b' }}
              >
                Step 1: Mark Deposit Intent
              </button>
            )}
            
            {depositMode === 'two-step' && intentMarked && (
              <button 
                className="primary-button" 
                onClick={createPrivateCommitment}
                disabled={!commitment}
                style={{ background: '#ff6b6b' }}
              >
                Step 2: Create Private Commitment
              </button>
            )}
          </>
        )}
        
        {/* Withdraw Flow Buttons */}
        {withdrawMode && proofState.state === ProofState.Initial && (
          <div className="withdraw-options">
            <button className="primary-button" onClick={claimSpSTRK} disabled={!wallet || !withdrawSecret}>
              Claim spSTRK (Instant)
            </button>
            <button className="primary-button" onClick={requestPrivateUnlock} disabled={!wallet || !withdrawSecret}>
              Request STRK Unlock (60s)
            </button>
            <button className="primary-button" onClick={completePrivateWithdraw} disabled={!wallet || !withdrawSecret}>
              Complete STRK Withdraw
            </button>
          </div>
        )}
        
        {/* Test Mode - Just verify proof on-chain */}
        <button className="secondary-button" onClick={testVerification} 
                disabled={proofState.state !== ProofState.Initial}>
          Test Verification Only
        </button>
        
        {(proofState.error || proofState.state === ProofState.ProofVerified) && (
          <button className="reset-button" onClick={resetState}>Reset</button>
        )}
      </div>
    </div>
  )
}

export default App

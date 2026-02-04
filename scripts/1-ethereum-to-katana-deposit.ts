#!/usr/bin/env ts-node
/**
 * Ethereum to Katana Deposit
 *
 * Deposits USDC into the vault on Ethereum and bridges the resulting
 * vault shares (vbUSDC) to Katana.
 *
 * Architecture:
 * - Ethereum: Has the main ERC4626 vault
 * - Katana: Receives vault shares
 *
 * Flow:
 * 1. User approves USDC to OVaultComposer on Ethereum
 * 2. OVaultComposer deposits USDC into the vault
 * 3. Vault mints shares to composer
 * 4. Composer bridges shares to recipient on Katana via LayerZero OFT
 *
 * Result: User sends USDC on Ethereum, receives vbUSDC shares on Katana
 *
 * Transactions Required: 2 (1 approval + 1 deposit & bridge)
 *
 * Run: npx ts-node scripts/1-ethereum-to-katana-deposit.ts
 */

import { ethers } from 'ethers'
import { parseUnits } from 'ethers/lib/utils'
import { Options, addressToBytes32 } from '@layerzerolabs/lz-v2-utilities'

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
    // ============================================
    // User Configuration - UPDATE THESE VALUES
    // ============================================
    privateKey: '<YOUR_PRIVATE_KEY_HERE>',

    transaction: {
        amount: '0.02', // Amount of USDC to deposit
        recipientAddress: '<YOUR_RECIPIENT_ADDRESS_ON_KATANA>', // Will receive vbUSDC on Katana
        slippageBps: 50, // 0.5% slippage tolerance
    },

    // ============================================
    // Chain Configuration
    // ============================================
    ethereum: {
        eid: 30101,
        rpcUrl: 'https://ethereum-rpc.publicnode.com',
        name: 'Ethereum',
    },
    katana: {
        eid: 30375,
        name: 'Katana',
    },

    // ============================================
    // Contract Addresses (Ethereum Mainnet)
    // ============================================
    contracts: {
        // USDC on Ethereum
        usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        // VaultBridge ERC4626 Vault
        vault: '0x53E82ABbb12638F09d9e624578ccB666217a765e',
        // OVaultComposer - handles deposit + cross-chain send
        composer: '0x8A35897fda9E024d2aC20a937193e099679eC477',
        // Share OFT Adapter - for quoting bridge fees
        shareOFT: '0xb5bADA33542a05395d504a25885e02503A957Bb3',
    },
}

// ============================================================================
// Main Script
// ============================================================================

async function main() {
    console.log('='.repeat(80))
    console.log('Ethereum to Katana Deposit')
    console.log('Ethereum (USDC) → Vault → Katana (vbUSDC shares)')
    console.log('='.repeat(80))

    // Validate configuration
    if (CONFIG.privateKey === '<YOUR_PRIVATE_KEY_HERE>') {
        throw new Error('Please set your private key in CONFIG.privateKey')
    }
    if (CONFIG.transaction.recipientAddress === '<YOUR_RECIPIENT_ADDRESS_ON_KATANA>') {
        throw new Error('Please set the recipient address in CONFIG.transaction.recipientAddress')
    }

    // Setup provider and wallet
    const ethereumProvider = new ethers.providers.JsonRpcProvider(CONFIG.ethereum.rpcUrl)
    const wallet = new ethers.Wallet(CONFIG.privateKey, ethereumProvider)

    console.log(`\n📍 Wallet Address: ${wallet.address}`)
    console.log(`💰 Amount: ${CONFIG.transaction.amount} USDC`)
    console.log(`📬 Recipient (Katana): ${CONFIG.transaction.recipientAddress}`)
    console.log('='.repeat(80))

    // ============================================================================
    // Step 1: Check USDC Balance
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 1: Checking USDC Balance on Ethereum')
    console.log('='.repeat(80))

    const erc20Abi = [
        'function decimals() view returns (uint8)',
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
    ]

    const usdc = new ethers.Contract(CONFIG.contracts.usdc, erc20Abi, wallet)
    const usdcDecimals = await usdc.decimals()
    const amount = parseUnits(CONFIG.transaction.amount, usdcDecimals)

    const balance = await usdc.balanceOf(wallet.address)
    console.log(`   Your USDC balance: ${ethers.utils.formatUnits(balance, usdcDecimals)} USDC`)

    if (balance.lt(amount)) {
        throw new Error(
            `Insufficient USDC balance. Need ${CONFIG.transaction.amount}, have ${ethers.utils.formatUnits(balance, usdcDecimals)}`
        )
    }
    console.log(`   ✅ Sufficient balance`)

    // ============================================================================
    // Step 2: Preview Vault Deposit
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 2: Previewing Vault Deposit')
    console.log('='.repeat(80))

    const vaultAbi = [
        'function decimals() view returns (uint8)',
        'function previewDeposit(uint256) view returns (uint256)',
    ]
    const vault = new ethers.Contract(CONFIG.contracts.vault, vaultAbi, ethereumProvider)
    const vaultDecimals = await vault.decimals()

    const expectedShares = await vault.previewDeposit(amount)
    const minShares = expectedShares.mul(10000 - CONFIG.transaction.slippageBps).div(10000)

    console.log(`   USDC to deposit: ${ethers.utils.formatUnits(amount, usdcDecimals)}`)
    console.log(`   Expected shares: ${ethers.utils.formatUnits(expectedShares, vaultDecimals)} vbUSDC`)
    console.log(`   Min shares (${CONFIG.transaction.slippageBps / 100}% slippage): ${ethers.utils.formatUnits(minShares, vaultDecimals)} vbUSDC`)

    // ============================================================================
    // Step 3: Quote LayerZero Bridge Fee
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 3: Quoting LayerZero Bridge Fee (Ethereum → Katana)')
    console.log('='.repeat(80))

    // Build SendParam for the share bridge to Katana
    const sendParam = {
        dstEid: CONFIG.katana.eid,
        to: addressToBytes32(CONFIG.transaction.recipientAddress),
        amountLD: expectedShares,
        minAmountLD: minShares,
        extraOptions: Options.newOptions().addExecutorLzReceiveOption(100000, 0).toHex(),
        composeMsg: '0x',
        oftCmd: '0x',
    }

    const oftAbi = [
        'function quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool) view returns ((uint256,uint256))',
    ]
    const shareOFT = new ethers.Contract(CONFIG.contracts.shareOFT, oftAbi, ethereumProvider)

    const quote = await shareOFT.quoteSend(
        [
            sendParam.dstEid,
            sendParam.to,
            sendParam.amountLD,
            sendParam.minAmountLD,
            sendParam.extraOptions,
            sendParam.composeMsg,
            sendParam.oftCmd,
        ],
        false
    )

    const bridgeFee = quote[0]
    console.log(`   Bridge fee: ${ethers.utils.formatEther(bridgeFee)} ETH`)

    // ============================================================================
    // Step 4: Approve USDC to Composer
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 4: Approving USDC to OVaultComposer')
    console.log('='.repeat(80))

    const allowance = await usdc.allowance(wallet.address, CONFIG.contracts.composer)
    console.log(`   Current allowance: ${ethers.utils.formatUnits(allowance, usdcDecimals)} USDC`)

    if (allowance.lt(amount)) {
        console.log(`   🔓 Approving USDC...`)
        const approveTx = await usdc.approve(CONFIG.contracts.composer, ethers.constants.MaxUint256)
        console.log(`   Transaction: ${approveTx.hash}`)
        await approveTx.wait()
        console.log(`   ✅ Approval confirmed`)
    } else {
        console.log(`   ✅ Sufficient allowance`)
    }

    // ============================================================================
    // Step 5: Execute Deposit and Bridge
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 5: Executing Deposit & Bridge')
    console.log('='.repeat(80))

    console.log(`   This transaction will:`)
    console.log(`   1. Transfer USDC from your wallet to composer`)
    console.log(`   2. Deposit USDC into the vault on Ethereum`)
    console.log(`   3. Bridge minted shares to Katana`)

    const composerAbi = [
        'function depositAndSend(uint256,(uint32,bytes32,uint256,uint256,bytes,bytes,bytes),address) payable',
    ]
    const composer = new ethers.Contract(CONFIG.contracts.composer, composerAbi, wallet)

    console.log(`\n📤 Sending transaction...`)
    const tx = await composer.depositAndSend(
        amount,
        [
            sendParam.dstEid,
            sendParam.to,
            sendParam.amountLD,
            sendParam.minAmountLD,
            sendParam.extraOptions,
            sendParam.composeMsg,
            sendParam.oftCmd,
        ],
        wallet.address, // refund address for excess ETH
        { value: bridgeFee }
    )

    console.log(`   Transaction hash: ${tx.hash}`)
    console.log(`   Waiting for confirmation...`)

    const receipt = await tx.wait()
    console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`)

    // ============================================================================
    // Success
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('🎉 Deposit & Bridge Successful!')
    console.log('='.repeat(80))
    console.log(`\nTransaction Summary:`)
    console.log(`   • Deposited: ${CONFIG.transaction.amount} USDC on Ethereum`)
    console.log(`   • Expected shares: ~${ethers.utils.formatUnits(expectedShares, vaultDecimals)} vbUSDC`)
    console.log(`   • Recipient on Katana: ${CONFIG.transaction.recipientAddress}`)
    console.log(`   • Bridge fee paid: ${ethers.utils.formatEther(bridgeFee)} ETH`)
    console.log(`\nWhat happens next:`)
    console.log(`   1. ⏳ LayerZero validators confirm the message (~1-2 min)`)
    console.log(`   2. ⏳ Executor delivers shares to Katana (~2-5 min)`)
    console.log(`   3. ✅ Recipient receives vbUSDC on Katana`)
    console.log(`\n📍 Track your transaction:`)
    console.log(`   LayerZero Scan: https://layerzeroscan.com/tx/${receipt.transactionHash}`)
    console.log(`   Etherscan: https://etherscan.io/tx/${receipt.transactionHash}`)
    console.log('\n✨ Your vbUSDC shares will arrive on Katana in ~3-7 minutes!')
    console.log('='.repeat(80))
}

// ============================================================================
// Execute
// ============================================================================

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ Error:', error.message)
        if (error.reason) {
            console.error('Reason:', error.reason)
        }
        if (error.code === 'INSUFFICIENT_FUNDS') {
            console.error('\n💡 Tip: Make sure you have enough ETH on Ethereum for gas fees')
        }
        process.exit(1)
    })

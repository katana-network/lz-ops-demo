#!/usr/bin/env ts-node
/**
 * Ethereum to Katana Deposit
 *
 * Deposits assets into the vault on Ethereum and bridges the resulting
 * vault shares to Katana. (e.g. USDC → vbUSDC, USDT → vbUSDT, WBTC → vbWBTC)
 *
 * Architecture:
 * - Ethereum: Has the main ERC4626 vault
 * - Katana: Receives vault shares
 *
 * Flow:
 * 1. User approves asset to OVaultComposer on Ethereum
 * 2. OVaultComposer deposits asset into the vault
 * 3. Vault mints shares to composer
 * 4. Composer bridges shares to recipient on Katana via LayerZero OFT
 *
 * Result: User sends asset on Ethereum, receives vault shares on Katana
 *
 * Transactions Required: 2 (1 approval + 1 deposit & bridge)
 *
 * Run: npx ts-node scripts/1-ethereum-to-katana-deposit.ts
 */

import { ethers } from 'ethers'
import { parseUnits } from 'ethers/lib/utils'
import { Options, addressToBytes32 } from '@layerzerolabs/lz-v2-utilities'
import { isSafeMode, buildSafeTx, writeSafePayload, SafeTransaction } from './utils/safe-payload'

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
    // ============================================
    // User Configuration - UPDATE THESE VALUES
    // ============================================
    privateKey: '<YOUR_PRIVATE_KEY_HERE>',

    transaction: {
        amount: '0.02', // Amount of asset to deposit (e.g. '10.0' USDC)
        recipientAddress: '<YOUR_RECIPIENT_ADDRESS_ON_KATANA>', // Will receive vault shares on Katana
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
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // e.g. USDC: 0xA0b8..., USDT: 0xdAC1..., WBTC: 0x2260...
        vault: '0x53E82ABbb12638F09d9e624578ccB666217a765e', // ERC4626 vault for the asset
        composer: '0x8A35897fda9E024d2aC20a937193e099679eC477', // OVaultComposer for the vault
        shareOFT: '0xb5bADA33542a05395d504a25885e02503A957Bb3', // Share OFT Adapter on Ethereum
    },
}

// ============================================================================
// Main Script
// ============================================================================

const SAFE_MODE = isSafeMode()
const safeTxs: SafeTransaction[] = []

async function main() {
    console.log('='.repeat(80))
    console.log('Ethereum to Katana Deposit')
    console.log('Ethereum (asset) → Vault → Katana (vault shares)')
    console.log('='.repeat(80))

    // Validate configuration
    if (!SAFE_MODE && CONFIG.privateKey === '<YOUR_PRIVATE_KEY_HERE>') {
        throw new Error('Please set your private key in CONFIG.privateKey')
    }
    if (CONFIG.transaction.recipientAddress === '<YOUR_RECIPIENT_ADDRESS_ON_KATANA>') {
        throw new Error('Please set the recipient address in CONFIG.transaction.recipientAddress')
    }

    // Setup provider and wallet
    const ethereumProvider = new ethers.providers.JsonRpcProvider(CONFIG.ethereum.rpcUrl)
    const wallet = SAFE_MODE ? null : new ethers.Wallet(CONFIG.privateKey, ethereumProvider)

    if (SAFE_MODE) {
        console.log(`\n🔐 Safe Mode: Generating transaction payload`)
    } else {
        console.log(`\n📍 Wallet Address: ${wallet!.address}`)
    }
    console.log(`💰 Amount: ${CONFIG.transaction.amount} (asset tokens)`)
    console.log(`📬 Recipient (Katana): ${CONFIG.transaction.recipientAddress}`)
    console.log('='.repeat(80))

    // ============================================================================
    // Step 1: Check Asset Balance
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 1: Checking Asset Balance on Ethereum')
    console.log('='.repeat(80))

    const erc20Abi = [
        'function decimals() view returns (uint8)',
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
    ]

    const assetToken = new ethers.Contract(CONFIG.contracts.asset, erc20Abi, wallet || ethereumProvider)
    const assetDecimals = await assetToken.decimals()
    const amount = parseUnits(CONFIG.transaction.amount, assetDecimals)

    if (!SAFE_MODE) {
        const balance = await assetToken.balanceOf(wallet!.address)
        console.log(`   Asset balance: ${ethers.utils.formatUnits(balance, assetDecimals)}`)

        if (balance.lt(amount)) {
            throw new Error(
                `Insufficient asset balance. Need ${CONFIG.transaction.amount}, have ${ethers.utils.formatUnits(balance, assetDecimals)}`
            )
        }
        console.log(`   ✅ Sufficient balance`)
    } else {
        console.log(`   ⏭️  Balance check skipped in Safe mode`)
    }

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

    console.log(`   Asset to deposit: ${ethers.utils.formatUnits(amount, assetDecimals)}`)
    console.log(`   Expected shares: ${ethers.utils.formatUnits(expectedShares, vaultDecimals)}`)
    console.log(`   Min shares (${CONFIG.transaction.slippageBps / 100}% slippage): ${ethers.utils.formatUnits(minShares, vaultDecimals)}`)

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
    // Step 4: Approve Asset to Composer
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 4: Approving Asset to OVaultComposer')
    console.log('='.repeat(80))

    if (SAFE_MODE) {
        safeTxs.push(buildSafeTx(
            CONFIG.contracts.asset,
            assetToken.interface.encodeFunctionData('approve', [CONFIG.contracts.composer, amount])
        ))
        console.log(`   ✅ Approval added to Safe payload (${ethers.utils.formatUnits(amount, assetDecimals)} tokens)`)
    } else {
        const allowance = await assetToken.allowance(wallet!.address, CONFIG.contracts.composer)
        console.log(`   Current allowance: ${ethers.utils.formatUnits(allowance, assetDecimals)}`)

        if (allowance.lt(amount)) {
            console.log(`   🔓 Approving ${ethers.utils.formatUnits(amount, assetDecimals)} tokens...`)
            const approveTx = await assetToken.approve(CONFIG.contracts.composer, amount)
            console.log(`   Transaction: ${approveTx.hash}`)
            await approveTx.wait()
            console.log(`   ✅ Approval confirmed`)
        } else {
            console.log(`   ✅ Sufficient allowance`)
        }
    }

    // ============================================================================
    // Step 5: Execute Deposit and Bridge
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 5: Executing Deposit & Bridge')
    console.log('='.repeat(80))

    console.log(`   This transaction will:`)
    console.log(`   1. Transfer asset from your wallet to composer`)
    console.log(`   2. Deposit asset into the vault on Ethereum`)
    console.log(`   3. Bridge minted shares to Katana`)

    const composerAbi = [
        'function depositAndSend(uint256,(uint32,bytes32,uint256,uint256,bytes,bytes,bytes),address) payable',
    ]

    if (SAFE_MODE) {
        const iface = new ethers.utils.Interface(composerAbi)
        safeTxs.push(buildSafeTx(
            CONFIG.contracts.composer,
            iface.encodeFunctionData('depositAndSend', [
                amount,
                [sendParam.dstEid, sendParam.to, sendParam.amountLD, sendParam.minAmountLD, sendParam.extraOptions, sendParam.composeMsg, sendParam.oftCmd],
                CONFIG.transaction.recipientAddress,
            ]),
            bridgeFee.toString()
        ))

        const { chainId } = await ethereumProvider.getNetwork()
        const filepath = writeSafePayload(1, chainId, 'Ethereum to Katana Deposit', safeTxs)
        console.log('\n' + '='.repeat(80))
        console.log('✅ Safe Payload Generated')
        console.log('='.repeat(80))
        console.log(`   File: ${filepath}`)
        console.log(`   Transactions: ${safeTxs.length} (approval + deposit & bridge)`)
        console.log(`   Import this file into Safe Transaction Builder`)
        console.log('='.repeat(80))
        return
    }

    const composer = new ethers.Contract(CONFIG.contracts.composer, composerAbi, wallet!)

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
        wallet!.address, // refund address for excess ETH
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
    console.log(`   • Deposited: ${CONFIG.transaction.amount} asset tokens on Ethereum`)
    console.log(`   • Expected shares: ~${ethers.utils.formatUnits(expectedShares, vaultDecimals)}`)
    console.log(`   • Recipient on Katana: ${CONFIG.transaction.recipientAddress}`)
    console.log(`   • Bridge fee paid: ${ethers.utils.formatEther(bridgeFee)} ETH`)
    console.log(`\nWhat happens next:`)
    console.log(`   1. ⏳ LayerZero validators confirm the message (~1-2 min)`)
    console.log(`   2. ⏳ Executor delivers shares to Katana (~2-5 min)`)
    console.log(`   3. ✅ Recipient receives vault shares on Katana`)
    console.log(`\n📍 Track your transaction:`)
    console.log(`   LayerZero Scan: https://layerzeroscan.com/tx/${receipt.transactionHash}`)
    console.log(`   Etherscan: https://etherscan.io/tx/${receipt.transactionHash}`)
    console.log('\n✨ Your vault shares will arrive on Katana in ~3-7 minutes!')
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

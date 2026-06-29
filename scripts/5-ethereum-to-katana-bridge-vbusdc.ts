#!/usr/bin/env ts-node
/**
 * Ethereum to Katana Bridge (vbUSDC)
 *
 * Bridges existing vault shares (vbUSDC) from Ethereum directly to Katana.
 * Use this when you already hold vault shares on Ethereum and want to move
 * them to Katana — no new deposit needed.
 *
 * Architecture:
 * - Ethereum: Holds existing vault shares (vbUSDC)
 * - Katana: Receives vault shares
 *
 * Flow:
 * 1. User approves vbUSDC to Share OFT Adapter on Ethereum
 * 2. Share OFT Adapter locks vbUSDC on Ethereum and messages Katana
 * 3. Katana OFT mints vbUSDC to recipient
 *
 * Result: User sends vault shares on Ethereum, receives vault shares on Katana
 *
 * Transactions Required: 2 (1 approval + 1 bridge)
 *
 * Run: npx ts-node scripts/5-ethereum-to-katana-bridge-vbusdc.ts
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
        amount: '<AMOUNT>', // Amount of vbUSDC to bridge (e.g. '10.0')
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
        vbUSDC: '0x53E82ABbb12638F09d9e624578ccB666217a765e', // vbUSDC vault shares token on Ethereum
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
    console.log('Ethereum to Katana Bridge (vbUSDC)')
    console.log('Ethereum (vbUSDC) → LayerZero OFT → Katana (vbUSDC)')
    console.log('='.repeat(80))

    // Validate configuration
    if (!SAFE_MODE && CONFIG.privateKey === '<YOUR_PRIVATE_KEY_HERE>') {
        throw new Error('Please set your private key in CONFIG.privateKey')
    }
    if (CONFIG.transaction.recipientAddress === '<YOUR_RECIPIENT_ADDRESS_ON_KATANA>') {
        throw new Error('Please set the recipient address in CONFIG.transaction.recipientAddress')
    }
    if (!CONFIG.transaction.amount) {
        throw new Error('Please set the amount in CONFIG.transaction.amount')
    }

    // Setup provider and wallet
    const ethereumProvider = new ethers.providers.JsonRpcProvider(CONFIG.ethereum.rpcUrl)
    const wallet = SAFE_MODE ? null : new ethers.Wallet(CONFIG.privateKey, ethereumProvider)

    if (SAFE_MODE) {
        console.log(`\n🔐 Safe Mode: Generating transaction payload`)
    } else {
        console.log(`\n📍 Wallet Address: ${wallet!.address}`)
    }
    console.log(`💰 Amount: ${CONFIG.transaction.amount} vbUSDC`)
    console.log(`📬 Recipient (Katana): ${CONFIG.transaction.recipientAddress}`)
    console.log('='.repeat(80))

    // ============================================================================
    // Step 1: Check vbUSDC Balance on Ethereum
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 1: Checking vbUSDC Balance on Ethereum')
    console.log('='.repeat(80))

    const erc20Abi = [
        'function decimals() view returns (uint8)',
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
    ]

    const vbUSDCToken = new ethers.Contract(CONFIG.contracts.vbUSDC, erc20Abi, wallet || ethereumProvider)
    const shareDecimals = await vbUSDCToken.decimals()
    const amount = parseUnits(CONFIG.transaction.amount, shareDecimals)
    const minAmountLD = amount.mul(10000 - CONFIG.transaction.slippageBps).div(10000)

    if (!SAFE_MODE) {
        const balance = await vbUSDCToken.balanceOf(wallet!.address)
        console.log(`   vbUSDC balance: ${ethers.utils.formatUnits(balance, shareDecimals)}`)

        if (balance.lt(amount)) {
            throw new Error(
                `Insufficient vbUSDC balance. Need ${CONFIG.transaction.amount}, have ${ethers.utils.formatUnits(balance, shareDecimals)}`
            )
        }
        console.log(`   ✅ Sufficient balance`)
    } else {
        console.log(`   ⏭️  Balance check skipped in Safe mode`)
    }

    console.log(`   Amount to bridge: ${ethers.utils.formatUnits(amount, shareDecimals)} vbUSDC`)
    console.log(`   Min amount (${CONFIG.transaction.slippageBps / 100}% slippage): ${ethers.utils.formatUnits(minAmountLD, shareDecimals)} vbUSDC`)

    // ============================================================================
    // Step 2: Quote LayerZero Bridge Fee
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 2: Quoting LayerZero Bridge Fee (Ethereum → Katana)')
    console.log('='.repeat(80))

    const sendParam = {
        dstEid: CONFIG.katana.eid,
        to: addressToBytes32(CONFIG.transaction.recipientAddress),
        amountLD: amount,
        minAmountLD: minAmountLD,
        extraOptions: Options.newOptions().addExecutorLzReceiveOption(100000, 0).toHex(),
        composeMsg: '0x',
        oftCmd: '0x',
    }

    const oftAbi = [
        'function quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool) view returns ((uint256,uint256))',
        'function send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address) payable returns ((bytes32,uint64))',
    ]
    const shareOFT = new ethers.Contract(CONFIG.contracts.shareOFT, oftAbi, wallet || ethereumProvider)

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

    const messagingFee = {
        nativeFee: quote[0],
        lzTokenFee: quote[1],
    }

    console.log(`   Bridge fee: ${ethers.utils.formatEther(messagingFee.nativeFee)} ETH`)
    console.log(`   ✅ Fee quoted`)

    // ============================================================================
    // Step 3: Approve vbUSDC to Share OFT Adapter
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 3: Approving vbUSDC to Share OFT Adapter')
    console.log('='.repeat(80))

    if (SAFE_MODE) {
        safeTxs.push(buildSafeTx(
            CONFIG.contracts.vbUSDC,
            vbUSDCToken.interface.encodeFunctionData('approve', [CONFIG.contracts.shareOFT, amount])
        ))
        console.log(`   ✅ Approval added to Safe payload (${ethers.utils.formatUnits(amount, shareDecimals)} vbUSDC)`)
    } else {
        const allowance = await vbUSDCToken.allowance(wallet!.address, CONFIG.contracts.shareOFT)
        console.log(`   Current allowance: ${ethers.utils.formatUnits(allowance, shareDecimals)}`)

        if (allowance.lt(amount)) {
            console.log(`   🔓 Approving ${ethers.utils.formatUnits(amount, shareDecimals)} vbUSDC...`)
            const approveTx = await vbUSDCToken.approve(CONFIG.contracts.shareOFT, amount)
            console.log(`   Transaction: ${approveTx.hash}`)
            await approveTx.wait()
            console.log(`   ✅ Approval confirmed`)
        } else {
            console.log(`   ✅ Sufficient allowance`)
        }
    }

    // ============================================================================
    // Step 4: Execute Bridge
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 4: Executing Bridge')
    console.log('='.repeat(80))

    console.log(`   This transaction will:`)
    console.log(`   1. Lock vbUSDC in the OFT Adapter on Ethereum`)
    console.log(`   2. Relay message to Katana via LayerZero`)
    console.log(`   3. Mint vbUSDC to recipient on Katana`)

    if (SAFE_MODE) {
        safeTxs.push(buildSafeTx(
            CONFIG.contracts.shareOFT,
            shareOFT.interface.encodeFunctionData('send', [
                [sendParam.dstEid, sendParam.to, sendParam.amountLD, sendParam.minAmountLD, sendParam.extraOptions, sendParam.composeMsg, sendParam.oftCmd],
                [messagingFee.nativeFee, messagingFee.lzTokenFee],
                CONFIG.transaction.recipientAddress,
            ]),
            messagingFee.nativeFee.toString()
        ))

        const { chainId } = await ethereumProvider.getNetwork()
        const filepath = writeSafePayload(5, chainId, 'Ethereum to Katana Bridge (vbUSDC)', safeTxs)
        console.log('\n' + '='.repeat(80))
        console.log('✅ Safe Payload Generated')
        console.log('='.repeat(80))
        console.log(`   File: ${filepath}`)
        console.log(`   Transactions: ${safeTxs.length} (approval + bridge)`)
        console.log(`   Import this file into Safe Transaction Builder`)
        console.log('='.repeat(80))
        return
    }

    console.log(`\n📤 Sending transaction...`)
    const tx = await shareOFT.send(
        [
            sendParam.dstEid,
            sendParam.to,
            sendParam.amountLD,
            sendParam.minAmountLD,
            sendParam.extraOptions,
            sendParam.composeMsg,
            sendParam.oftCmd,
        ],
        [messagingFee.nativeFee, messagingFee.lzTokenFee],
        wallet!.address, // refund address for excess ETH
        { value: messagingFee.nativeFee }
    )

    console.log(`   Transaction hash: ${tx.hash}`)
    console.log(`   Waiting for confirmation...`)

    const receipt = await tx.wait()
    console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`)

    // ============================================================================
    // Success
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('🎉 Bridge Successful!')
    console.log('='.repeat(80))
    console.log(`\nTransaction Summary:`)
    console.log(`   • Bridged: ${CONFIG.transaction.amount} vbUSDC from Ethereum`)
    console.log(`   • Recipient on Katana: ${CONFIG.transaction.recipientAddress}`)
    console.log(`   • Bridge fee paid: ${ethers.utils.formatEther(messagingFee.nativeFee)} ETH`)
    console.log(`\nWhat happens next:`)
    console.log(`   1. ⏳ LayerZero validators confirm the message (~1-2 min)`)
    console.log(`   2. ⏳ Executor delivers vbUSDC to Katana (~2-5 min)`)
    console.log(`   3. ✅ Recipient receives vbUSDC on Katana`)
    console.log(`\n📍 Track your transaction:`)
    console.log(`   LayerZero Scan: https://layerzeroscan.com/tx/${receipt.transactionHash}`)
    console.log(`   Etherscan: https://etherscan.io/tx/${receipt.transactionHash}`)
    console.log('\n✨ Your vbUSDC will arrive on Katana in ~3-7 minutes!')
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
            console.error('\n💡 Tip: Make sure you have enough ETH on Ethereum for gas fees and the bridge fee')
        }
        process.exit(1)
    })

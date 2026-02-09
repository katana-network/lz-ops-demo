#!/usr/bin/env ts-node
/**
 * Katana to Ethereum Redemption
 *
 * Bridges vault shares (vbUSDC) from Katana to Ethereum,
 * redeems them from the vault, and keeps the resulting USDC on Ethereum.
 *
 * Architecture:
 * - Katana: Has vault shares to redeem
 * - Ethereum: Has the main ERC4626 vault, receives final USDC
 *
 * Flow:
 * 1. User approves vbUSDC shares to Share OFT Adapter on Katana
 * 2. Share OFT bridges shares to OVaultComposer on Ethereum
 * 3. Composer receives shares via lzCompose callback
 * 4. Composer redeems shares from vault for USDC
 * 5. Composer sends USDC to recipient on Ethereum
 *
 * Result: User sends vbUSDC on Katana, receives USDC on Ethereum
 *
 * Transactions Required: 2 (1 approval + 1 bridge with compose)
 *
 * Run: npx ts-node scripts/2-katana-to-ethereum-redemption.ts
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
        amount: '0.02', // Amount of vbUSDC shares to redeem
        recipientAddress: '<YOUR_RECIPIENT_ADDRESS_ON_ETHEREUM>', // Will receive USDC on Ethereum
        slippageBps: 50, // 0.5% slippage tolerance
        composeGas: 800000, // Gas for vault redemption - tested on mainnet
    },

    // ============================================
    // Chain Configuration
    // ============================================
    katana: {
        eid: 30375,
        rpcUrl: 'https://rpc.katana.network/', // Update with Katana RPC endpoint
        name: 'Katana',
    },
    ethereum: {
        eid: 30101,
        rpcUrl: 'https://ethereum-rpc.publicnode.com',
        name: 'Ethereum',
    },

    // ============================================
    // Contract Addresses
    // ============================================
    contracts: {
        // Katana contracts
        katana: {
            // vbUSDC token on Katana (OFT representation of vault shares)
            vbUsdcToken: '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36',
            // Share OFT Adapter on Katana
            shareOFT: '0x807275727Dd3E640c5F2b5DE7d1eC72B4Dd293C0',
        },
        // Ethereum contracts
        ethereum: {
            // VaultBridge ERC4626 Vault
            vault: '0x53E82ABbb12638F09d9e624578ccB666217a765e',
            // OVaultComposer - handles redemption via lzCompose
            composer: '0x8A35897fda9E024d2aC20a937193e099679eC477',
        },
    },
}

// ============================================================================
// Main Script
// ============================================================================

const SAFE_MODE = isSafeMode()
const safeTxs: SafeTransaction[] = []

async function main() {
    console.log('='.repeat(80))
    console.log('Katana to Ethereum Redemption')
    console.log('Katana (vbUSDC shares) → Vault Redeem → Ethereum (USDC)')
    console.log('='.repeat(80))

    // Validate configuration
    if (!SAFE_MODE && CONFIG.privateKey === '<YOUR_PRIVATE_KEY_HERE>') {
        throw new Error('Please set your private key in CONFIG.privateKey')
    }
    if (CONFIG.transaction.recipientAddress === '<YOUR_RECIPIENT_ADDRESS_ON_ETHEREUM>') {
        throw new Error('Please set the recipient address in CONFIG.transaction.recipientAddress')
    }
    if (CONFIG.katana.rpcUrl === '<KATANA_RPC_URL_HERE>') {
        throw new Error('Please set the Katana RPC URL in CONFIG.katana.rpcUrl')
    }

    // Setup providers and wallet
    const katanaProvider = new ethers.providers.JsonRpcProvider(CONFIG.katana.rpcUrl)
    const ethereumProvider = new ethers.providers.JsonRpcProvider(CONFIG.ethereum.rpcUrl)
    const katanaWallet = SAFE_MODE ? null : new ethers.Wallet(CONFIG.privateKey, katanaProvider)

    if (SAFE_MODE) {
        console.log(`\n🔐 Safe Mode: Generating transaction payload`)
    } else {
        console.log(`\n📍 Wallet Address: ${katanaWallet!.address}`)
    }
    console.log(`💰 Amount: ${CONFIG.transaction.amount} vbUSDC shares`)
    console.log(`📬 Recipient (Ethereum): ${CONFIG.transaction.recipientAddress}`)
    console.log('='.repeat(80))

    // ============================================================================
    // Step 1: Check Share Balance
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 1: Checking vbUSDC Balance on Katana')
    console.log('='.repeat(80))

    const erc20Abi = [
        'function decimals() view returns (uint8)',
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
    ]

    const vbUsdc = new ethers.Contract(CONFIG.contracts.katana.vbUsdcToken, erc20Abi, katanaWallet || katanaProvider)
    const shareDecimals = await vbUsdc.decimals()
    const amount = parseUnits(CONFIG.transaction.amount, shareDecimals)

    if (!SAFE_MODE) {
        const balance = await vbUsdc.balanceOf(katanaWallet!.address)
        console.log(`   Your vbUSDC balance: ${ethers.utils.formatUnits(balance, shareDecimals)} vbUSDC`)

        if (balance.lt(amount)) {
            throw new Error(
                `Insufficient vbUSDC balance. Need ${CONFIG.transaction.amount}, have ${ethers.utils.formatUnits(balance, shareDecimals)}`
            )
        }
        console.log(`   ✅ Sufficient balance`)
    } else {
        console.log(`   ⏭️  Balance check skipped in Safe mode`)
    }

    // ============================================================================
    // Step 2: Preview Vault Redemption
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 2: Previewing Vault Redemption on Ethereum')
    console.log('='.repeat(80))

    const vaultAbi = [
        'function asset() view returns (address)',
        'function previewRedeem(uint256) view returns (uint256)',
    ]
    const vault = new ethers.Contract(CONFIG.contracts.ethereum.vault, vaultAbi, ethereumProvider)

    // Get asset decimals
    const assetAddress = await vault.asset()
    const assetToken = new ethers.Contract(assetAddress, erc20Abi, ethereumProvider)
    const assetDecimals = await assetToken.decimals()

    const expectedAssets = await vault.previewRedeem(amount)
    const minAssets = expectedAssets.mul(10000 - CONFIG.transaction.slippageBps).div(10000)

    console.log(`   Shares to redeem: ${ethers.utils.formatUnits(amount, shareDecimals)} vbUSDC`)
    console.log(`   Expected USDC: ${ethers.utils.formatUnits(expectedAssets, assetDecimals)} USDC`)
    console.log(`   Min USDC (${CONFIG.transaction.slippageBps / 100}% slippage): ${ethers.utils.formatUnits(minAssets, assetDecimals)} USDC`)

    // ============================================================================
    // Step 3: Build Compose Message
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 3: Building Compose Message')
    console.log('='.repeat(80))

    // For Ethereum redemption (no second hop), destination is Ethereum itself
    // The SendParam tells the composer where to send redeemed assets
    const secondHopSendParam = {
        dstEid: CONFIG.ethereum.eid, // Destination is Ethereum (no actual second hop)
        to: addressToBytes32(CONFIG.transaction.recipientAddress),
        amountLD: expectedAssets,
        minAmountLD: minAssets,
        extraOptions: Options.newOptions().addExecutorLzReceiveOption(100000, 0).toHex(),
        composeMsg: '0x', // No nested compose
        oftCmd: '0x',
    }

    // No second cross-chain hop value needed since destination is Ethereum
    const secondHopValue = 0
    console.log(`   ℹ️ Destination is Ethereum - no second cross-chain hop needed`)

    // Encode compose message: (SendParam, uint256 msgValue)
    const composeMsg = ethers.utils.defaultAbiCoder.encode(
        ['tuple(uint32,bytes32,uint256,uint256,bytes,bytes,bytes)', 'uint256'],
        [
            [
                secondHopSendParam.dstEid,
                secondHopSendParam.to,
                secondHopSendParam.amountLD,
                secondHopSendParam.minAmountLD,
                secondHopSendParam.extraOptions,
                secondHopSendParam.composeMsg,
                secondHopSendParam.oftCmd,
            ],
            secondHopValue,
        ]
    )

    console.log(`   Compose message length: ${composeMsg.length} bytes`)
    console.log(`   Contains: Redemption instructions for OVaultComposer`)

    // ============================================================================
    // Step 4: Build LayerZero Options
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 4: Building LayerZero Options')
    console.log('='.repeat(80))

    // Build options with compose gas (no value for second hop since staying on Ethereum)
    const options = Options.newOptions()
        .addExecutorComposeOption(0, CONFIG.transaction.composeGas, secondHopValue)
    const extraOptions = options.toHex()

    console.log(`   Compose gas: ${CONFIG.transaction.composeGas.toLocaleString()}`)
    console.log(`   Compose value: 0 ETH (no second hop)`)
    console.log(`   ✅ Options encoded`)

    // ============================================================================
    // Step 5: Build First Hop SendParam
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 5: Building SendParam (Katana → Ethereum)')
    console.log('='.repeat(80))

    const minSharesFirstHop = amount.mul(10000 - CONFIG.transaction.slippageBps).div(10000)

    const sendParam = {
        dstEid: CONFIG.ethereum.eid,
        to: addressToBytes32(CONFIG.contracts.ethereum.composer), // Send to composer for redemption
        amountLD: amount,
        minAmountLD: minSharesFirstHop,
        extraOptions: extraOptions,
        composeMsg: composeMsg,
        oftCmd: '0x',
    }

    console.log(`   Destination: Ethereum (EID ${CONFIG.ethereum.eid})`)
    console.log(`   Receiver: OVaultComposer (${CONFIG.contracts.ethereum.composer})`)
    console.log(`   Amount: ${ethers.utils.formatUnits(amount, shareDecimals)} vbUSDC`)
    console.log(`   ✅ SendParam built`)

    // ============================================================================
    // Step 6: Quote LayerZero Fee
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 6: Quoting LayerZero Fee (Katana → Ethereum)')
    console.log('='.repeat(80))

    const oftAbi = [
        'function quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool) view returns ((uint256,uint256))',
        'function send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address) payable returns ((bytes32,uint64))',
    ]
    const shareOFT = new ethers.Contract(CONFIG.contracts.katana.shareOFT, oftAbi, katanaWallet || katanaProvider)

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

    console.log(`   LayerZero fee: ${ethers.utils.formatEther(messagingFee.nativeFee)} native`)
    console.log(`   (Includes compose execution cost on Ethereum)`)

    // ============================================================================
    // Step 7: Approve Shares to Share OFT
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 7: Approving vbUSDC to Share OFT on Katana')
    console.log('='.repeat(80))

    if (SAFE_MODE) {
        safeTxs.push(buildSafeTx(
            CONFIG.contracts.katana.vbUsdcToken,
            vbUsdc.interface.encodeFunctionData('approve', [CONFIG.contracts.katana.shareOFT, ethers.constants.MaxUint256])
        ))
        console.log(`   ✅ Approval added to Safe payload`)
    } else {
        const allowance = await vbUsdc.allowance(katanaWallet!.address, CONFIG.contracts.katana.shareOFT)
        console.log(`   Current allowance: ${ethers.utils.formatUnits(allowance, shareDecimals)} vbUSDC`)

        if (allowance.lt(amount)) {
            console.log(`   🔓 Approving vbUSDC...`)
            const approveTx = await vbUsdc.approve(CONFIG.contracts.katana.shareOFT, ethers.constants.MaxUint256)
            console.log(`   Transaction: ${approveTx.hash}`)
            await approveTx.wait()
            console.log(`   ✅ Approval confirmed`)
        } else {
            console.log(`   ✅ Sufficient allowance`)
        }
    }

    // ============================================================================
    // Step 8: Execute Bridge and Redemption
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 8: Executing Bridge & Redemption')
    console.log('='.repeat(80))

    console.log(`   This transaction will:`)
    console.log(`   1. Lock vbUSDC shares on Katana`)
    console.log(`   2. Bridge shares to OVaultComposer on Ethereum`)
    console.log(`   3. Composer redeems shares for USDC`)
    console.log(`   4. USDC sent to recipient on Ethereum`)

    if (SAFE_MODE) {
        safeTxs.push(buildSafeTx(
            CONFIG.contracts.katana.shareOFT,
            shareOFT.interface.encodeFunctionData('send', [
                [sendParam.dstEid, sendParam.to, sendParam.amountLD, sendParam.minAmountLD, sendParam.extraOptions, sendParam.composeMsg, sendParam.oftCmd],
                [messagingFee.nativeFee, messagingFee.lzTokenFee],
                CONFIG.transaction.recipientAddress,
            ]),
            messagingFee.nativeFee.toString()
        ))

        const { chainId } = await katanaProvider.getNetwork()
        const filepath = writeSafePayload(2, chainId, 'Katana to Ethereum Redemption', safeTxs)
        console.log('\n' + '='.repeat(80))
        console.log('✅ Safe Payload Generated')
        console.log('='.repeat(80))
        console.log(`   File: ${filepath}`)
        console.log(`   Transactions: ${safeTxs.length} (approval + bridge & redeem)`)
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
        katanaWallet!.address, // refund address
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
    console.log('🎉 Redemption Transaction Sent!')
    console.log('='.repeat(80))
    console.log(`\nTransaction Summary:`)
    console.log(`   • Shares redeemed: ${CONFIG.transaction.amount} vbUSDC from Katana`)
    console.log(`   • Expected USDC: ~${ethers.utils.formatUnits(expectedAssets, assetDecimals)} USDC`)
    console.log(`   • Recipient on Ethereum: ${CONFIG.transaction.recipientAddress}`)
    console.log(`   • Bridge fee paid: ${ethers.utils.formatEther(messagingFee.nativeFee)} native`)
    console.log(`\nWhat happens next:`)
    console.log(`   1. ⏳ LayerZero validators confirm the message (~1-2 min)`)
    console.log(`   2. ⏳ Executor delivers shares to composer on Ethereum`)
    console.log(`   3. ⏳ Composer redeems shares from vault (automatic)`)
    console.log(`   4. ✅ USDC sent to recipient on Ethereum`)
    console.log(`\n📍 Track your transaction:`)
    console.log(`   LayerZero Scan: https://layerzeroscan.com/tx/${receipt.transactionHash}`)
    console.log('\n✨ Your USDC will arrive on Ethereum in ~3-7 minutes!')
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
            console.error('\n💡 Tip: Make sure you have enough native token on Katana for gas fees')
        }
        process.exit(1)
    })

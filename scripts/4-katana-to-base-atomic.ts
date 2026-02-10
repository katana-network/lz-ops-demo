#!/usr/bin/env ts-node
/**
 * Katana to Base Atomic Redemption
 *
 * Redeems vault shares from Katana and sends asset to Base
 * via Ethereum in a single atomic transaction.
 * Uses LayerZero compose to chain multiple cross-chain operations.
 * (e.g. vbUSDC → USDC, vbUSDT → USDT, vbWBTC → WBTC)
 *
 * Architecture:
 * - Source: Katana (user has vault shares)
 * - Hub: Ethereum (has the main ERC4626 vault, transit chain)
 * - Destination: Base (user receives asset)
 *
 * Flow:
 * 1. User approves vault shares to Share OFT Adapter on Katana
 * 2. Share OFT bridges shares to OVaultComposer on Ethereum with compose message
 * 3. Composer receives shares via lzCompose callback
 * 4. Composer redeems shares from vault for asset
 * 5. Composer bridges asset to recipient on Base via Stargate
 *
 * Result: User sends vault shares on Katana, receives asset on Base
 *
 * Transactions Required: 2 (1 approval + 1 atomic bridge & redeem)
 *
 * Run: npx ts-node scripts/4-katana-to-base-atomic.ts
 */

import { ethers } from 'ethers'
import { addressToBytes32, Options } from '@layerzerolabs/lz-v2-utilities'
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
        amount: '0.02', // Amount of vault shares to redeem (e.g. '10.0' vbUSDC)
        recipientAddress: '<YOUR_RECIPIENT_ADDRESS_ON_BASE>', // Will receive asset on Base
        slippageBps: 50, // 0.5% slippage for both hops
        composeGas: 1200000, // Gas for redeem + bridge on Ethereum (1.2M for safety)
    },

    // ============================================
    // Chain Configuration
    // ============================================
    katana: {
        rpcUrl: 'https://rpc.katana.network/', // Update with Katana RPC endpoint
        eid: 30375,
        name: 'Katana',
    },
    ethereum: {
        rpcUrl: 'https://ethereum-rpc.publicnode.com',
        eid: 30101,
        name: 'Ethereum',
    },
    base: {
        eid: 30184,
        name: 'Base',
    },

    // ============================================
    // Contract Addresses
    // ============================================
    contracts: {
        katana: {
            vaultShareToken: '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36', // e.g. vbUSDC on Katana
            shareOFT: '0x807275727Dd3E640c5F2b5DE7d1eC72B4Dd293C0', // Share OFT Adapter on Katana
        },
        ethereum: {
            vault: '0x53E82ABbb12638F09d9e624578ccB666217a765e', // ERC4626 vault for the asset
            composer: '0x8A35897fda9E024d2aC20a937193e099679eC477', // OVaultComposer for the vault
            stargatePool: '0xc026395860Db2d07ee33e05fE50ed7bD583189C7', // e.g. Stargate USDC Pool on Ethereum
        },
        base: {
            asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // e.g. USDC on Base
        },
    },
}

// ============================================================================
// Helper Functions
// ============================================================================

function calculateMinAmount(amount: ethers.BigNumber, slippageBps: number): ethers.BigNumber {
    return amount.mul(10000 - slippageBps).div(10000)
}

// ============================================================================
// Main Script
// ============================================================================

const SAFE_MODE = isSafeMode()
const safeTxs: SafeTransaction[] = []

async function main() {
    console.log('='.repeat(80))
    console.log('Katana to Base Atomic Redemption')
    console.log('Katana (vault shares) → Ethereum (Vault Redeem) → Base (asset)')
    console.log('='.repeat(80))

    // Validate configuration
    if (!SAFE_MODE && CONFIG.privateKey === '<YOUR_PRIVATE_KEY_HERE>') {
        throw new Error('Please set your private key in CONFIG.privateKey')
    }
    if (CONFIG.transaction.recipientAddress === '<YOUR_RECIPIENT_ADDRESS_ON_BASE>') {
        throw new Error('Please set the recipient address in CONFIG.transaction.recipientAddress')
    }
    if (CONFIG.katana.rpcUrl === '<KATANA_RPC_URL_HERE>') {
        throw new Error('Please set the Katana RPC URL in CONFIG.katana.rpcUrl')
    }

    // Setup providers and wallet
    const katanaProvider = new ethers.providers.JsonRpcProvider(CONFIG.katana.rpcUrl)
    const ethProvider = new ethers.providers.JsonRpcProvider(CONFIG.ethereum.rpcUrl)
    const katanaWallet = SAFE_MODE ? null : new ethers.Wallet(CONFIG.privateKey, katanaProvider)

    if (SAFE_MODE) {
        console.log(`\n🔐 Safe Mode: Generating transaction payload`)
    } else {
        console.log(`\n📍 Wallet Address: ${katanaWallet!.address}`)
    }
    console.log(`💰 Amount: ${CONFIG.transaction.amount} (vault shares)`)
    console.log(`📬 Recipient (Base): ${CONFIG.transaction.recipientAddress}`)
    console.log('='.repeat(80))

    // Parse amount
    const shareAmount = ethers.utils.parseUnits(CONFIG.transaction.amount, 6)

    // ============================================================================
    // Step 1: Preview Vault Redemption and Quote Second Hop Fee
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 1: Quoting Ethereum → Base Bridge Fee')
    console.log('='.repeat(80))

    // Preview the vault redemption to get expected assets
    const vaultAbi = [
        'function previewRedeem(uint256) view returns (uint256)',
        'function decimals() view returns (uint8)',
    ]
    const vault = new ethers.Contract(CONFIG.contracts.ethereum.vault, vaultAbi, ethProvider)

    const expectedAssets = await vault.previewRedeem(shareAmount)
    const vaultDecimals = await vault.decimals()

    console.log(`   Shares to redeem: ${ethers.utils.formatUnits(shareAmount, vaultDecimals)}`)
    console.log(`   Expected assets: ${ethers.utils.formatUnits(expectedAssets, 6)}`)

    // Calculate min assets with slippage
    const minAssets = calculateMinAmount(expectedAssets, CONFIG.transaction.slippageBps)
    console.log(`   Min assets (${CONFIG.transaction.slippageBps / 100}% slippage): ${ethers.utils.formatUnits(minAssets, 6)}`)

    // Build SendParam for second hop: Ethereum → Base (via Stargate)
    const secondHopSendParam = {
        dstEid: CONFIG.base.eid,
        to: addressToBytes32(CONFIG.transaction.recipientAddress),
        amountLD: expectedAssets,
        minAmountLD: minAssets,
        extraOptions: Options.newOptions().addExecutorLzReceiveOption(100000, 0).toHex(),
        composeMsg: '0x',
        oftCmd: '0x',
    }

    // Quote the Ethereum → Base bridge fee from Stargate
    const stargatePoolAbi = [
        'function quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool) view returns ((uint256,uint256))',
    ]
    const ethStargatePool = new ethers.Contract(
        CONFIG.contracts.ethereum.stargatePool,
        stargatePoolAbi,
        ethProvider
    )

    const secondHopQuote = await ethStargatePool.quoteSend(
        [
            secondHopSendParam.dstEid,
            secondHopSendParam.to,
            secondHopSendParam.amountLD,
            secondHopSendParam.minAmountLD,
            secondHopSendParam.extraOptions,
            secondHopSendParam.composeMsg,
            secondHopSendParam.oftCmd,
        ],
        false
    )

    const secondHopFee = secondHopQuote[0]
    // Add 20% buffer to account for gas price fluctuations
    const secondHopFeeWithBuffer = secondHopFee.mul(120).div(100)
    console.log(`   Second hop fee (ETH → Base): ${ethers.utils.formatEther(secondHopFee)} ETH`)
    console.log(`   With 20% buffer: ${ethers.utils.formatEther(secondHopFeeWithBuffer)} ETH`)

    // ============================================================================
    // Step 2: Build Compose Message
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 2: Building Compose Message')
    console.log('='.repeat(80))

    // Encode the compose message: (SendParam, uint256 msgValue)
    // This tells the composer what to do with the received shares
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
            secondHopFeeWithBuffer, // ETH to use for second hop
        ]
    )

    console.log(`   Compose message length: ${composeMsg.length} bytes`)
    console.log(`   Contains instructions for: Redeem shares + Bridge asset to Base`)

    // ============================================================================
    // Step 3: Build LayerZero Options
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 3: Building LayerZero Options')
    console.log('='.repeat(80))

    const composeGas = CONFIG.transaction.composeGas
    const composeValue = secondHopFeeWithBuffer

    console.log(`   Compose Gas: ${composeGas.toLocaleString()} (1M = very safe)`)
    console.log(`   Compose Value: ${ethers.utils.formatEther(composeValue)} ETH`)
    console.log(`   Note: Compose value covers the second hop (ETH → Base) fee`)

    const options = Options.newOptions()
        .addExecutorComposeOption(0, composeGas, composeValue.toNumber())
    const extraOptions = options.toHex()

    console.log(`   ✅ Options encoded`)

    // ============================================================================
    // Step 4: Build First Hop SendParam (Katana → Ethereum)
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 4: Building First Hop SendParam')
    console.log('='.repeat(80))

    const minShares = calculateMinAmount(shareAmount, CONFIG.transaction.slippageBps)

    const firstHopSendParam = {
        dstEid: CONFIG.ethereum.eid,
        to: addressToBytes32(CONFIG.contracts.ethereum.composer), // Send to composer
        amountLD: shareAmount,
        minAmountLD: minShares,
        extraOptions: extraOptions,
        composeMsg: composeMsg,
        oftCmd: '0x',
    }

    console.log(`   Destination: Ethereum (EID ${CONFIG.ethereum.eid})`)
    console.log(`   Receiver: OVaultComposer (${CONFIG.contracts.ethereum.composer})`)
    console.log(`   Amount: ${ethers.utils.formatUnits(shareAmount, 6)} shares`)
    console.log(`   Min Amount: ${ethers.utils.formatUnits(minShares, 6)} shares`)
    console.log(`   ✅ SendParam built`)

    // ============================================================================
    // Step 5: Quote First Hop Fee
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 5: Quoting First Hop Fee')
    console.log('='.repeat(80))

    const shareOFTAbi = [
        'function quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool) view returns ((uint256,uint256))',
    ]
    const katanaShareOFT = new ethers.Contract(CONFIG.contracts.katana.shareOFT, shareOFTAbi, katanaProvider)

    const firstHopQuote = await katanaShareOFT.quoteSend(
        [
            firstHopSendParam.dstEid,
            firstHopSendParam.to,
            firstHopSendParam.amountLD,
            firstHopSendParam.minAmountLD,
            firstHopSendParam.extraOptions,
            firstHopSendParam.composeMsg,
            firstHopSendParam.oftCmd,
        ],
        false
    )

    const firstHopFee = firstHopQuote[0]
    console.log(`   First hop fee (Katana → ETH): ${ethers.utils.formatEther(firstHopFee)} native`)
    console.log(`   (Includes compose execution cost on Ethereum)`)

    // ============================================================================
    // Step 6: Check and Approve Vault Shares
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 6: Checking Vault Share Approval')
    console.log('='.repeat(80))

    const erc20Abi = [
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
    ]
    const shareToken = new ethers.Contract(CONFIG.contracts.katana.vaultShareToken, erc20Abi, katanaWallet || katanaProvider)

    if (SAFE_MODE) {
        safeTxs.push(buildSafeTx(
            CONFIG.contracts.katana.vaultShareToken,
            shareToken.interface.encodeFunctionData('approve', [CONFIG.contracts.katana.shareOFT, shareAmount])
        ))
        console.log(`   ⏭️  Balance check skipped in Safe mode`)
        console.log(`   ✅ Approval added to Safe payload (${ethers.utils.formatUnits(shareAmount, 6)} shares)`)
    } else {
        // Check balance
        const shareBalance = await shareToken.balanceOf(katanaWallet!.address)
        console.log(`   Share balance: ${ethers.utils.formatUnits(shareBalance, 6)}`)

        if (shareBalance.lt(shareAmount)) {
            throw new Error(
                `Insufficient share balance. Have ${ethers.utils.formatUnits(shareBalance, 6)}, need ${ethers.utils.formatUnits(shareAmount, 6)}`
            )
        }

        // Check and approve
        const currentAllowance = await shareToken.allowance(katanaWallet!.address, CONFIG.contracts.katana.shareOFT)
        console.log(`   Current allowance: ${ethers.utils.formatUnits(currentAllowance, 6)}`)

        if (currentAllowance.lt(shareAmount)) {
            console.log(`   🔓 Approving ${ethers.utils.formatUnits(shareAmount, 6)} shares...`)
            const approveTx = await shareToken.approve(CONFIG.contracts.katana.shareOFT, shareAmount)
            console.log(`   Transaction: ${approveTx.hash}`)
            await approveTx.wait()
            console.log(`   ✅ Approval confirmed`)
        } else {
            console.log(`   ✅ Sufficient allowance`)
        }
    }

    // ============================================================================
    // Step 7: Execute Atomic Transaction
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 7: Sending Atomic Transaction')
    console.log('='.repeat(80))

    const sendAbi = [
        'function send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address) payable returns ((bytes32,uint64))',
    ]

    const messagingFee = {
        nativeFee: firstHopFee,
        lzTokenFee: 0,
    }

    if (SAFE_MODE) {
        const iface = new ethers.utils.Interface(sendAbi)
        safeTxs.push(buildSafeTx(
            CONFIG.contracts.katana.shareOFT,
            iface.encodeFunctionData('send', [
                [firstHopSendParam.dstEid, firstHopSendParam.to, firstHopSendParam.amountLD, firstHopSendParam.minAmountLD, firstHopSendParam.extraOptions, firstHopSendParam.composeMsg, firstHopSendParam.oftCmd],
                [messagingFee.nativeFee, messagingFee.lzTokenFee],
                CONFIG.transaction.recipientAddress,
            ]),
            firstHopFee.toString()
        ))

        const { chainId } = await katanaProvider.getNetwork()
        const filepath = writeSafePayload(4, chainId, 'Katana to Base Atomic Redemption', safeTxs)
        console.log('\n' + '='.repeat(80))
        console.log('✅ Safe Payload Generated')
        console.log('='.repeat(80))
        console.log(`   File: ${filepath}`)
        console.log(`   Transactions: ${safeTxs.length} (approval + atomic bridge & redeem)`)
        console.log(`   Import this file into Safe Transaction Builder`)
        console.log('='.repeat(80))
        return
    }

    const shareOFTWithSigner = new ethers.Contract(
        CONFIG.contracts.katana.shareOFT,
        sendAbi,
        katanaWallet!
    )

    console.log(`\n📋 Transaction Summary:`)
    console.log(`   From: Katana`)
    console.log(`   Via: Ethereum (vault redemption)`)
    console.log(`   To: Base`)
    console.log(`   Amount: ${CONFIG.transaction.amount} vault shares`)
    console.log(`   Expected assets: ${ethers.utils.formatUnits(expectedAssets, 6)}`)
    console.log(`   Final recipient: ${CONFIG.transaction.recipientAddress}`)
    console.log(`   Total native needed: ${ethers.utils.formatEther(firstHopFee)}`)

    console.log(`\n📤 Sending transaction...`)
    const tx = await shareOFTWithSigner.send(
        [
            firstHopSendParam.dstEid,
            firstHopSendParam.to,
            firstHopSendParam.amountLD,
            firstHopSendParam.minAmountLD,
            firstHopSendParam.extraOptions,
            firstHopSendParam.composeMsg,
            firstHopSendParam.oftCmd,
        ],
        [messagingFee.nativeFee, messagingFee.lzTokenFee],
        katanaWallet!.address,
        { value: firstHopFee }
    )

    console.log(`   Transaction Hash: ${tx.hash}`)
    console.log(`   Waiting for confirmation...`)

    const receipt = await tx.wait()
    console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`)

    // ============================================================================
    // Success
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('🎉 Atomic Transaction Sent Successfully!')
    console.log('='.repeat(80))
    console.log(`\nTransaction Summary:`)
    console.log(`   • Sent: ${CONFIG.transaction.amount} vault shares from Katana`)
    console.log(`   • Expected assets: ~${ethers.utils.formatUnits(expectedAssets, 6)}`)
    console.log(`   • Recipient on Base: ${CONFIG.transaction.recipientAddress}`)
    console.log(`   • Total fee paid: ${ethers.utils.formatEther(firstHopFee)} native`)
    console.log(`\nWhat happens next:`)
    console.log(`   1. ⏳ Katana → Ethereum: Shares bridge to OVaultComposer (~2-5 min)`)
    console.log(`   2. ⏳ On Ethereum: Composer redeems shares for asset (automatic)`)
    console.log(`   3. ⏳ Ethereum → Base: Asset bridges via Stargate (~2-5 min)`)
    console.log(`\n📍 Track your transaction:`)
    console.log(`   LayerZero Scan: https://layerzeroscan.com/tx/${tx.hash}`)
    console.log('\n✨ Your assets will arrive on Base in ~5-10 minutes!')
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

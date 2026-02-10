#!/usr/bin/env ts-node
/**
 * Base to Katana Atomic Deposit
 *
 * Sends asset from Base to Katana via Ethereum in a single atomic transaction.
 * Uses LayerZero compose to chain multiple cross-chain operations.
 * (e.g. USDC → vbUSDC, USDT → vbUSDT, WBTC → vbWBTC)
 *
 * Architecture:
 * - Source: Base (user has asset)
 * - Hub: Ethereum (has the main ERC4626 vault, transit chain)
 * - Destination: Katana (user receives vault shares)
 *
 * Flow:
 * 1. User approves asset to Stargate Pool on Base
 * 2. Stargate bridges asset to OVaultComposer on Ethereum with compose message
 * 3. Composer receives asset via lzCompose callback
 * 4. Composer deposits asset into vault, receives shares
 * 5. Composer bridges shares to recipient on Katana via LayerZero OFT
 *
 * Result: User sends asset on Base, receives vault shares on Katana
 *
 * Transactions Required: 2 (1 approval + 1 atomic bridge & deposit)
 *
 * Run: npx ts-node scripts/3-base-to-katana-atomic.ts
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
        amount: '0.02', // Amount of asset to deposit (e.g. '10.0' USDC)
        recipientAddress: '<YOUR_RECIPIENT_ADDRESS_ON_KATANA>', // Will receive vault shares on Katana
        slippageBps: 50, // 0.5% slippage for both hops
        composeGas: 1000000, // Gas for deposit + bridge on Ethereum (1M for safety)
    },

    // ============================================
    // Chain Configuration
    // ============================================
    base: {
        rpcUrl: 'https://mainnet.base.org',
        eid: 30184,
        name: 'Base',
    },
    ethereum: {
        rpcUrl: 'https://ethereum-rpc.publicnode.com',
        eid: 30101,
        name: 'Ethereum',
    },
    katana: {
        eid: 30375,
        name: 'Katana',
    },

    // ============================================
    // Contract Addresses
    // ============================================
    contracts: {
        base: {
            asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // e.g. USDC on Base
            stargatePool: '0x27a16dc786820B16E5c9028b75B99F6f604b5d26', // e.g. Stargate USDC Pool on Base
        },
        ethereum: {
            vault: '0x53E82ABbb12638F09d9e624578ccB666217a765e', // ERC4626 vault for the asset
            composer: '0x8A35897fda9E024d2aC20a937193e099679eC477', // OVaultComposer for the vault
            shareOFT: '0xb5bADA33542a05395d504a25885e02503A957Bb3', // Share OFT Adapter on Ethereum
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
    console.log('Base to Katana Atomic Deposit')
    console.log('Base (asset) → Ethereum (Vault) → Katana (vault shares)')
    console.log('='.repeat(80))

    // Validate configuration
    if (!SAFE_MODE && CONFIG.privateKey === '<YOUR_PRIVATE_KEY_HERE>') {
        throw new Error('Please set your private key in CONFIG.privateKey')
    }
    if (CONFIG.transaction.recipientAddress === '<YOUR_RECIPIENT_ADDRESS_ON_KATANA>') {
        throw new Error('Please set the recipient address in CONFIG.transaction.recipientAddress')
    }

    // Setup providers and wallet
    const baseProvider = new ethers.providers.JsonRpcProvider(CONFIG.base.rpcUrl)
    const ethProvider = new ethers.providers.JsonRpcProvider(CONFIG.ethereum.rpcUrl)
    const baseWallet = SAFE_MODE ? null : new ethers.Wallet(CONFIG.privateKey, baseProvider)

    if (SAFE_MODE) {
        console.log(`\n🔐 Safe Mode: Generating transaction payload`)
    } else {
        console.log(`\n📍 Wallet Address: ${baseWallet!.address}`)
    }
    console.log(`💰 Amount: ${CONFIG.transaction.amount} (asset tokens)`)
    console.log(`📬 Recipient (Katana): ${CONFIG.transaction.recipientAddress}`)
    console.log('='.repeat(80))

    // Parse amount
    const assetAmount = ethers.utils.parseUnits(CONFIG.transaction.amount, 6)

    // ============================================================================
    // Step 1: Preview Vault Deposit and Quote Second Hop Fee
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 1: Quoting Ethereum → Katana Bridge Fee')
    console.log('='.repeat(80))

    // Preview the vault deposit to get expected shares
    const vaultAbi = [
        'function previewDeposit(uint256) view returns (uint256)',
        'function decimals() view returns (uint8)',
    ]
    const vault = new ethers.Contract(CONFIG.contracts.ethereum.vault, vaultAbi, ethProvider)

    const expectedShares = await vault.previewDeposit(assetAmount)
    const shareDecimals = await vault.decimals()

    console.log(`   Expected shares: ${ethers.utils.formatUnits(expectedShares, shareDecimals)}`)

    // Calculate min shares with slippage
    const minShares = calculateMinAmount(expectedShares, CONFIG.transaction.slippageBps)
    console.log(`   Min shares (${CONFIG.transaction.slippageBps / 100}% slippage): ${ethers.utils.formatUnits(minShares, shareDecimals)}`)

    // Build SendParam for second hop: Ethereum → Katana
    const secondHopSendParam = {
        dstEid: CONFIG.katana.eid,
        to: addressToBytes32(CONFIG.transaction.recipientAddress),
        amountLD: expectedShares,
        minAmountLD: minShares,
        extraOptions: Options.newOptions().addExecutorLzReceiveOption(100000, 0).toHex(),
        composeMsg: '0x',
        oftCmd: '0x',
    }

    // Quote the Ethereum → Katana bridge fee
    const shareOFTAbi = [
        'function quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool) view returns ((uint256,uint256))',
    ]
    const shareOFT = new ethers.Contract(CONFIG.contracts.ethereum.shareOFT, shareOFTAbi, ethProvider)

    const secondHopQuote = await shareOFT.quoteSend(
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
    console.log(`   Second hop fee (ETH → Katana): ${ethers.utils.formatEther(secondHopFee)} ETH`)
    console.log(`   With 20% buffer: ${ethers.utils.formatEther(secondHopFeeWithBuffer)} ETH`)

    // ============================================================================
    // Step 2: Build Compose Message
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 2: Building Compose Message')
    console.log('='.repeat(80))

    // Encode the compose message: (SendParam, uint256 msgValue)
    // This tells the composer what to do with the received asset
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
    console.log(`   Contains instructions for: Deposit asset + Bridge shares to Katana`)

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
    console.log(`   Note: Compose value covers the second hop (ETH → Katana) fee`)

    const options = Options.newOptions()
        .addExecutorComposeOption(0, composeGas, composeValue.toNumber())
    const extraOptions = options.toHex()

    console.log(`   ✅ Options encoded`)

    // ============================================================================
    // Step 4: Build First Hop SendParam (Base → Ethereum)
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 4: Building First Hop SendParam')
    console.log('='.repeat(80))

    const minAsset = calculateMinAmount(assetAmount, CONFIG.transaction.slippageBps)

    const firstHopSendParam = {
        dstEid: CONFIG.ethereum.eid,
        to: addressToBytes32(CONFIG.contracts.ethereum.composer), // Send to composer
        amountLD: assetAmount,
        minAmountLD: minAsset,
        extraOptions: extraOptions,
        composeMsg: composeMsg,
        oftCmd: '0x',
    }

    console.log(`   Destination: Ethereum (EID ${CONFIG.ethereum.eid})`)
    console.log(`   Receiver: OVaultComposer (${CONFIG.contracts.ethereum.composer})`)
    console.log(`   Amount: ${ethers.utils.formatUnits(assetAmount, 6)}`)
    console.log(`   Min Amount: ${ethers.utils.formatUnits(minAsset, 6)}`)
    console.log(`   ✅ SendParam built`)

    // ============================================================================
    // Step 5: Quote First Hop Fee
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 5: Quoting First Hop Fee')
    console.log('='.repeat(80))

    const stargatePoolAbi = [
        'function quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool) view returns ((uint256,uint256))',
    ]
    const stargatePool = new ethers.Contract(CONFIG.contracts.base.stargatePool, stargatePoolAbi, baseProvider)

    const firstHopQuote = await stargatePool.quoteSend(
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
    console.log(`   First hop fee (Base → ETH): ${ethers.utils.formatEther(firstHopFee)} ETH`)
    console.log(`   (Includes compose execution cost on Ethereum)`)

    // ============================================================================
    // Step 6: Check and Approve Asset
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 6: Checking Asset Approval')
    console.log('='.repeat(80))

    const erc20Abi = [
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
    ]
    const assetToken = new ethers.Contract(CONFIG.contracts.base.asset, erc20Abi, baseWallet || baseProvider)

    if (SAFE_MODE) {
        safeTxs.push(buildSafeTx(
            CONFIG.contracts.base.asset,
            assetToken.interface.encodeFunctionData('approve', [CONFIG.contracts.base.stargatePool, assetAmount])
        ))
        console.log(`   ⏭️  Balance check skipped in Safe mode`)
        console.log(`   ✅ Approval added to Safe payload (${ethers.utils.formatUnits(assetAmount, 6)} tokens)`)
    } else {
        // Check balance
        const assetBalance = await assetToken.balanceOf(baseWallet!.address)
        console.log(`   Asset balance: ${ethers.utils.formatUnits(assetBalance, 6)}`)

        if (assetBalance.lt(assetAmount)) {
            throw new Error(
                `Insufficient asset balance. Have ${ethers.utils.formatUnits(assetBalance, 6)}, need ${ethers.utils.formatUnits(assetAmount, 6)}`
            )
        }

        // Check and approve
        const currentAllowance = await assetToken.allowance(baseWallet!.address, CONFIG.contracts.base.stargatePool)
        console.log(`   Current allowance: ${ethers.utils.formatUnits(currentAllowance, 6)}`)

        if (currentAllowance.lt(assetAmount)) {
            console.log(`   🔓 Approving ${ethers.utils.formatUnits(assetAmount, 6)} tokens...`)
            const approveTx = await assetToken.approve(CONFIG.contracts.base.stargatePool, assetAmount)
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
            CONFIG.contracts.base.stargatePool,
            iface.encodeFunctionData('send', [
                [firstHopSendParam.dstEid, firstHopSendParam.to, firstHopSendParam.amountLD, firstHopSendParam.minAmountLD, firstHopSendParam.extraOptions, firstHopSendParam.composeMsg, firstHopSendParam.oftCmd],
                [messagingFee.nativeFee, messagingFee.lzTokenFee],
                CONFIG.transaction.recipientAddress,
            ]),
            firstHopFee.toString()
        ))

        const { chainId } = await baseProvider.getNetwork()
        const filepath = writeSafePayload(3, chainId, 'Base to Katana Atomic Deposit', safeTxs)
        console.log('\n' + '='.repeat(80))
        console.log('✅ Safe Payload Generated')
        console.log('='.repeat(80))
        console.log(`   File: ${filepath}`)
        console.log(`   Transactions: ${safeTxs.length} (approval + atomic bridge & deposit)`)
        console.log(`   Import this file into Safe Transaction Builder`)
        console.log('='.repeat(80))
        return
    }

    const stargatePoolWithSigner = new ethers.Contract(
        CONFIG.contracts.base.stargatePool,
        sendAbi,
        baseWallet!
    )

    console.log(`\n📋 Transaction Summary:`)
    console.log(`   From: Base`)
    console.log(`   Via: Ethereum (vault deposit)`)
    console.log(`   To: Katana`)
    console.log(`   Amount: ${CONFIG.transaction.amount} (asset tokens)`)
    console.log(`   Expected shares: ${ethers.utils.formatUnits(expectedShares, shareDecimals)}`)
    console.log(`   Final recipient: ${CONFIG.transaction.recipientAddress}`)
    console.log(`   Total ETH needed: ${ethers.utils.formatEther(firstHopFee)} ETH`)

    console.log(`\n📤 Sending transaction...`)
    const tx = await stargatePoolWithSigner.send(
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
        baseWallet!.address,
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
    console.log(`   • Sent: ${CONFIG.transaction.amount} asset tokens from Base`)
    console.log(`   • Expected shares: ~${ethers.utils.formatUnits(expectedShares, shareDecimals)}`)
    console.log(`   • Recipient on Katana: ${CONFIG.transaction.recipientAddress}`)
    console.log(`   • Total fee paid: ${ethers.utils.formatEther(firstHopFee)} ETH`)
    console.log(`\nWhat happens next:`)
    console.log(`   1. ⏳ Base → Ethereum: Asset bridges to OVaultComposer (~2-5 min)`)
    console.log(`   2. ⏳ On Ethereum: Composer deposits asset and bridges shares (automatic)`)
    console.log(`   3. ⏳ Ethereum → Katana: Shares bridge to recipient (~2-5 min)`)
    console.log(`\n📍 Track your transaction:`)
    console.log(`   LayerZero Scan: https://layerzeroscan.com/tx/${tx.hash}`)
    console.log(`   Base Scan: https://basescan.org/tx/${tx.hash}`)
    console.log('\n✨ Your vault shares will arrive on Katana in ~5-10 minutes!')
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
            console.error('\n💡 Tip: Make sure you have enough ETH on Base for gas fees')
        }
        process.exit(1)
    })

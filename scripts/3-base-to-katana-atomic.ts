#!/usr/bin/env ts-node
/**
 * Base to Katana Atomic Deposit
 *
 * Sends USDC from Base to Katana via Ethereum in a single atomic transaction.
 * Uses LayerZero compose to chain multiple cross-chain operations.
 *
 * Architecture:
 * - Source: Base (user has USDC)
 * - Hub: Ethereum (has the main ERC4626 vault, transit chain)
 * - Destination: Katana (user receives vault shares)
 *
 * Flow:
 * 1. User approves USDC to Stargate Pool on Base
 * 2. Stargate bridges USDC to OVaultComposer on Ethereum with compose message
 * 3. Composer receives USDC via lzCompose callback
 * 4. Composer deposits USDC into vault, receives shares
 * 5. Composer bridges shares to recipient on Katana via LayerZero OFT
 *
 * Result: User sends USDC on Base, receives vbUSDC shares on Katana
 *
 * Transactions Required: 2 (1 approval + 1 atomic bridge & deposit)
 *
 * Run: npx ts-node scripts/3-base-to-katana-atomic.ts
 */

import { ethers } from 'ethers'
import { addressToBytes32, Options } from '@layerzerolabs/lz-v2-utilities'

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
    // ============================================
    // User Configuration - UPDATE THESE VALUES
    // ============================================
    privateKey: '<YOUR_PRIVATE_KEY_HERE>',

    transaction: {
        usdcAmount: '0.02', // Amount in USDC (e.g., '10' = 10 USDC)
        recipientAddress: '<YOUR_RECIPIENT_ADDRESS_ON_KATANA>', // Will receive vbUSDC on Katana
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
        // Base contracts
        base: {
            usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            stargatePoolUSDC: '0x27a16dc786820B16E5c9028b75B99F6f604b5d26',
        },
        // Ethereum contracts
        ethereum: {
            vault: '0x53E82ABbb12638F09d9e624578ccB666217a765e',
            composer: '0x8A35897fda9E024d2aC20a937193e099679eC477',
            shareOFT: '0xb5bADA33542a05395d504a25885e02503A957Bb3',
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

async function main() {
    console.log('='.repeat(80))
    console.log('Base to Katana Atomic Deposit')
    console.log('Base (USDC) → Ethereum (Vault) → Katana (vbUSDC shares)')
    console.log('='.repeat(80))

    // Validate configuration
    if (CONFIG.privateKey === '<YOUR_PRIVATE_KEY_HERE>') {
        throw new Error('Please set your private key in CONFIG.privateKey')
    }
    if (CONFIG.transaction.recipientAddress === '<YOUR_RECIPIENT_ADDRESS_ON_KATANA>') {
        throw new Error('Please set the recipient address in CONFIG.transaction.recipientAddress')
    }

    // Setup providers and wallet
    const baseProvider = new ethers.providers.JsonRpcProvider(CONFIG.base.rpcUrl)
    const ethProvider = new ethers.providers.JsonRpcProvider(CONFIG.ethereum.rpcUrl)
    const baseWallet = new ethers.Wallet(CONFIG.privateKey, baseProvider)

    console.log(`\n📍 Wallet Address: ${baseWallet.address}`)
    console.log(`💰 Amount: ${CONFIG.transaction.usdcAmount} USDC`)
    console.log(`📬 Recipient (Katana): ${CONFIG.transaction.recipientAddress}`)
    console.log('='.repeat(80))

    // Parse amount (USDC has 6 decimals)
    const usdcAmount = ethers.utils.parseUnits(CONFIG.transaction.usdcAmount, 6)

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

    const expectedShares = await vault.previewDeposit(usdcAmount)
    const shareDecimals = await vault.decimals()

    console.log(`   Expected shares: ${ethers.utils.formatUnits(expectedShares, shareDecimals)} vbUSDC`)

    // Calculate min shares with slippage
    const minShares = calculateMinAmount(expectedShares, CONFIG.transaction.slippageBps)
    console.log(`   Min shares (${CONFIG.transaction.slippageBps / 100}% slippage): ${ethers.utils.formatUnits(minShares, shareDecimals)} vbUSDC`)

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
    // This tells the composer what to do with the received USDC
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
    console.log(`   Contains instructions for: Deposit USDC + Bridge shares to Katana`)

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

    const minUSDC = calculateMinAmount(usdcAmount, CONFIG.transaction.slippageBps)

    const firstHopSendParam = {
        dstEid: CONFIG.ethereum.eid,
        to: addressToBytes32(CONFIG.contracts.ethereum.composer), // Send to composer
        amountLD: usdcAmount,
        minAmountLD: minUSDC,
        extraOptions: extraOptions,
        composeMsg: composeMsg,
        oftCmd: '0x',
    }

    console.log(`   Destination: Ethereum (EID ${CONFIG.ethereum.eid})`)
    console.log(`   Receiver: OVaultComposer (${CONFIG.contracts.ethereum.composer})`)
    console.log(`   Amount: ${ethers.utils.formatUnits(usdcAmount, 6)} USDC`)
    console.log(`   Min Amount: ${ethers.utils.formatUnits(minUSDC, 6)} USDC`)
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
    const stargatePool = new ethers.Contract(CONFIG.contracts.base.stargatePoolUSDC, stargatePoolAbi, baseProvider)

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
    // Step 6: Check and Approve USDC
    // ============================================================================

    console.log('\n' + '='.repeat(80))
    console.log('Step 6: Checking USDC Approval')
    console.log('='.repeat(80))

    const erc20Abi = [
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
    ]
    const usdc = new ethers.Contract(CONFIG.contracts.base.usdc, erc20Abi, baseWallet)

    // Check balance
    const usdcBalance = await usdc.balanceOf(baseWallet.address)
    console.log(`   USDC Balance: ${ethers.utils.formatUnits(usdcBalance, 6)} USDC`)

    if (usdcBalance.lt(usdcAmount)) {
        throw new Error(
            `Insufficient USDC balance. Have ${ethers.utils.formatUnits(usdcBalance, 6)}, need ${ethers.utils.formatUnits(usdcAmount, 6)}`
        )
    }

    // Check and approve
    const currentAllowance = await usdc.allowance(baseWallet.address, CONFIG.contracts.base.stargatePoolUSDC)
    console.log(`   Current allowance: ${ethers.utils.formatUnits(currentAllowance, 6)} USDC`)

    if (currentAllowance.lt(usdcAmount)) {
        console.log(`   🔓 Approving USDC...`)
        const approveTx = await usdc.approve(CONFIG.contracts.base.stargatePoolUSDC, ethers.constants.MaxUint256)
        console.log(`   Transaction: ${approveTx.hash}`)
        await approveTx.wait()
        console.log(`   ✅ Approval confirmed`)
    } else {
        console.log(`   ✅ Sufficient allowance`)
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
    const stargatePoolWithSigner = new ethers.Contract(
        CONFIG.contracts.base.stargatePoolUSDC,
        sendAbi,
        baseWallet
    )

    console.log(`\n📋 Transaction Summary:`)
    console.log(`   From: Base`)
    console.log(`   Via: Ethereum (vault deposit)`)
    console.log(`   To: Katana`)
    console.log(`   Amount: ${CONFIG.transaction.usdcAmount} USDC`)
    console.log(`   Expected shares: ${ethers.utils.formatUnits(expectedShares, shareDecimals)} vbUSDC`)
    console.log(`   Final recipient: ${CONFIG.transaction.recipientAddress}`)
    console.log(`   Total ETH needed: ${ethers.utils.formatEther(firstHopFee)} ETH`)

    const messagingFee = {
        nativeFee: firstHopFee,
        lzTokenFee: 0,
    }

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
        baseWallet.address,
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
    console.log(`   • Sent: ${CONFIG.transaction.usdcAmount} USDC from Base`)
    console.log(`   • Expected shares: ~${ethers.utils.formatUnits(expectedShares, shareDecimals)} vbUSDC`)
    console.log(`   • Recipient on Katana: ${CONFIG.transaction.recipientAddress}`)
    console.log(`   • Total fee paid: ${ethers.utils.formatEther(firstHopFee)} ETH`)
    console.log(`\nWhat happens next:`)
    console.log(`   1. ⏳ Base → Ethereum: USDC bridges to OVaultComposer (~2-5 min)`)
    console.log(`   2. ⏳ On Ethereum: Composer deposits USDC and bridges shares (automatic)`)
    console.log(`   3. ⏳ Ethereum → Katana: Shares bridge to recipient (~2-5 min)`)
    console.log(`\n📍 Track your transaction:`)
    console.log(`   LayerZero Scan: https://layerzeroscan.com/tx/${tx.hash}`)
    console.log(`   Base Scan: https://basescan.org/tx/${tx.hash}`)
    console.log('\n✨ Your vbUSDC shares will arrive on Katana in ~5-10 minutes!')
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

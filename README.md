# LayerZero OVault Cross-Chain Scripts

Standalone scripts demonstrating cross-chain ERC4626 vault operations using LayerZero OFT and Stargate protocols.

## Overview

This project enables cross-chain vault operations across three chains:
- **Ethereum** - Main ERC4626 vault (hub chain)
- **Katana** - Users hold vault shares (e.g. vbUSDC, vbUSDT, vbWBTC)
- **Base** - Bridge assets for atomic operations

**Supported Assets:** USDC, USDT, and WBTC (ETH/WETH not supported)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure a Script

Open any script file and update the `CONFIG` object:

```typescript
const CONFIG = {
    privateKey: '0xYOUR_PRIVATE_KEY_HERE',
    
    transaction: {
        amount: '10.0',                              // Amount to transfer
        recipientAddress: '0xYOUR_RECIPIENT_ADDRESS',
        slippageBps: 50,                             // 0.5% slippage tolerance
    },
    
    // RPC URLs and contract addresses are pre-configured for mainnet
}
```

### 3. Run a Script

```bash
npm run 1    # Ethereum → Katana deposit
npm run 2    # Katana → Ethereum redemption
npm run 3    # Base → Katana atomic deposit
npm run 4    # Katana → Base atomic redemption
```

### Safe Mode (Gnosis Safe)

To generate a Safe Transaction Builder payload instead of executing directly:

```bash
npm run 1 -- --safe
npm run 2 -- --safe
npm run 3 -- --safe
npm run 4 -- --safe
```

No private key required. Outputs a JSON file to `safe_payloads/` that can be imported into the [Safe Transaction Builder](https://app.safe.global/). Each payload includes both the approval and the main transaction.

## Scripts

### [Script 1: Ethereum → Katana Deposit](#script-1-ethereum-to-katana-deposit)
Deposit asset on Ethereum, receive vault shares on Katana.

```bash
npm run 1
```

### [Script 2: Katana → Ethereum Redemption](#script-2-katana-to-ethereum-redemption)
Redeem vault shares from Katana, receive asset on Ethereum.

```bash
npm run 2
```

### [Script 3: Base → Katana Atomic](#script-3-base-to-katana-atomic)
Atomic operation: Send asset from Base, receive shares on Katana (via Ethereum).

```bash
npm run 3
```

### [Script 4: Katana → Base Atomic](#script-4-katana-to-base-atomic)
Atomic operation: Send shares from Katana, receive asset on Base (via Ethereum).

```bash
npm run 4
```

---

## Script Details

### Script 1: Ethereum to Katana Deposit

**Flow:**
```
Ethereum (asset) → Vault Deposit → Katana (vault shares)
```

**What it does:**
1. Approves asset to OVaultComposer on Ethereum
2. Composer deposits asset into vault, receives shares
3. Bridges shares to Katana via LayerZero OFT

**Requirements:**
- Asset balance on Ethereum (e.g. USDC, USDT, WBTC)
- ETH for gas fees

**File:** `scripts/1-ethereum-to-katana-deposit.ts`

**Example Transaction:**
- [LayerZero Scan](https://layerzeroscan.com/tx/0x4f8b1d59d2286a6d4d505e375ed696188647ce0410615e4dd08c2b43a10ccacc)

---

### Script 2: Katana to Ethereum Redemption

**Flow:**
```
Katana (vault shares) → Bridge → Ethereum Vault Redeem → asset
```

**What it does:**
1. Approves vault shares to Share OFT on Katana
2. Bridges shares to OVaultComposer on Ethereum
3. Composer redeems shares from vault (via lzCompose)
4. Asset sent to recipient on Ethereum

**Requirements:**
- Vault share balance on Katana (e.g. vbUSDC, vbUSDT, vbWBTC)
- Native token for gas + LayerZero fees

**File:** `scripts/2-katana-to-ethereum-redemption.ts`

**Configuration:**
```typescript
transaction: {
    amount: '10.0',
    recipientAddress: '0x...',
    composeGas: 800000,  // Gas for redemption callback
}
```

**Example Transactions:**
- [LayerZero Scan](https://layerzeroscan.com/tx/0x0a7c66e08bc51ec004302a5dafd2e7092c95ae0e90d36fcf044ab75e2a89fe3f) (bridge)
- [Etherscan](https://etherscan.io/tx/0x76af87d688cae656ab68b77328210285cf7edbd7ee71e5175911f42b6d7b2985) (lzCompose redemption)

---

### Script 3: Base to Katana Atomic

**Flow:**
```
Base (asset) → Stargate → Ethereum (Vault) → LayerZero → Katana (vault shares)
```

**What it does:**
1. Approves asset to Stargate Pool on Base
2. Single atomic transaction:
   - Stargate bridges asset to Ethereum
   - Composer deposits into vault (via lzCompose)
   - Composer bridges shares to Katana

**Requirements:**
- Asset balance on Base (e.g. USDC, USDT, WBTC)
- ETH for gas + LayerZero fees (covers all 3 chains)

**File:** `scripts/3-base-to-katana-atomic.ts`

**Configuration:**
```typescript
transaction: {
    amount: '10.0',           // Amount of asset to deposit (e.g. USDC)
    recipientAddress: '0x...',
    composeGas: 1000000,      // Gas for atomic operation
}
```

**Example Transactions:**
- [Hop 1: Base → Ethereum](https://layerzeroscan.com/tx/0x71bf33cab89949fff5174070d6ff7424e43c2cf1789151dbb8e543885703e95a) (Stargate asset bridge + vault deposit)
- [Hop 2: Ethereum → Katana](https://layerzeroscan.com/tx/0x42b09fce460301636367b8048c31ab89b30b9b35fab80cd098067615e66b99fa) (share bridge)

---

### Script 4: Katana to Base Atomic

**Flow:**
```
Katana (vault shares) → LayerZero → Ethereum (Vault) → Stargate → Base (asset)
```

**What it does:**
1. Approves vault shares to Share OFT on Katana
2. Single atomic transaction:
   - Share OFT bridges to Ethereum
   - Composer redeems from vault (via lzCompose)
   - Composer bridges asset to Base via Stargate

**Requirements:**
- Vault share balance on Katana (e.g. vbUSDC, vbUSDT, vbWBTC)
- Native token for gas + LayerZero fees (covers all 3 chains)

**File:** `scripts/4-katana-to-base-atomic.ts`

**Configuration:**
```typescript
transaction: {
    amount: '10.0',           // Amount of vault shares to redeem (e.g. vbUSDC)
    recipientAddress: '0x...',
    composeGas: 1000000,      // Gas for atomic operation
}
```

**Example Transactions:**
- [Hop 1: Katana → Ethereum](https://layerzeroscan.com/tx/0x9d01ee2a3f7cea3dd3e03f2a4efd231cd07f3db1ee624862e41011ad549879b4) (share bridge + vault redemption)
- [Hop 2: Ethereum → Base](https://layerzeroscan.com/tx/0xa783113d5bdcd59ff00d52ddd709a30d262457a2cd37e92800cca6febe05ce44) (Stargate asset bridge)

---

## Katana Vault Bridge vs Standard Bridging

The key differences between bridging assets to/from **Katana network** (using Vault Bridge) versus standard LayerZero OFT/Stargate bridging to other layer 2 networks.

---

## Key Differences

| Aspect | Standard Bridge | Katana Vault Bridge |
|--------|-----------------|---------------------|
| **Asset** | Same token in/out | Asset in → vault shares out (e.g. USDC → vbUSDC) |
| **Yield** | None | Underlying earns via Morpho vaults |
| **Contracts** | 1 (Pool/OFT) | 3+ (Vault + Composer + OFT) |
| **Compose** | Optional | Required for redemptions |
| **Gas** | ~100-200k | 800k-1.2M |
| **Hub Chain** | Direct | Always routes through Ethereum |
| **Supported Assets** | Any OFT | USDC, USDT, WBTC only (no ETH/WETH currently) |

---

## Difference #1: Token Type Received

| Network | Token Deposited | Token Received | Mechanism |
|---------|-----------------|----------------|-----------|
| **Katana** | Asset (e.g. USDC) | **Vault shares** (e.g. vbUSDC) | ERC4626 vault deposit + OFT bridge |
| **Other L2** | USDC | USDC | Standard Stargate/OFT bridge |

**Katana-specific**: You receive **yield-bearing vault shares**, not the underlying asset.

---

## Difference #2: Contract Architecture

### Standard Bridge (Base ↔ Ethereum)
```
Stargate Pool.send() → LayerZero → Stargate Pool.lzReceive()
```
- Single contract type (Stargate Pool)
- Direct token transfer

### Katana Bridge (via OVaultComposer)
```
User → OVaultComposer.depositAndSend() → [Vault.deposit() + ShareOFT.send()]
```
- Multiple contracts orchestrated:
  - `VaultBridge` (0x53E8...) - ERC4626 vault
  - `OVaultComposer` (0x8A35...) - orchestration layer
  - `Share OFT Adapter` (0xb5bA...) - cross-chain share transfer

---

## Difference #3: Functions Used

| Operation | Standard OFT/Stargate | Katana Vault Bridge |
|-----------|----------------------|---------------------|
| **Deposit** | `pool.send()` | `composer.depositAndSend()` |
| **Quote** | `pool.quoteSend()` | `vault.previewDeposit()` + `shareOFT.quoteSend()` |
| **Redeem** | `pool.send()` | `shareOFT.send()` with `lzCompose` callback |
| **Preview** | N/A | `vault.previewDeposit()` / `vault.previewRedeem()` |

---

## Difference #4: Compose Messages (Multi-hop)

Katana requires `lzCompose` for redemption flows. The compose message encodes the next-hop instructions:

```typescript
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
        secondHopValue,  // ETH for second hop
    ]
)
```

**Standard bridges** don't need this compose pattern - they're single-hop.

---

## Difference #5: Gas Requirements

| Script | Network Flow | Compose Gas | Notes |
|--------|--------------|-------------|-------|
| **Script 1** | ETH → Katana | N/A | Simple deposit+bridge |
| **Script 2** | Katana → ETH | **800,000** | Needs compose for vault redemption |
| **Script 3** | Base → Katana | **1,000,000** | Two-hop: Stargate + Vault + OFT |
| **Script 4** | Katana → Base | **1,200,000** | Two-hop: OFT + Vault + Stargate |

**Standard bridges** typically need ~100,000-200,000 gas.

---

## Difference #6: Flow Patterns

### Depositing TO Katana

#### Direct from Ethereum (Script 1)
```
1. approve(asset → OVaultComposer)
2. composer.depositAndSend(amount, sendParam, refund)
   └── internally: vault.deposit() → shareOFT.send()
```

#### Atomic from Base (Script 3 - 2-hop)
```
1. approve(asset → Stargate Pool)
2. stargatePool.send() with composeMsg
   └── Hop 1: Base → Ethereum (asset via Stargate)
   └── lzCompose: composer deposits + bridges shares
   └── Hop 2: Ethereum → Katana (shares via OFT)
```

### Withdrawing FROM Katana

#### To Ethereum (Script 2)
```
1. approve(vault shares → Share OFT on Katana)
2. shareOFT.send() with composeMsg
   └── bridges shares to OVaultComposer
   └── lzCompose: composer.redeem() → sends asset to recipient
```

#### Atomic to Base (Script 4 - 2-hop)
```
1. approve(vault shares → Share OFT on Katana)
2. shareOFT.send() with nested composeMsg
   └── Hop 1: Katana → Ethereum (shares via OFT)
   └── lzCompose: composer.redeem() + stargate.send()
   └── Hop 2: Ethereum → Base (asset via Stargate)
```

---

## Difference #7: Options Builder Pattern

### Katana redemption requires compose options:
```typescript
const options = Options.newOptions()
    .addExecutorComposeOption(0, CONFIG.transaction.composeGas, secondHopValue)
const extraOptions = options.toHex()
```

### Standard OFT just needs receive option:
```typescript
const options = Options.newOptions()
    .addExecutorLzReceiveOption(100000, 0)
```

---



## Contract Addresses (Mainnet)

> The addresses below are **example values for vbUSDC**. Replace with the corresponding addresses for the vault asset you are using (e.g. vbUSDT, vbWBTC).

### Ethereum (EID: 30101)
| Contract | Address | Notes |
|----------|---------|-------|
| Asset | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | e.g. USDC |
| Vault | `0x53E82ABbb12638F09d9e624578ccB666217a765e` | ERC4626 vault for the asset |
| OVaultComposer | `0x8A35897fda9E024d2aC20a937193e099679eC477` | Composer for the vault |
| Share OFT Adapter | `0xb5bADA33542a05395d504a25885e02503A957Bb3` | Share OFT on Ethereum |
| Stargate Pool | `0xc026395860Db2d07ee33e05fE50ed7bD583189C7` | e.g. Stargate USDC Pool |

### Base (EID: 30184)
| Contract | Address | Notes |
|----------|---------|-------|
| Asset | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` | e.g. USDC on Base |
| Stargate Pool | `0x27a16dc786820B16E5c9028b75B99F6f604b5d26` | e.g. Stargate USDC Pool on Base |

### Katana (EID: 30375)
| Contract | Address | Notes |
|----------|---------|-------|
| Vault Share Token | `0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36` | e.g. vbUSDC on Katana |
| Share OFT | `0x807275727Dd3E640c5F2b5DE7d1eC72B4Dd293C0` | Share OFT on Katana |

---

## Gas Settings

| Script | Compose Gas | Status |
|--------|-------------|--------|
| Script 1 | N/A | ✅ Tested |
| Script 2 | 800,000 | ✅ Tested |
| Script 3 | 1,000,000 | ✅ Tested |
| Script 4 | 1,000,000 | ✅ Tested |

---

## Troubleshooting

### "Please set your private key"
Update `CONFIG.privateKey` in the script file.

### "Please set the Katana RPC URL"
Required for scripts 2 & 4. Update `CONFIG.katana.rpcUrl`.

### "Insufficient balance"
Ensure your wallet has:
- Tokens on the source chain
- Native token for gas fees
- For atomic scripts, the first hop fee covers all chains

### "lzCompose failed" or "execution reverted"
Increase `composeGas`:
- Script 2: Minimum 800,000
- Scripts 3 & 4: Minimum 1,000,000

### Transaction takes long
Cross-chain operations take 3-10 minutes. Track progress at [LayerZero Scan](https://layerzeroscan.com/).

---

## Important Notes

- **Never commit private keys** - Use environment variables in production
- **Test with small amounts** before running larger transactions
- **Verify contract addresses** on Etherscan/Basescan before use
- Cross-chain transactions are atomic - they fully succeed or fully revert
- LayerZero messaging fees are paid on the source chain

---

## Resources

- [LayerZero Documentation](https://docs.layerzero.network/)
- [LayerZero Scan](https://layerzeroscan.com/) - Track cross-chain transactions
- [Stargate Documentation](https://stargateprotocol.gitbook.io/)
- [ERC4626 Standard](https://eips.ethereum.org/EIPS/eip-4626)

---

## License

ISC

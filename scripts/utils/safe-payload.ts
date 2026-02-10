import * as fs from 'fs'
import * as path from 'path'

export interface SafeTransaction {
    to: string
    value: string
    data: string
    operation: number
}

export function isSafeMode(): boolean {
    return process.argv.includes('--safe')
}

export function buildSafeTx(to: string, data: string, value: string = '0'): SafeTransaction {
    return { to, value, data, operation: 0 }
}

export function writeSafePayload(
    scriptNumber: number,
    chainId: number,
    description: string,
    transactions: SafeTransaction[]
): string {
    const payload = {
        version: '1.0',
        chainId: chainId.toString(),
        createdAt: Date.now(),
        meta: {
            name: `Script ${scriptNumber}`,
            description,
        },
        transactions,
    }

    const dir = path.resolve(__dirname, '..', '..', 'safe_payloads')
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }

    const now = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const filename = `${scriptNumber}-${timestamp}.json`
    const filepath = path.join(dir, filename)

    fs.writeFileSync(filepath, JSON.stringify(payload, null, 2))
    return filepath
}

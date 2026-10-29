import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
function tokenAccount(mint, wallet) { return PublicKey.findProgramAddressSync([wallet.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0]; }
import bs58 from 'bs58';
import { PlayerError, ensure } from './errors.js';
function checkEntry(prepared, attempt, funds, wallet, operation, signed) {
    operation.check();
    try {
        const check = (v) => ensure(v, 'SIGNATURE_REFUSED');
        check(funds.wallet === wallet.publicKey.toBase58() && funds.entry && funds.entry.ready && funds.entry.round === attempt.round);
        const entry = funds.entry;
        check(funds.token.decimals === 6 && entry.burnUnits === attempt.burnUnits && attempt.burnUnits === ['100000000000', '250000000000', '500000000000'][attempt.round - 1]);
        check(Number.isSafeInteger(attempt.season) && attempt.season >= 1 && attempt.season <= 0xffffffff && /^[a-f0-9]{64}$/.test(attempt.commitment) && /^[a-f0-9]{64}$/.test(attempt.rubricVersion));
        check(/^[a-f0-9-]{36}$/.test(attempt.id) && Number.isSafeInteger(prepared.lastValidBlockHeight) && prepared.lastValidBlockHeight > 0);
        check(prepared.transaction.length <= 1644 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(prepared.transaction));
        const raw = Buffer.from(prepared.transaction, 'base64');
        check(raw.length <= 1232 && raw.toString('base64') === prepared.transaction);
        const tx = Transaction.from(raw);
        check(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).equals(raw));
        check(tx.instructions.length === 1 && tx.feePayer?.equals(wallet.publicKey) && tx.recentBlockhash === prepared.blockhash && new PublicKey(prepared.blockhash).toBase58() === prepared.blockhash);
        const program = new PublicKey(entry.program), judge = new PublicKey(entry.judge), mint = new PublicKey(funds.token.mint);
        const game = PublicKey.findProgramAddressSync([Buffer.from('game')], program)[0];
        check(game.toBase58() === entry.game);
        const hash = createHash('sha256').update(attempt.id).digest();
        const receipt = PublicKey.findProgramAddressSync([Buffer.from('entry'), game.toBuffer(), hash], program)[0];
        const expected = [wallet.publicKey, game, receipt, tokenAccount(mint, wallet.publicKey), mint, TOKEN_2022_PROGRAM_ID, SystemProgram.programId, judge];
        check(new Set(expected.map(k => k.toBase58())).size === 8);
        const ix = tx.instructions[0];
        check(ix.programId.equals(program) && ix.keys.length === 8);
        ix.keys.forEach((k, i) => check(k.pubkey.equals(expected[i]) && k.isSigner === (i === 0 || i === 7) && k.isWritable === (i < 5)));
        const data = Buffer.alloc(110);
        data[0] = 1;
        hash.copy(data, 1);
        Buffer.from(attempt.commitment, 'hex').copy(data, 33);
        Buffer.from(attempt.rubricVersion, 'hex').copy(data, 65);
        data.writeUInt32LE(attempt.season, 97);
        data[101] = attempt.round;
        data.writeBigUInt64LE(BigInt(attempt.burnUnits), 102);
        check(ix.data.equals(data));
        check(tx.signatures.length === 2 && tx.signatures[0].publicKey.equals(wallet.publicKey) && (signed ? tx.signatures[0].signature?.length === 64 : tx.signatures[0].signature === null) && tx.signatures[1].publicKey.equals(judge) && tx.signatures[1].signature?.length === 64 && tx.verifySignatures(signed));
        operation.check();
        return tx;
    }
    catch (error) {
        if (error instanceof PlayerError)
            throw error;
        throw new PlayerError('SIGNATURE_REFUSED');
    }
}
export function signEntry(prepared, attempt, funds, wallet, operation) {
    const tx = checkEntry(prepared, attempt, funds, wallet, operation, false);
    try {
        const check = (v) => ensure(v, 'SIGNATURE_REFUSED');
        const message = tx.serializeMessage(), priorJudge = Buffer.from(tx.signatures[1].signature);
        operation.check();
        tx.partialSign(wallet);
        operation.check();
        check(tx.serializeMessage().equals(message) && tx.signatures[1].signature?.equals(priorJudge) && tx.verifySignatures());
        return { transaction: tx.serialize().toString('base64'), signature: bs58.encode(tx.signatures[0].signature), blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight };
    }
    catch (error) {
        if (error instanceof PlayerError)
            throw error;
        throw new PlayerError('SIGNATURE_REFUSED');
    }
}
export function validateSignedEntry(signed, attempt, funds, wallet, operation) {
    const tx = checkEntry(signed, attempt, funds, wallet, operation, true);
    ensure(bs58.encode(tx.signatures[0].signature) === signed.signature, 'SIGNATURE_REFUSED');
    operation.check();
}
export function validatePreparedEntry(prepared, attempt, funds, wallet, operation) { checkEntry(prepared, attempt, funds, wallet, operation, false); }

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bs58 = require("bs58");
const fetch = require("node-fetch");
const Claim = require("./models/Claim");
const ReferralClaim = require("./models/ReferralClaim"); // New model import

const {
  Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  getMint,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} = require("@solana/spl-token");

const app = express();
app.use(cors());
app.use(express.json());

const connection = new Connection(process.env.RPC_URL, "confirmed");
mongoose.connect(process.env.MONGO_URI, { dbName: "wallet_cache" });

const MEME_MINT = new PublicKey(process.env.MEME_MINT);
const CLAIM_FEE_LAMPORTS = BigInt(process.env.CLAIM_FEE_LAMPORTS || "15000000");
const FEE_COLLECTOR = new PublicKey(process.env.FEE_COLLECTOR);
const PORT = process.env.PORT || 5001;

// Treasury (server signs token transfer)
const TREASURY = Keypair.fromSecretKey(
  (() => {
    try {
      return Uint8Array.from(JSON.parse(process.env.TREASURY_SECRET));
    } catch {
      const decoder = bs58.decode || bs58.default?.decode;
      if (!decoder) throw new Error("bs58 decode function not found");
      return decoder(process.env.TREASURY_SECRET);
    }
  })()
);

const toPk = (s) => new PublicKey(s);

// ---- helper: fetch final allocation from checker (server-side truth) ----
async function getEligibility(wallet) {
  const url = `${process.env.CHECKER_URL}/check-eligibility?wallet=${wallet}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Checker ${r.status}`);
  return r.json();
}

/**
 * STEP A: build fee-payment tx (user -> fee_collector)
 * Client signs & sends this, then calls /claim/complete
 */
app.post("/claim/init-fee", async (req, res) => {
  try {
    const wallet = (req.body.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });
    const userPk = toPk(wallet);

    // if already claimed, stop
    const already = await Claim.findOne({ wallet: wallet.toLowerCase() });
    if (already) return res.status(400).json({ error: "Already claimed" });

    // build SOL transfer tx to fee collector
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    const tx = new Transaction({ feePayer: userPk, recentBlockhash: blockhash });
    tx.add(SystemProgram.transfer({
      fromPubkey: userPk,
      toPubkey: FEE_COLLECTOR,
      lamports: Number(CLAIM_FEE_LAMPORTS),
    }));

    // serialize (no server sign here)
    const b64 = tx.serialize({ requireAllSignatures: false }).toString("base64");
    res.json({ transaction: b64 });
  } catch (e) {
    console.error("init-fee error", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * STEP B: verify fee tx on-chain, recompute allocation, then send tokens from treasury
 * Body: { wallet, feeSig }
 */
app.post("/claim/complete", async (req, res) => {
  try {
    const { wallet, feeSig } = req.body || {};
    if (!wallet || !feeSig) return res.status(400).json({ error: "Missing wallet/feeSig" });

    // 1) block double claim
    const exists = await Claim.findOne({ wallet: wallet.toLowerCase() });
    if (exists) return res.status(400).json({ error: "Already claimed" });

    // 2) verify $fee transfer
    const parsed = await connection.getParsedTransaction(feeSig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!parsed || !parsed.meta || parsed.meta.err) {
      return res.status(400).json({ error: "Fee tx not found or failed" });
    }

    // must contain a SystemProgram transfer to FEE_COLLECTOR with exact lamports, and signer == wallet
    let ok = false;
    const messageAccs = parsed.transaction.message.accountKeys.map(a => a.pubkey.toBase58());
    const fromCandidate = messageAccs[0]; // signer usually index 0
    const signerMatches = fromCandidate === wallet;

    for (const ix of parsed.transaction.message.instructions) {
      // parsed ix only available in parsed form
      const asParsed = ix;
      if (asParsed.program !== "system") continue;
      if (asParsed.parsed?.type !== "transfer") continue;

      const info = asParsed.parsed?.info;
      if (!info) continue;

      const to = info.destination;
      const from = info.source;
      const lamports = BigInt(info.lamports);

      if (to === FEE_COLLECTOR.toBase58() &&
        from === wallet &&
        lamports === CLAIM_FEE_LAMPORTS &&
        signerMatches) {
        ok = true;
        break;
      }
    }
    if (!ok) return res.status(400).json({ error: "Fee payment invalid (amount/to/from mismatch)" });

    // 3) recompute final allocation (never trust client)
    const eg = await getEligibility(wallet);
    if (!eg?.eligible || !eg?.finalTotal) {
      return res.status(403).json({ error: "Not eligible" });
    }
    // ensure number-like string
    const finalHuman = `${eg.finalTotal}`; // e.g. "40000"
    const mintInfo = await getMint(connection, MEME_MINT);
    const dec = mintInfo.decimals;

    // BigInt 10^dec safely (NO Number math)
    const multiplier = (BigInt(10) ** BigInt(dec));
    // finalHuman may be integer string only; if you support decimals in allocation, split and scale accordingly
    if (!/^\d+$/.test(finalHuman)) {
      return res.status(400).json({ error: "finalTotal must be integer tokens (no decimal) on UI/server" });
    }
    const amountSmallest = BigInt(finalHuman) * multiplier;

    // 4) ensure treasury has enough token balance
    const treasuryATA = getAssociatedTokenAddressSync(MEME_MINT, TREASURY.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const treasAcc = await getAccount(connection, treasuryATA);
    if (treasAcc.amount < amountSmallest) {
      return res.status(400).json({ error: "Treasury balance insufficient" });
    }

    // 5) prepare user ATA (create if missing)
    const userPk = toPk(wallet);
    const userATA = getAssociatedTokenAddressSync(MEME_MINT, userPk, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const userAtaInfo = await connection.getAccountInfo(userATA);

    const { blockhash } = await connection.getLatestBlockhash("finalized");
    const tx = new Transaction({ feePayer: TREASURY.publicKey, recentBlockhash: blockhash });

    if (!userAtaInfo) {
      tx.add(createAssociatedTokenAccountInstruction(
        TREASURY.publicKey,    // payer (treasury pays rent)
        userATA,
        userPk,
        MEME_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ));
    }

    // 6) transfer tokens
    tx.add(createTransferInstruction(
      treasuryATA,
      userATA,
      TREASURY.publicKey,
      Number(amountSmallest), // ok here: instruction expects number, but BEWARE > 2^53; devnet/airdrop sizes usually fine. For >2^53 use v0 tx & u64 helper.
      [],
      TOKEN_PROGRAM_ID
    ));

    // 7) sign & send
    const sig = await connection.sendTransaction(tx, [TREASURY], { skipPreflight: false });
    await connection.confirmTransaction(sig, "finalized");

    // 8) save single source of truth AFTER success
    await Claim.create({
      wallet: wallet.toLowerCase(),
      amount: amountSmallest.toString(),
      humanAmount: finalHuman,
      decimals: dec,
      tier: typeof eg.tier === "number" ? eg.tier : null,
      txSig: sig,
      feeSig,
      status: "confirmed",
    });

    res.json({ ok: true, txSig: sig, amount: finalHuman, decimals: dec });
  } catch (e) {
    console.error("complete error", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * NEW: Endpoint for claiming referral bonus
 * Body: { wallet, txSig }
 */
app.post("/claim/referral", async (req, res) => {
  try {
    const { wallet, txSig } = req.body || {};
    if (!wallet || !txSig) {
      return res.status(400).json({ error: "Missing wallet or txSig" });
    }
    const normalizedWallet = wallet.toLowerCase();
    const userPk = toPk(wallet);

    // 1) Block double claim using the new model
    const already = await ReferralClaim.findOne({ wallet: normalizedWallet });
    if (already) {
      return res.status(400).json({ error: "Referral bonus already claimed" });
    }

    // 2) Verify dummy transaction signature
    const confirmedTx = await connection.getSignatureStatus(txSig, { searchTransactionHistory: true });
    if (confirmedTx.value?.confirmationStatus !== 'finalized') {
      return res.status(400).json({ error: 'Transaction is not confirmed.' });
    }

    // 3) Recompute referral bonus amount from checker (server-side truth)
    const eg = await getEligibility(wallet);
    const referralBonus = eg?.referralBonus;

    if (!referralBonus || referralBonus <= 0) {
      return res.status(400).json({ error: "No pending referral bonus to claim." });
    }
    
    // Ensure amount is integer
    const finalHuman = `${referralBonus}`;
    if (!/^\d+$/.test(finalHuman)) {
      return res.status(400).json({ error: "Referral bonus must be integer tokens (no decimal) on server" });
    }

    const mintInfo = await getMint(connection, MEME_MINT);
    const dec = mintInfo.decimals;
    const multiplier = (BigInt(10) ** BigInt(dec));
    const amountSmallest = BigInt(finalHuman) * multiplier;

    // 4) Ensure treasury has enough token balance
    const treasuryATA = getAssociatedTokenAddressSync(MEME_MINT, TREASURY.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const treasAcc = await getAccount(connection, treasuryATA);
    if (treasAcc.amount < amountSmallest) {
      return res.status(500).json({ error: "Treasury balance insufficient for referral bonus" });
    }

    // 5) Prepare user ATA (create if missing)
    const userATA = getAssociatedTokenAddressSync(MEME_MINT, userPk, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const userAtaInfo = await connection.getAccountInfo(userATA);

    const { blockhash } = await connection.getLatestBlockhash("finalized");
    const tx = new Transaction({ feePayer: TREASURY.publicKey, recentBlockhash: blockhash });

    if (!userAtaInfo) {
      tx.add(createAssociatedTokenAccountInstruction(
        TREASURY.publicKey,    // payer (treasury pays rent)
        userATA,
        userPk,
        MEME_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ));
    }

    // 6) Transfer referral bonus tokens
    tx.add(createTransferInstruction(
      treasuryATA,
      userATA,
      TREASURY.publicKey,
      Number(amountSmallest),
      [],
      TOKEN_PROGRAM_ID
    ));

    // 7) Sign & send the transaction
    const sig = await connection.sendTransaction(tx, [TREASURY], { skipPreflight: false });
    await connection.confirmTransaction(sig, "finalized");

    // 8) Save the referral claim to the new model AFTER success
    await ReferralClaim.create({
      wallet: normalizedWallet,
      amount: amountSmallest.toString(),
      txSig: sig,
      status: "confirmed",
    });

    res.json({
      ok: true,
      txSig: sig,
      amount: finalHuman,
      message: `Successfully claimed ${finalHuman} referral bonus.`,
    });

  } catch (e) {
    console.error("Referral claim error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/healthz", (_, res) => res.json({ ok: true, pubkey: TREASURY.publicKey.toBase58() }));

app.listen(PORT, () => console.log(`✅ Claim server on :${PORT}`));

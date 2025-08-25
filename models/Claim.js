const mongoose = require("mongoose");

const claimSchema = new mongoose.Schema({
  wallet: { type: String, unique: true, index: true },
  amount: { type: String },                 // smallest units (string)
  humanAmount: { type: String },            // human (eg. "40000")
  decimals: { type: Number },
  tier: { type: Number },
  txSig: { type: String },
  feeSig: { type: String },
  status: { type: String, enum: ["confirmed"], default: "confirmed" },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Claim", claimSchema);

// models/ReferralClaim.js

const mongoose = require("mongoose");



const referralClaimSchema = new mongoose.Schema({

  wallet: {

    type: String,

    required: true,

    unique: true,

  },

  amount: {

    type: String, // Store as string to avoid precision issues with BigInt

    required: true,

  },

  txSig: {

    type: String,

    required: true,

  },

  status: {

    type: String,

    enum: ["pending", "confirmed"],

    default: "pending",

  },

  createdAt: {

    type: Date,

    default: Date.now,

  },

});



module.exports = mongoose.model("ReferralClaim", referralClaimSchema);
// models/TxCache.js
const mongoose = require('mongoose');

const TxCacheSchema = new mongoose.Schema({
    wallet: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        index: true,
    },
    transactions: {
        type: mongoose.Schema.Types.Mixed, // Stores the array of transactions
        default: [],
    },
    updatedAt: {
        type: Date,
        default: Date.now,
        expires: '24h', // Cache will expire in 24 hours
    },
});

const TxCache = mongoose.model('TxCache', TxCacheSchema);

module.exports = TxCache;
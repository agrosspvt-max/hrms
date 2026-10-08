const mongoose = require('mongoose');
const { assertDatabaseTarget } = require('./runtimeSafety');

/**
 * Connects to MongoDB using MONGO_URI env var.
 * Exits the process on connection failure so issues are surfaced early.
 */
const connectDB = async () => {
  try {
    // Refuse (before any connection or write) a non-production process that
    // points at a shared remote database; see config/runtimeSafety.js.
    assertDatabaseTarget(process.env.MONGO_URI);
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      autoIndex: true,
    });
    console.log(`[DB] MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error(`[DB] MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;

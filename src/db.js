require("dotenv").config();
const mongoose = require("mongoose");

const DEFAULT_LOCAL_URI = "mongodb://127.0.0.1:27017/voltstation";
const mongoOptions = {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 20000
};

async function connect() {
  const primaryUri = (process.env.MONGODB_URI || "").trim();
  const fallbackUri = (process.env.MONGODB_LOCAL_URI || DEFAULT_LOCAL_URI).trim();
  const useLocalFallback = process.env.MONGODB_FALLBACK_LOCAL === "true";
  const candidateUris = [];

  if (primaryUri) candidateUris.push(primaryUri);
  if (useLocalFallback && fallbackUri && !candidateUris.includes(fallbackUri)) candidateUris.push(fallbackUri);

  if (!candidateUris.length) {
    console.warn("⚠️ No MongoDB URI configured. Set MONGODB_URI in .env or start a local MongoDB server.");
    return false;
  }

  for (const uri of candidateUris) {
    console.log("👉 Connecting to MongoDB:", uri);

    try {
      await mongoose.connect(uri, mongoOptions);
      console.log("✓ MongoDB connected");
      return true;
    } catch (error) {
      console.error("⚠️ MongoDB connection failed:", error.message);
    }
  }

  return false;
}

module.exports = { connect, mongoose };
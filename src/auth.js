// Authentication: hashed passwords (bcrypt) + signed tokens (JWT).
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "change-me-dev-secret";

const hash = pwd => bcrypt.hashSync(pwd, 10);
const compare = (pwd, h) => bcrypt.compareSync(pwd, h);
const sign = user => jwt.sign(
  { id: user._id.toString(), role: user.role, name: user.name },
  SECRET, { expiresIn: "7d" }
);
const verify = token => jwt.verify(token, SECRET);

// Require a valid token; attaches req.user = { id, role, name }.
function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "login required" });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch (e) { return res.status(401).json({ error: "invalid or expired token" }); }
}

// Require an admin (the station owner).
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
    next();
  });
}

module.exports = { hash, compare, sign, verify, requireAuth, requireAdmin };
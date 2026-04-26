const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());


// ========================================
// SAFE JSON READER
// ========================================
function safeReadJSON(file, fallback = []) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    return fallback;
  } catch (err) {
    console.log("❌ JSON READ ERROR:", file, err);
    return fallback;
  }
}


// ========================================
// SAFE JSON WRITER
// ========================================
function safeWriteJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.log("❌ JSON WRITE ERROR:", file, err);
  }
}


// ========================================
// LOAD DATABASE FILES
// ========================================
let students = safeReadJSON("students.json", []);
let blockedAttempts = safeReadJSON("blockedAttempts.json", []);
let loginLogs = safeReadJSON("loginLogs.json", []);


// ========================================
// ADMIN NEVER EXPIRE EMAILS
// ========================================
const ADMIN_EMAILS = [
  "g10.educational.platform@gmail.com",
  "g10.educational.platform2@gmail.com",
  "g10.educational.platform3@gmail.com"
];


// ========================================
// ACTIVE LIVE SESSIONS (RAM)
// ========================================
let activeSessions = {};


// ========================================
// GET CLEAN REAL IP
// ========================================
function getClientIP(req) {
  let ip =
    req.headers["x-forwarded-for"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    req.ip ||
    "";

  if (ip.includes(",")) ip = ip.split(",")[0].trim();
  if (ip.includes("::ffff:")) ip = ip.replace("::ffff:", "");

  return ip;
}


// ========================================
// EXPIRY CHECK
// ========================================
function isExpired(email, expiresOn) {
  if (ADMIN_EMAILS.includes(email.toLowerCase())) {
    return false;
  }

  const expiryDate = new Date(expiresOn);
  const today = new Date();

  expiryDate.setHours(23, 59, 59, 999);

  return today > expiryDate;
}


// ========================================
// EXPIRING SOON CHECK
// ========================================
function getExpiringData(email, expiresOn) {
  if (ADMIN_EMAILS.includes(email.toLowerCase())) {
    return {
      expiringSoon: false,
      expiryDate: "2099-12-31"
    };
  }

  const expiryDate = new Date(expiresOn);
  const today = new Date();

  expiryDate.setHours(23, 59, 59, 999);

  const diffTime = expiryDate - today;
  const diffDays = diffTime / (1000 * 60 * 60 * 24);

  if (diffDays <= 3 && diffDays >= 0) {
    return {
      expiringSoon: true,
      expiryDate: expiresOn
    };
  }

  return {
    expiringSoon: false,
    expiryDate: expiresOn
  };
}


// ========================================
// LOGIN ROUTE
// ========================================
app.post("/login", (req, res) => {
  try {
    const { email, fingerprint } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const ip = getClientIP(req);

    // reload students live every login (important if file updated)
    students = safeReadJSON("students.json", []);

    // find genuine student
    const student = students.find(s =>
      s.email.toLowerCase() === normalizedEmail
    );

    // if now genuine registered, remove old fake block record
    if (student) {
      blockedAttempts = blockedAttempts.filter(b => b.email !== normalizedEmail);
      safeWriteJSON("blockedAttempts.json", blockedAttempts);
    }

    // ====================================
    // FAKE USER CONTROL
    // ====================================
    if (!student) {

      const blockedByEmail = blockedAttempts.find(b => b.email === normalizedEmail);
      if (blockedByEmail) {
        return res.json({ blocked: true });
      }

      const blockedByFingerprint = fingerprint
        ? blockedAttempts.find(b => b.fingerprint === fingerprint)
        : null;

      if (blockedByFingerprint) {
        return res.json({ blocked: true });
      }

      const trapToken = "trap_" + Math.random().toString(36).substring(2);

      activeSessions[normalizedEmail] = {
        token: trapToken,
        trap: true,
        loginTime: Date.now(),
        ip,
        fingerprint
      };

      blockedAttempts.push({
        email: normalizedEmail,
        ip,
        fingerprint,
        blocked: true,
        firstAttempt: new Date().toISOString()
      });

      safeWriteJSON("blockedAttempts.json", blockedAttempts);

      console.log("🚨 FAKE LOGIN TRAP:", normalizedEmail, ip);

      return res.json({
        trap: true,
        token: trapToken,
        minutes: 5
      });
    }

    // ====================================
    // EXPIRED CHECK
    // ====================================
    if (isExpired(normalizedEmail, student.expiresOn)) {
      return res.json({ expired: true });
    }

    const expiryInfo = getExpiringData(normalizedEmail, student.expiresOn);

    // ====================================
    // GENUINE SESSION CREATE
    // ====================================
    const token = Math.random().toString(36).substring(2);

    activeSessions[normalizedEmail] = {
      token,
      trap: false,
      ip,
      fingerprint
    };

    loginLogs.push({
      email: normalizedEmail,
      ip,
      fingerprint,
      loginTime: new Date().toISOString()
    });

    if (loginLogs.length > 500) {
      loginLogs = loginLogs.slice(-500);
    }

    safeWriteJSON("loginLogs.json", loginLogs);

    console.log("✅ GENUINE LOGIN:", normalizedEmail, ip);

    return res.json({
      token,
      expiringSoon: expiryInfo.expiringSoon,
      expiryDate: expiryInfo.expiryDate
    });

  } catch (err) {
    console.log("❌ LOGIN ERROR:", err);
    return res.status(500).json({ error: "Server login error" });
  }
});


// ========================================
// VALIDATE ROUTE
// ========================================
app.post("/validate", (req, res) => {
  try {
    const { email, token, fingerprint } = req.body;

    if (!email || !token) {
      return res.json({ valid: false });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const ip = getClientIP(req);

    const session = activeSessions[normalizedEmail];

    if (!session) {
      return res.json({ valid: false });
    }

    // trap validation
    if (session.trap) {
      const trapValid =
        session.token === token &&
        session.ip === ip &&
        session.fingerprint === fingerprint;

      if (!trapValid) {
        return res.json({ valid: false });
      }

      const elapsed = Date.now() - session.loginTime;

      if (elapsed > 5 * 60 * 1000) {
        delete activeSessions[normalizedEmail];
        return res.json({ valid: false, trapExpired: true });
      }

      return res.json({
        valid: true,
        trap: true,
        remaining: Math.ceil((5 * 60 * 1000 - elapsed) / 1000)
      });
    }

    // genuine validation
    students = safeReadJSON("students.json", []);

    const student = students.find(s =>
      s.email.toLowerCase() === normalizedEmail
    );

    if (!student) {
      return res.json({ valid: false });
    }

    if (isExpired(normalizedEmail, student.expiresOn)) {
      return res.json({ valid: false, expired: true });
    }

    const expiryInfo = getExpiringData(normalizedEmail, student.expiresOn);

    const valid =
      session.token === token &&
      session.ip === ip &&
      session.fingerprint === fingerprint;

    return res.json({
      valid,
      trap: false,
      expiringSoon: expiryInfo.expiringSoon,
      expiryDate: expiryInfo.expiryDate
    });

  } catch (err) {
    console.log("❌ VALIDATE ERROR:", err);
    return res.status(500).json({ valid: false });
  }
});


// ========================================
// FRONTEND
// ========================================
app.use(express.static(path.join(__dirname, "Public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "index.html"));
});


// ========================================
// START SERVER
// ========================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
});

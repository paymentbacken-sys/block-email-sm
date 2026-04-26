const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();

app.set("trust proxy", true); // IMPORTANT FOR RENDER REAL IP

app.use(cors());
app.use(express.json());


// ===============================
// LOAD STUDENTS
// ===============================
let students = JSON.parse(fs.readFileSync("students.json"));


// ===============================
// ACTIVE LIVE SESSIONS
// ===============================
let activeSessions = {};


// ===============================
// BLOCKED FAKE LOGIN ATTEMPTS
// ===============================
let blockedAttempts = fs.existsSync("blockedAttempts.json")
  ? JSON.parse(fs.readFileSync("blockedAttempts.json"))
  : [];

function saveBlockedAttempts(){
  fs.writeFileSync("blockedAttempts.json", JSON.stringify(blockedAttempts,null,2));
}


// ===============================
// GENUINE LOGIN LOGS
// ===============================
let loginLogs = fs.existsSync("loginLogs.json")
  ? JSON.parse(fs.readFileSync("loginLogs.json"))
  : [];

function saveLoginLogs(){
  fs.writeFileSync("loginLogs.json", JSON.stringify(loginLogs,null,2));
}


// ===============================
// GET CLEAN REAL IP FROM RENDER
// ===============================
function getClientIP(req){
  let ip =
    req.headers["x-forwarded-for"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    req.ip ||
    "";

  if(ip.includes(",")){
    ip = ip.split(",")[0].trim();
  }

  if(ip.includes("::ffff:")){
    ip = ip.replace("::ffff:", "");
  }

  return ip;
}


// ===============================
// EXPIRY CHECK
// ===============================
function isExpired(expiresOn){
  const expiryDate = new Date(expiresOn);
  const today = new Date();
  expiryDate.setHours(23,59,59,999);
  return today > expiryDate;
}


// ===============================
// EXPIRING SOON CHECK
// ===============================
function getExpiringData(expiresOn){
  const expiryDate = new Date(expiresOn);
  const today = new Date();

  expiryDate.setHours(23,59,59,999);

  const diffTime = expiryDate - today;
  const diffDays = diffTime / (1000*60*60*24);

  if(diffDays <= 3 && diffDays >= 0){
    return {
      expiringSoon:true,
      expiryDate:expiresOn
    };
  }

  return {
    expiringSoon:false,
    expiryDate:expiresOn
  };
}



// ===============================
// LOGIN ROUTE
// ===============================
app.post("/login",(req,res)=>{
  const { email, fingerprint } = req.body;

  if(!email){
    return res.status(400).json({error:"Email required"});
  }

  const normalizedEmail = email.toLowerCase().trim();
  const ip = getClientIP(req);


  // =========================================
  // PERMANENT BLOCK CHECK FOR FAKE USERS
  // =========================================
  const blocked = blockedAttempts.find(b =>
    b.email === normalizedEmail ||
    b.fingerprint === fingerprint ||
    (b.email === normalizedEmail && b.ip === ip)
  );

  if(blocked){
    return res.json({ blocked:true });
  }


  // =========================================
  // FIND REGISTERED STUDENT
  // =========================================
  const student = students.find(s =>
    s.email.toLowerCase() === normalizedEmail
  );


  // =========================================
  // TRAP MODE FOR UNREGISTERED EMAIL
  // =========================================
  if(!student){

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
      blocked:true,
      firstAttempt:new Date().toISOString()
    });

    saveBlockedAttempts();

    console.log("🚨 FAKE LOGIN TRAP:", normalizedEmail, ip);

    return res.json({
      trap:true,
      token:trapToken,
      minutes:5
    });
  }


  // =========================================
  // EXPIRED ACCOUNT CHECK
  // =========================================
  if(isExpired(student.expiresOn)){
    return res.json({ expired:true });
  }


  // =========================================
  // EXPIRING SOON INFO
  // =========================================
  const expiryInfo = getExpiringData(student.expiresOn);


  // =========================================
  // GENUINE LOGIN CREATE NEW SESSION
  // opening elsewhere auto destroys old session
  // =========================================
  const token = Math.random().toString(36).substring(2);

  activeSessions[normalizedEmail] = {
    token,
    trap:false,
    ip,
    fingerprint
  };


  loginLogs.push({
    email: normalizedEmail,
    ip,
    fingerprint,
    loginTime:new Date().toISOString()
  });
  saveLoginLogs();

  console.log("✅ GENUINE LOGIN:", normalizedEmail, ip);

  return res.json({
    token,
    expiringSoon: expiryInfo.expiringSoon,
    expiryDate: expiryInfo.expiryDate
  });
});




// ===============================
// VALIDATE ROUTE
// ===============================
app.post("/validate",(req,res)=>{
  const { email, token, fingerprint } = req.body;

  if(!email || !token){
    return res.json({ valid:false });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const ip = getClientIP(req);

  const session = activeSessions[normalizedEmail];

  if(!session){
    return res.json({ valid:false });
  }


  // =========================================
  // TRAP SESSION VALIDATION
  // =========================================
  if(session.trap){

    const trapValid =
      session.token === token &&
      session.ip === ip &&
      session.fingerprint === fingerprint;

    if(!trapValid){
      return res.json({ valid:false });
    }

    const elapsed = Date.now() - session.loginTime;

    if(elapsed > 5*60*1000){
      delete activeSessions[normalizedEmail];
      return res.json({ valid:false, trapExpired:true });
    }

    return res.json({
      valid:true,
      trap:true,
      remaining: Math.ceil((5*60*1000 - elapsed)/1000)
    });
  }


  // =========================================
  // GENUINE ACCOUNT VALIDATION
  // =========================================
  const student = students.find(s =>
    s.email.toLowerCase() === normalizedEmail
  );

  if(!student){
    return res.json({ valid:false });
  }

  if(isExpired(student.expiresOn)){
    return res.json({ valid:false, expired:true });
  }

  const expiryInfo = getExpiringData(student.expiresOn);


  const valid =
    session.token === token &&
    session.ip === ip &&
    session.fingerprint === fingerprint;

  return res.json({
    valid,
    expiringSoon: expiryInfo.expiringSoon,
    expiryDate: expiryInfo.expiryDate
  });
});




// ===============================
// FRONTEND
// ===============================
app.use(express.static(path.join(__dirname,"Public")));

app.get("/",(req,res)=>{
  res.sendFile(path.join(__dirname,"Public","index.html"));
});




// ===============================
// SERVER START
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{
  console.log("🚀 Server running on",PORT);
});

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());


// ===============================
// LOAD STUDENTS
// ===============================
let students = JSON.parse(fs.readFileSync("students.json"));


// ===============================
// ADMIN EMAILS NEVER EXPIRE
// ===============================
const ADMIN_EMAILS = [
  "g10.educational.platform@gmail.com",
  "g10.educational.platform2@gmail.com",
  "g10.educational.platform3@gmail.com"
];


// ===============================
// ACTIVE SESSIONS FILE SAFE
// ===============================
let activeSessions = fs.existsSync("activeSessions.json")
  ? JSON.parse(fs.readFileSync("activeSessions.json"))
  : {};

function saveActiveSessions(){
  fs.writeFileSync("activeSessions.json", JSON.stringify(activeSessions,null,2));
}


// ===============================
// BLOCKED FAKE USERS
// ===============================
let blockedAttempts = fs.existsSync("blockedAttempts.json")
  ? JSON.parse(fs.readFileSync("blockedAttempts.json"))
  : [];

function saveBlockedAttempts(){
  fs.writeFileSync("blockedAttempts.json", JSON.stringify(blockedAttempts,null,2));
}


// ===============================
// LOGIN LOGS
// ===============================
let loginLogs = fs.existsSync("loginLogs.json")
  ? JSON.parse(fs.readFileSync("loginLogs.json"))
  : [];

function saveLoginLogs(){
  fs.writeFileSync("loginLogs.json", JSON.stringify(loginLogs,null,2));
}


// ===============================
// GET REAL IP
// ===============================
function getClientIP(req){
  let ip =
    req.headers["x-forwarded-for"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    req.ip ||
    "";

  if(ip.includes(",")) ip = ip.split(",")[0].trim();
  if(ip.includes("::ffff:")) ip = ip.replace("::ffff:","");

  return ip;
}


// ===============================
// EXPIRY CHECK
// ===============================
function isExpired(email, expiresOn){

  if(ADMIN_EMAILS.includes(email.toLowerCase())){
    return false;
  }

  const expiryDate = new Date(expiresOn);
  expiryDate.setHours(23,59,59,999);

  return new Date() > expiryDate;
}


// ===============================
// EXPIRING SOON CHECK
// ===============================
function getExpiringData(email, expiresOn){

  if(ADMIN_EMAILS.includes(email.toLowerCase())){
    return {
      expiringSoon:false,
      expiryDate:"2099-12-31"
    };
  }

  const expiryDate = new Date(expiresOn);
  expiryDate.setHours(23,59,59,999);

  const diffDays = (expiryDate - new Date())/(1000*60*60*24);

  return {
    expiringSoon: diffDays <= 3 && diffDays >= 0,
    expiryDate: expiresOn
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

  const student = students.find(s =>
    s.email.toLowerCase() === normalizedEmail
  );


  // genuine student remove old fake block
  if(student){
    blockedAttempts = blockedAttempts.filter(b => b.email !== normalizedEmail);
    saveBlockedAttempts();
  }


  // ===============================
  // FAKE USER HANDLING
  // ===============================
  if(!student){

    const permanentlyBlocked = blockedAttempts.find(b =>
      b.email === normalizedEmail ||
      b.fingerprint === fingerprint
    );

    if(permanentlyBlocked){
      return res.json({ blocked:true });
    }

    const trapToken = "trap_" + Math.random().toString(36).substring(2);

    activeSessions[normalizedEmail] = {
      token: trapToken,
      trap:true,
      loginTime: Date.now(),
      ip,
      fingerprint
    };
    saveActiveSessions();

    blockedAttempts.push({
      email: normalizedEmail,
      ip,
      fingerprint,
      blocked:true,
      firstAttempt:new Date().toISOString()
    });
    saveBlockedAttempts();

    console.log("🚨 FAKE LOGIN:", normalizedEmail);

    return res.json({
      trap:true,
      token:trapToken,
      minutes:5
    });
  }


  // ===============================
  // EXPIRED ACCOUNT
  // ===============================
  if(isExpired(normalizedEmail, student.expiresOn)){
    return res.json({ expired:true });
  }

  const expiryInfo = getExpiringData(normalizedEmail, student.expiresOn);


  // ===============================
  // GENUINE LOGIN SESSION
  // ===============================
  const token = Math.random().toString(36).substring(2);

  activeSessions[normalizedEmail] = {
    token,
    trap:false,
    ip,
    fingerprint
  };
  saveActiveSessions();


  loginLogs.push({
    email: normalizedEmail,
    ip,
    fingerprint,
    loginTime:new Date().toISOString()
  });

  if(loginLogs.length > 500){
    loginLogs = loginLogs.slice(-500);
  }

  saveLoginLogs();

  console.log("✅ GENUINE LOGIN:", normalizedEmail);

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


  // ===============================
  // TRAP VALIDATE
  // ===============================
  if(session.trap){

    const sameDevice =
      session.token === token &&
      session.ip === ip &&
      session.fingerprint === fingerprint;

    if(!sameDevice){
      return res.json({ valid:false });
    }

    const elapsed = Date.now() - session.loginTime;

    if(elapsed > 5*60*1000){
      delete activeSessions[normalizedEmail];
      saveActiveSessions();
      return res.json({ valid:false, trapExpired:true });
    }

    return res.json({
      valid:true,
      trap:true,
      remaining: Math.ceil((5*60*1000 - elapsed)/1000)
    });
  }


  // ===============================
  // GENUINE VALIDATE
  // ===============================
  const student = students.find(s =>
    s.email.toLowerCase() === normalizedEmail
  );

  if(!student){
    return res.json({ valid:false });
  }

  if(isExpired(normalizedEmail, student.expiresOn)){
    return res.json({ valid:false, expired:true });
  }

  const expiryInfo = getExpiringData(normalizedEmail, student.expiresOn);

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
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{
  console.log("🚀 Server running on",PORT);
});

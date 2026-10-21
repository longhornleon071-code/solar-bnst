// Solar BNST API. Zero dependencies. Requires Node 22+ (node:http, node:crypto, node:sqlite).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  throw new Error(`Solar BNST requires Node.js 22 or newer. Current version: ${process.versions.node}`);
}

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || "./solar-bnst.db";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const MAX_LOAD = 5;
// Serve the frontend from public/index.html (recommended) or index.html (legacy layout).
const INDEX_CANDIDATES = [
  new URL("./public/index.html", import.meta.url),
  new URL("./index.html", import.meta.url)
];
const INDEX_URL = INDEX_CANDIDATES.find(candidate => fs.existsSync(candidate));
if (!INDEX_URL) {
  throw new Error("Website HTML not found. Put index.html inside the public folder (public/index.html), or beside server.mjs.");
}
const INDEX = fs.readFileSync(INDEX_URL);

// ---------- roles (rank decides what each role may do) ----------
const ROLES = {
  visitor:     {rank:-1, label:"MEMBER",     color:"#8A8F98"},
  trial_mod:   {rank:1,  label:"TRIAL MOD",  color:"#7FD1AE"},
  trial_admin: {rank:2,  label:"TRIAL ADMIN",color:"#3BB8A8"},
  moderator:   {rank:3,  label:"MOD",        color:"#4A90E2"},
  admin:       {rank:4,  label:"ADMIN",      color:"#8B5CF6"},
  head_mod:    {rank:5,  label:"HEAD MOD",   color:"#2563EB"},
  head_admin:  {rank:6,  label:"HEAD ADMIN", color:"#DB2777"},
  co_owner:    {rank:7,  label:"CO-OWNER",   color:"#F5B301"},
  owner:       {rank:8,  label:"OWNER",      color:"#E11D48"}
};
const RANK_MANAGE_TX = 3;  // moderator and up: assign, move statuses, see all transactions
const RANK_ADMIN = 4;      // admin and up: assign MMs, move statuses, disputes, cancel
const RANK_CO = 7;      // co-owner and owner: admin panel (staff, moderation, revenue, audit, GC links, survey), change roles
const RANK_OWNER = 8;      // owner only: platform fee and owner-level settings
const rank = u => ROLES[u.role]?.rank ?? 0;
const roleLabel = r => ROLES[r]?.label || "MEMBER";

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL, mm_eligible INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  bio TEXT NOT NULL DEFAULT '', specialties TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, show_public INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS transactions(
  id TEXT PRIMARY KEY, buyer_name TEXT NOT NULL, buyer_fb TEXT NOT NULL, seller_name TEXT NOT NULL, seller_fb TEXT NOT NULL,
  item TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents > 0), currency TEXT NOT NULL,
  description TEXT NOT NULL, extra TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, mm_id INTEGER REFERENCES users(id),
  open_dispute INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE IF NOT EXISTS tx_history(id INTEGER PRIMARY KEY AUTOINCREMENT, tx_id TEXT NOT NULL REFERENCES transactions(id),
  from_status TEXT, to_status TEXT NOT NULL, actor_id INTEGER, reason TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
  tx_id TEXT, text TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, action TEXT NOT NULL,
  target TEXT, detail TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
  fb_url TEXT NOT NULL, created_by INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_images(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  mime TEXT NOT NULL, data BLOB NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,kind));
CREATE TABLE IF NOT EXISTS survey_responses(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, source TEXT NOT NULL,
  inviter TEXT NOT NULL DEFAULT '', feedback TEXT NOT NULL DEFAULT '', submitted_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS game_items(id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL CHECK(game IN ('adm','mm2')),
  name TEXT NOT NULL COLLATE NOCASE, value REAL, currency TEXT NOT NULL DEFAULT 'PHP', image_mime TEXT, image_data BLOB, image_at TEXT,
  updated_at TEXT NOT NULL, updated_by INTEGER, UNIQUE(game,name));
CREATE TABLE IF NOT EXISTS market_listings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL CHECK(game IN ('adm','mm2')),
  item_name TEXT NOT NULL,
  asking_price REAL NOT NULL CHECK(asking_price >= 0),
  notes TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','sold','removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
const USER_COLS = "id,username,name,pass_hash,role,mm_eligible,active,bio,specialties,created_at,show_public,google_sub,onboarded,purpose,referrer,join_stream,banned,ban_reason,suspended_until,suspend_reason,avatar_at,banner_at,can_edit_values";
// Columns added over time. Each ALTER is ignored if the column already exists.
for (const sql of [
  "ALTER TABLE users ADD COLUMN show_public INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN google_sub TEXT",
  "ALTER TABLE users ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE users ADD COLUMN purpose TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN referrer TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN join_stream INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN suspended_until TEXT",
  "ALTER TABLE users ADD COLUMN suspend_reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN avatar_at TEXT",
  "ALTER TABLE users ADD COLUMN banner_at TEXT",
  "ALTER TABLE users ADD COLUMN can_edit_values INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE game_items ADD COLUMN sheet TEXT NOT NULL DEFAULT 'Other'",
  "ALTER TABLE game_items ADD COLUMN image_url TEXT"
]) { try { db.exec(sql); } catch {} }
// Older databases had a CHECK that only allowed owner/admin/staff. Rebuild the table without it,
// copying every column (the ALTERs above have already added the newer ones).
{
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (t && /CHECK\s*\(\s*role/i.test(t.sql)) {
    db.exec(`PRAGMA foreign_keys=OFF;
    BEGIN;
    CREATE TABLE users_new(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
      pass_hash TEXT NOT NULL, role TEXT NOT NULL, mm_eligible INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      bio TEXT NOT NULL DEFAULT '', specialties TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      show_public INTEGER NOT NULL DEFAULT 0, google_sub TEXT, onboarded INTEGER NOT NULL DEFAULT 1,
      purpose TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '', join_stream INTEGER NOT NULL DEFAULT 0,
      banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT NOT NULL DEFAULT '', suspended_until TEXT,
      suspend_reason TEXT NOT NULL DEFAULT '', avatar_at TEXT, banner_at TEXT, can_edit_values INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users_new(${USER_COLS}) SELECT ${USER_COLS} FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys=ON;`);
  }
}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub)"); } catch {}
try { db.exec("UPDATE users SET role='visitor' WHERE role='staff'"); } catch {}

// ---------- statuses ----------
const S = {PENDING:"Pending Assignment",AWAIT:"Awaiting MM/MW Acceptance",ASSIGNED:"Assigned",GC:"Messenger GC Setup",
  PROG:"In Progress",CONF:"Awaiting Confirmation",DONE:"Completed",DISP:"Disputed",CANCEL:"Cancelled"};
const FINAL = [S.DONE, S.CANCEL];
const T = {
  [S.PENDING]:[S.AWAIT,S.CANCEL], [S.AWAIT]:[S.ASSIGNED,S.PENDING,S.CANCEL],
  [S.ASSIGNED]:[S.GC,S.DISP,S.CANCEL], [S.GC]:[S.PROG,S.DISP,S.CANCEL], [S.PROG]:[S.CONF,S.DISP,S.CANCEL],
  [S.CONF]:[S.DONE,S.PROG,S.DISP], [S.DISP]:[S.PROG,S.CANCEL], [S.DONE]:[], [S.CANCEL]:[]
};
const ADMIN_ONLY_TO = [S.DISP, S.CANCEL, S.DONE, S.PENDING];

// ---------- helpers ----------
class HttpError extends Error { constructor(code,msg,extra={}){ super(msg); this.code = code; this.extra = extra; } }
const fail = (code,msg,extra) => { throw new HttpError(code,msg,extra); };
const now = () => new Date().toISOString();
const q = (sql,...p) => db.prepare(sql).all(...p);
const one = (sql,...p) => db.prepare(sql).get(...p);
const run = (sql,...p) => db.prepare(sql).run(...p);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const full = (code,body,headers={}) => ({__full:true,code,body,headers});
function atomic(fn){ db.exec("BEGIN IMMEDIATE"); try{ const r = fn(); db.exec("COMMIT"); return r; } catch(e){ db.exec("ROLLBACK"); throw e; } }
function hashPw(pw){ const salt = crypto.randomBytes(16).toString("hex"); return `scrypt$${salt}$${crypto.scryptSync(pw,salt,64).toString("hex")}`; }
function checkPw(pw,stored){ const [,salt,h] = stored.split("$"); return crypto.timingSafeEqual(crypto.scryptSync(pw,salt,64), Buffer.from(h,"hex")); }
function newTxId(){ const a="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b=crypto.randomBytes(10); let s=""; for(const x of b) s+=a[x%a.length]; return `STB-${s.slice(0,5)}-${s.slice(5)}`; }

// Failed-login counter: only wrong passwords count; a correct login clears it.
const attempts = new Map();
function lockedOut(key,max,windowMs){
  const e = attempts.get(key); if(!e) return false;
  if(Date.now() - e.start > windowMs){ attempts.delete(key); return false; }
  return e.n >= max;
}
function bumpFail(key,windowMs){
  const t = Date.now(); const e = attempts.get(key) || {n:0,start:t};
  if(t - e.start > windowMs){ e.n = 0; e.start = t; }
  e.n++; attempts.set(key,e);
}
function clearFail(key){ attempts.delete(key); }

const hits = new Map();
function limited(key,max,windowMs){
  const t = Date.now(); const e = hits.get(key) || {n:0,start:t};
  if(t - e.start > windowMs){ e.n = 0; e.start = t; }
  e.n++; hits.set(key,e); return e.n > max;
}
function send(res,code,body,headers={}){
  res.writeHead(code,{"Content-Type":"application/json","X-Content-Type-Options":"nosniff","Cache-Control":"no-store","Referrer-Policy":"no-referrer",...headers});
  res.end(JSON.stringify(body));
}
async function readBody(req){
  if(!String(req.headers["content-type"]||"").includes("application/json")) fail(415,"Send JSON.");
  let s=""; for await(const c of req){ s+=c; if(s.length>65536) fail(413,"Request too large."); }
  try{ return s ? JSON.parse(s) : {}; } catch { fail(400,"Invalid JSON."); }
}
function cookie(req,name){ const m = (req.headers.cookie||"").match(new RegExp("(?:^|; )"+name+"=([^;]+)")); return m ? decodeURIComponent(m[1]) : null; }
function sessionUser(req){
  const tok = cookie(req,"sid"); if(!tok) return null;
  return one("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?", sha(tok), Date.now()) || null;
}
// Why an account cannot use the site right now (null when it can).
function restriction(u){
  if(!u.active) return {msg:"This account is inactive. Please contact the team.", extra:{restricted:true, kind:"inactive"}};
  if(u.banned) return {msg:`Your account has been banned.${u.ban_reason ? " Reason: "+u.ban_reason : ""}`, extra:{restricted:true, kind:"banned", reason:u.ban_reason}};
  if(u.suspended_until && Date.parse(u.suspended_until) > Date.now())
    return {msg:`Your account is suspended for now.${u.suspend_reason ? " Reason: "+u.suspend_reason : ""}`,
      extra:{restricted:true, kind:"suspended", until:u.suspended_until, reason:u.suspend_reason}};
  return null;
}
// need(req, minRank): logged-in, unrestricted user whose rank is at least minRank
function need(req,minRank=-1){
  sweepSuspensions();
  const u = sessionUser(req); if(!u) fail(401,"Please log in.");
  const r = restriction(u); if(r) fail(403, r.msg, r.extra);
  if(rank(u) < minRank) fail(403,"Not allowed.");
  return u;
}
const canChangeRoles = u => rank(u) >= RANK_CO;
const canManageTx = u => rank(u) >= RANK_MANAGE_TX;
// Can actor give this role? Only roles below their own rank, and only the owner can give co-owner.
function canGrant(actor,role){
  if(!ROLES[role]) return false;
  if(actor.role === "owner") return true;            // the Owner can give any role, including Owner, with no limit
  if(role === "owner" || role === "co_owner") return false;
  return ROLES[role].rank < rank(actor);
}
// Keep at least one Owner account so the platform can never be locked out.
const ownerCount = () => one("SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1").n;
// Can actor change this user at all?
function canManageUser(actor,target){
  if(actor.role === "owner") return true;
  return rank(target) < rank(actor);
}
const pub = u => ({id:u.id,username:u.username,name:u.name,role:u.role,role_label:roleLabel(u.role),
  mm_eligible:!!u.mm_eligible,active:!!u.active,bio:u.bio,specialties:u.specialties,show_public:!!u.show_public,
  onboarded:!!u.onboarded,purpose:u.purpose||"",join_stream:!!u.join_stream,can_edit_values:u.can_edit_values===1,banned:!!u.banned,ban_reason:u.ban_reason||"",suspended_until:u.suspended_until||null,suspend_reason:u.suspend_reason||"",avatar_at:u.avatar_at||null,banner_at:u.banner_at||null,role_color:ROLES[u.role]?.color||"#8A8F98"});
function audit(actorId,action,target,detail){ run("INSERT INTO audit(actor_id,action,target,detail,at) VALUES(?,?,?,?,?)",actorId,action,target||null,detail||null,now()); }
function notifyUser(uid,text,txId){ run("INSERT INTO notifications(user_id,tx_id,text,at) VALUES(?,?,?,?)",uid,txId||null,text,now()); }
function notifyManagers(text,txId){
  for(const a of q("SELECT id,role FROM users WHERE active=1")) if(rank(a) >= RANK_MANAGE_TX) notifyUser(a.id,text,txId);
}

const FB = /^https:\/\/(www\.|m\.)?(facebook\.com|fb\.com)\/[A-Za-z0-9.\-_]{1,100}\/?(\?[^\s]{0,200})?$/i;
const GC_URL = /^https:\/\/(www\.|m\.)?(facebook\.com|messenger\.com|m\.me)\/[^\s"'<>]{1,300}$/i;
const str = (v,max) => String(v ?? "").trim().slice(0,max);

function moveTx(tx,to,actorId,reason,patch={}){
  if(!(T[tx.status]||[]).includes(to)) fail(409,`Cannot move from "${tx.status}" to "${to}".`);
  let open = tx.open_dispute;
  if(to === S.DISP) open = 1;
  if(tx.status === S.DISP && to !== S.DISP) open = 0;
  if(to === S.DONE && open) fail(409,"Cannot complete while a dispute is open.");
  const mm = patch.mm_id !== undefined ? patch.mm_id : tx.mm_id;
  const completed = to === S.DONE ? now() : tx.completed_at;
  run("UPDATE transactions SET status=?,mm_id=?,open_dispute=?,completed_at=? WHERE id=?",to,mm,open,completed,tx.id);
  run("INSERT INTO tx_history(tx_id,from_status,to_status,actor_id,reason,at) VALUES(?,?,?,?,?,?)",tx.id,tx.status,to,actorId,reason||"",now());
  if(mm) notifyUser(mm,`${tx.id}: ${to}`,tx.id);
  return one("SELECT * FROM transactions WHERE id=?",tx.id);
}
const getTx = id => one("SELECT * FROM transactions WHERE id=?",id) || fail(404,"Transaction not found.");
const validUsername = u => /^[a-zA-Z0-9_]{3,24}$/.test(u);

// ---------- routes ----------
const routes = [];
const R = (m,p,h) => routes.push({m,p:new RegExp("^"+p+"$"),h});

R("GET","/api/status",async ()=>({setup_required: !one("SELECT id FROM users LIMIT 1")}));

R("POST","/api/setup",async req=>{
  const b = await readBody(req);
  const h = one("SELECT value FROM settings WHERE key='setup_hash'");
  if(!h) fail(404,"Setup is already complete.");
  if(sha(str(b.code,20).toUpperCase()) !== h.value) fail(403,"Invalid setup code.");
  const username = str(b.username,24), name = str(b.name,60), pw = String(b.password||"");
  if(!validUsername(username)) fail(400,"Username: 3 to 24 letters, numbers, or underscores.");
  if(!name) fail(400,"Name is required.");
  if(pw.length < 12) fail(400,"Password must be at least 12 characters.");
  atomic(()=>{
    run("INSERT INTO users(username,name,pass_hash,role,created_at) VALUES(?,?,?,?,?)",username,name,hashPw(pw),"owner",now());
    run("DELETE FROM settings WHERE key='setup_hash'");
  });
  return {ok:true};
});

R("POST","/api/login",async req=>{
  const b = await readBody(req);
  const u = str(b.username,24);
  const lk = "login:"+req.socket.remoteAddress+":"+u.toLowerCase(), WIN = 15*60e3;
  if(lockedOut(lk,5,WIN)) fail(429,"Too many wrong passwords. Try again in 15 minutes.");
  const user = one("SELECT * FROM users WHERE username=?",u);
  if(!user || !user.pass_hash.startsWith("scrypt$") || !checkPw(String(b.password||""),user.pass_hash)){
    bumpFail(lk,WIN); fail(401,"Invalid username or password.");
  }
  clearFail(lk);
  const restricted = restriction(user); if(restricted) fail(403, restricted.msg, restricted.extra);
  const tok = crypto.randomBytes(32).toString("base64url");
  run("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",sha(tok),user.id,Date.now()+7*864e5);
  return full(200,{ok:true,user:pub(user)},{"Set-Cookie":`sid=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7*86400}${COOKIE_SECURE?"; Secure":""}`});
});

R("POST","/api/logout",async req=>{
  const tok = cookie(req,"sid"); if(tok) run("DELETE FROM sessions WHERE token_hash=?",sha(tok));
  return full(200,{ok:true},{"Set-Cookie":"sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"});
});

R("GET","/api/me",async req=>pub(need(req)));

R("PATCH","/api/me",async req=>{
  const u = need(req); const b = await readBody(req);
  const name = str(b.name,60) || u.name;
  run("UPDATE users SET name=?,bio=?,specialties=?,show_public=? WHERE id=?",name,str(b.bio,500),str(b.specialties,200),b.show_public===true?1:0,u.id);
  return pub(one("SELECT * FROM users WHERE id=?",u.id));
});

R("GET","/api/roles",async req=>{
  const u = need(req,RANK_ADMIN);
  return Object.entries(ROLES).filter(([r])=>canGrant(u,r)).map(([value,v])=>({value,label:v.label,color:v.color}));
});
R("GET","/api/role-hierarchy",async ()=>Object.entries(ROLES).map(([value,v])=>({value,label:v.label,color:v.color,rank:v.rank})).sort((a,b)=>a.rank-b.rank));

// Queue picker: managers can see only active, eligible MM/MW accounts.
R("GET","/api/eligible-mms",async req=>{
  need(req,RANK_MANAGE_TX);
  return q("SELECT id,name,mm_eligible,active FROM users WHERE active=1 AND mm_eligible=1 ORDER BY name COLLATE NOCASE");
});

// Staff management (admin and up)
R("GET","/api/staff",async req=>{
  need(req,RANK_CO);
  return q("SELECT * FROM users ORDER BY created_at").map(pub);
});

R("POST","/api/staff",async req=>{
  const actor = need(req,RANK_CO); const b = await readBody(req);
  const username = str(b.username,24), name = str(b.name,60), pw = String(b.password||"");
  const role = str(b.role,20) || "visitor";
  if(role !== "visitor" && !canChangeRoles(actor)) fail(403,"Only the Owner or Co-Owner can give roles.");
  if(!canGrant(actor,role)) fail(403,"You cannot give that role.");
  if(!validUsername(username)) fail(400,"Username: 3 to 24 letters, numbers, or underscores.");
  if(!name) fail(400,"Name is required.");
  if(pw.length < 12) fail(400,"Temporary password must be at least 12 characters.");
  if(one("SELECT id FROM users WHERE username=?",username)) fail(409,"Username already exists.");
  const id = atomic(()=>{
    const r = run("INSERT INTO users(username,name,pass_hash,role,mm_eligible,created_at) VALUES(?,?,?,?,?,?)",username,name,hashPw(pw),role,b.mm_eligible?1:0,now());
    audit(actor.id,"staff.create",String(r.lastInsertRowid),`${username} as ${role}`);
    return r.lastInsertRowid;
  });
  return pub(one("SELECT * FROM users WHERE id=?",id));
});

R("PATCH","/api/staff/(\\d+)",async (req,m)=>{
  const actor = need(req,RANK_CO); const b = await readBody(req);
  const target = one("SELECT * FROM users WHERE id=?",Number(m[1])) || fail(404,"Staff not found.");
  if(!canManageUser(actor,target)) fail(403,"You cannot change this account.");
  if(target.id === actor.id && b.active === false) fail(400,"You cannot deactivate your own account.");
  if(b.role !== undefined && target.id === actor.id && b.role !== target.role) fail(400,"You cannot change your own role.");
  if(b.role !== undefined && b.role !== target.role && !canChangeRoles(actor)) fail(403,"Only the Owner or Co-Owner can change roles.");
  if(b.role !== undefined && !canGrant(actor,b.role)) fail(403,"You cannot give that role.");
  const losesOwner = target.role === "owner" && ((b.role !== undefined && b.role !== "owner") || b.active === false);
  if(losesOwner && ownerCount() <= 1) fail(409,"Keep at least one Owner account. Give another account the Owner role first.");
  if(b.can_edit_values !== undefined && !canChangeRoles(actor)) fail(403,"Only the Owner or Co-Owner can give the value-editor privilege.");
  atomic(()=>{
    if(b.can_edit_values !== undefined){
      run("UPDATE users SET can_edit_values=? WHERE id=?", b.can_edit_values ? 1 : 0, target.id);
      audit(actor.id,"staff.value_editor",String(target.id),JSON.stringify({granted:!!b.can_edit_values}));
    }
    run("UPDATE users SET role=?,mm_eligible=?,active=? WHERE id=?",
      b.role ?? target.role, b.mm_eligible !== undefined ? (b.mm_eligible?1:0) : target.mm_eligible,
      b.active !== undefined ? (b.active?1:0) : target.active, target.id);
    if(b.active === false) run("DELETE FROM sessions WHERE user_id=?",target.id);
    audit(actor.id,"staff.update",String(target.id),JSON.stringify({role:b.role,mm_eligible:b.mm_eligible,active:b.active}));
  });
  return pub(one("SELECT * FROM users WHERE id=?",target.id));
});

// ---- Moderation: ban / suspend (admin and up). The Owner can never be targeted; nobody can act on a higher or equal rank. ----
function moderationTarget(actor,id){
  const target = one("SELECT * FROM users WHERE id=?",id) || fail(404,"Account not found.");
  if(target.id === actor.id) fail(400,"You cannot moderate your own account.");
  if(target.role === "owner") fail(403,"The Owner account cannot be banned or suspended.");
  if(!canManageUser(actor,target)) fail(403,"You cannot moderate this account.");
  return target;
}
const reasonOf = b => { const r = str(b.reason,300); if(r.length < 3) fail(400,"A reason of at least 3 characters is required."); return r; };

R("POST","/api/staff/(\\d+)/ban",async (req,m)=>{
  const actor = need(req,RANK_CO); const b = await readBody(req);
  const reason = reasonOf(b); const target = moderationTarget(actor,Number(m[1]));
  atomic(()=>{
    run("UPDATE users SET banned=1,ban_reason=?,suspended_until=NULL,suspend_reason='' WHERE id=?",reason,target.id);
    audit(actor.id,"user.ban",String(target.id),JSON.stringify({reason}));
  });
  return pub(one("SELECT * FROM users WHERE id=?",target.id));
});

R("POST","/api/staff/(\\d+)/unban",async (req,m)=>{
  const actor = need(req,RANK_CO);
  const target = moderationTarget(actor,Number(m[1]));
  if(!target.banned) fail(409,"This account is not banned.");
  atomic(()=>{
    run("UPDATE users SET banned=0,ban_reason='' WHERE id=?",target.id);
    audit(actor.id,"user.unban",String(target.id),null);
  });
  return pub(one("SELECT * FROM users WHERE id=?",target.id));
});

R("POST","/api/staff/(\\d+)/suspend",async (req,m)=>{
  const actor = need(req,RANK_CO); const b = await readBody(req);
  const reason = reasonOf(b); const target = moderationTarget(actor,Number(m[1]));
  const until = new Date(typeof b.until === "string" ? b.until : "");
  if(isNaN(until.getTime()) || until.getTime() <= Date.now()) fail(400,"Choose an expiry date and time in the future.");
  if(until.getTime() > Date.now() + 365*864e5) fail(400,"Suspensions can last at most one year. Use a ban instead.");
  const iso = until.toISOString();
  atomic(()=>{
    run("UPDATE users SET suspended_until=?,suspend_reason=? WHERE id=?",iso,reason,target.id);
    audit(actor.id,"user.suspend",String(target.id),JSON.stringify({reason,until:iso}));
  });
  return pub(one("SELECT * FROM users WHERE id=?",target.id));
});

R("POST","/api/staff/(\\d+)/unsuspend",async (req,m)=>{
  const actor = need(req,RANK_CO);
  const target = moderationTarget(actor,Number(m[1]));
  if(!target.suspended_until) fail(409,"This account is not suspended.");
  atomic(()=>{
    run("UPDATE users SET suspended_until=NULL,suspend_reason='' WHERE id=?",target.id);
    audit(actor.id,"user.unsuspend",String(target.id),null);
  });
  return pub(one("SELECT * FROM users WHERE id=?",target.id));
});

// ---- Profile pictures and banners ----
const IMG_MAX = {avatar: 2*1024*1024, banner: 3*1024*1024};
function sniffImage(buf){
  if(buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  if(buf.length >= 8 && buf.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) return "image/png";
  if(buf.length >= 12 && buf.subarray(0,4).toString("latin1") === "RIFF" && buf.subarray(8,12).toString("latin1") === "WEBP") return "image/webp";
  if(buf.length >= 6 && ["GIF87a","GIF89a"].includes(buf.subarray(0,6).toString("latin1"))) return "image/gif";
  return null;
}
async function readJsonLimited(req,max){
  if(!String(req.headers["content-type"]||"").includes("application/json")) fail(415,"Send JSON.");
  const chunks = []; let size = 0;
  for await(const c of req){ size += c.length; if(size > max) fail(413,"Image is too large."); chunks.push(c); }
  try{ return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { fail(400,"Invalid JSON."); }
}
function imageTarget(actor,id){
  const target = one("SELECT * FROM users WHERE id=?",id) || fail(404,"Profile not found.");
  if(target.id === actor.id) return target;
  if(rank(actor) >= RANK_ADMIN && canManageUser(actor,target)) return target;
  fail(403,"You can only change your own pictures.");
}

R("PUT","/api/users/(\\d+)/(avatar|banner)",async (req,m)=>{
  const actor = need(req); const kind = m[2];
  const target = imageTarget(actor,Number(m[1]));
  const b = await readJsonLimited(req, 5*1024*1024);
  const match = typeof b.data === "string" && b.data.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
  if(!match) fail(400,"Choose a JPG, PNG, WEBP, or GIF image.");
  const buf = Buffer.from(match[2],"base64");
  if(buf.length > IMG_MAX[kind]) fail(413,`That image is too large. Maximum is ${IMG_MAX[kind]/1024/1024} MB.`);
  const mime = sniffImage(buf);
  if(!mime || mime !== "image/"+match[1]) fail(400,"The file is not a valid image of the type you chose.");
  const at = now();
  atomic(()=>{
    run(`INSERT INTO profile_images(user_id,kind,mime,data,updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(user_id,kind) DO UPDATE SET mime=excluded.mime,data=excluded.data,updated_at=excluded.updated_at`,
         target.id,kind,mime,buf,at);
    run(`UPDATE users SET ${kind==="avatar"?"avatar_at":"banner_at"}=? WHERE id=?`,at,target.id);
  });
  return pub(one("SELECT * FROM users WHERE id=?",target.id));
});

R("DELETE","/api/users/(\\d+)/(avatar|banner)",async (req,m)=>{
  const actor = need(req); const kind = m[2];
  const target = imageTarget(actor,Number(m[1]));
  atomic(()=>{
    run("DELETE FROM profile_images WHERE user_id=? AND kind=?",target.id,kind);
    run(`UPDATE users SET ${kind==="avatar"?"avatar_at":"banner_at"}=NULL WHERE id=?`,target.id);
  });
  return pub(one("SELECT * FROM users WHERE id=?",target.id));
});

R("GET","/api/users/(\\d+)/(avatar|banner)",async (req,m)=>{
  need(req);
  const row = one("SELECT mime,data FROM profile_images WHERE user_id=? AND kind=?",Number(m[1]),m[2]) || fail(404,"No image.");
  return {__raw:true, code:200, type:row.mime, body:row.data};
});

// ---- Onboarding survey: "How did you discover Solar BNST?" Private: only Owner and Co-Owner can read responses ----
const SURVEY_SOURCES = ["invited_staff","invited_member","advertisement","facebook","tiktok","other_social","search","other"];
R("GET","/api/survey/me",async req=>{
  const u = need(req);
  const r = one("SELECT source,inviter,feedback FROM survey_responses WHERE user_id=?",u.id);
  return r ? {done:true, ...r} : {done:false};
});
R("POST","/api/survey",async req=>{
  const u = need(req); const b = await readBody(req);
  const source = str(b.source,30);
  if(!SURVEY_SOURCES.includes(source)) fail(400,"Please choose how you discovered Solar BNST.");
  const inviter = str(b.inviter,24);
  if(inviter && !validUsername(inviter)) fail(400,"Inviter username: 3 to 24 letters, numbers, or underscores.");
  const feedback = str(b.feedback,500);
  const at = now();
  run(`INSERT INTO survey_responses(user_id,source,inviter,feedback,submitted_at,updated_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET source=excluded.source,inviter=excluded.inviter,feedback=excluded.feedback,updated_at=excluded.updated_at`,
       u.id,source,inviter,feedback,at,at);
  return {ok:true, done:true, source, inviter, feedback};
});
R("GET","/api/survey-responses",async req=>{
  need(req,RANK_CO);
  return q(`SELECT s.user_id, u.username, u.name, s.source, s.inviter, s.feedback, s.submitted_at
            FROM survey_responses s JOIN users u ON u.id=s.user_id ORDER BY s.submitted_at DESC`);
});

// ---- Value list: ADM and MM2 items with a value and a picture. Owner, Co-Owner, and staff with the value-editor privilege can edit. ----
const GAMES = ["adm","mm2"];
// Sheets (tabs) per game. ADM: rarity tiers from Common up to Legendary, then item categories. MM2: weapon types.
const SHEETS = {
  adm: ["Common","Uncommon","Rare","Ultra Rare","Legendary","Pets","Food","Vehicles","Strollers","Gifts","Toys","Stickers","Pet Wear","Other"],
  mm2: ["Knife","Gun","Other"],
};
const sheetOf = (game, v) => { const x = str(v || "Other", 30); if(!SHEETS[game].includes(x)) fail(400,"Choose a sheet from the list."); return x; };
const canEditValues = u => !!u && (rank(u) >= RANK_CO || u.can_edit_values === 1);

// Initial ADM value catalogue from the values supplied with this update.
// Values are user-provided estimates, not live-verified market prices. INSERT OR IGNORE preserves editor changes.
const INITIAL_ADM_VALUES = [
  ['Bat Dragon',1015.0000,'Legendary'],
  ['Neon Bat Dragon',4060.0000,'Legendary'],
  ['Mega Neon Bat Dragon',16240.0000,'Legendary'],
  ['Shadow Dragon',845.0000,'Legendary'],
  ['Neon Shadow Dragon',3380.0000,'Legendary'],
  ['Mega Neon Shadow Dragon',13520.0000,'Legendary'],
  ['Giraffe',474.0000,'Legendary'],
  ['Neon Giraffe',1896.0000,'Legendary'],
  ['Mega Neon Giraffe',7584.0000,'Legendary'],
  ['Frost Dragon',327.0000,'Legendary'],
  ['Neon Frost Dragon',1308.0000,'Legendary'],
  ['Mega Neon Frost Dragon',5232.0000,'Legendary'],
  ['Owl',246.5000,'Legendary'],
  ['Neon Owl',986.0000,'Legendary'],
  ['Mega Neon Owl',3944.0000,'Legendary'],
  ['Blazing Lion',202.0000,'Legendary'],
  ['Neon Blazing Lion',808.0000,'Legendary'],
  ['Mega Neon Blazing Lion',3232.0000,'Legendary'],
  ['Parrot',197.5000,'Legendary'],
  ['Neon Parrot',790.0000,'Legendary'],
  ['Mega Neon Parrot',3160.0000,'Legendary'],
  ['Crow',178.0000,'Legendary'],
  ['Neon Crow',712.0000,'Legendary'],
  ['Mega Neon Crow',2848.0000,'Legendary'],
  ['Evil Unicorn',172.0000,'Legendary'],
  ['Neon Evil Unicorn',688.0000,'Legendary'],
  ['Mega Neon Evil Unicorn',2752.0000,'Legendary'],
  ['Balloon Unicorn',169.0000,'Legendary'],
  ['Neon Balloon Unicorn',676.0000,'Legendary'],
  ['Mega Neon Balloon Unicorn',2704.0000,'Legendary'],
  ['Cryptid',151.0000,'Legendary'],
  ['Neon Cryptid',604.0000,'Legendary'],
  ['Mega Neon Cryptid',2416.0000,'Legendary'],
  ['Diamond Butterfly',69.0000,'Legendary'],
  ['Neon Diamond Butterfly',276.0000,'Legendary'],
  ['Mega Neon Diamond Butterfly',1104.0000,'Legendary'],
  ['Monkey King',66.0000,'Legendary'],
  ['Neon Monkey King',264.0000,'Legendary'],
  ['Mega Neon Monkey King',1056.0000,'Legendary'],
  ['Arctic Reindeer',54.0000,'Legendary'],
  ['Neon Arctic Reindeer',216.0000,'Legendary'],
  ['Mega Neon Arctic Reindeer',864.0000,'Legendary'],
  ['Strawberry Bat Dragon',48.2500,'Legendary'],
  ['Neon Strawberry Bat Dragon',193.0000,'Legendary'],
  ['Mega Neon Strawberry Bat Dragon',772.0000,'Legendary'],
  ['Chocolate Bat Dragon',47.2500,'Legendary'],
  ['Neon Chocolate Bat Dragon',189.0000,'Legendary'],
  ['Mega Neon Chocolate Bat Dragon',756.0000,'Legendary'],
  ['Black Pheasant',42.0000,'Legendary'],
  ['Neon Black Pheasant',168.0000,'Legendary'],
  ['Mega Neon Black Pheasant',672.0000,'Legendary'],
  ['Fairy Bat Dragon',30.5000,'Legendary'],
  ['Neon Fairy Bat Dragon',122.0000,'Legendary'],
  ['Mega Neon Fairy Bat Dragon',488.0000,'Legendary'],
  ['Kangaroo',18.7500,'Legendary'],
  ['Neon Kangaroo',75.0000,'Legendary'],
  ['Mega Neon Kangaroo',300.0000,'Legendary'],
  ['Albino Monkey',17.2500,'Legendary'],
  ['Neon Albino Monkey',69.0000,'Legendary'],
  ['Mega Neon Albino Monkey',276.0000,'Legendary'],
  ['Turtle',15.5000,'Legendary'],
  ['Neon Turtle',62.0000,'Legendary'],
  ['Mega Neon Turtle',248.0000,'Legendary'],
  ['Vampire Dragon',14.2500,'Legendary'],
  ['Neon Vampire Dragon',57.0000,'Legendary'],
  ['Mega Neon Vampire Dragon',228.0000,'Legendary'],
  ['Diamond Amazon',12.0000,'Legendary'],
  ['Neon Diamond Amazon',48.0000,'Legendary'],
  ['Mega Neon Diamond Amazon',192.0000,'Legendary'],
  ['Nessie',8.5000,'Legendary'],
  ['Neon Nessie',34.0000,'Legendary'],
  ['Mega Neon Nessie',136.0000,'Legendary'],
  ['Sugar Glider',6.5000,'Legendary'],
  ['Neon Sugar Glider',26.0000,'Legendary'],
  ['Mega Neon Sugar Glider',104.0000,'Legendary'],
  ['Frost Fury',5.3500,'Legendary'],
  ['Neon Frost Fury',21.4000,'Legendary'],
  ['Mega Neon Frost Fury',85.6000,'Legendary'],
  ['Lava Dragon',4.7500,'Legendary'],
  ['Neon Lava Dragon',19.0000,'Legendary'],
  ['Mega Neon Lava Dragon',76.0000,'Legendary'],
  ['Chameleon',4.2000,'Legendary'],
  ['Neon Chameleon',16.8000,'Legendary'],
  ['Mega Neon Chameleon',67.2000,'Legendary'],
  ['Squid',4.0000,'Legendary'],
  ['Neon Squid',16.0000,'Legendary'],
  ['Mega Neon Squid',64.0000,'Legendary'],
  ['Golden Walrus',3.8000,'Legendary'],
  ['Neon Golden Walrus',15.2000,'Legendary'],
  ['Mega Neon Golden Walrus',60.8000,'Legendary'],
  ['Unicorn',3.5000,'Legendary'],
  ['Neon Unicorn',14.0000,'Legendary'],
  ['Mega Neon Unicorn',56.0000,'Legendary'],
  ['Dancing Dragon',3.2000,'Legendary'],
  ['Neon Dancing Dragon',12.8000,'Legendary'],
  ['Mega Neon Dancing Dragon',51.2000,'Legendary'],
  ['Phoenix',2.8000,'Legendary'],
  ['Neon Phoenix',11.2000,'Legendary'],
  ['Mega Neon Phoenix',44.8000,'Legendary'],
  ['Alicorn',2.5000,'Legendary'],
  ['Neon Alicorn',10.0000,'Legendary'],
  ['Mega Neon Alicorn',40.0000,'Legendary'],
  ['Ancient Dragon',2.5000,'Legendary'],
  ['Neon Ancient Dragon',10.0000,'Legendary'],
  ['Mega Neon Ancient Dragon',40.0000,'Legendary'],
  ['Axolotl',2.2000,'Legendary'],
  ['Neon Axolotl',8.8000,'Legendary'],
  ['Mega Neon Axolotl',35.2000,'Legendary'],
  ['Goldhorn',2.0000,'Legendary'],
  ['Neon Goldhorn',8.0000,'Legendary'],
  ['Mega Neon Goldhorn',32.0000,'Legendary'],
  ['Golden Unicorn',1.8000,'Legendary'],
  ['Neon Golden Unicorn',7.2000,'Legendary'],
  ['Mega Neon Golden Unicorn',28.8000,'Legendary'],
  ['Diamond Unicorn',1.8000,'Legendary'],
  ['Neon Diamond Unicorn',7.2000,'Legendary'],
  ['Mega Neon Diamond Unicorn',28.8000,'Legendary'],
  ['Dragon',1.5000,'Legendary'],
  ['Neon Dragon',6.0000,'Legendary'],
  ['Mega Neon Dragon',24.0000,'Legendary'],
  ['Robo Dog',1.2000,'Legendary'],
  ['Neon Robo Dog',4.8000,'Legendary'],
  ['Mega Neon Robo Dog',19.2000,'Legendary'],
  ['Cerberus',1.2000,'Legendary'],
  ['Neon Cerberus',4.8000,'Legendary'],
  ['Mega Neon Cerberus',19.2000,'Legendary'],
  ['Kitsune',1.0000,'Legendary'],
  ['Neon Kitsune',4.0000,'Legendary'],
  ['Mega Neon Kitsune',16.0000,'Legendary'],
  ['Griffin',0.8000,'Legendary'],
  ['Neon Griffin',3.2000,'Legendary'],
  ['Mega Neon Griffin',12.8000,'Legendary'],
  ['Metal Ox',0.5000,'Legendary'],
  ['Neon Metal Ox',2.0000,'Legendary'],
  ['Mega Neon Metal Ox',8.0000,'Legendary'],
  ['Minion Chick',0.2000,'Legendary'],
  ['Neon Minion Chick',0.8000,'Legendary'],
  ['Mega Neon Minion Chick',3.2000,'Legendary'],
  ['Hot Doggo',39.5000,'Ultra Rare'],
  ['Neon Hot Doggo',158.0000,'Ultra Rare'],
  ['Mega Neon Hot Doggo',632.0000,'Ultra Rare'],
  ['Dalmatian',36.0000,'Ultra Rare'],
  ['Neon Dalmatian',144.0000,'Ultra Rare'],
  ['Mega Neon Dalmatian',576.0000,'Ultra Rare'],
  ['Flamingo',28.0000,'Ultra Rare'],
  ['Neon Flamingo',112.0000,'Ultra Rare'],
  ['Mega Neon Flamingo',448.0000,'Ultra Rare'],
  ['Bush Elephant',23.0000,'Ultra Rare'],
  ['Neon Bush Elephant',92.0000,'Ultra Rare'],
  ['Mega Neon Bush Elephant',368.0000,'Ultra Rare'],
  ['Caterpillar',21.0000,'Ultra Rare'],
  ['Neon Caterpillar',84.0000,'Ultra Rare'],
  ['Mega Neon Caterpillar',336.0000,'Ultra Rare'],
  ['Lion',19.0000,'Ultra Rare'],
  ['Neon Lion',76.0000,'Ultra Rare'],
  ['Mega Neon Lion',304.0000,'Ultra Rare'],
  ['Elephant',18.0000,'Ultra Rare'],
  ['Neon Elephant',72.0000,'Ultra Rare'],
  ['Mega Neon Elephant',288.0000,'Ultra Rare'],
  ['Puffin',14.0000,'Ultra Rare'],
  ['Neon Puffin',56.0000,'Ultra Rare'],
  ['Mega Neon Puffin',224.0000,'Ultra Rare'],
  ['Crocodile',13.5000,'Ultra Rare'],
  ['Neon Crocodile',54.0000,'Ultra Rare'],
  ['Mega Neon Crocodile',216.0000,'Ultra Rare'],
  ['Turkey',9.5000,'Ultra Rare'],
  ['Neon Turkey',38.0000,'Ultra Rare'],
  ['Mega Neon Turkey',152.0000,'Ultra Rare'],
  ['Llama',7.5000,'Ultra Rare'],
  ['Neon Llama',30.0000,'Ultra Rare'],
  ['Mega Neon Llama',120.0000,'Ultra Rare'],
  ['Zombie Buffalo',7.0000,'Ultra Rare'],
  ['Neon Zombie Buffalo',28.0000,'Ultra Rare'],
  ['Mega Neon Zombie Buffalo',112.0000,'Ultra Rare'],
  ['Strawberry Penguin',6.7500,'Ultra Rare'],
  ['Neon Strawberry Penguin',27.0000,'Ultra Rare'],
  ['Mega Neon Strawberry Penguin',108.0000,'Ultra Rare'],
  ['Platypus',5.0000,'Ultra Rare'],
  ['Neon Platypus',20.0000,'Ultra Rare'],
  ['Mega Neon Platypus',80.0000,'Ultra Rare'],
  ['Arctic Fox',4.5000,'Ultra Rare'],
  ['Neon Arctic Fox',18.0000,'Ultra Rare'],
  ['Mega Neon Arctic Fox',72.0000,'Ultra Rare'],
  ['Ghost Bunny',3.5000,'Ultra Rare'],
  ['Neon Ghost Bunny',14.0000,'Ultra Rare'],
  ['Mega Neon Ghost Bunny',56.0000,'Ultra Rare'],
  ['Albino Bat',2.5000,'Ultra Rare'],
  ['Neon Albino Bat',10.0000,'Ultra Rare'],
  ['Mega Neon Albino Bat',40.0000,'Ultra Rare'],
  ['Wyvern',1.2000,'Ultra Rare'],
  ['Neon Wyvern',4.8000,'Ultra Rare'],
  ['Mega Neon Wyvern',19.2000,'Ultra Rare'],
  ['Hydra',1.0000,'Ultra Rare'],
  ['Neon Hydra',4.0000,'Ultra Rare'],
  ['Mega Neon Hydra',16.0000,'Ultra Rare'],
  ['Red Panda',0.8000,'Ultra Rare'],
  ['Neon Red Panda',3.2000,'Ultra Rare'],
  ['Mega Neon Red Panda',12.8000,'Ultra Rare'],
  ['Shiba Inu',0.8000,'Ultra Rare'],
  ['Neon Shiba Inu',3.2000,'Ultra Rare'],
  ['Mega Neon Shiba Inu',12.8000,'Ultra Rare'],
  ['Deinonychus',0.7000,'Ultra Rare'],
  ['Neon Deinonychus',2.8000,'Ultra Rare'],
  ['Mega Neon Deinonychus',11.2000,'Ultra Rare'],
  ['Sabertooth',0.7000,'Ultra Rare'],
  ['Neon Sabertooth',2.8000,'Ultra Rare'],
  ['Mega Neon Sabertooth',11.2000,'Ultra Rare'],
  ['Bee',0.6000,'Ultra Rare'],
  ['Neon Bee',2.4000,'Ultra Rare'],
  ['Mega Neon Bee',9.6000,'Ultra Rare'],
  ['Penguin',0.6000,'Ultra Rare'],
  ['Neon Penguin',2.4000,'Ultra Rare'],
  ['Mega Neon Penguin',9.6000,'Ultra Rare'],
  ['Sloth',0.6000,'Ultra Rare'],
  ['Neon Sloth',2.4000,'Ultra Rare'],
  ['Mega Neon Sloth',9.6000,'Ultra Rare'],
  ['Cow',16.5000,'Rare'],
  ['Neon Cow',66.0000,'Rare'],
  ['Mega Neon Cow',264.0000,'Rare'],
  ['Hyena',11.0000,'Rare'],
  ['Neon Hyena',44.0000,'Rare'],
  ['Mega Neon Hyena',176.0000,'Rare'],
  ['Shrew',6.5000,'Rare'],
  ['Neon Shrew',26.0000,'Rare'],
  ['Mega Neon Shrew',104.0000,'Rare'],
  ['Brown Bear',5.5000,'Rare'],
  ['Neon Brown Bear',22.0000,'Rare'],
  ['Mega Neon Brown Bear',88.0000,'Rare'],
  ['Pig',4.5000,'Rare'],
  ['Neon Pig',18.0000,'Rare'],
  ['Mega Neon Pig',72.0000,'Rare'],
  ['Polar Bear',4.0000,'Rare'],
  ['Neon Polar Bear',16.0000,'Rare'],
  ['Mega Neon Polar Bear',64.0000,'Rare'],
  ['Swan',3.5000,'Rare'],
  ['Neon Swan',14.0000,'Rare'],
  ['Mega Neon Swan',56.0000,'Rare'],
  ['Rhino',3.2000,'Rare'],
  ['Neon Rhino',12.8000,'Rare'],
  ['Mega Neon Rhino',51.2000,'Rare'],
  ['Reindeer',2.5000,'Rare'],
  ['Neon Reindeer',10.0000,'Rare'],
  ['Mega Neon Reindeer',40.0000,'Rare'],
  ['Rat',1.5000,'Rare'],
  ['Neon Rat',6.0000,'Rare'],
  ['Mega Neon Rat',24.0000,'Rare'],
  ['Australian Kelpie',0.8000,'Rare'],
  ['Neon Australian Kelpie',3.2000,'Rare'],
  ['Mega Neon Australian Kelpie',12.8000,'Rare'],
  ['Emu',0.8000,'Rare'],
  ['Neon Emu',3.2000,'Rare'],
  ['Mega Neon Emu',12.8000,'Rare'],
  ['Monkey',0.6000,'Rare'],
  ['Neon Monkey',2.4000,'Rare'],
  ['Mega Neon Monkey',9.6000,'Rare'],
  ['Bunny',0.4000,'Rare'],
  ['Neon Bunny',1.6000,'Rare'],
  ['Mega Neon Bunny',6.4000,'Rare'],
  ['Rabbit',0.4000,'Rare'],
  ['Neon Rabbit',1.6000,'Rare'],
  ['Mega Neon Rabbit',6.4000,'Rare'],
  ['Beaver',0.3000,'Rare'],
  ['Neon Beaver',1.2000,'Rare'],
  ['Mega Neon Beaver',4.8000,'Rare'],
  ['Snow Puma',0.3000,'Rare'],
  ['Neon Snow Puma',1.2000,'Rare'],
  ['Mega Neon Snow Puma',4.8000,'Rare'],
  ['Wild Boar',8.0000,'Uncommon'],
  ['Neon Wild Boar',32.0000,'Uncommon'],
  ['Mega Neon Wild Boar',128.0000,'Uncommon'],
  ['Capybara',4.0000,'Uncommon'],
  ['Neon Capybara',16.0000,'Uncommon'],
  ['Mega Neon Capybara',64.0000,'Uncommon'],
  ['Black Panther',3.5000,'Uncommon'],
  ['Neon Black Panther',14.0000,'Uncommon'],
  ['Mega Neon Black Panther',56.0000,'Uncommon'],
  ['Drake',2.8000,'Uncommon'],
  ['Neon Drake',11.2000,'Uncommon'],
  ['Mega Neon Drake',44.8000,'Uncommon'],
  ['Silly Duck',2.8000,'Uncommon'],
  ['Neon Silly Duck',11.2000,'Uncommon'],
  ['Mega Neon Silly Duck',44.8000,'Uncommon'],
  ['Chicken',2.5000,'Uncommon'],
  ['Neon Chicken',10.0000,'Uncommon'],
  ['Mega Neon Chicken',40.0000,'Uncommon'],
  ['Meerkat',2.5000,'Uncommon'],
  ['Neon Meerkat',10.0000,'Uncommon'],
  ['Mega Neon Meerkat',40.0000,'Uncommon'],
  ['Pink Cat',2.0000,'Uncommon'],
  ['Neon Pink Cat',8.0000,'Uncommon'],
  ['Mega Neon Pink Cat',32.0000,'Uncommon'],
  ['Blue Dog',2.0000,'Uncommon'],
  ['Neon Blue Dog',8.0000,'Uncommon'],
  ['Mega Neon Blue Dog',32.0000,'Uncommon'],
  ['Dingo',0.5000,'Uncommon'],
  ['Neon Dingo',2.0000,'Uncommon'],
  ['Mega Neon Dingo',8.0000,'Uncommon'],
  ['Wolf',0.5000,'Uncommon'],
  ['Neon Wolf',2.0000,'Uncommon'],
  ['Mega Neon Wolf',8.0000,'Uncommon'],
  ['Poodle',0.3000,'Uncommon'],
  ['Neon Poodle',1.2000,'Uncommon'],
  ['Mega Neon Poodle',4.8000,'Uncommon'],
  ['Donkey',0.3000,'Uncommon'],
  ['Neon Donkey',1.2000,'Uncommon'],
  ['Mega Neon Donkey',4.8000,'Uncommon'],
  ['Bandicoot',0.3000,'Uncommon'],
  ['Neon Bandicoot',1.2000,'Uncommon'],
  ['Mega Neon Bandicoot',4.8000,'Uncommon'],
  ['Cat',0.1000,'Common'],
  ['Neon Cat',0.8000,'Common'],
  ['Mega Neon Cat',3.5000,'Common'],
  ['Dog',0.1000,'Common'],
  ['Neon Dog',0.8000,'Common'],
  ['Mega Neon Dog',3.5000,'Common'],
  ['Otter',0.1000,'Common'],
  ['Neon Otter',0.8000,'Common'],
  ['Mega Neon Otter',3.5000,'Common'],
  ['Mouse',0.1000,'Common'],
  ['Neon Mouse',0.8000,'Common'],
  ['Mega Neon Mouse',3.5000,'Common'],
  ['Ant',0.1000,'Common'],
  ['Neon Ant',0.8000,'Common'],
  ['Mega Neon Ant',3.5000,'Common'],
  ['Buffalo',0.1000,'Common'],
  ['Neon Buffalo',0.8000,'Common'],
  ['Mega Neon Buffalo',3.5000,'Common']
];
for (const [name,value,sheet] of INITIAL_ADM_VALUES) {
  try {
    run("INSERT OR IGNORE INTO game_items(game,name,value,currency,sheet,updated_at) VALUES('adm',?,?,'POINTS',?,?)", name, value, sheet, now());
  } catch {}
}

// MM2 starter values transcribed from MM2Calculator's public community list (checked 2026-10-21).
// Community estimates change frequently; this is a starter subset, not a claim of the full 1,550-item catalogue.
const INITIAL_MM2_VALUES = [
  ["Chroma Traveler's Gun",220000,"Gun"], ["Traveler's Gun",180000,"Gun"],
  ["Chroma Evergreen Set",145000,"Other"], ["Chroma Evergun",56000,"Gun"],
  ["Chroma Ornament Set",54200,"Other"], ["Chroma Evergreen",42000,"Knife"],
  ["Chroma Alien Set",38000,"Other"], ["Chroma Bauble Set",35825,"Other"],
  ["Chroma Bauble",34000,"Knife"], ["Chroma Constellation",32000,"Knife"],
  ["Chroma Vampire's Gun",29000,"Gun"], ["Chroma Alienbeam",24000,"Gun"],
  ["Chroma Sun Set",17000,"Other"], ["Chroma Raygun",14000,"Gun"],
  ["Chroma Sunrise",10500,"Gun"], ["Chroma Snow Set",10100,"Other"],
  ["Chroma Blizzard Set",9500,"Other"], ["Chroma Snowcannon",7750,"Gun"],
  ["Chroma Sunset",6500,"Knife"], ["Chroma Blizzard",5000,"Gun"],
  ["Chroma Sweet Treat Set 2026",4800,"Other"], ["Heart Wand",340,"Knife"],
  ["Sweet Treat Set 2026",325,"Other"], ["Corrupt Set",368,"Other"],
  ["Corrupt",350,"Knife"], ["Heartblade",130,"Knife"], ["Candy",80,"Knife"],
  ["Luger",47,"Gun"], ["Nightblade",23,"Knife"], ["Red Luger",45,"Gun"],
  ["Phantom",42,"Knife"], ["Spectre",42,"Gun"], ["Blossom",1370,"Knife"],
  ["Zombie Dog",775,"Other"], ["Bats Set",241,"Other"], ["Bats (bats knife 2018)",240,"Knife"],
  ["Blue Pumpkin (blue pumpkin 2018)",220,"Other"], ["Black Cat",130,"Other"],
  ["Sparkle Set",127,"Other"], ["Red Pumpkin (red pumpkin 2018)",120,"Other"],
  ["Glitch1",65,"Knife"], ["Glitch2",35,"Gun"], ["Elf (elf pet 2019)",375,"Other"],
  ["Bones (bones 2019)",210,"Knife"], ["Dogey",155,"Other"], ["Zombified Set",135,"Other"],
  ["Brains (brains 2019)",135,"Knife"], ["Zombified (zombified knife)",120,"Knife"],
  ["Gingerbread (gingerbread knife 2019)",75,"Knife"], ["Sweater (sweater knife 2018)",60,"Knife"],
  ["Snowflake (snowflake knife 2018)",55,"Knife"], ["Branches",50,"Knife"],
  ["Vintage Set",59,"Other"], ["Blood",8,"Knife"], ["Laser (laser vintage)",8,"Gun"],
  ["America (america vintage)",7,"Gun"], ["Prince",6,"Knife"], ["Shadow",6,"Knife"],
  ["Phaser",5,"Gun"], ["Cowboy",4,"Gun"], ["Splitter",3,"Knife"],
  ["Raygun",1800,"Gun"], ["Beach Set",160,"Other"], ["Beachy",80,"Knife"],
  ["Sands Gun 2026",80,"Gun"], ["Branches",50,"Knife"], ["Xenoknife",435,"Knife"],
  ["Xenoshot",435,"Gun"], ["Emberscythe",2500,"Knife"], ["Embersickle",450,"Knife"],
  ["Chroma Emberscythe",14000,"Knife"], ["Emberbow",8000,"Gun"]
];
for (const [name,value,sheet] of INITIAL_MM2_VALUES) {
  try {
    run("INSERT OR IGNORE INTO game_items(game,name,value,currency,sheet,updated_at) VALUES('mm2',?,?,'POINTS',?,?)", name, value, sheet, now());
  } catch {}
}

const escLike = t => t.replace(/[\\%_]/g, c => "\\" + c);
const gameOf = g => { if(!GAMES.includes(g)) fail(400,"Choose ADM or MM2."); return g; };
const parseValue = v => {
  if(v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,\s]/g,""));
  if(!Number.isFinite(n) || n < 0 || n > 1e9) fail(400,"Value must be a number from 0 to 1,000,000,000.");
  return Math.round(n * 100) / 100;
};
const itemName = v => { const n = str(v,80); if(!n) fail(400,"Item name is required."); return n; };
const parseImageUrl = v => { if(v == null || String(v).trim() === "") return null; let u; try { u = new URL(String(v).trim()); } catch { fail(400,"Image URL must be a valid HTTPS URL."); } if(u.protocol !== "https:" || u.username || u.password) fail(400,"Image URL must use HTTPS."); return u.toString().slice(0,1000); };
const itemRow = id => one("SELECT id,game,sheet,name,value,currency,image_at,image_url,updated_at FROM game_items WHERE id=?", id) || fail(404,"Item not found.");
const needEditor = req => { const u = need(req); if(!canEditValues(u)) fail(403,"You do not have permission to edit values."); return u; };

R("GET","/api/items",async (req,m,url)=>{
  const u = need(req);
  const game = gameOf(url.searchParams.get("game"));
  const term = str(url.searchParams.get("q") || "", 60);
  const sheetParam = url.searchParams.get("sheet");
  const countRows = Object.fromEntries(q("SELECT sheet, COUNT(*) AS n FROM game_items WHERE game=? GROUP BY sheet", game).map(r => [r.sheet, r.n]));
  const firstWithItems = SHEETS[game].find(x => (countRows[x] || 0) > 0) || SHEETS[game][0];
  const all = url.searchParams.get("all") === "1";
  const sheet = (term || all) ? null : (SHEETS[game].includes(sheetParam) ? sheetParam : firstWithItems);
  const items = q(`SELECT id,game,sheet,name,value,currency,image_at,image_url,updated_at FROM game_items WHERE game=? AND name LIKE ? ESCAPE '\\'${sheet ? " AND sheet=?" : ""} ORDER BY name COLLATE NOCASE LIMIT ${all ? 3000 : 500}`,
    ...(sheet ? [game, `%${escLike(term)}%`, sheet] : [game, `%${escLike(term)}%`]));
  const sheets = SHEETS[game].map(name => ({name, count: countRows[name] || 0}));
  return {game, sheet, sheets, items, can_edit: canEditValues(u)};
});

R("POST","/api/items",async req=>{
  const u = needEditor(req); const b = await readBody(req);
  const game = gameOf(b.game), name = itemName(b.name), value = parseValue(b.value), sheet = sheetOf(game, b.sheet), image_url = parseImageUrl(b.image_url);
  if(one("SELECT id FROM game_items WHERE game=? AND name=?", game, name)) fail(409,"That item is already in the list.");
  const r = run("INSERT INTO game_items(game,sheet,name,value,currency,image_url,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)", game, sheet, name, value, "POINTS", image_url, now(), u.id);
  audit(u.id,"item.add",String(r.lastInsertRowid),JSON.stringify({game,name,value}));
  return itemRow(Number(r.lastInsertRowid));
});

R("PATCH","/api/items/(\\d+)",async (req,m)=>{
  const u = needEditor(req); const b = await readBody(req);
  const cur = itemRow(Number(m[1]));
  const name = b.name !== undefined ? itemName(b.name) : cur.name;
  const value = b.value !== undefined ? parseValue(b.value) : cur.value;
  if(name !== cur.name && one("SELECT id FROM game_items WHERE game=? AND name=? AND id<>?", cur.game, name, cur.id)) fail(409,"That name is already used.");
  const sheet = b.sheet !== undefined ? sheetOf(cur.game, b.sheet) : cur.sheet;
  const image_url = b.image_url !== undefined ? parseImageUrl(b.image_url) : cur.image_url;
  run("UPDATE game_items SET name=?,value=?,sheet=?,image_url=?,updated_at=?,updated_by=? WHERE id=?", name, value, sheet, image_url, now(), u.id, cur.id);
  if(value !== cur.value) audit(u.id,"item.value",String(cur.id),JSON.stringify({name,from:cur.value,to:value}));
  else if(name !== cur.name) audit(u.id,"item.rename",String(cur.id),JSON.stringify({from:cur.name,to:name}));
  return itemRow(cur.id);
});

R("DELETE","/api/items/(\\d+)",async (req,m)=>{
  const u = needEditor(req);
  const cur = itemRow(Number(m[1]));
  run("DELETE FROM game_items WHERE id=?", cur.id);
  audit(u.id,"item.delete",String(cur.id),JSON.stringify({game:cur.game,name:cur.name}));
  return {ok:true};
});

R("PUT","/api/items/(\\d+)/image",async (req,m)=>{
  const u = needEditor(req);
  const cur = itemRow(Number(m[1]));
  const b = await readJsonLimited(req, 4*1024*1024);
  const match = typeof b.data === "string" && b.data.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
  if(!match) fail(400,"Choose a JPG, PNG, WEBP, or GIF image.");
  const buf = Buffer.from(match[2],"base64");
  if(buf.length > 2*1024*1024) fail(413,"Item picture is too large. Maximum is 2 MB.");
  const mime = sniffImage(buf);
  if(!mime || mime !== "image/"+match[1]) fail(400,"The file is not a valid image of the type you chose.");
  const at = now();
  run("UPDATE game_items SET image_mime=?,image_data=?,image_at=?,updated_at=?,updated_by=? WHERE id=?", mime, buf, at, at, u.id, cur.id);
  audit(u.id,"item.image",String(cur.id),null);
  return itemRow(cur.id);
});

R("GET","/api/items/(\\d+)/image",async (req,m)=>{
  need(req);
  const row = one("SELECT image_mime AS mime, image_data AS data FROM game_items WHERE id=?", Number(m[1]));
  if(!row || !row.data) fail(404,"No picture.");
  return {__raw:true, code:200, type:row.mime, body:row.data};
});

// Bulk add or update: one item per line, "name,value" or "name<TAB>value". The last comma or tab splits name from value.
R("POST","/api/items/import",async req=>{
  const u = needEditor(req); const b = await readBody(req);
  const game = gameOf(b.game), sheet = sheetOf(game, b.sheet);
  const lines = String(b.text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if(lines.length > 1000) fail(400,"Import up to 1000 lines at a time.");
  let added = 0, updated = 0; const skipped = [];
  atomic(()=>{
    lines.forEach((line,i)=>{
      const cut = line.includes("\t") ? line.lastIndexOf("\t") : line.lastIndexOf(",");
      const name = str(cut > 0 ? line.slice(0,cut) : line, 80);
      let value; try { value = parseValue(cut > 0 ? line.slice(cut+1) : ""); } catch { value = undefined; }
      if(!name || value === undefined){ skipped.push(i+1); return; }
      const hit = one("SELECT id FROM game_items WHERE game=? AND name=?", game, name);
      if(hit){ run("UPDATE game_items SET value=?,sheet=?,updated_at=?,updated_by=? WHERE id=?", value, sheet, now(), u.id, hit.id); updated++; }
      else { run("INSERT INTO game_items(game,sheet,name,value,currency,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)", game, sheet, name, value, "POINTS", now(), u.id); added++; }
    });
    audit(u.id,"item.import",game,JSON.stringify({sheet,added,updated,skipped:skipped.length}));
  });
  return {added, updated, skipped_lines: skipped};
});

// Best-effort catalogue sync from public community pages. Existing hand-edited values are preserved
// unless a numeric value is clearly present in the source markup. Unparseable values stay null.
function plainHtml(s) {
  return String(s || "").replace(/<script\b[\s\S]*?<\/script>/gi," ").replace(/<style\b[\s\S]*?<\/style>/gi," ")
    .replace(/<br\s*\/?>/gi," ").replace(/<\/(?:div|li|p|tr|td|h\d)>/gi," ").replace(/<[^>]+>/g," ")
    .replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
    .replace(/&#x27;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/\s+/g," ").trim();
}
function attr(tag, name) {
  const m = tag.match(new RegExp("\\b"+name+"\\s*=\\s*(?:\\\"([^\\\"]*)\\\"|'([^']*)'|([^\\s>]+))","i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}
function normalizeSourceName(value) {
  return plainHtml(value).replace(/^Image:\s*/i,"")
    .replace(/\bMM2 item\b/ig,"")
    .replace(/\bAdopt Me (?:pet|item)\b/ig,"")
    .replace(/^\s*(?:Ancient|Godly|Chroma|Vintage|Unique|Legendary|Ultra Rare|Rare|Uncommon|Common)\s+/i,"")
    .replace(/\s+(?:Hot\s+)?(?:Knife|Gun|Pet|Misc|Set)\s*$/i,"")
    .replace(/\s+(?:Ancient|Godly|Chroma|Vintage|Unique|Legendary|Ultra Rare|Rare|Uncommon|Common)\s*$/i,"")
    .replace(/\s+/g," ").trim();
}
function sourceImageMap(html, base) {
  const out = new Map();
  for (const m of String(html).matchAll(/<img\b[^>]*>/gi)) {
    const tag=m[0], rawName=(attr(tag,"alt") || attr(tag,"title")).trim();
    const name=normalizeSourceName(rawName);
    let src=attr(tag,"src") || attr(tag,"data-src") || attr(tag,"data-lazy-src") || attr(tag,"data-original");
    if(!src) src=(attr(tag,"srcset") || attr(tag,"data-srcset") || "").split(",")[0].trim().split(/\s+/)[0];
    if(!name || !src || /^data:/i.test(src)) continue;
    try { src=new URL(src,base).toString(); if(new URL(src).protocol!=="https:") continue; } catch { continue; }
    out.set(name.toLowerCase(),src);
    if(rawName) out.set(rawName.toLowerCase(),src);
  }
  return out;
}
function sourceCatalogRows(html, game, base) {
  const images=sourceImageMap(html,base), found=new Map();
  const add=(name,value,sheet,image)=>{
    name=normalizeSourceName(name).replace(/\s+(?:Pets|Pet|Other)\s*$/i,"").trim();
    if(!name || name.length>120 || /^(?:Image|Calculator|View all|Show more)$/i.test(name)) return;
    if(/^(?:all|search|items|values)$/i.test(name)) return;
    const k=name.toLowerCase(), prev=found.get(k)||{};
    const valid=Number.isFinite(value) && value>=0 ? value : null;
    found.set(k,{name,value:valid ?? prev.value ?? null,sheet:sheet || prev.sheet || "Other",image_url:image || images.get(k) || prev.image_url || null});
  };
  // Parse accessible table rows first. MM2Calculator exposes item name, value, tier,
  // demand and trend in table cells; this is more reliable than guessing from nearby text.
  if(game === "mm2") {
    for(const tr of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const rowHtml = tr[1];
      const cells = [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x => x[1]);
      if(cells.length < 2) continue;
      const first = cells[0];
      const link = first.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
      let name = plainHtml(link ? link[1] : first).replace(/\s+(?:Hot\s+)?(?:Knife|Gun|Pet|Misc|Set)\b.*$/i, "").trim();
      name = name.replace(/\s+(?:New\s+)?(?:Knife|Gun|Pet|Misc|Set)\s*$/i, "").trim();
      const valueText = plainHtml(cells[1]);
      const vm = valueText.match(/(?:^|\s)([\d,]+(?:\.\d+)?)(?:\s|$)/);
      const value = vm ? Number(vm[1].replace(/,/g,"")) : null;
      const whole = plainHtml(rowHtml);
      const sheet = /\bPet\b/i.test(whole) ? "Other" : /\bGun\b/i.test(whole) ? "Gun" : /\bKnife\b/i.test(whole) ? "Knife" : "Other";
      const imgTag = rowHtml.match(/<img\b[^>]*>/i);
      let image = null;
      if(imgTag) {
        const src = attr(imgTag[0],"src") || attr(imgTag[0],"data-src") || attr(imgTag[0],"data-lazy-src");
        try { if(src) { image = new URL(src,base).toString(); if(new URL(image).protocol !== "https:") image = null; } } catch {}
      }
      add(name,value,sheet,image);
    }
  }
  // Item pages often render cards as images with their name in alt text and category in adjacent text.
  for(const m of String(html).matchAll(/<img\b[^>]*>/gi)) {
    const tag=m[0], name=attr(tag,"alt") || attr(tag,"title");
    const src=attr(tag,"src") || attr(tag,"data-src") || attr(tag,"data-lazy-src") || attr(tag,"data-original");
    if(!name || !src) continue;
    const pos=m.index || 0, nearby=plainHtml(String(html).slice(pos,Math.min(String(html).length,pos+450)));
    const category=game==="mm2" ? (/\bAncient\b/i.test(nearby)?"Other":/\b(?:Godly|Chroma|Vintage|Unique|Legendary|Rare|Uncommon|Common)\b/i.test(nearby)?"Knife":"Other") :
      (/\bLegendary\b/i.test(nearby)?"Legendary":/\bUltra Rare\b/i.test(nearby)?"Ultra Rare":/\bRare\b/i.test(nearby)?"Rare":/\bUncommon\b/i.test(nearby)?"Uncommon":/\bCommon\b/i.test(nearby)?"Common":/\bVehicle\b/i.test(nearby)?"Vehicles":"Other");
    let image=null; try { image=new URL(src,base).toString(); if(new URL(image).protocol!=="https:") image=null; } catch {}
    add(name,null,category,image);
  }
  // Parse anchor/card text where the source exposes a value alongside an item name.
  const anchors=[...String(html).matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)];
  for(let i=0;i<anchors.length;i++) {
    const m=anchors[i], inner=m[1], start=(m.index||0)+m[0].length, end=i+1<anchors.length?(anchors[i+1].index||String(html).length):Math.min(String(html).length,start+500);
    const tail=plainHtml(String(html).slice(start,Math.min(end,start+600)));
    const txt=plainHtml(inner);
    let name=txt.replace(/^Image:\s*/i,"");
    let val=null;
    if(game==="adm") {
      const vm=tail.match(/(?:—|–|\s-\s|:\s*)\s*([\d,]+(?:\.\d+)?)(?!\d)/);
      if(vm) val=Number(vm[1].replace(/,/g,""));
    } else {
      const both=plainHtml(inner+" "+tail);
      let vm=both.match(/Demand\s*([1-8])\s*([\d,]+(?:\.\d+)?)/i);
      if(vm) val=Number(vm[2].replace(/,/g,""));
      if(!name || name.length>100) name=(attr(m[0],"title")||"");
      // FairStash cards concatenate item name, year and rarity; keep the readable leading title.
      name=name.replace(/\s+(?:\d{4})?\s*(?:Godly|Ancient|Sets?|Pets?|Unique|Vintage|Legendary|Rare|Uncommon|Common|Misc).*$/i,"").trim();
    }
    const before=String(html).slice(Math.max(0,(m.index||0)-500),m.index||0);
    const im=[...before.matchAll(/<img\b[^>]*>/gi)].pop();
    const img=im ? (attr(im[0],"src")||attr(im[0],"data-src")) : null;
    let sheet="Other";
    if(game==="mm2") sheet=/\bGun\b/i.test(txt+" "+tail)?"Gun":/\bKnife\b/i.test(txt+" "+tail)?"Knife":"Other";
    else sheet=/\bLegendary\b/i.test(txt+" "+tail)?"Legendary":/\bUltra Rare\b/i.test(txt+" "+tail)?"Ultra Rare":/\bRare\b/i.test(txt+" "+tail)?"Rare":/\bUncommon\b/i.test(txt+" "+tail)?"Uncommon":/\bCommon\b/i.test(txt+" "+tail)?"Common":"Other";
    let image=null; try { if(img) { image=new URL(img,base).toString(); if(new URL(image).protocol!=="https:") image=null; } } catch {}
    add(name,val,sheet,image);
  }
  return [...found.values()];
}
R("POST","/api/items/sync-catalog",async req=>{
  const u=needEditor(req), b=await readBody(req), game=gameOf(b.game);
  // Pull category pages, not only the landing page: many value sites show just the
  // first page of the catalogue at /values. Each category page contributes names,
  // community points and image URLs; duplicates are merged below.
  const sources=game==="adm" ? [
    {url:"https://adoptme.trading/values",label:"Adopt Me full value list"},
    {url:"https://adoptme.trading/values/pets",label:"Adopt Me pets"},
    {url:"https://adoptme.trading/values/eggs",label:"Adopt Me eggs"},
    {url:"https://adoptme.trading/values/vehicles",label:"Adopt Me vehicles"},
    {url:"https://adoptme.trading/values/strollers",label:"Adopt Me strollers"},
    {url:"https://adoptme.trading/values/toys",label:"Adopt Me toys"},
    {url:"https://adoptme.trading/values/food",label:"Adopt Me food"},
    {url:"https://adoptme.trading/values/pet-wear",label:"Adopt Me pet wear"},
    {url:"https://adoptme.trading/values/gifts",label:"Adopt Me gifts"},
    {url:"https://adoptme.trading/values/stickers",label:"Adopt Me stickers"},
    {url:"https://adoptme.trading/values/houses",label:"Adopt Me houses"},
    {url:"https://adoptme.trading/values/halloween-pets",label:"Adopt Me Halloween pets"}
  ] : [
    {url:"https://mm2calculator.com/mm2-values",label:"MM2 full value list"},
    {url:"https://mm2calculator.com/mm2-knife-values",label:"MM2 knives"},
    {url:"https://mm2calculator.com/mm2-gun-values",label:"MM2 guns"},
    {url:"https://mm2calculator.com/mm2-pet-values",label:"MM2 pets"},
    {url:"https://mm2calculator.com/mm2-misc-values",label:"MM2 misc and sets"},
    {url:"https://mm2calculator.com/mm2-godly-values",label:"MM2 godly items"},
    {url:"https://mm2calculator.com/mm2-ancient-values",label:"MM2 ancient items"},
    {url:"https://mm2calculator.com/mm2-unique-values",label:"MM2 unique items"},
    {url:"https://mm2calculator.com/mm2-vintage-values",label:"MM2 vintage items"},
    {url:"https://mm2calculator.com/mm2-legendary-values",label:"MM2 legendary items"},
    {url:"https://mm2calculator.com/mm2-rare-values",label:"MM2 rare items"},
    {url:"https://mm2calculator.com/mm2-uncommon-values",label:"MM2 uncommon items"},
    {url:"https://mm2calculator.com/mm2-common-values",label:"MM2 common items"},
    {url:"https://mm2values.app/",label:"MM2Values.app secondary source"},
    {url:"https://mm2values.com/",label:"MM2Values secondary source"}
  ];
  const fetched=await Promise.all(sources.map(async source=>{
    try {
      const resp=await fetch(source.url,{headers:{"User-Agent":"Mozilla/5.0 (compatible; SolarBNST-CatalogSync/1.0)"},signal:AbortSignal.timeout(12000)});
      if(!resp.ok) throw new Error("HTTP "+resp.status);
      const html=await resp.text();
      if(html.length>15*1024*1024) throw new Error("source page too large");
      return {source,html,rows:sourceCatalogRows(html,game,source.url)};
    } catch(e) { return {source,error:String(e.message||e),rows:[]}; }
  }));
  const merged=new Map();
  for(const part of fetched) for(const row of part.rows) {
    const k=row.name.toLowerCase(), old=merged.get(k)||{};
    merged.set(k,{...old,...row,value:row.value ?? old.value ?? null,image_url:row.image_url || old.image_url || null});
  }
  if(!merged.size) {
    return {game,added:0,updated:0,values:0,pictures:0,parsed:0,sources:fetched.map(x=>({label:x.source.label,url:x.source.url,parsed:x.rows.length,error:x.error||null})),note:"No catalogue rows could be parsed. The server may not have internet access, or the source page may have changed. No database rows were changed."};
  }
  let added=0,updated=0,values=0,pictures=0;
  atomic(()=>{
    for(const row of merged.values()) {
      let sheet=row.sheet;
      if(!SHEETS[game].includes(sheet)) sheet="Other";
      const old=one("SELECT id,value,image_url FROM game_items WHERE game=? AND name=?",game,row.name);
      if(old) {
        const value=row.value==null?old.value:row.value;
        const image_url=row.image_url||old.image_url;
        if(row.value!=null && row.value!==old.value) values++;
        if(row.image_url && row.image_url!==old.image_url) pictures++;
        run("UPDATE game_items SET value=?,image_url=?,sheet=?,currency='POINTS',updated_at=?,updated_by=? WHERE id=?",value,image_url,sheet,now(),u.id,old.id);
        updated++;
      } else {
        run("INSERT INTO game_items(game,sheet,name,value,currency,image_url,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)",game,sheet,row.name,row.value,"POINTS",row.image_url,now(),u.id);
        added++; if(row.value!=null) values++; if(row.image_url) pictures++;
      }
    }
    audit(u.id,"item.catalog_sync",game,JSON.stringify({added,updated,values,pictures,sources:fetched.map(x=>({url:x.source.url,rows:x.rows.length,error:x.error||null}))}));
  });
  return {game,added,updated,values,pictures,parsed:merged.size,sources:fetched.map(x=>({label:x.source.label,url:x.source.url,parsed:x.rows.length,error:x.error||null})),note:"Only clearly parsed community values were imported. Items without a confirmed numeric value remain unvalued; verify source updates before trading."};
});

// ---- Community market: listings are separate from the value database ----
const marketRow = id => one(`SELECT l.id,l.seller_id,l.game,l.item_name,l.asking_price,l.notes,l.contact,l.status,l.created_at,l.updated_at,u.name AS seller_name,u.username AS seller_username
  FROM market_listings l JOIN users u ON u.id=l.seller_id WHERE l.id=?`, id);
R("GET","/api/market",async (req,m,url)=>{
  const u = need(req);
  const game = url.searchParams.get("game");
  if(game && !GAMES.includes(game)) fail(400,"Choose ADM or MM2.");
  const status = url.searchParams.get("status")==="mine" ? "mine" : "active";
  const term = str(url.searchParams.get("q")||"",60);
  const rows = q(`SELECT l.id,l.seller_id,l.game,l.item_name,l.asking_price,l.notes,l.contact,l.status,l.created_at,l.updated_at,u.name AS seller_name,u.username AS seller_username
    FROM market_listings l JOIN users u ON u.id=l.seller_id
    WHERE l.status=? AND (?='' OR l.game=?) AND l.item_name LIKE ? ESCAPE '\\' ${status==="mine" ? "AND l.seller_id=?" : ""}
    ORDER BY l.created_at DESC LIMIT 200`,
    status==="mine" ? "active" : "active", game||"",game||"",`%${escLike(term)}%`,...(status==="mine"?[u.id]:[]));
  return rows;
});
R("POST","/api/market",async req=>{
  const u=need(req); const b=await readBody(req);
  const game=gameOf(b.game), item_name=itemName(b.item_name);
  const price=Number(String(b.asking_price??"").replace(/,/g,""));
  if(!Number.isFinite(price)||price<0||price>1e9) fail(400,"Enter a valid asking price (0 or more).");
  const notes=str(b.notes,500), contact=str(b.contact,200);
  if(contact && !/^https:\/\/(www\.|m\.)?(facebook\.com|fb\.com|messenger\.com|m\.me)\/[^\s"'<>]{1,180}$/i.test(contact))
    fail(400,"Contact must be an https Facebook or Messenger link.");
  const at=now();
  const r=run("INSERT INTO market_listings(seller_id,game,item_name,asking_price,notes,contact,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?)",u.id,game,item_name,Math.round(price*100)/100,notes,contact,at,at);
  audit(u.id,"market.listing.create",String(r.lastInsertRowid),JSON.stringify({game,item_name,asking_price:price}));
  return marketRow(Number(r.lastInsertRowid));
});
R("PATCH","/api/market/(\\d+)",async (req,m)=>{
  const u=need(req), b=await readBody(req), cur=marketRow(Number(m[1]));
  if(cur.seller_id!==u.id && rank(u)<RANK_CO) fail(403,"You can only manage your own listing.");
  const status=b.status===undefined?cur.status:str(b.status,20);
  if(!["active","sold","removed"].includes(status)) fail(400,"Unknown listing status.");
  const notes=b.notes===undefined?cur.notes:str(b.notes,500);
  run("UPDATE market_listings SET status=?,notes=?,updated_at=? WHERE id=?",status,notes,now(),cur.id);
  audit(u.id,"market.listing.update",String(cur.id),JSON.stringify({status}));
  return marketRow(cur.id);
});
R("DELETE","/api/market/(\\d+)",async (req,m)=>{
  const u=need(req), cur=marketRow(Number(m[1]));
  if(cur.seller_id!==u.id && rank(u)<RANK_CO) fail(403,"You can only delete your own listing.");
  run("DELETE FROM market_listings WHERE id=?",cur.id);
  audit(u.id,"market.listing.delete",String(cur.id),null);
  return {ok:true};
});

// ---- Chat assistant: an HTTPS link the Owner or Co-Owner sets; shown inside a sandboxed frame ----
const ASSISTANT_URL = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[^\s"'<>]*)?$/i;
R("GET","/api/assistant",async req=>{
  need(req);
  return {url: one("SELECT value FROM settings WHERE key='assistant_url'")?.value || null};
});
R("PATCH","/api/assistant",async req=>{
  const u = need(req,RANK_CO); const b = await readBody(req);
  const url = str(b.url,300);
  if(url && !ASSISTANT_URL.test(url)) fail(400,"Use a full https:// link.");
  if(url) run("INSERT INTO settings(key,value) VALUES('assistant_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",url);
  else run("DELETE FROM settings WHERE key='assistant_url'");
  audit(u.id,"assistant.set",null,url ? "set" : "cleared");
  return {url: url || null};
});

// ---- GC invitation link (public to read, admins can set or clear) ----
R("GET","/api/gc-invite",async ()=>({url: one("SELECT value FROM settings WHERE key='gc_invite'")?.value || null}));
R("PATCH","/api/gc-invite",async req=>{
  const u = need(req,RANK_CO); const b = await readBody(req);
  const url = str(b.url,300);
  if(url && !GC_URL.test(url)) fail(400,"Use an https Facebook or Messenger link.");
  if(url) run("INSERT INTO settings(key,value) VALUES('gc_invite',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",url);
  else run("DELETE FROM settings WHERE key='gc_invite'");
  audit(u.id,"gc.invite",null,url ? "set" : "cleared");
  return {url: url || null};
});

// Saved clients: any signed-in staff can add and edit; admins can delete
R("GET","/api/clients",async req=>{
  need(req,1);
  return q("SELECT id,name,display_name,fb_url,created_at FROM clients ORDER BY name COLLATE NOCASE");
});
R("POST","/api/clients",async req=>{
  const u = need(req,1); const b = await readBody(req);
  const name = str(b.name,60), display = str(b.display_name,60), fb = str(b.fb_url,300);
  if(!name) fail(400,"Client name is required.");
  if(!FB.test(fb)) fail(400,"Use an https facebook.com page or profile link.");
  const r = run("INSERT INTO clients(name,display_name,fb_url,created_by,created_at) VALUES(?,?,?,?,?)",name,display,fb,u.id,now());
  return {id:Number(r.lastInsertRowid),name,display_name:display,fb_url:fb};
});
R("PATCH","/api/clients/(\\d+)",async (req,m)=>{
  need(req,1); const b = await readBody(req);
  const c = one("SELECT * FROM clients WHERE id=?",Number(m[1])) || fail(404,"Client not found.");
  const name = b.name !== undefined ? str(b.name,60) : c.name;
  const display = b.display_name !== undefined ? str(b.display_name,60) : c.display_name;
  const fb = b.fb_url !== undefined ? str(b.fb_url,300) : c.fb_url;
  if(!name) fail(400,"Client name is required.");
  if(!FB.test(fb)) fail(400,"Use an https facebook.com page or profile link.");
  run("UPDATE clients SET name=?,display_name=?,fb_url=? WHERE id=?",name,display,fb,c.id);
  return {id:c.id,name,display_name:display,fb_url:fb};
});
R("DELETE","/api/clients/(\\d+)",async (req,m)=>{
  const u = need(req,RANK_ADMIN);
  run("DELETE FROM clients WHERE id=?",Number(m[1]));
  audit(u.id,"client.delete",m[1],null);
  return {ok:true};
});


R("GET","/api/config",async ()=>({google_client_id: GOOGLE_CLIENT_ID || null}));

async function startSession(res,user){
  const tok = crypto.randomBytes(32).toString("base64url");
  run("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",sha(tok),user.id,Date.now()+7*864e5);
  return full(200,{ok:true,user:pub(user)},{"Set-Cookie":`sid=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7*86400}${COOKIE_SECURE?"; Secure":""}`});
}

R("POST","/api/auth/google",async req=>{
  if(!GOOGLE_CLIENT_ID) fail(404,"Google sign-in is not set up yet.");
  const b = await readBody(req);
  const cred = str(b.credential,4096); if(!cred) fail(400,"Missing Google credential.");
  let t;
  try{
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token="+encodeURIComponent(cred));
    if(!r.ok) fail(401,"Google sign-in failed.");
    t = await r.json();
  } catch(e){ if(e instanceof HttpError) throw e; fail(502,"Could not reach Google. Try again."); }
  if(t.aud !== GOOGLE_CLIENT_ID || !t.sub) fail(401,"Google sign-in failed.");
  let user = one("SELECT * FROM users WHERE google_sub=?",t.sub);
  if(!user){
    const name = str(t.name || t.given_name || "Visitor",60);
    const uname = "g_" + t.sub.slice(-12);
    run("INSERT INTO users(username,name,pass_hash,role,created_at,google_sub,onboarded) VALUES(?,?,?,?,?,?,0)",uname,name,"-","visitor",now(),t.sub);
    user = one("SELECT * FROM users WHERE google_sub=?",t.sub);
  }
  const restricted = restriction(user); if(restricted) fail(403, restricted.msg, restricted.extra);
  return startSession(null,user);
});

R("POST","/api/visitors",async req=>{
  if(limited("signup:"+req.socket.remoteAddress,10,3600e3)) fail(429,"Too many sign-ups from this network. Try again later.");
  const b = await readBody(req);
  const name = str(b.name,60), username = str(b.username,24), pw = String(b.password||"");
  if(!name) fail(400,"Name is required.");
  if(!validUsername(username)) fail(400,"Username: 3 to 24 letters, numbers, or underscores.");
  if(pw.length < 8) fail(400,"Password must be at least 8 characters.");
  if(one("SELECT id FROM users WHERE username=?",username)) fail(409,"That username is taken.");
  const id = run("INSERT INTO users(username,name,pass_hash,role,created_at,onboarded) VALUES(?,?,?,?,?,0)",username,name,hashPw(pw),"visitor",now()).lastInsertRowid;
  return startSession(null, one("SELECT * FROM users WHERE id=?",Number(id)));
});

R("PATCH","/api/onboarding",async req=>{
  const u = need(req,-1); const b = await readBody(req);
  const purposes = ["buying","selling","middleman","looking","other"];
  const purpose = str(b.purpose,20);
  if(!purposes.includes(purpose)) fail(400,"Please choose why you are here.");
  run("UPDATE users SET onboarded=1,purpose=?,referrer=?,join_stream=? WHERE id=?",purpose,str(b.referrer,120),b.join_stream===true?1:0,u.id);
  return pub(one("SELECT * FROM users WHERE id=?",u.id));
});

// Most requests: how often each person (by Facebook link) appears as buyer or seller. Names only, no links.
R("GET","/api/top-requesters",async ()=>{
  const rows = q("SELECT buyer_name AS n, buyer_fb AS f, created_at AS c FROM transactions UNION ALL SELECT seller_name, seller_fb, created_at FROM transactions");
  const m = new Map();
  for(const r of rows){
    const k = r.f.toLowerCase().replace(/^https?:\/\/(www\.|m\.)?/,"").replace(/[?#].*$/,"").replace(/\/+$/,"");
    const e = m.get(k) || {name:r.n, count:0, last:""};
    e.count++;
    if(r.c > e.last){ e.last = r.c; e.name = r.n; }
    m.set(k,e);
  }
  return [...m.values()].sort((a,b)=>b.count-a.count || a.name.localeCompare(b.name)).slice(0,20).map(({name,count})=>({name,count}));
});

// Join GC links (public, configured by admins)
R("GET","/api/gc-links",async ()=>[1,2,3].map(slot=>({slot, url: one("SELECT value FROM settings WHERE key=?","gc_"+slot)?.value || null})));
R("PATCH","/api/gc-links",async req=>{
  const u = need(req,RANK_CO); const b = await readBody(req);
  const slot = Number(b.slot);
  if(![1,2,3].includes(slot)) fail(400,"Slot must be 1, 2, or 3.");
  const url = str(b.url,300);
  if(url && !GC_URL.test(url)) fail(400,"Use an https Facebook or Messenger link.");
  if(url) run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value","gc_"+slot,url);
  else run("DELETE FROM settings WHERE key=?","gc_"+slot);
  audit(u.id,"gc.set",String(slot),url?"set":"cleared");
  return {slot, url: url || null};
});

// Public submission and tracking
R("POST","/api/transactions",async req=>{
  const ip = req.socket.remoteAddress;
  if(limited("submit:"+ip,10,3600e3)) fail(429,"Too many requests. Please try again later.");
  const b = await readBody(req);
  const v = {buyer_name:str(b.buyer_name,60),buyer_fb:str(b.buyer_fb,300),seller_name:str(b.seller_name,60),
    seller_fb:str(b.seller_fb,300),item:str(b.item,120),price:str(b.price,20),currency:str(b.currency,3),
    description:str(b.description,1000),extra:str(b.extra,1000)};
  if(!v.buyer_name) fail(400,"Buyer name is required.");
  if(!FB.test(v.buyer_fb)) fail(400,"Buyer Facebook link must be an https facebook.com profile URL.");
  if(!v.seller_name) fail(400,"Seller name is required.");
  if(!FB.test(v.seller_fb)) fail(400,"Seller Facebook link must be an https facebook.com profile URL.");
  if(!v.item) fail(400,"Item or service is required.");
  if(!/^\d{1,8}(\.\d{1,2})?$/.test(v.price) || Number(v.price) <= 0) fail(400,"Enter a positive price with up to 2 decimals.");
  if(!["PHP","USD","EUR"].includes(v.currency)) fail(400,"Unsupported currency.");
  if(!v.description) fail(400,"Please describe the transaction.");
  if(b.agree !== true) fail(400,"Both parties must agree before submitting.");
  const id = newTxId(), at = now();
  atomic(()=>{
    run(`INSERT INTO transactions(id,buyer_name,buyer_fb,seller_name,seller_fb,item,price_cents,currency,description,extra,status,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,id,v.buyer_name,v.buyer_fb,v.seller_name,v.seller_fb,v.item,
         Math.round(Number(v.price)*100),v.currency,v.description,v.extra,S.PENDING,at);
    run("INSERT INTO tx_history(tx_id,from_status,to_status,actor_id,reason,at) VALUES(?,?,?,?,?,?)",id,"(new)",S.PENDING,null,"Submitted",at);
    notifyManagers(`New request ${id}`,id);
  });
  return {id,status:S.PENDING};
});

R("GET","/api/track/(STB-[A-Z2-9]{5}-[A-Z2-9]{5})",async (req,m)=>{
  if(limited("track:"+req.socket.remoteAddress,60,60e3)) fail(429,"Too many requests.");
  const tx = getTx(m[1]);
  const timeline = q("SELECT to_status,at FROM tx_history WHERE tx_id=? ORDER BY id",tx.id).map(h=>({status:h.to_status,at:h.at}));
  return {id:tx.id,status:tx.status,created_at:tx.created_at,timeline};
});

R("GET","/api/transactions/([A-Z0-9-]+)",async (req,m)=>{
  const u = need(req); const tx = getTx(m[1]);
  if(!canManageTx(u) && tx.mm_id !== u.id) fail(403,"Not allowed.");
  const history = q("SELECT from_status,to_status,actor_id,reason,at FROM tx_history WHERE tx_id=? ORDER BY id",tx.id);
  return {...tx, price:tx.price_cents/100, price_cents:undefined, history};
});

R("GET","/api/transactions",async req=>{
  const u = need(req);
  const cols = "id,item,price_cents,currency,status,mm_id,open_dispute,created_at";
  const rows = canManageTx(u) ? q(`SELECT ${cols} FROM transactions ORDER BY created_at DESC`)
    : u.mm_eligible ? q(`SELECT ${cols} FROM transactions WHERE mm_id=? ORDER BY created_at DESC`,u.id) : [];
  return rows.map(r=>({...r,price:r.price_cents/100,price_cents:undefined}));
});

R("POST","/api/transactions/([A-Z0-9-]+)/assign",async (req,m)=>{
  const actor = need(req,RANK_MANAGE_TX); const b = await readBody(req);
  return atomic(()=>{
    const tx = getTx(m[1]);
    if(![S.PENDING,S.AWAIT].includes(tx.status)) fail(409,"This request is not open for assignment.");
    const mm = one("SELECT * FROM users WHERE id=? AND active=1 AND mm_eligible=1",Number(b.mm_id));
    if(!mm) fail(400,"Selected user is not an active, eligible MM/MW.");
    const load = one("SELECT COUNT(*) c FROM transactions WHERE mm_id=? AND status NOT IN (?,?)",mm.id,S.DONE,S.CANCEL).c;
    if(load >= MAX_LOAD) fail(409,"This MM/MW is at their workload limit.");
    const updated = moveTx(tx,S.AWAIT,actor.id,"Assigned",{mm_id:mm.id});
    audit(actor.id,"tx.assign",tx.id,`to ${mm.username}`);
    return {id:updated.id,status:updated.status,mm_id:updated.mm_id};
  });
});

R("POST","/api/transactions/([A-Z0-9-]+)/respond",async (req,m)=>{
  const u = need(req); const b = await readBody(req);
  return atomic(()=>{
    const tx = getTx(m[1]);
    if(tx.mm_id !== u.id) fail(403,"Only the assigned MM/MW can respond.");
    if(tx.status !== S.AWAIT) fail(409,"Nothing to respond to.");
    const updated = b.accept === true
      ? moveTx(tx,S.ASSIGNED,u.id,"Accepted")
      : moveTx(tx,S.PENDING,u.id,"Declined by MM/MW",{mm_id:null});
    return {id:updated.id,status:updated.status};
  });
});

R("POST","/api/transactions/([A-Z0-9-]+)/transition",async (req,m)=>{
  const u = need(req); const b = await readBody(req);
  const to = str(b.to,40), reason = str(b.reason,300);
  if(!Object.values(S).includes(to)) fail(400,"Unknown status.");
  if([S.ASSIGNED,S.AWAIT].includes(to)) fail(400,"Use assignment and acceptance to set this status.");
  const manage = canManageTx(u);
  if(!manage && (ADMIN_ONLY_TO.includes(to) || !u.mm_eligible)) fail(403,"Not allowed to set that status.");
  if([S.DISP,S.CANCEL].includes(to) && reason.length < 3) fail(400,"A reason is required for this status.");
  return atomic(()=>{
    const tx = getTx(m[1]);
    if(!manage && tx.mm_id !== u.id) fail(403,"Only the assigned MM/MW or a manager can update this.");
    const updated = moveTx(tx,to,u.id,reason);
    if(manage) audit(u.id,"tx.transition",tx.id,`${tx.status} to ${to}`);
    return {id:updated.id,status:updated.status};
  });
});

R("GET","/api/notifications",async req=>{
  const u = need(req);
  const rows = q("SELECT id,tx_id,text,read,at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100",u.id);
  return {unread:rows.filter(r=>!r.read).length,items:rows.map(r=>({...r,read:!!r.read}))};
});
R("POST","/api/notifications/read-all",async req=>{
  const u = need(req); run("UPDATE notifications SET read=1 WHERE user_id=?",u.id); return {ok:true};
});

// Public directory, leaderboard, and overview: only opted-in MMs, no usernames, no links
R("GET","/api/mms",async ()=>q(`
  SELECT u.id,u.name,u.bio,u.specialties,
    (SELECT COUNT(*) FROM transactions t WHERE t.mm_id=u.id AND t.status NOT IN ('${S.DONE}','${S.CANCEL}')) AS holding,
    (SELECT COUNT(*) FROM transactions t WHERE t.mm_id=u.id AND t.status='${S.DONE}') AS completed
  FROM users u WHERE u.mm_eligible=1 AND u.active=1 AND u.show_public=1 ORDER BY holding DESC, u.name`));

// Leaderboard: Daily / Weekly / Monthly (Philippine time, UTC+8), ranked by completed deals or estimated fees.
const PH_OFFSET = 8 * 3600e3;
function periodSince(period){
  const d = new Date(Date.now() + PH_OFFSET);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const start = period === "daily" ? today : period === "weekly" ? today - 6*864e5 : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return new Date(start - PH_OFFSET).toISOString();
}
R("GET","/api/leaderboard",async (req,m,url)=>{
  const period = ["daily","weekly","monthly"].includes(url.searchParams.get("period")) ? url.searchParams.get("period") : "monthly";
  const metric = url.searchParams.get("metric") === "completed" ? "completed" : "fees";
  const fee = Number(one("SELECT value FROM settings WHERE key='fee_percent'")?.value || 0);
  const rows = q(`SELECT u.id,u.name,u.role,u.avatar_at,t.currency,COUNT(t.id) AS n,SUM(t.price_cents) AS cents
    FROM transactions t JOIN users u ON u.id=t.mm_id
    WHERE t.status=? AND t.completed_at>=? AND u.show_public=1 AND u.active=1
    GROUP BY u.id,t.currency`, S.DONE, periodSince(period));
  const currencies = [...new Set(rows.map(r=>r.currency))].sort();
  const cur = currencies.includes(String(url.searchParams.get("currency")||"").toUpperCase()) ? String(url.searchParams.get("currency")).toUpperCase() : (currencies.includes("PHP") ? "PHP" : currencies[0] || "PHP");
  const byUser = new Map();
  for(const r of rows){
    const e = byUser.get(r.id) || {id:r.id,name:r.name,role_label:roleLabel(r.role),role_color:ROLES[r.role]?.color||"#8A8F98",avatar_at:r.avatar_at||null,completed:0,fees:{},values:{}};
    e.completed += r.n;
    e.fees[r.currency] = Math.round(r.cents * fee) / 100 / 100;
    e.values[r.currency] = r.cents / 100;
    byUser.set(r.id, e);
  }
  const list = [...byUser.values()].map(e => ({...e, fee_value: e.fees[cur] || 0, value: e.values[cur] || 0}))
    .sort((x,y) => metric === "completed" ? (y.completed - x.completed || x.name.localeCompare(y.name)) : (y.fee_value - x.fee_value || y.completed - x.completed || x.name.localeCompare(y.name)))
    .slice(0,50).map((e,i) => ({rank:i+1, ...e}));
  return {period, metric, currency: cur, currencies, fee_percent: fee, rows: list};
});
R("GET","/api/overview",async ()=>{
  const fee = Number(one("SELECT value FROM settings WHERE key='fee_percent'")?.value || 0);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const month_completed = one("SELECT COUNT(*) n FROM transactions WHERE status=? AND completed_at>=?", S.DONE, monthStart).n;
  const by_currency = q("SELECT currency,COUNT(*) n,SUM(price_cents) cents FROM transactions WHERE status=? GROUP BY currency", S.DONE)
    .map(r=>({currency:r.currency,count:r.n,value:r.cents/100,est_fee:Math.round(r.cents*fee/100)/100}));
  const days = [];
  for(let i=29;i>=0;i--){ const d = new Date(); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()-i); days.push(d.toISOString().slice(0,10)); }
  const rows = q("SELECT substr(completed_at,1,10) day,currency,COUNT(*) n,SUM(price_cents) cents FROM transactions WHERE status=? AND completed_at>=? GROUP BY day,currency", S.DONE, days[0]+"T00:00:00.000Z");
  const series = days.map(day=>{
    const r = {day, completions:0, value:{}, fees:{}};
    for(const x of rows.filter(x=>x.day===day)){ r.completions += x.n; r.value[x.currency] = x.cents/100; r.fees[x.currency] = Math.round(x.cents*fee/100)/100; }
    return r;
  });
  return {fee_percent:fee, month_completed, by_currency, series};
});

// Revenue, settings, audit
R("GET","/api/revenue",async req=>{
  need(req,RANK_CO);
  const fee = Number(one("SELECT value FROM settings WHERE key='fee_percent'")?.value || 0);
  const byCurrency = q(`SELECT currency,COUNT(*) AS count,SUM(price_cents) AS cents FROM transactions WHERE status='${S.DONE}' GROUP BY currency`)
    .map(r=>({currency:r.currency,count:r.count,value:r.cents/100,est_fee:Math.round(r.cents*fee/100)/100}));
  const counts = Object.fromEntries(q("SELECT status,COUNT(*) AS n FROM transactions GROUP BY status").map(r=>[r.status,r.n]));
  const monthly = q(`SELECT substr(completed_at,1,7) AS month,COUNT(*) AS count FROM transactions WHERE status='${S.DONE}' GROUP BY month ORDER BY month DESC LIMIT 6`);
  return {fee_percent:fee,by_currency:byCurrency,counts,monthly};
});

R("PATCH","/api/settings",async req=>{
  const u = need(req,RANK_OWNER); const b = await readBody(req);
  const fee = Number(b.fee_percent);
  if(!(fee >= 0 && fee <= 50)) fail(400,"Fee must be between 0 and 50.");
  run("INSERT INTO settings(key,value) VALUES('fee_percent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(fee));
  audit(u.id,"settings.fee",null,String(fee));
  return {fee_percent:fee};
});

R("GET","/api/audit",async req=>{
  need(req,RANK_CO);
  return q("SELECT a.id,u.username AS actor,a.action,a.target,a.detail,a.at FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200");
});

// Lift suspensions whose time has passed. Runs on every request and once a minute.
function sweepSuspensions(){
  const due = q("SELECT id FROM users WHERE suspended_until IS NOT NULL AND suspended_until<=?", now());
  for(const r of due){
    run("UPDATE users SET suspended_until=NULL,suspend_reason='' WHERE id=?", r.id);
    audit(null,"user.suspension_expired",String(r.id),null);
  }
}

// ---------- startup ----------
if(!one("SELECT id FROM users LIMIT 1")){
  const code = crypto.randomBytes(6).toString("hex").toUpperCase().match(/.{4}/g).join("-");
  run("INSERT OR REPLACE INTO settings(key,value) VALUES('setup_hash',?)",sha(code));
  console.log(`First run. Owner setup code (shown once): ${code}`);
}

// Seed the three GC links once, on first start, so Join GC 1-3 and the invitation link work immediately.
// Admins can change or clear them later; this never runs again after it has been done once.
if (!one("SELECT value FROM settings WHERE key='gc_seeded'")) {
  const SEED = {gc_1:"https://m.me/j/1VRtp8GV25ZeqWGk/?send_source=gc%3Acopy_invite_link_t",
                gc_2:"https://m.me/j/bp4HND5-XcsdjBzT/?send_source=gc%3Acopy_invite_link_t",
                gc_3:"https://m.me/j/xQXjV2Jqm3woQe6L/?send_source=gc%3Acopy_invite_link_t"};
  atomic(()=>{
    for (const [k,v] of Object.entries(SEED)) if (GC_URL.test(v)) run("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)",k,v);
    run("INSERT OR IGNORE INTO settings(key,value) VALUES('gc_invite',?)",SEED.gc_1);
    run("INSERT INTO settings(key,value) VALUES('gc_seeded','1')");
  });
}

async function handle(req,res){
  const url = new URL(req.url,"http://localhost");
  if(!url.pathname.startsWith("/api/")){
    if(req.method !== "GET") return send(res,405,{error:"Method not allowed."});
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'","X-Frame-Options":"DENY","X-Content-Type-Options":"nosniff","Cache-Control":"no-cache"});
    return res.end(INDEX);
  }
  const route = routes.find(r=>r.m===req.method && r.p.test(url.pathname));
  if(!route) return send(res,404,{error:"Not found."});
  const m = route.p.exec(url.pathname);
  const out = await route.h(req,m,url);
  if(out && out.__raw){
    res.writeHead(out.code,{"Content-Type":out.type,"X-Content-Type-Options":"nosniff","Cache-Control":"private, no-cache","Content-Security-Policy":"default-src 'none'; img-src 'self' data:"});
    return res.end(out.body);
  }
  if(out && out.__full) return send(res,out.code,out.body,out.headers);
  return send(res,200,out ?? {ok:true});
}

setInterval(()=>{ try{ sweepSuspensions(); } catch(e){ console.error(e); } }, 60e3).unref();

http.createServer((req,res)=>{
  handle(req,res).catch(e=>{
    if(e instanceof HttpError) return send(res,e.code,{error:e.message,...e.extra});
    console.error(e); send(res,500,{error:"Server error."});
  });
}).listen(PORT,()=>console.log(`Solar BNST API listening on http://localhost:${PORT}`));

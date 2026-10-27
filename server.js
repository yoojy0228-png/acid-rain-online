const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({limit:'32kb'}));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// 계정/전적은 서버의 users.json에 영구 저장됩니다. 비밀번호 원문은 저장하지 않습니다.
const DB_FILE = path.join(__dirname, 'users.json');
const SECRET_FILE = path.join(__dirname, '.literlover-auth-secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(48).toString('hex'), {mode:0o600});
const AUTH_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
let db = { users: {} };
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('users.json 읽기 실패:', e.message); }
if (!db || typeof db.users !== 'object' || !db.users) db = {users:{}};
function saveDb(){ const tmp=DB_FILE+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(db,null,2), {mode:0o600}); fs.renameSync(tmp,DB_FILE); }
function userKey(name){ return String(name||'').toLocaleLowerCase('ko-KR'); }
function safeUser(u){return {username:u.username,createdAt:u.createdAt,stats:u.stats||{games:0,wins:0,losses:0,draws:0,bestScore:0}};}
function makeToken(username){const payload=Buffer.from(JSON.stringify({u:userKey(username),exp:Date.now()+30*24*60*60*1000})).toString('base64url');const sig=crypto.createHmac('sha256',AUTH_SECRET).update(payload).digest('base64url');return payload+'.'+sig;}
function authUser(token){try{const [payload,sig]=String(token||'').split('.');if(!payload||!sig)return null;const expected=crypto.createHmac('sha256',AUTH_SECRET).update(payload).digest();const got=Buffer.from(sig,'base64url');if(got.length!==expected.length||!crypto.timingSafeEqual(got,expected))return null;const data=JSON.parse(Buffer.from(payload,'base64url').toString());if(!data.u||data.exp<Date.now())return null;return db.users[data.u]||null;}catch(_){return null;}}
function bearer(req){return (req.headers.authorization||'').startsWith('Bearer ')?req.headers.authorization.slice(7):'';}
function requireAuth(req,res,next){const u=authUser(bearer(req));if(!u)return res.status(401).json({message:'로그인이 만료되었습니다. 다시 로그인해 주세요.'});req.user=u;next();}
function validCredentials(username,password){if(typeof username!=='string'||!/^[가-힣A-Za-z0-9_-]{3,18}$/.test(username))return '아이디는 한글·영문·숫자·밑줄·하이픈으로 3~18자여야 합니다.';if(typeof password!=='string'||password.length<6||password.length>128)return '비밀번호는 6~128자로 입력해 주세요.';return null;}
function hashPassword(password,salt){return crypto.scryptSync(password,salt,64).toString('hex');}
app.post('/api/register',(req,res)=>{
  const {username,password}=req.body||{};const err=validCredentials(username,password);if(err)return res.status(400).json({message:err});
  const key=userKey(username);if(db.users[key])return res.status(409).json({message:'이미 사용 중인 아이디입니다.'});
  const salt=crypto.randomBytes(16).toString('hex');const user={username,salt,passwordHash:hashPassword(password,salt),createdAt:new Date().toISOString(),stats:{games:0,wins:0,losses:0,draws:0,bestScore:0},records:[]};db.users[key]=user;saveDb();res.json({token:makeToken(username),user:safeUser(user)});
});
app.post('/api/login',(req,res)=>{
  const {username,password}=req.body||{};if(typeof username!=='string'||typeof password!=='string')return res.status(400).json({message:'아이디와 비밀번호를 입력해 주세요.'});
  const user=db.users[userKey(username)];if(!user)return res.status(401).json({message:'아이디 또는 비밀번호가 올바르지 않습니다.'});
  const got=Buffer.from(hashPassword(password,user.salt),'hex'),want=Buffer.from(user.passwordHash,'hex');if(got.length!==want.length||!crypto.timingSafeEqual(got,want))return res.status(401).json({message:'아이디 또는 비밀번호가 올바르지 않습니다.'});
  res.json({token:makeToken(user.username),user:safeUser(user)});
});
app.get('/api/me',requireAuth,(req,res)=>res.json({user:safeUser(req.user)}));
app.get('/api/records',requireAuth,(req,res)=>res.json({stats:req.user.stats||{},records:req.user.records||[]}));
app.post('/api/logout',(_req,res)=>res.json({ok:true}));
function addRecord(user, record){
  if(!user)return;const stats=user.stats||(user.stats={games:0,wins:0,losses:0,draws:0,bestScore:0});
  stats.games=(stats.games||0)+1;const result=record.result;
  if(result==='win')stats.wins=(stats.wins||0)+1;else if(result==='loss')stats.losses=(stats.losses||0)+1;else if(result==='draw')stats.draws=(stats.draws||0)+1;
  if(Number.isFinite(Number(record.score)))stats.bestScore=Math.max(stats.bestScore||0,Number(record.score));
  user.records=user.records||[];user.records.unshift({...record,date:new Date().toISOString().slice(0,10)});user.records=user.records.slice(0,100);saveDb();
}
app.post('/api/record',requireAuth,(req,res)=>{
  const b=req.body||{};const score=Number(b.score);if(!Number.isFinite(score))return res.status(400).json({message:'점수 형식이 올바르지 않습니다.'});
  const result=String(b.result||'');const outcome=result==='YOU WIN'||result==='QUIZ COMPLETE'?'win':result==='AI WIN'?'loss':'played';
  addRecord(req.user,{mode:['single','ai'].includes(b.mode)?b.mode:'single',modeLabel:b.mode==='ai'?'AI 대전':'싱글',topic:String(b.topic||'').slice(0,40),score,aiScore:Number(b.aiScore)||0,correct:Number(b.correct)||0,attempts:Number(b.attempts)||0,result:outcome,resultLabel:result});
  res.json({ok:true,stats:req.user.stats});
});

// 로그인 없이 게스트도 온라인 대전에 참가할 수 있습니다.
// 로그인 계정이 있으면 계정 정보를 사용하고, 없으면 연결별 임시 게스트 ID를 사용합니다.
io.use((socket,next)=>{
  const u=authUser(socket.handshake.auth&&socket.handshake.auth.token);
  if(u){
    socket.data.accountKey=userKey(u.username);
    socket.data.accountName=u.username;
  } else {
    const guestName=String(socket.handshake.auth&&socket.handshake.auth.name||'플레이어').trim().slice(0,18)||'플레이어';
    socket.data.accountKey='guest:'+socket.id;
    socket.data.accountName=guestName;
  }
  next();
});
const rooms = new Map();
function recordOnlineResult(r, scores, mode){
  if(!r||r.recorded)return;r.recorded=true;
  const max=Math.max(...scores), winners=scores.map((v,i)=>v===max?i:-1).filter(i=>i>=0);
  r.players.forEach((p,i)=>{const u=db.users[p.userKey];if(!u)return;const outcome=winners.length>1?'draw':(winners[0]===i?'win':'loss');addRecord(u,{mode,modeLabel:mode==='dots'?'온라인 도트 앤 박스':'온라인 퀴즈',topic:r.topic||'가짜 판별',score:scores[i],opponent:r.players[1-i]?.name||'',result:outcome,resultLabel:outcome==='win'?'승리':outcome==='loss'?'패배':'무승부'});});
}
function code(){ let s=''; do { s=String(Math.floor(100000+Math.random()*900000)); } while(rooms.has(s)); return s; }
function publicRoom(r){ return {code:r.code, players:r.players.map(p=>({name:p.name, score:p.score})), started:r.started, topic:r.topic, mode:r.mode}; }
function newDots(){return {size:4, lines:{}, boxes:Array.from({length:4},()=>Array(4).fill(-1)), turn:0, scores:[0,0], finished:false};}
function dotsFor(r, playerId){const you=r.players.findIndex(p=>p.id===playerId);return {...r.dots,you};}
function emitDots(r){r.players.forEach(p=>io.to(p.id).emit(r.dots.finished?'dots:ended':'dots:state',dotsFor(r,p.id)));}
function boxEdges(row,col){return [`h-${row}-${col}`,`h-${row+1}-${col}`,`v-${row}-${col}`,`v-${row}-${col+1}`];}
io.on('connection', socket => {
  socket.on('room:create', ({name, topic, mode}={}) => {
    const c=code(); const chosenMode=mode==='dots'?'dots':'quiz';
    const r={code:c, host:socket.id, players:[{id:socket.id,userKey:socket.data.accountKey,name:socket.data.accountName,score:0}], started:false, topic:topic||'문해력', mode:chosenMode, question:null, answered:{}, dots:null, recorded:false};
    rooms.set(c,r); socket.join(c); socket.data.room=c; socket.emit('room:created',publicRoom(r));
  });
  socket.on('room:join', ({code:c,name,mode}={}) => {
    c=String(c||'').trim(); const r=rooms.get(c);
    if(!r){socket.emit('room:error','방 코드를 찾을 수 없습니다.');return;}
    if(r.players.length>=2){socket.emit('room:error','이 방은 이미 두 명이 가득 찼습니다.');return;}
    if(r.started){socket.emit('room:error','이미 게임이 시작된 방입니다.');return;}
    r.players.push({id:socket.id,userKey:socket.data.accountKey,name:socket.data.accountName,score:0}); socket.join(c); socket.data.room=c;
    io.to(c).emit('room:update',publicRoom(r)); io.to(c).emit('room:ready', {room:publicRoom(r)});
  });
  socket.on('game:start', () => {
    const r=rooms.get(socket.data.room); if(!r||r.host!==socket.id||r.players.length!==2)return;
    if(r.started&&!(r.mode==='dots'&&r.dots&&r.dots.finished))return; // 도트 앤 박스는 끝난 뒤 한 판 더 가능
    r.started=true; r.recorded=false; r.players.forEach(p=>p.score=0); r.question=null; r.answered={};
    if(r.mode==='dots')r.dots=newDots();
    io.to(r.code).emit('game:started',publicRoom(r));
    if(r.mode==='dots')emitDots(r);
  });
  // 온라인 도트 앤 박스 비밀 코드: 현재 플레이어가 15칸을 차지하고 마지막 한 칸만 남긴다.
  // 서버에서 상태를 변경하고 양쪽에 브로드캐스트해 화면 불일치를 방지한다.
  socket.on('dots:cheat', () => {
    const r=rooms.get(socket.data.room);
    if(!r||!r.started||r.mode!=='dots'||!r.dots||r.dots.finished)return;
    const playerIndex=r.players.findIndex(p=>p.id===socket.id);
    if(playerIndex<0)return;
    const n=r.dots.size;
    r.dots.lines={};
    for(let row=0;row<=n;row++)for(let col=0;col<n;col++){
      const key=`h-${row}-${col}`;
      if(!(row===n&&col===n-1))r.dots.lines[key]=playerIndex;
    }
    for(let row=0;row<n;row++)for(let col=0;col<=n;col++)r.dots.lines[`v-${row}-${col}`]=playerIndex;
    r.dots.boxes=Array.from({length:n},(_,row)=>Array.from({length:n},(_,col)=>(row===n-1&&col===n-1)?-1:playerIndex));
    r.dots.scores=Array.from({length:r.players.length},(_,i)=>i===playerIndex?n*n-1:0);
    r.dots.turn=playerIndex;
    r.dots.finished=false;
    r.players.forEach((p,i)=>p.score=r.dots.scores[i]);
    emitDots(r);
    io.to(r.code).emit('game:scores',r.players.map(p=>({name:p.name,score:p.score})));
  });
  socket.on('dots:line', ({line}={}) => {
    const r=rooms.get(socket.data.room); if(!r||!r.started||r.mode!=='dots'||!r.dots||r.dots.finished)return;
    const playerIndex=r.players.findIndex(p=>p.id===socket.id);if(playerIndex<0||playerIndex!==r.dots.turn)return;
    if(typeof line!=='string'||r.dots.lines[line]!==undefined)return;
    const m=line.match(/^([hv])-(\d+)-(\d+)$/);if(!m)return;
    const [,dir,rs,cs]=m,row=Number(rs),col=Number(cs),n=r.dots.size;
    if((dir==='h'&&(row<0||row>n||col<0||col>=n))||(dir==='v'&&(row<0||row>=n||col<0||col>n)))return;
    r.dots.lines[line]=playerIndex;
    let got=0;
    for(let br=0;br<n;br++)for(let bc=0;bc<n;bc++)if(r.dots.boxes[br][bc]===-1&&boxEdges(br,bc).every(k=>r.dots.lines[k]!==undefined)){r.dots.boxes[br][bc]=playerIndex;r.dots.scores[playerIndex]++;got++;}
    r.players.forEach((p,i)=>p.score=r.dots.scores[i]);
    if(!got)r.dots.turn=1-playerIndex;
    r.dots.finished=r.dots.boxes.every(row=>row.every(x=>x!==-1));
    if(r.dots.finished)recordOnlineResult(r,r.dots.scores,'dots');
    emitDots(r);io.to(r.code).emit('game:scores',r.players.map(p=>({name:p.name,score:p.score})));
  });
  socket.on('game:question', data => {
    const r=rooms.get(socket.data.room); if(!r||r.mode!=='quiz'||r.host!==socket.id||!r.started)return;
    if(!data||!Array.isArray(data.options)||data.options.length!==2)return;
    r.question={id:String(data.id),text:String(data.text||'').slice(0,1000),options:data.options.map(x=>String(x).slice(0,300)),correct:Number(data.correct)===1?1:0,explain:String(data.explain||'').slice(0,1000)}; r.answered={};
    io.to(r.code).emit('game:question',{id:r.question.id,text:r.question.text,options:r.question.options});
  });
  socket.on('game:answer', ({id,index}={}) => {
    const r=rooms.get(socket.data.room); if(!r||r.mode!=='quiz'||!r.started||!r.question||r.question.id!==String(id)||r.answered[socket.id]!==undefined)return;
    if(!r.players.some(p=>p.id===socket.id))return;
    const choice=Number(index); if(choice!==0&&choice!==1)return;
    r.answered[socket.id]={choice,correct:choice===r.question.correct};
    const p=r.players.find(p=>p.id===socket.id); p.score += choice===r.question.correct?10:-10;
    socket.emit('game:answer-result',{correct:choice===r.question.correct,correctIndex:r.question.correct,explain:r.question.explain,score:p.score});
    io.to(r.code).emit('game:scores',r.players.map(p=>({name:p.name,score:p.score})));
    if(r.players.every(p=>r.answered[p.id]!==undefined)){
      const winner=r.players.find(p=>p.score>=100);
      if(winner)recordOnlineResult(r,r.players.map(p=>p.score),'quiz');
      io.to(r.code).emit('game:round-complete',{answers:r.players.map(p=>({name:p.name,choice:r.answered[p.id].choice,correct:r.answered[p.id].correct})),correctIndex:r.question.correct,explain:r.question.explain,winner:winner?winner.name:null});
    }
  });
  socket.on('game:next',()=>{const r=rooms.get(socket.data.room);if(r&&r.mode==='quiz'&&r.host===socket.id&&r.started){if(r.players.some(p=>p.score>=100)){r.players.forEach(p=>p.score=0);r.recorded=false;io.to(r.code).emit('game:scores',r.players.map(p=>({name:p.name,score:p.score})));}io.to(r.code).emit('game:next-request');}});
  socket.on('room:leave',()=>leave(socket));
  socket.on('disconnect',()=>leave(socket));
  function leave(s){const c=s.data.room;if(!c)return;const r=rooms.get(c);s.data.room=null;if(!r)return;rooms.delete(c);io.to(c).emit('room:closed','상대방 연결이 종료되어 방이 닫혔습니다.');}
});
const port=process.env.PORT||3000; server.listen(port,'0.0.0.0',()=>console.log(`ACID RAIN listening on ${port}`));const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({limit:'32kb'}));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// 계정/전적은 서버의 users.json에 영구 저장됩니다. 비밀번호 원문은 저장하지 않습니다.
const DB_FILE = path.join(__dirname, 'users.json');
const SECRET_FILE = path.join(__dirname, '.literlover-auth-secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(48).toString('hex'), {mode:0o600});
const AUTH_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
let db = { users: {} };
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('users.json 읽기 실패:', e.message); }
if (!db || typeof db.users !== 'object' || !db.users) db = {users:{}};
function saveDb(){ const tmp=DB_FILE+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(db,null,2), {mode:0o600}); fs.renameSync(tmp,DB_FILE); }
function userKey(name){ return String(name||'').toLocaleLowerCase('ko-KR'); }
function safeUser(u){return {username:u.username,createdAt:u.createdAt,stats:u.stats||{games:0,wins:0,losses:0,draws:0,bestScore:0}};}
function makeToken(username){const payload=Buffer.from(JSON.stringify({u:userKey(username),exp:Date.now()+30*24*60*60*1000})).toString('base64url');const sig=crypto.createHmac('sha256',AUTH_SECRET).update(payload).digest('base64url');return payload+'.'+sig;}
function authUser(token){try{const [payload,sig]=String(token||'').split('.');if(!payload||!sig)return null;const expected=crypto.createHmac('sha256',AUTH_SECRET).update(payload).digest();const got=Buffer.from(sig,'base64url');if(got.length!==expected.length||!crypto.timingSafeEqual(got,expected))return null;const data=JSON.parse(Buffer.from(payload,'base64url').toString());if(!data.u||data.exp<Date.now())return null;return db.users[data.u]||null;}catch(_){return null;}}
function bearer(req){return (req.headers.authorization||'').startsWith('Bearer ')?req.headers.authorization.slice(7):'';}
function requireAuth(req,res,next){const u=authUser(bearer(req));if(!u)return res.status(401).json({message:'로그인이 만료되었습니다. 다시 로그인해 주세요.'});req.user=u;next();}
function validCredentials(username,password){if(typeof username!=='string'||!/^[가-힣A-Za-z0-9_-]{3,18}$/.test(username))return '아이디는 한글·영문·숫자·밑줄·하이픈으로 3~18자여야 합니다.';if(typeof password!=='string'||password.length<6||password.length>128)return '비밀번호는 6~128자로 입력해 주세요.';return null;}
function hashPassword(password,salt){return crypto.scryptSync(password,salt,64).toString('hex');}
app.post('/api/register',(req,res)=>{
  const {username,password}=req.body||{};const err=validCredentials(username,password);if(err)return res.status(400).json({message:err});
  const key=userKey(username);if(db.users[key])return res.status(409).json({message:'이미 사용 중인 아이디입니다.'});
  const salt=crypto.randomBytes(16).toString('hex');const user={username,salt,passwordHash:hashPassword(password,salt),createdAt:new Date().toISOString(),stats:{games:0,wins:0,losses:0,draws:0,bestScore:0},records:[]};db.users[key]=user;saveDb();res.json({token:makeToken(username),user:safeUser(user)});
});
app.post('/api/login',(req,res)=>{
  const {username,password}=req.body||{};if(typeof username!=='string'||typeof password!=='string')return res.status(400).json({message:'아이디와 비밀번호를 입력해 주세요.'});
  const user=db.users[userKey(username)];if(!user)return res.status(401).json({message:'아이디 또는 비밀번호가 올바르지 않습니다.'});
  const got=Buffer.from(hashPassword(password,user.salt),'hex'),want=Buffer.from(user.passwordHash,'hex');if(got.length!==want.length||!crypto.timingSafeEqual(got,want))return res.status(401).json({message:'아이디 또는 비밀번호가 올바르지 않습니다.'});
  res.json({token:makeToken(user.username),user:safeUser(user)});
});
app.get('/api/me',requireAuth,(req,res)=>res.json({user:safeUser(req.user)}));
app.get('/api/records',requireAuth,(req,res)=>res.json({stats:req.user.stats||{},records:req.user.records||[]}));
app.post('/api/logout',(_req,res)=>res.json({ok:true}));
function addRecord(user, record){
  if(!user)return;const stats=user.stats||(user.stats={games:0,wins:0,losses:0,draws:0,bestScore:0});
  stats.games=(stats.games||0)+1;const result=record.result;
  if(result==='win')stats.wins=(stats.wins||0)+1;else if(result==='loss')stats.losses=(stats.losses||0)+1;else if(result==='draw')stats.draws=(stats.draws||0)+1;
  if(Number.isFinite(Number(record.score)))stats.bestScore=Math.max(stats.bestScore||0,Number(record.score));
  user.records=user.records||[];user.records.unshift({...record,date:new Date().toISOString().slice(0,10)});user.records=user.records.slice(0,100);saveDb();
}
app.post('/api/record',requireAuth,(req,res)=>{
  const b=req.body||{};const score=Number(b.score);if(!Number.isFinite(score))return res.status(400).json({message:'점수 형식이 올바르지 않습니다.'});
  const result=String(b.result||'');const outcome=result==='YOU WIN'||result==='QUIZ COMPLETE'?'win':result==='AI WIN'?'loss':'played';
  addRecord(req.user,{mode:['single','ai'].includes(b.mode)?b.mode:'single',modeLabel:b.mode==='ai'?'AI 대전':'싱글',topic:String(b.topic||'').slice(0,40),score,aiScore:Number(b.aiScore)||0,correct:Number(b.correct)||0,attempts:Number(b.attempts)||0,result:outcome,resultLabel:result});
  res.json({ok:true,stats:req.user.stats});
});

// 로그인 없이 게스트도 온라인 대전에 참가할 수 있습니다.
// 로그인 계정이 있으면 계정 정보를 사용하고, 없으면 연결별 임시 게스트 ID를 사용합니다.
io.use((socket,next)=>{
  const u=authUser(socket.handshake.auth&&socket.handshake.auth.token);
  if(u){
    socket.data.accountKey=userKey(u.username);
    socket.data.accountName=u.username;
  } else {
    const guestName=String(socket.handshake.auth&&socket.handshake.auth.name||'플레이어').trim().slice(0,18)||'플레이어';
    socket.data.accountKey='guest:'+socket.id;
    socket.data.accountName=guestName;
  }
  next();
});
const rooms = new Map();
function recordOnlineResult(r, scores, mode){
  if(!r||r.recorded)return;r.recorded=true;
  const max=Math.max(...scores), winners=scores.map((v,i)=>v===max?i:-1).filter(i=>i>=0);
  r.players.forEach((p,i)=>{const u=db.users[p.userKey];if(!u)return;const outcome=winners.length>1?'draw':(winners[0]===i?'win':'loss');addRecord(u,{mode,modeLabel:mode==='dots'?'온라인 도트 앤 박스':'온라인 퀴즈',topic:r.topic||'가짜 판별',score:scores[i],opponent:r.players[1-i]?.name||'',result:outcome,resultLabel:outcome==='win'?'승리':outcome==='loss'?'패배':'무승부'});});
}
function code(){ let s=''; do { s=String(Math.floor(100000+Math.random()*900000)); } while(rooms.has(s)); return s; }
function publicRoom(r){ return {code:r.code, players:r.players.map(p=>({name:p.name, score:p.score})), started:r.started, topic:r.topic, mode:r.mode}; }
function newDots(){return {size:4, lines:{}, boxes:Array.from({length:4},()=>Array(4).fill(-1)), turn:0, scores:[0,0], finished:false};}
function dotsFor(r, playerId){const you=r.players.findIndex(p=>p.id===playerId);return {...r.dots,you};}
function emitDots(r){r.players.forEach(p=>io.to(p.id).emit(r.dots.finished?'dots:ended':'dots:state',dotsFor(r,p.id)));}
function boxEdges(row,col){return [`h-${row}-${col}`,`h-${row+1}-${col}`,`v-${row}-${col}`,`v-${row}-${col+1}`];}
io.on('connection', socket => {
  socket.on('room:create', ({name, topic, mode}={}) => {
    const c=code(); const chosenMode=mode==='dots'?'dots':'quiz';
    const r={code:c, host:socket.id, players:[{id:socket.id,userKey:socket.data.accountKey,name:socket.data.accountName,score:0}], started:false, topic:topic||'문해력', mode:chosenMode, question:null, answered:{}, dots:null, recorded:false};
    rooms.set(c,r); socket.join(c); socket.data.room=c; socket.emit('room:created',publicRoom(r));
  });
  socket.on('room:join', ({code:c,name,mode}={}) => {
    c=String(c||'').trim(); const r=rooms.get(c);
    if(!r){socket.emit('room:error','방 코드를 찾을 수 없습니다.');return;}
    if(r.players.length>=2){socket.emit('room:error','이 방은 이미 두 명이 가득 찼습니다.');return;}
    if(r.started){socket.emit('room:error','이미 게임이 시작된 방입니다.');return;}
    r.players.push({id:socket.id,userKey:socket.data.accountKey,name:socket.data.accountName,score:0}); socket.join(c); socket.data.room=c;
    io.to(c).emit('room:update',publicRoom(r)); io.to(c).emit('room:ready', {room:publicRoom(r)});
  });
  socket.on('game:start', () => {
    const r=rooms.get(socket.data.room); if(!r||r.host!==socket.id||r.players.length!==2||r.started)return;
    r.started=true; r.recorded=false; r.players.forEach(p=>p.score=0); r.question=null; r.answered={};
    if(r.mode==='dots')r.dots=newDots();
    io.to(r.code).emit('game:started',publicRoom(r));
    if(r.mode==='dots')emitDots(r);
  });
  // 온라인 도트 앤 박스 비밀 코드: 현재 플레이어가 15칸을 차지하고 마지막 한 칸만 남긴다.
  // 서버에서 상태를 변경하고 양쪽에 브로드캐스트해 화면 불일치를 방지한다.
  socket.on('dots:cheat', () => {
    const r=rooms.get(socket.data.room);
    if(!r||!r.started||r.mode!=='dots'||!r.dots||r.dots.finished)return;
    const playerIndex=r.players.findIndex(p=>p.id===socket.id);
    if(playerIndex<0)return;
    const n=r.dots.size;
    r.dots.lines={};
    for(let row=0;row<=n;row++)for(let col=0;col<n;col++){
      const key=`h-${row}-${col}`;
      if(!(row===n&&col===n-1))r.dots.lines[key]=playerIndex;
    }
    for(let row=0;row<n;row++)for(let col=0;col<=n;col++)r.dots.lines[`v-${row}-${col}`]=playerIndex;
    r.dots.boxes=Array.from({length:n},(_,row)=>Array.from({length:n},(_,col)=>(row===n-1&&col===n-1)?-1:playerIndex));
    r.dots.scores=Array.from({length:r.players.length},(_,i)=>i===playerIndex?n*n-1:0);
    r.dots.turn=playerIndex;
    r.dots.finished=false;
    r.players.forEach((p,i)=>p.score=r.dots.scores[i]);
    emitDots(r);
    io.to(r.code).emit('game:scores',r.players.map(p=>({name:p.name,score:p.score})));
  });
  socket.on('dots:line', ({line}={}) => {
    const r=rooms.get(socket.data.room); if(!r||!r.started||r.mode!=='dots'||!r.dots||r.dots.finished)return;
    const playerIndex=r.players.findIndex(p=>p.id===socket.id);if(playerIndex<0||playerIndex!==r.dots.turn)return;
    if(typeof line!=='string'||r.dots.lines[line])return;
    const m=line.match(/^([hv])-(\d+)-(\d+)$/);if(!m)return;
    const [,dir,rs,cs]=m,row=Number(rs),col=Number(cs),n=r.dots.size;
    if((dir==='h'&&(row<0||row>n||col<0||col>=n))||(dir==='v'&&(row<0||row>=n||col<0||col>n)))return;
    r.dots.lines[line]=playerIndex;
    let got=0;
    for(let br=0;br<n;br++)for(let bc=0;bc<n;bc++)if(r.dots.boxes[br][bc]===-1&&boxEdges(br,bc).every(k=>r.dots.lines[k]!==undefined)){r.dots.boxes[br][bc]=playerIndex;r.dots.scores[playerIndex]++;got++;}
    r.players.forEach((p,i)=>p.score=r.dots.scores[i]);
    if(!got)r.dots.turn=1-playerIndex;
    r.dots.finished=r.dots.boxes.every(row=>row.every(x=>x!==-1));
    if(r.dots.finished)recordOnlineResult(r,r.dots.scores,'dots');
    emitDots(r);io.to(r.code).emit('game:scores',r.players.map(p=>({name:p.name,score:p.score})));
  });
  socket.on('game:question', data => {
    const r=rooms.get(socket.data.room); if(!r||r.mode!=='quiz'||r.host!==socket.id||!r.started)return;
    if(!data||!Array.isArray(data.options)||data.options.length!==2)return;
    r.question={id:String(data.id),text:String(data.text||'').slice(0,1000),options:data.options.map(x=>String(x).slice(0,300)),correct:Number(data.correct)===1?1:0,explain:String(data.explain||'').slice(0,1000)}; r.answered={};
    io.to(r.code).emit('game:question',{id:r.question.id,text:r.question.text,options:r.question.options});
  });
  socket.on('game:answer', ({id,index}={}) => {
    const r=rooms.get(socket.data.room); if(!r||r.mode!=='quiz'||!r.started||!r.question||r.question.id!==String(id)||r.answered[socket.id]!==undefined)return;
    if(!r.players.some(p=>p.id===socket.id))return;
    const choice=Number(index); if(choice!==0&&choice!==1)return;
    r.answered[socket.id]={choice,correct:choice===r.question.correct};
    const p=r.players.find(p=>p.id===socket.id); p.score += choice===r.question.correct?10:-10;
    socket.emit('game:answer-result',{correct:choice===r.question.correct,correctIndex:r.question.correct,explain:r.question.explain,score:p.score});
    io.to(r.code).emit('game:scores',r.players.map(p=>({name:p.name,score:p.score})));
    if(r.players.every(p=>r.answered[p.id]!==undefined)){
      const winner=r.players.find(p=>p.score>=100);
      if(winner)recordOnlineResult(r,r.players.map(p=>p.score),'quiz');
      io.to(r.code).emit('game:round-complete',{answers:r.players.map(p=>({name:p.name,choice:r.answered[p.id].choice,correct:r.answered[p.id].correct})),correctIndex:r.question.correct,explain:r.question.explain,winner:winner?winner.name:null});
    }
  });
  socket.on('game:next',()=>{const r=rooms.get(socket.data.room);if(r&&r.mode==='quiz'&&r.host===socket.id&&r.started){if(r.players.some(p=>p.score>=100)){r.players.forEach(p=>p.score=0);r.recorded=false;io.to(r.code).emit('game:scores',r.players.map(p=>({name:p.name,score:p.score})));}io.to(r.code).emit('game:next-request');}});
  socket.on('room:leave',()=>leave(socket));
  socket.on('disconnect',()=>leave(socket));
  function leave(s){const c=s.data.room;if(!c)return;const r=rooms.get(c);s.data.room=null;if(!r)return;rooms.delete(c);io.to(c).emit('room:closed','상대방 연결이 종료되어 방이 닫혔습니다.');}
});
const port=process.env.PORT||3000; server.listen(port,'0.0.0.0',()=>console.log(`ACID RAIN listening on ${port}`));

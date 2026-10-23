const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
const rooms = new Map();
function code(){ let s=''; do { s=String(Math.floor(100000+Math.random()*900000)); } while(rooms.has(s)); return s; }
function publicRoom(r){ return {code:r.code, players:r.players.map(p=>({name:p.name, score:p.score})), started:r.started, topic:r.topic}; }
io.on('connection', socket => {
  socket.on('room:create', ({name, topic}={}) => {
    const c=code(); const r={code:c, host:socket.id, players:[{id:socket.id,name:String(name||'플레이어 1').slice(0,18),score:0}], started:false, topic:topic||'문해력', question:null, answered:{}};
    rooms.set(c,r); socket.join(c); socket.data.room=c; socket.emit('room:created',publicRoom(r));
  });
  socket.on('room:join', ({code:c,name}={}) => {
    c=String(c||'').trim(); const r=rooms.get(c);
    if(!r){socket.emit('room:error','방 코드를 찾을 수 없습니다.');return;}
    if(r.players.length>=2){socket.emit('room:error','이 방은 이미 두 명이 가득 찼습니다.');return;}
    if(r.started){socket.emit('room:error','이미 게임이 시작된 방입니다.');return;}
    r.players.push({id:socket.id,name:String(name||'플레이어 2').slice(0,18),score:0}); socket.join(c); socket.data.room=c;
    io.to(c).emit('room:update',publicRoom(r));
    io.to(c).emit('room:ready', {room:publicRoom(r)});
  });
  socket.on('game:start', () => {
    const r=rooms.get(socket.data.room); if(!r||r.host!==socket.id||r.players.length!==2||r.started)return;
    r.started=true; r.players.forEach(p=>p.score=0); r.question=null; r.answered={}; io.to(r.code).emit('game:started',publicRoom(r));
  });
  socket.on('game:question', data => {
    const r=rooms.get(socket.data.room); if(!r||r.host!==socket.id||!r.started)return;
    if(!data||!Array.isArray(data.options)||data.options.length!==2)return;
    r.question={id:String(data.id),text:String(data.text||'').slice(0,1000),options:data.options.map(x=>String(x).slice(0,300)),correct:Number(data.correct)===1?1:0,explain:String(data.explain||'').slice(0,1000)}; r.answered={};
    io.to(r.code).emit('game:question',{id:r.question.id,text:r.question.text,options:r.question.options});
  });
  socket.on('game:answer', ({id,index}={}) => {
    const r=rooms.get(socket.data.room); if(!r||!r.started||!r.question||r.question.id!==String(id)||r.answered[socket.id]!==undefined)return;
    if(!r.players.some(p=>p.id===socket.id))return;
    const choice=Number(index); if(choice!==0&&choice!==1)return;
    r.answered[socket.id]={choice,correct:choice===r.question.correct};
    const p=r.players.find(p=>p.id===socket.id); p.score += choice===r.question.correct?10:-10;
    socket.emit('game:answer-result',{correct:choice===r.question.correct,correctIndex:r.question.correct,explain:r.question.explain,score:p.score});
    io.to(r.code).emit('game:scores',r.players.map(p=>({name:p.name,score:p.score})));
    if(r.players.every(p=>r.answered[p.id]!==undefined)){
      const winner=r.players.find(p=>p.score>=100);
      io.to(r.code).emit('game:round-complete',{answers:r.players.map(p=>({name:p.name,choice:r.answered[p.id].choice,correct:r.answered[p.id].correct})),correctIndex:r.question.correct,explain:r.question.explain,winner:winner?winner.name:null});
    }
  });
  socket.on('game:next',()=>{const r=rooms.get(socket.data.room);if(r&&r.host===socket.id&&r.started){if(r.players.some(p=>p.score>=100)){r.players.forEach(p=>p.score=0);io.to(r.code).emit('game:scores',r.players.map(p=>({name:p.name,score:p.score})));}io.to(r.code).emit('game:next-request');}});
  socket.on('room:leave',()=>leave(socket));
  socket.on('disconnect',()=>leave(socket));
  function leave(s){const c=s.data.room;if(!c)return;const r=rooms.get(c);s.data.room=null;if(!r)return;rooms.delete(c);io.to(c).emit('room:closed','상대방 연결이 종료되어 방이 닫혔습니다.');}
});
const port=process.env.PORT||3000; server.listen(port,'0.0.0.0',()=>console.log(`ACID RAIN listening on ${port}`));

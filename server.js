'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const PORT = Number(process.env.PORT || 8080);
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const TOKEN = process.env.AYBER_ACCESS_TOKEN;
const MAX_DAILY = Number(process.env.MAX_DAILY_REQUESTS || 100);
const MAX_PER_IP_HOUR = Number(process.env.MAX_PER_IP_HOUR || 12);
const requests = new Map();
let dailyCount = 0, day = new Date().toISOString().slice(0,10);
const reply = (res, status, payload) => {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(payload));};
const server = http.createServer(async (req,res) => {
  if(req.method === 'GET' && req.url === '/health') return reply(res,200,{status:'ok'});
  if(req.method !== 'POST' || req.url !== '/chat') return reply(res,404,{error:'not_found'});
  if(!KEY || !TOKEN || TOKEN.length < 24) return reply(res,503,{error:'server_not_configured'});
  const supplied = String(req.headers['x-ayber-token'] || '');
  const a = Buffer.from(supplied), b = Buffer.from(TOKEN);
  if(a.length !== b.length || !crypto.timingSafeEqual(a,b)) return reply(res,401,{error:'unauthorized'});
  const now = Date.now(); const today = new Date().toISOString().slice(0,10);
  if(today !== day){ day = today; dailyCount=0; requests.clear(); }
  if(dailyCount >= MAX_DAILY) return reply(res,429,{error:'daily_limit'});
  // For proxy deployments, use direct socket address unless a trusted proxy is configured.
  const ip = req.socket.remoteAddress || 'unknown';
  const record = requests.get(ip) || {start:now,count:0};
  if(now-record.start > 3600000){record.start=now;record.count=0;}
  if(record.count >= MAX_PER_IP_HOUR) return reply(res,429,{error:'rate_limit'});
  let raw='';
  try {
    for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>32000) return reply(res,413,{error:'too_large'});}
    const data=JSON.parse(raw);
    const input=(Array.isArray(data.messages)?data.messages:[]).slice(-12)
      .filter(m=>m && ['user','assistant'].includes(m.role) && typeof m.content==='string')
      .map(m=>({role:m.role,content:m.content.slice(0,2000)}));
    if(!input.length || input[input.length-1].role !== 'user') return reply(res,400,{error:'invalid_messages'});
    const name=String(data.assistantName||'AYBER').replace(/[\r\n]/g,' ').slice(0,24);
    const language=String(data.language||'tr').slice(0,12);
    record.count++;requests.set(ip,record);dailyCount++;
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),25000);
    let upstream;
    try {upstream=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',signal:controller.signal,
      headers:{Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:MODEL,store:false,max_output_tokens:450,
        instructions:`Sen ${name} adlı yardımcı asistansın. Kullanıcının diline uygun yanıt ver (dil: ${language}). Telefon arama veya SMS gönderme işlemini yaptığını iddia etme.`,input})
    });} finally {clearTimeout(timer);}
    const result=await upstream.json();
    if(!upstream.ok){console.error('AI status:',upstream.status,'code:',result.error?.code);return reply(res,502,{error:'ai_provider_error'});}
    const answer=(result.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n').trim();
    return reply(res,200,{reply:answer||'Şu anda yanıt oluşturamadım.'});
  } catch(err){console.error('Request error:',err.name);return reply(res,500,{error:'request_failed'});}
});
server.listen(PORT,'0.0.0.0',()=>console.log('AYBER API listening on',PORT));

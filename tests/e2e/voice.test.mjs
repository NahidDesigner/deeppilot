import './_setup.mjs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT=fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, ''), PORT=8774;
const got=[]; let n=0; const tasks=[];
const server=http.createServer((req,res)=>{const ch=[];req.on('data',d=>ch.push(d));req.on('end',()=>{
  const body=Buffer.concat(ch);
  if(req.url==='/audio/transcriptions'){ n++;
    const txt=body.toString('latin1');
    const field=k=>{const m=txt.match(new RegExp(`name="${k}"\\r\\n\\r\\n([^\\r]*)`));return m&&m[1];};
    got.push({auth:req.headers.authorization, model:field('model'), language:field('language'), prompt:(field('prompt')||'').slice(0,60), bytes:body.length, fileType:(txt.match(/filename="([^"]+)"\r\nContent-Type: ([^\r]+)/)||[]).slice(1)});
    res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify({text: n===1?'Find ten HVAC leads in Dallas':'Summarize this page'}));
  }
  if(req.url==='/v1/chat/completions'){ const j=JSON.parse(body); tasks.push([...j.messages].reverse().find(m=>typeof m.content==='string'&&m.content.startsWith('TASK:')).content);
    res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'d',type:'function',function:{name:'done',arguments:'{"answer":"ok"}'}}]}}]}));}
  res.writeHead(200,{'content-type':'text/html'}); res.end('<title>p</title>hi');
});});
await new Promise(r=>server.listen(PORT,r));
const ctx=await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(),'dp-')),{headless:false,args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
let [sw]=ctx.serviceWorkers(); if(!sw) sw=await ctx.waitForEvent('serviceworker');
const extId=sw.url().split('/')[2];
const web=ctx.pages()[0]; await web.goto(`http://localhost:${PORT}/x`);
const v=await ctx.newPage(); await v.setViewportSize({width:400,height:800}); const errors=[]; v.on('pageerror',e=>errors.push(String(e)));
await v.goto(`chrome-extension://${extId}/permission.html`);
await v.evaluate(()=>chrome.storage.local.set({apiKey:'x',verifyDone:false,baseUrl:'http://localhost:8774/v1',vision:false,notify:false,repeatAlarm:false,voiceEngine:'whisper',whisperKey:'gsk_test',whisperUrl:'http://localhost:8774/audio/transcriptions',voiceLang:'en-IN',voiceWords:'Nahid Web Studio, Coolify'}));
const tabId=await v.evaluate(async()=>(await chrome.tabs.query({})).find(t=>t.url.startsWith('http'))?.id);
await v.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
await v.click('#micBtn'); await v.waitForTimeout(1800);
const recUi=await v.textContent('#interim'); const pressed=await v.getAttribute('#micBtn','aria-pressed');
await v.screenshot({path:'voice-rec.png'});
await v.click('#micBtn'); await v.waitForFunction(()=>document.getElementById('input').value.length>0,null,{timeout:10000});
const inserted=await v.inputValue('#input');
// second: speak then press Enter while still recording -> transcribe + send
await v.fill('#input','');
await v.click('#micBtn'); await v.waitForTimeout(1200);
await v.focus('#input'); await v.keyboard.press('Enter');
await v.waitForSelector('.msg.final',{timeout:15000});
const userMsg=await v.$$eval('.msg.user',n=>n.map(x=>x.textContent));
// esc cancel
await v.click('#micBtn'); await v.waitForTimeout(600); await v.keyboard.press('Escape'); await v.waitForTimeout(300);
const afterEsc={pressed:await v.getAttribute('#micBtn','aria-pressed'), msg:await v.textContent('#interim'), calls:n};
console.log(JSON.stringify({recUi,pressed,inserted,userMsg,tasks,got,afterEsc,errors},null,1));
await ctx.close(); server.close();

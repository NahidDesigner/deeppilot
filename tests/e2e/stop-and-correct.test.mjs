import { fileURLToPath } from 'node:url';
// Stop mid-tool-call, then send a correction: history must stay valid (DeepSeek-strict mock).
import http from 'node:http';
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT=fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, ''), PORT=8773, B=`http://localhost:${PORT}`;
let calls=0; const seen=[];
function validate(msgs){
  for (let i=0;i<msgs.length;i++){ const m=msgs[i]; if(m.role==='assistant'&&m.tool_calls?.length){ const ids=new Set(); let j=i+1; while(j<msgs.length&&msgs[j].role==='tool'){ids.add(msgs[j].tool_call_id); j++;} for(const tc of m.tool_calls) if(!ids.has(tc.id)) return false; } }
  return true;
}
const server=http.createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{
  if(req.url==='/v1/chat/completions'){ calls++; const j=JSON.parse(b);
    if(!validate(j.messages)){ res.writeHead(400,{'content-type':'application/json'}); return res.end(JSON.stringify({error:{message:"An assistant message with 'tool_calls' must be followed by tool messages"}})); }
    const task=[...j.messages].reverse().find(m=>m.role==='user'&&typeof m.content==='string'&&m.content.startsWith('TASK:')).content;
    const stopNote=j.messages.some(m=>typeof m.content==='string'&&m.content.includes('user pressed Stop'));
    seen.push({task:task.slice(6,30), stopNote});
    let message;
    if(task.includes('slow')) message={role:'assistant',content:'Waiting a bit.',tool_calls:[{id:'w1',type:'function',function:{name:'wait',arguments:'{"seconds":10}'}},{id:'w2',type:'function',function:{name:'get_page_text',arguments:'{}'}}]};
    else message={role:'assistant',content:'',tool_calls:[{id:'d'+calls,type:'function',function:{name:'done',arguments:JSON.stringify({answer:'Correction handled; saw stop note: '+stopNote})}}]};
    res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:10,completion_tokens:5}}));
  }
  res.writeHead(200,{'content-type':'text/html'}); res.end('<title>x</title><h1>page</h1>');
});});
await new Promise(r=>server.listen(PORT,r));
const ctx=await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(),'dp-')),{headless:false,args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`]});
let [sw]=ctx.serviceWorkers(); if(!sw) sw=await ctx.waitForEvent('serviceworker');
const extId=sw.url().split('/')[2];
const web=ctx.pages()[0]; await web.goto(`${B}/a`);
const v=await ctx.newPage(); const errors=[]; v.on('pageerror',e=>errors.push(String(e)));
await v.goto(`chrome-extension://${extId}/permission.html`);
await v.evaluate(()=>chrome.storage.local.set({apiKey:'x',baseUrl:'http://localhost:8773/v1',notify:false,repeatAlarm:false,vision:false}));
const tabId=await v.evaluate(async()=>(await chrome.tabs.query({})).find(t=>t.url.startsWith('http'))?.id);
await v.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
const send=async t=>{await v.fill('#input',t); await v.evaluate(()=>document.getElementById('form').requestSubmit());};
await send('slow task please');
await v.waitForTimeout(3000);
await v.click('#stopBtn');
await v.waitForSelector('.msg.stopped',{timeout:20000});
await send('correction: do it differently');
await v.waitForSelector('.msg.final',{timeout:20000});
console.log(JSON.stringify({final:await v.textContent('.msg.final'), errorsShown: await v.$$eval('.msg.error',n=>n.map(x=>x.textContent)), seen, errors}));
await ctx.close(); server.close();

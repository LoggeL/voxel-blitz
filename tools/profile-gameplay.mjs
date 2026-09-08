import { access, mkdir, writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';
const output = process.env.PROFILE_OUT || '.artifacts/gameplay-profile';
const candidates = [process.env.PROFILE_BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
let executable;
for (const candidate of candidates) {try {await access(candidate);executable=candidate;break;} catch {}}
if (!executable) throw new Error('Set PROFILE_BROWSER to an installed Chrome/Chromium executable.');
const server = startServer({ cwd: process.cwd() });
let browser;
try {
  await mkdir(output, {recursive:true});
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/?headless=1`, {
    browser: executable,
    softwareRendering: false,
  });
  const p = browser.page;
  await p.waitFor(`document.getElementById('create-lobby-btn') && window.__vb`);
  await p.evaluate(`document.getElementById('create-lobby-btn').click()`);
  await p.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  await p.evaluate(`(() => { for (const [id,value] of [['bot-count','6'],['game-mode-select','fun']]) {const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));} })()`);
  await p.evaluate(`document.getElementById('lobby-ready-btn').click()`);
  await p.waitFor(`document.getElementById('lobby-start-btn')?.disabled === false`);
  await p.send('Profiler.enable');
  await p.send('Profiler.start');
  await p.evaluate(`window.profileFrames=[];window.profileTasks=[];new PerformanceObserver(l=>profileTasks.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});let last=performance.now();function sample(t){profileFrames.push(t-last);last=t;requestAnimationFrame(sample)}requestAnimationFrame(sample);document.getElementById('lobby-start-btn').click()`);
  await p.waitFor(`window.__vb.stats.running && window.__vb.stats.avatars >= 6`, {timeoutMs:60000});
  const liveFrameStart = await p.evaluate('profileFrames.length');
  for(let i=0;i<20;i++) {
    await p.send('Input.dispatchKeyEvent',{type:'keyDown',key:i%2?'d':'w',code:i%2?'KeyD':'KeyW'});
    await p.send('Input.dispatchMouseEvent',{type:'mousePressed',x:640,y:360,button:'left',buttons:1,clickCount:1});
    await new Promise(r=>setTimeout(r,1000));
    await p.send('Input.dispatchKeyEvent',{type:'keyUp',key:i%2?'d':'w',code:i%2?'KeyD':'KeyW'});
  }
  const {profile}=await p.send('Profiler.stop');
  await writeFile(`${output}/gameplay.cpuprofile`,JSON.stringify(profile));
  const metrics=await p.evaluate(`({stats:window.__vb.stats,frames:profileFrames,tasks:profileTasks,userAgent:navigator.userAgent,gpu:(()=>{const g=document.querySelector('canvas').getContext('webgl2');const e=g.getExtension('WEBGL_debug_renderer_info');return e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER)})()})`);
  metrics.liveFrameStart = liveFrameStart;
  const sorted=metrics.frames.slice(liveFrameStart).sort((a,b)=>a-b);
  metrics.frameSummary={count:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1),over50:sorted.filter(x=>x>50).length};
  const times=new Map();for(let i=0;i<profile.samples.length;i++)times.set(profile.samples[i],(times.get(profile.samples[i])||0)+(profile.timeDeltas[i]||0));
  metrics.hotspots=profile.nodes.map(n=>({name:n.callFrame.functionName,url:n.callFrame.url,line:n.callFrame.lineNumber+1,ms:(times.get(n.id)||0)/1000})).sort((a,b)=>b.ms-a.ms).slice(0,35);
  metrics.errors=p.errors;
  if (/swiftshader|llvmpipe/i.test(metrics.gpu)) metrics.warning='Software rendering: do not use these timings as hardware GPU evidence.';
  await writeFile(`${output}/summary.json`,JSON.stringify(metrics,null,2));
  console.log(JSON.stringify({frameSummary:metrics.frameSummary,gpu:metrics.gpu,stats:metrics.stats,hotspots:metrics.hotspots.slice(0,18),errors:metrics.errors},null,2));
} finally {await browser?.close();await stopServer(server);}

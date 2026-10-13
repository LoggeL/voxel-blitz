#!/usr/bin/env node
// Record the real weapon shader with a fixed close camera, no image retouching.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const out='docs/design/thunderbolt/orbs';
await mkdir(out,{recursive:true});
const frames=await mkdtemp(path.join(tmpdir(),'tb4-orb-frames-'));
const server=startServer({entry:'tools/capture-server.mjs'});
let session;
try {
  session=await launchCdpSession(`http://127.0.0.1:${await server.port}/titanfall-weapon-capture.html`,
    {width:960,height:720});
  const page=session.page;
  await page.waitFor('window.__tfw?.ready',{timeoutMs:90000});
  for(let i=0;i<48;i++) {
    const state=await page.evaluate(`window.__tfw.inspect({weapon:"thunderbolt",detail:"drum",plasmaElapsed:${i ? 1/24 : 0}})`);
    assert.equal(state.thunderbolt.source,'thunderbolt');
    assert.equal(state.thunderbolt.visibleRounds,4);
    const shot=await page.send('Page.captureScreenshot',{format:'png'});
    const bytes=Buffer.from(shot.data,'base64');
    await writeFile(path.join(frames,String(i).padStart(3,'0')+'.png'),bytes);
    if(i===0)await writeFile(path.join(out,'drum.png'),bytes);
  }
  assert.deepEqual(page.errors,[]);
  // Ping-pong only affects the documentation loop; all frames are real shader renders.
  await promisify(execFile)('ffmpeg',['-y','-loglevel','error','-framerate','24','-i',path.join(frames,'%03d.png'),
    '-filter_complex','[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0,split[c][d];[c]palettegen=stats_mode=diff[p];[d][p]paletteuse=dither=sierra2_4a',
    '-loop','0',path.join(out,'plasma.gif')]);
  console.log('TB-4: 48 actual shader frames captured to '+out+'/plasma.gif');
} finally {
  await session?.close(); await stopServer(server);
  await rm(frames,{recursive:true,force:true});
}


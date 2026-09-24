import { startServer, stopServer } from '../lib/server-process.mjs';
import { launchCdpSession } from '../lib/cdp-session.mjs';

/** Render one delivered Blender asset's geometry and ImageGen maps into a transparent HUD icon. */
// `side: 'left'` renders the left flank (e.g. SKIPJACK's cassette) and mirrors the
// image so the muzzle still points right like every other HUD icon.
export async function renderBlenderHud({ asset, weapon, width = 480, height = 240, side = 'right' } = {}) {
  if (!asset || !weapon) throw new TypeError('renderBlenderHud requires { asset, weapon }');
  const left = side === 'left';
  const server = startServer({ entry: 'tools/capture-server.mjs' });
  let browser;
  try {
    browser = await launchCdpSession(`http://127.0.0.1:${await server.port}/weapon-capture.html?weapon=${weapon}&state=held`);
    await browser.page.waitFor(`document.documentElement.dataset.captureReady === 'true'`, { timeoutMs: 20000 });
    const data = await browser.page.evaluate(`(async () => {
      const T = await import('/js/vendor/three.module.js');
      const { buildGun, disposeGunModels } = await import('/js/guns/assemble.js');
      const { MaterialCache } = await import('/js/guns/kit.js');
      const cache=new MaterialCache(),gun=buildGun(${JSON.stringify(weapon)},cache),root=gun.root;
      if (gun.body.userData.blenderAsset !== ${JSON.stringify(asset)}) throw new Error(${JSON.stringify(`${asset} runtime asset not loaded`)});
      // Use the game's rest pose: covers and gates stay present; loose reload rounds stay hidden.
      for(const name of ['hand_l','hand_r']) { const hand=root.getObjectByName(name);if(hand)hand.visible=false; }
      root.updateMatrixWorld(true);
      const bounds=new T.Box3();
      root.traverseVisible(object=>{
        if(!object.isMesh || [].concat(object.material).every(m=>m.transparent||m.isShaderMaterial))return;
        object.geometry.computeBoundingBox();bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
      });
      const center=bounds.getCenter(new T.Vector3()),size=bounds.getSize(new T.Vector3());
      const aspect=${width}/${height}, half=Math.max(size.y,size.z/aspect)*.54;
      const camera=new T.OrthographicCamera(-half*aspect,half*aspect,half,-half,.01,10);
      camera.position.set(${left ? -2 : 2},center.y,center.z);camera.lookAt(center);
      const scene=new T.Scene();scene.add(root,new T.HemisphereLight(0xe3efff,0x493a2f,2));
      const key=new T.DirectionalLight(0xffedd4,3);key.position.set(${left ? -3 : 3},5,-4);scene.add(key);
      const renderer=new T.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
      renderer.setSize(${width},${height});renderer.setClearColor(0x000000,0);
      renderer.outputColorSpace=T.SRGBColorSpace;renderer.render(scene,camera);
      let output=renderer.domElement;
      if(${left}){const flipped=document.createElement('canvas');flipped.width=${width};flipped.height=${height};
        const context=flipped.getContext('2d');context.scale(-1,1);context.drawImage(output,-${width},0);output=flipped;}
      const png=output.toDataURL('image/png').split(',')[1];
      const triangles=renderer.info.render.triangles;renderer.dispose();disposeGunModels([gun],cache);
      return {png,triangles};
    })()`);
    if (browser.page.errors.length) throw new Error(browser.page.errors.join('\n'));
    return { png: Buffer.from(data.png, 'base64'), triangles: data.triangles };
  } finally { await browser?.close(); await stopServer(server); }
}

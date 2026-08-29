import * as THREE from '../vendor/three.module.js';

const SITE_COLORS = Object.freeze({
  A: '#ff9f1c',
  B: '#58a6ff',
});

function siteCenter(site) {
  return {
    x: (site.minX + site.maxX + 1) * 0.5,
    y: site.y + 5.25,
    z: (site.minZ + site.maxZ + 1) * 0.5,
  };
}

function makeLabelTexture(label) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable for bomb-site marker');

  ctx.clearRect(0, 0, 512, 512);
  ctx.beginPath();
  ctx.arc(256, 256, 196, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(5, 8, 12, 0.72)';
  ctx.fill();
  ctx.lineWidth = 24;
  ctx.strokeStyle = SITE_COLORS[label] || '#ffffff';
  ctx.stroke();

  ctx.font = '900 330px Arial Black, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 30;
  ctx.strokeStyle = '#05080c';
  ctx.strokeText(label, 256, 278);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, 256, 278);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** World-space S&D site labels. Depth testing keeps them from leaking through walls. */
export class SiteMarkers {
  constructor(sites = []) {
    this.group = new THREE.Group();
    this.group.name = 'snd-site-markers';
    this.group.visible = false;
    this._resources = [];

    for (const site of Array.isArray(sites) ? sites : []) {
      if (!site || !['A', 'B'].includes(String(site.id).toUpperCase())) continue;
      const label = String(site.id).toUpperCase();
      const texture = makeLabelTexture(label);
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(material);
      const center = siteCenter(site);
      sprite.name = `bomb-site-${label}`;
      sprite.position.set(center.x, center.y, center.z);
      sprite.scale.set(5.4, 5.4, 1);
      sprite.renderOrder = 4;
      this.group.add(sprite);
      this._resources.push({ texture, material });
    }
  }

  setMode(mode) {
    this.group.visible = mode === 'snd' && this.group.children.length > 0;
  }

  dispose() {
    this.group.removeFromParent();
    for (const { texture, material } of this._resources) {
      texture.dispose();
      material.dispose();
    }
    this._resources.length = 0;
    this.group.clear();
  }
}

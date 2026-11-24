// Wall-mounted name plaques for member rooms (and the meeting room). Replaces the old
// floating HTML bubbles: a real plate hangs on the wall beside the door, with the name,
// presence and agent note painted onto a canvas texture (same approach as meters and zone signs).
import * as THREE from './vendor/three/three.module.min.js';
import {WALL_H} from './office-layout.js';
import {plaqueCopy} from './office-plaques-core.js';

const W = 1024, H = 320;
const PLAQUE_W = 2.35, PLAQUE_H = 0.52, PLAQUE_D = 0.05;
// Sit just under the top of the low front wall (WALL_H), proud of the face.
const plaqueY = h => WALL_H - h / 2 - 0.06;

function draw(ctx, {title, subtitle, lines, online, status, accent}) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Warm ivory plate; offline rooms go cooler and flatter.
  ctx.fillStyle = online ? '#f3eee4' : '#d9d6d0';
  ctx.fillRect(0, 0, w, h);

  // Thin inner bevel.
  ctx.strokeStyle = online ? 'rgba(42,36,32,.22)' : 'rgba(42,36,32,.14)';
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, w - 20, h - 20);

  // Member accent rail (left) and a soft status wash along the top edge.
  const rail = Math.round(w * 0.045);
  ctx.fillStyle = accent || '#5a6a64';
  ctx.fillRect(0, 0, rail, h);
  ctx.fillStyle = status.color || '#8b9490';
  ctx.globalAlpha = online ? 0.9 : 0.45;
  ctx.fillRect(rail, 0, w - rail, Math.round(h * 0.045));
  ctx.globalAlpha = 1;

  const ink = online ? '#1c2421' : '#5a625e';
  const mute = online ? '#5c6762' : '#7a827c';
  const left = rail + Math.round(w * 0.055);
  const right = w - Math.round(w * 0.05);
  const maxW = right - left;

  // Name.
  let size = Math.round(h * 0.28);
  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (; size > 28; size -= 2) {
    ctx.font = `700 ${size}px Georgia,"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",serif`;
    if (ctx.measureText(title).width <= maxW * 0.78) break;
  }
  const nameY = Math.round(h * (subtitle || lines.length ? 0.42 : 0.58));
  ctx.fillText(title, left, nameY, maxW * 0.82);

  // Status mark on the right.
  ctx.font = `600 ${Math.round(h * 0.16)}px system-ui,-apple-system,"Segoe UI",sans-serif`;
  ctx.fillStyle = status.color || mute;
  ctx.textAlign = 'right';
  ctx.fillText(status.glyph || '●', right, nameY - Math.round(h * 0.02));
  ctx.textAlign = 'left';

  // Subtitle ("Your room") and meta lines.
  let y = nameY + Math.round(h * 0.2);
  if (subtitle) {
    ctx.fillStyle = mute;
    ctx.font = `600 ${Math.round(h * 0.125)}px system-ui,-apple-system,"Segoe UI",sans-serif`;
    ctx.fillText(subtitle.toUpperCase(), left, y, maxW);
    y += Math.round(h * 0.16);
  }
  ctx.fillStyle = mute;
  ctx.font = `500 ${Math.round(h * 0.115)}px system-ui,-apple-system,"Segoe UI",sans-serif`;
  for (const line of lines) {
    ctx.fillText(line, left, y, maxW);
    y += Math.round(h * 0.145);
  }
}

// A plaque parented under a room (or meeting) group. Local +z faces out of the wall.
// pose: {x, y, z} in the parent's space (centre of the plate).
export function createRoomPlaque(parent, pose = {}, {width = PLAQUE_W, height = PLAQUE_H} = {}) {
  const group = new THREE.Group();
  group.name = 'room-plaque';
  group.position.set(pose.x || 0, pose.y ?? plaqueY(height), pose.z || 0);
  if (Number.isFinite(pose.ry)) group.rotation.y = pose.ry;
  parent.add(group);

  const frameMat = new THREE.MeshLambertMaterial({color: '#2a2420', flatShading: true});
  const frame = new THREE.Mesh(new THREE.BoxGeometry(width + 0.06, height + 0.06, PLAQUE_D), frameMat);
  frame.position.z = -PLAQUE_D / 2;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const faceMat = new THREE.MeshBasicMaterial({map: texture, toneMapped: false});
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), faceMat);
  face.position.z = 0.002;
  face.userData.plaque = true;

  group.add(frame, face);
  // One dispose on the group: clear() in office.js calls userData.dispose on every node.
  group.userData.dispose = () => {
    face.geometry.dispose();
    frame.geometry.dispose();
    texture.dispose();
    faceMat.dispose();
    frameMat.dispose();
  };

  let signature = '';
  function paint(input) {
    const copy = plaqueCopy(input);
    const accent = input.fg || input.accent || '#5a6a64';
    const sig = JSON.stringify([copy, accent]);
    if (sig === signature) return;
    signature = sig;
    draw(canvas.getContext('2d'), {...copy, accent});
    texture.needsUpdate = true;
  }

  return {group, face, paint, dispose: () => { group.userData.dispose?.(); group.removeFromParent(); }};
}

export {PLAQUE_W, PLAQUE_H, plaqueCopy};

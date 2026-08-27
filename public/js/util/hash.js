export function hashInt(value) {
  const s = String(value);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

export function hashHue(id) {
  return hashInt(id) % 360;
}

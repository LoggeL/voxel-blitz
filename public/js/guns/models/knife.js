// Extruded pixel-art diamond pickaxe. Keep the stable knife slot for loadouts.
export function build({ kit, groups }) {
  const { box } = kit;
  const { body } = groups;
  const pixels = [
    '...DDDDDDD...',
    '..DLLLLLLDD..',
    '.DLTTTTTTTLD.',
    '.DDDDWDDTTLDD',
    '....WW..DTLD.',
    '...WW....DDD.',
    '..WW.........',
    '.WW..........',
    'WW...........',
  ];
  const colors = { D: 0x123e3b, L: 0x9affed, T: 0x26d6c1, W: 0x94602f };
  const unit = 0.035;
  pixels.forEach((row, y) => [...row].forEach((pixel, x) => {
    if (!colors[pixel]) return;
    box(body, 0.042, unit, unit, 0, -0.015 - y * unit,
      0.0175 - x * unit, colors[pixel], { rg: 0.88, mt: 0.04 });
    if (pixel === 'W') box(body, 0.044, unit * 0.45, unit * 0.45,
      0, -0.010 - y * unit, 0.0125 - x * unit, 0xd6a45f, { rg: 1, mt: 0 });
  }));
  body.userData.sightHeight = 0.02;
}

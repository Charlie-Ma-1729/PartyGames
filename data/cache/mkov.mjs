import { readFileSync, writeFileSync } from 'node:fs';
import { parseSeeds, allSongs } from '../../scripts/lib.mjs';
const want = { '前前前世': 'PDSkFeMVNFs', 'A Thousand Years': 'rtOvBOTyX00', 'Spider-Man 2 Main Title': 'x-qgkHhCA6Y', 'Signal Fire': '11KD3gN6Bus', 'The Amazing Spider-Man': 'fn15NuU-T4M' };
const songs = allSongs(parseSeeds());
const ov = JSON.parse(readFileSync('data/overrides.json', 'utf8') || '{}');
for (const s of songs) {
  if (want[s.title] && /你的名字|破曉第一部|蜘蛛人2|Signal|驚奇再起|蜘蛛人3/.test(s.key) ) { ov[s.id] = { ...(ov[s.id] || {}), ytId: want[s.title] }; console.log('ov', s.key.slice(0, 30), s.title); }
  if (s.title === 'Main Title' && /新希望/.test(s.key)) { ov[s.id] = { ytId: 'ZSthLmvh6Fk' }; console.log('ov star wars'); }
}
writeFileSync('data/overrides.json', JSON.stringify(ov, null, 1));

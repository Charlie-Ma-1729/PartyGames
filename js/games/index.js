// 遊戲用戶端模組登錄（順序 = 選單順序，要與 server/games/index.mjs 的 id 一致）
import songguess from './songguess/index.js';
import dubbing from './dubbing/index.js';
import headsup from './headsup/index.js';
import coopdraw from './coopdraw/index.js';
import soramimi from './soramimi/index.js';

export const GAME_MODULES = { songguess, dubbing, headsup, coopdraw, soramimi };

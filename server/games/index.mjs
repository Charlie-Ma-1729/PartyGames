// 遊戲登錄：新增遊戲只要寫一個繼承 GameBase 的 class（見 base.mjs）並加到這裡，再加一個前端模組（js/games/）。
import { SongGame } from './songguess.mjs';
import { DubbingGame } from './dubbing.mjs';
import { HeadsUpGame } from './headsup.mjs';
import { CoopDrawGame } from './coopdraw.mjs';
import { SoramimiGame } from './soramimi.mjs';

export const GAMES = {
  songguess: SongGame,
  dubbing: DubbingGame,
  headsup: HeadsUpGame,
  coopdraw: CoopDrawGame,
  soramimi: SoramimiGame,
};
export const DEFAULT_GAME = 'songguess';

/** 選單用的遊戲資訊（依登錄順序） */
export const gameList = () => Object.values(GAMES).map((G) => G.meta);
/** 各遊戲的靜態資訊（題庫數量、分類清單…），隨 joined 訊息送給用戶端 */
export const gameInfo = () => Object.fromEntries(Object.entries(GAMES).map(([id, G]) => [id, G.info()]));

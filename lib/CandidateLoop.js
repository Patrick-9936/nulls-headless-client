const ByteStream = require('../DataStream/ByteStream');

function currentEvent(home) {
  if (!Buffer.isBuffer(home) || home.length > 1024 * 1024) throw new Error('Нет ограниченного Home для выбора события');
  const matches = new Map();
  const s = new ByteStream(); s.set(home);
  // Experimental bounded scan of the native event prefix. TeamData must confirm the selected ID afterwards.
  for (let offset = 0; offset < home.length - 10; offset++) {
    s.offset = offset; s.booleanBit = 0;
    try {
      const event = s.readVInt(), slot = s.readVInt(), kind = s.readVInt();
      if (event < 10000000 || event >= 1000000000 || slot !== 12 || kind !== 0) continue;
      const start = s.readVInt(), end = s.readVInt(); s.readVInt();
      const cls = s.readVInt(); if (cls !== 0 && cls !== 15) continue;
      if (cls) s.readVInt();
      if (start > 0 || start < -86400 || end <= 0 || end > 86400) continue;
      matches.set(event, {event, slot: 12, expiresAt: Date.now() + end * 1000});
    } catch {}
  }
  if (matches.size !== 1) throw new Error(`Неоднозначное текущее событие «Кандидаты дня»: ${matches.size}`);
  return [...matches.values()][0];
}

class Cycle {
  constructor() {this.phase = 'idle'; this.completed = 0; this.generation = null; this.wasLoaded = false;}
  begin(generation) {if (this.phase !== 'idle') return false; this.generation = generation; this.phase = 'requesting'; this.wasLoaded = false; return true;}
  packet(type, generation, length = 1) {
    // Login can restore an existing battle before a new ready request is sent.
    if([20559,24112].includes(type)&&length>0&&this.phase==='idle') {
      this.generation=generation;this.phase='loading';this.wasLoaded=true;return false;
    }
    if (type === 20405 && length > 0 && this.phase === 'idle') {
      this.generation = generation; this.phase = 'queued'; this.wasLoaded = false; return false;
    }
    if (generation !== this.generation) return false;
    if (type === 20405 && this.phase === 'requesting') this.phase = 'queued';
    if (type === 20406 && !this.wasLoaded && ['requesting', 'queued', 'awaiting-resume'].includes(this.phase)) this.phase = 'idle';
    if ([20559, 24112].includes(type) && length > 0 && ['requesting', 'queued', 'awaiting-resume'].includes(this.phase)) {this.phase = 'loading'; this.wasLoaded = true;}
    // 23456 is the native BattleEndMessage (getter 0xf3fad4). No timer or socket close counts as a result.
    if (type === 23456 && length > 0 && (['loading','battle'].includes(this.phase) || this.phase === 'awaiting-resume' && this.wasLoaded)) {
      this.phase = 'ended'; this.completed++; return true;
    }
    return false;
  }
  battleConnected(generation) {if(generation===this.generation&&['loading','awaiting-resume'].includes(this.phase)){this.phase='battle';this.wasLoaded=true;}}
  disconnect() {if (['requesting', 'queued', 'loading','battle'].includes(this.phase)) this.phase = 'result-unknown';}
  resume(generation) {if (['result-unknown', 'awaiting-resume'].includes(this.phase)) {this.generation = generation; this.phase = 'awaiting-resume';}}
  resetAfterEnd() {if (this.phase !== 'ended') throw new Error('Конец боя не подтверждён'); this.phase = 'idle';}
}
module.exports = {currentEvent, Cycle};

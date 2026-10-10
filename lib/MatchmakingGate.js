// Coordinate pending matchmaking in this runner. A lost connection is not a cancellation.
class MatchmakingGate {
  constructor(limit = 1) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('--max-queued: 1..500');
    this.limit = limit; this.active = new Set(); this.waiting = [];
  }
  acquire(bot) {
    if (this.active.has(bot)) return false;
    if (!this.waiting.includes(bot)) this.waiting.push(bot);
    if (this.active.size >= this.limit || this.waiting[0] !== bot) return false;
    this.waiting.shift(); this.active.add(bot); return true;
  }
  occupy(bot) {
    this.waiting = this.waiting.filter(value => value !== bot);
    this.active.add(bot);
  }
  release(bot) {this.active.delete(bot); this.waiting = this.waiting.filter(value => value !== bot);}
}
module.exports = MatchmakingGate;

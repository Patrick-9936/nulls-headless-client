const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Store = require('./Store');
class AccountLock {
  constructor(account) {this.file = account + '.lock'; this.id = crypto.randomUUID();}
  acquire() {
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.file, 'wx', 0o600);
        try {fs.writeFileSync(fd, JSON.stringify({pid: process.pid, id: this.id}));} finally {fs.closeSync(fd);}
        this.owned = true; return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const holder = Store.read(this.file, {});
        if (Number.isInteger(holder.pid) && holder.pid > 0) {
          try {process.kill(holder.pid, 0); throw new Error(`Аккаунт уже используется процессом ${holder.pid}. Для онлайн-бота используйте fleet command`);}
          catch (status) {if (status.code !== 'ESRCH') throw status;}
        } else throw new Error('Не удалось проверить блокировку аккаунта');
        fs.unlinkSync(this.file);
      }
    }
    throw new Error('Не удалось занять аккаунт');
  }
  release() {
    if (this.owned && Store.read(this.file, {}).id === this.id) fs.unlinkSync(this.file);
    this.owned = false;
  }
}
module.exports = AccountLock;

const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const Store = require('./Store');
const { AppError, codes, fromFilesystem } = require('./Errors');
class AccountLock {
  constructor(account) {
    this.file = account + '.lock';
    this.id = crypto.randomUUID();
  }
  acquire() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch (error) {
      throw fromFilesystem(error, { file: this.file, operation: 'mkdir' });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.file, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, id: this.id }));
        } finally {
          fs.closeSync(fd);
        }
        this.owned = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw fromFilesystem(error, { file: this.file, operation: 'lock' });
        const holder = Store.read(this.file, {});
        if (Number.isInteger(holder.pid) && holder.pid > 0) {
          try {
            process.kill(holder.pid, 0);
            throw new AppError(
              codes.ACCOUNT_LOCKED,
              `Аккаунт уже используется процессом ${holder.pid}. Для онлайн-бота используйте fleet command`,
              { details: { file: this.file, pid: holder.pid } },
            );
          } catch (status) {
            if (status.code !== 'ESRCH') throw status;
          }
        } else
          throw new AppError(codes.ACCOUNT_LOCKED, 'Не удалось проверить блокировку аккаунта', {
            details: { file: this.file },
          });
        try {
          fs.unlinkSync(this.file);
        } catch (error) {
          throw fromFilesystem(error, { file: this.file, operation: 'unlink' });
        }
      }
    }
    throw new AppError(codes.ACCOUNT_LOCKED, 'Не удалось занять аккаунт', { details: { file: this.file } });
  }
  release() {
    if (this.owned && Store.read(this.file, {}).id === this.id) fs.unlinkSync(this.file);
    this.owned = false;
  }
}
module.exports = AccountLock;

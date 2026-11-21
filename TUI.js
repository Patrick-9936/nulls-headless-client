#!/usr/bin/env node
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  readline = require('node:readline');
const { createInterface } = require('node:readline/promises'),
  { spawn } = require('node:child_process');
const Client = require('./lib/Client'),
  Actions = require('./lib/Actions'),
  Store = require('./lib/Store'),
  I18N = require('./lib/i18n');
const ROOT = __dirname,
  VERSION = require('./package.json').version,
  t = I18N.t;
const clean = (v) =>
  String(v ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
// Ширина символа в терминале: CJK и эмодзи занимают две колонки.
const charWidth = (ch) => {
  const cp = ch.codePointAt(0);
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  return (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
    ? 2
    : 1;
};
const publicJSON = (v) =>
  JSON.stringify(
    v,
    (k, x) =>
      /passToken|password|secret|deviceId|androidId|idForVendor|openDeviceId|license|loginClientSeed/i.test(k)
        ? t('tui.json.hidden')
        : x,
    2,
  );
class Exit extends Error {}
class Cancel extends Error {}
const tag = ['tag', 'tui.field.tag', 'text', undefined, true],
  clubTag = ['clubTag', 'tui.field.clubTag', 'text', undefined, true];
const text = ['text', 'tui.field.text', 'text', undefined, true],
  code = ['code', 'tui.field.code', 'text', undefined, true];
const decision = [
  'accept',
  'tui.field.decision',
  'choice',
  [
    { label: 'tui.decision.accept', value: true },
    { label: 'tui.decision.decline', value: false },
  ],
  true,
];
const commands = {
  'account-region': ['tui.action.account-region', [['region', 'tui.field.region', 'regions', undefined, true]]],
  friend: ['tui.action.friend', [tag]],
  'accept-friend': ['tui.action.accept-friend', [tag]],
  'decline-friend': ['tui.action.decline-friend', [tag]],
  'remove-friend': ['tui.action.remove-friend', [tag]],
  friends: ['tui.action.friends', []],
  'friends-online': ['tui.action.friends-online', []],
  spectate: ['tui.action.spectate', [tag]],
  'stop-spectate': ['tui.action.stop-spectate', []],
  'brawl-tv': ['tui.action.brawl-tv', []],
  'brawl-tv-channels': ['tui.action.brawl-tv-channels', []],
  'brawl-tv-next': ['tui.action.brawl-tv-next', [['channel', 'tui.field.channel', 'tv-channel', undefined, true]]],
  'create-club': ['tui.action.create-club', [['clubName', 'tui.field.clubName', 'text', undefined, true]]],
  'join-club': ['tui.action.join-club', [clubTag]],
  'leave-club': ['tui.action.leave-club', []],
  'club-info': ['tui.action.club-info', [['clubTag', 'tui.field.clubTagSelf', 'text']]],
  'club-recommendations': ['tui.action.club-recommendations', []],
  'club-members': ['tui.action.club-members', []],
  'club-online': ['tui.action.club-online', []],
  'club-chat': ['tui.action.club-chat', [text]],
  'club-stream': ['tui.action.club-stream', []],
  'club-requests': ['tui.action.club-requests', []],
  'club-request': ['tui.action.club-request', [clubTag, text]],
  'club-answer': ['tui.action.club-answer', [tag, decision]],
  'club-description': [
    'tui.action.club-description',
    [['description', 'tui.field.descriptionOptional', 'empty', '', true]],
  ],
  'club-trophies': [
    'tui.action.club-trophies',
    [['requiredTrophies', 'tui.field.requiredTrophies', 'number', 0, true]],
  ],
  'club-settings': [
    'tui.action.club-settings',
    [
      ['description', 'tui.field.newDescription', 'text'],
      [
        'type',
        'tui.field.clubType',
        'choice',
        [
          { label: 'tui.clubType.open', value: 1 },
          { label: 'tui.clubType.apply', value: 2 },
          { label: 'tui.clubType.closed', value: 3 },
        ],
      ],
      ['requiredTrophies', 'tui.field.requiredTrophies', 'number'],
      ['badge', 'tui.field.badge', 'badges'],
      ['region', 'tui.field.region', 'regions'],
      [
        'familyFriendly',
        'tui.field.familyFriendly',
        'choice',
        [
          { label: 'tui.yes', value: true },
          { label: 'tui.no', value: false },
        ],
      ],
    ],
  ],
  'club-role': [
    'tui.action.club-role',
    [
      tag,
      [
        'role',
        'tui.field.role',
        'choice',
        [
          { label: 'tui.role.member', value: 'member' },
          { label: 'tui.role.senior', value: 'senior' },
          { label: 'tui.role.vice', value: 'vice' },
          { label: 'tui.role.president', value: 'president' },
        ],
        true,
      ],
    ],
  ],
  'club-promote': ['tui.action.club-promote', [tag]],
  'club-demote': ['tui.action.club-demote', [tag]],
  'club-kick': ['tui.action.club-kick', [tag, ['text', 'tui.field.kickReason', 'text']]],
  'club-invite': ['tui.action.club-invite', [tag]],
  'create-room': [
    'tui.action.create-room',
    [
      [
        'type',
        'tui.field.roomType',
        'choice',
        [
          { label: 'tui.roomType.team', value: 0 },
          { label: 'tui.roomType.friendly', value: 1 },
        ],
        true,
      ],
    ],
  ],
  'join-room': ['tui.action.join-room', [code]],
  'leave-room': ['tui.action.leave-room', []],
  'team-info': ['tui.action.team-info', []],
  chat: ['tui.action.chat', [text]],
  'team-invite': ['tui.action.team-invite', [tag]],
  'team-cancel-invite': ['tui.action.team-cancel-invite', [tag]],
  invitations: ['tui.action.invitations', []],
  'accept-invite': ['tui.action.accept-invite', [['code', 'tui.field.codeOptional', 'text']]],
  'decline-invite': ['tui.action.decline-invite', [['code', 'tui.field.codeOptional', 'text']]],
  'invite-answer': ['tui.action.invite-answer', [['code', 'tui.field.codeOptional', 'text'], decision]],
  'team-answer': [
    'tui.action.team-answer',
    [
      ['response', 'tui.field.response', 'number', 0, true],
      ['extra', 'tui.field.extra', 'number', 0, true],
    ],
  ],
  'team-request': ['tui.action.team-request', [tag, code]],
  'team-cancel-request': ['tui.action.team-cancel-request', []],
  'team-request-answer': ['tui.action.team-request-answer', [tag, decision]],
  'team-kick': ['tui.action.team-kick', [tag]],
  'team-map': ['tui.action.team-map', [['location', 'tui.field.location', 'maps', undefined, true]]],
  'team-mode': ['tui.action.team-mode', [['mode', 'tui.field.mode', 'modes', undefined, true]]],
  'team-location': [
    'tui.action.team-location',
    [
      ['location', 'tui.field.location', 'maps', undefined, true],
      ['modifiers', 'tui.field.modifiers', 'numbers'],
    ],
  ],
  'team-event': [
    'tui.action.team-event',
    [
      ['event', 'tui.field.event', 'number', undefined, true],
      ['slot', 'tui.field.slot', 'number', 0, true],
      ['modifier', 'tui.field.extra', 'number', 0, true],
    ],
  ],
  'team-status': ['tui.action.team-status', [['status', 'tui.field.numericStatus', 'number', 0, true]]],
  'team-bot': [
    'tui.action.team-bot',
    [
      ['slot', 'tui.field.slot09', 'number', 0, true],
      [
        'disabled',
        'tui.field.state',
        'choice',
        [
          { label: 'tui.bot.disable', value: true },
          { label: 'tui.bot.enable', value: false },
        ],
        true,
      ],
    ],
  ],
  'team-advertise': ['tui.action.team-advertise', [['type', 'tui.field.type', 'number', 0, true]]],
  ready: ['tui.action.ready', []],
  unready: ['tui.action.unready', []],
  matchmake: ['tui.action.matchmake', []],
  'cancel-matchmake': ['tui.action.cancel-matchmake', []],
  practice: ['tui.action.practice', []],
  'player-status': [
    'tui.action.player-status',
    [
      ['status', 'tui.field.status', 'number', 0, true],
      ['extra', 'tui.field.extra', 'number', 0, true],
    ],
  ],
  'team-brawler': ['tui.action.team-brawler', []],
  top: [
    'tui.action.top',
    [
      ['type', 'tui.field.ratingType', 'number', 0, true],
      [
        'local',
        'tui.field.rating',
        'choice',
        [
          { label: 'tui.rating.global', value: false },
          { label: 'tui.rating.local', value: true },
        ],
        true,
      ],
      ['brawler', 'tui.field.brawler', 'text', '16:0', true],
      ['extra', 'tui.field.extra', 'number', 0, true],
    ],
  ],
};
const groups = [
  ['tui.group.account', []],
  [
    'tui.group.friends',
    [
      'friends',
      'friends-online',
      'friend',
      'accept-friend',
      'decline-friend',
      'remove-friend',
      'account-region',
      'player-status',
    ],
  ],
  [
    'tui.group.club',
    [
      'club-recommendations',
      'club-info',
      'club-members',
      'club-online',
      'club-stream',
      'club-requests',
      'create-club',
      'join-club',
      'leave-club',
      'club-chat',
      'club-request',
      'club-answer',
      'club-description',
      'club-trophies',
      'club-settings',
      'club-role',
      'club-promote',
      'club-demote',
      'club-kick',
      'club-invite',
    ],
  ],
  [
    'tui.group.team',
    [
      'create-room',
      'join-room',
      'leave-room',
      'team-info',
      'chat',
      'team-invite',
      'invitations',
      'accept-invite',
      'decline-invite',
      'invite-answer',
      'team-request',
      'team-cancel-request',
      'team-request-answer',
      'team-cancel-invite',
      'team-kick',
      'team-status',
      'team-advertise',
      'team-answer',
    ],
  ],
  [
    'tui.group.maps',
    [
      'team-mode',
      'team-map',
      'team-location',
      'team-event',
      'team-bot',
      'team-brawler',
      'ready',
      'unready',
      'matchmake',
      'cancel-matchmake',
      'practice',
    ],
  ],
  ['tui.group.tv', ['spectate', 'stop-spectate', 'brawl-tv', 'brawl-tv-channels', 'brawl-tv-next']],
  ['tui.group.top', ['top']],
  ['tui.group.utilities', []],
];
class App {
  constructor(root = ROOT, deps = {}) {
    this.root = root;
    this.Client = deps.Client || Client;
    this.execute = deps.execute || Actions.execute;
    this.sessions = new Map();
    this.active = null;
    this.logs = [];
    this.closing = false;
    this.refresh = null;
    this.abort = null;
    this.child = null;
    this.connection = { battleTransport: 'udp', reconnect: true };
    this.previousDebugger = global.Debugger;
    const config = Store.read(path.join(root, 'config.json'), {});
    const language = I18N.detectInfo({ config });
    I18N.setLanguage(language.language);
    this.languageInfo = language;
    this.uiLanguage =
      config.uiLanguage === undefined || I18N.isAuto(config.uiLanguage)
        ? I18N.AUTO
        : I18N.resolve(config.uiLanguage) || I18N.AUTO;
    this.features = Store.read(path.join(root, 'docs/features.json'), { commands: [] });
  }
  log(v) {
    this.logs.push(clean(v).replace(/\n/g, ' ').slice(0, 180));
    if (this.logs.length > 3) this.logs.shift();
    this.refresh?.();
  }
  context() {
    const c = this.active;
    if (!c) return clean(t('tui.context.disconnected', { count: this.sessions.size }));
    const name = c.account.name || t('tui.context.unnamed');
    const tag = c.account.lo ? require('./utils/TagCodec').logicLongToTag(c.account.hi, c.account.lo) : '';
    return clean(t('tui.context.state', { name, tag, state: c.state, count: this.sessions.size }));
  }
  draw(title, items, index = 0, view = {}) {
    const columns = Math.max(20, process.stdout.columns || 80);
    const height = Math.max(5, (process.stdout.rows || 24) - 10),
      start = Math.max(0, Math.min(index - Math.floor(height / 2), items.length - height));
    // Обрезаем каждую строку по ширине терминала, чтобы узкое окно не ломало кадр.
    const fit = (value) => {
      const text = clean(value).replace(/\r/g, ''),
        chars = [...text],
        total = chars.reduce((sum, ch) => sum + charWidth(ch), 0);
      if (total <= columns) return text;
      let used = 0,
        out = '';
      for (const ch of chars) {
        const width = charWidth(ch);
        if (used + width > columns - 1) break;
        out += ch;
        used += width;
      }
      return out + '…';
    };
    const lines = [
      fit(t('tui.header', { version: VERSION })),
      fit(this.context()),
      '',
      ...String(title).split('\n').map(fit),
    ];
    items
      .slice(start, start + height)
      .forEach((item, n) => lines.push(fit((start + n === index ? '>' : ' ') + ' ' + (item.label ?? item))));
    const hint = columns < 64 ? t('tui.hint.keysNarrow') : t('tui.hint.keys');
    lines.push('', fit((items.length ? index + 1 + '/' + items.length + ' · ' : '') + hint));
    if (view.typed) lines.push(fit(t('tui.hint.typed', { number: view.typed })));
    if (view.notice) lines.push(fit(view.notice));
    if (view.help) lines.push(...t('tui.hint.help').split('\n').map(fit));
    lines.push(...this.logs.map(fit));
    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
  }
  choose(title, items) {
    if (this.closing) return Promise.reject(new Exit());
    if (!items.length) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let index = 0,
        typed = '',
        notice = '',
        help = false;
      const wasRaw = !!process.stdin.isRaw,
        render = () => this.draw(title, items, index, { typed, notice, help }),
        done = (v, e) => {
          process.stdin.removeListener('keypress', key);
          process.stdout.removeListener('resize', render);
          if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
          this.refresh = null;
          this.abort = null;
          e ? reject(e) : resolve(v);
        },
        pick = (n) => items[n].value ?? items[n],
        move = (n) => {
          index = n;
          notice = '';
        };
      const key = (str, k = {}) => {
        if (k.ctrl && k.name === 'c') return done(null, new Exit());
        const name = k.name,
          char = str || k.sequence || '';
        if (char === '?') {
          help = !help;
          notice = '';
          return render();
        }
        if (name === 'escape') {
          if (help) {
            help = false;
            notice = '';
            return render();
          }
          return done(null);
        }
        if (name === 'q') return done(null);
        if (name === 'up' || char === 'k' || name === 'k') move((index + items.length - 1) % items.length);
        else if (name === 'down' || char === 'j' || name === 'j') move((index + 1) % items.length);
        else if (name === 'pageup' || (name === 'tab' && k.shift) || name === 'backtab') move(Math.max(0, index - 10));
        else if (name === 'pagedown' || name === 'tab') move(Math.min(items.length - 1, index + 10));
        else if (name === 'home' || char === 'g') move(0);
        else if (name === 'end' || char === 'G') move(items.length - 1);
        else if (name === 'backspace' || name === 'delete') typed = '';
        else if (/^[1-9]$/.test(char) && !typed) typed = char;
        else if (/^[0-9]$/.test(char) && typed) typed += char;
        else if (name === 'return' || name === 'enter') {
          if (typed) {
            const n = Number(typed);
            typed = '';
            if (n >= 1 && n <= items.length) return done(pick(n - 1));
            notice = t('tui.hint.noItem', { number: n });
            return render();
          }
          return done(pick(index));
        } else notice = '';
        render();
      };
      this.refresh = render;
      this.abort = () => done(null, new Exit());
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('keypress', key);
      process.stdout.on('resize', render);
      render();
    });
  }
  async prompt(label, fallback, required = false, kind = 'text') {
    for (;;) {
      if (this.closing) throw new Exit();
      process.stdout.write(
        '\x1b[2J\x1b[H' +
          clean(label) +
          (fallback !== undefined ? ' [' + clean(fallback) + ']' : '') +
          '\n' +
          clean(t('tui.prompt.hint')) +
          '\n',
      );
      const rl = createInterface({ input: process.stdin, output: process.stdout }),
        controller = new AbortController();
      this.abort = () => {
        controller.abort();
        rl.close();
      };
      rl.once('SIGINT', () => {
        this.closing = true;
        this.abort?.();
      });
      let answer;
      try {
        answer = await rl.question('› ', { signal: controller.signal });
      } catch {
        throw new Exit();
      } finally {
        rl.close();
        this.abort = null;
      }
      if (answer === '/cancel') throw new Cancel();
      const value = answer !== '' ? answer : fallback;
      if (value === undefined && !required) return undefined;
      if ((value === undefined || (kind !== 'empty' && !String(value).trim())) && required) {
        this.log(t('tui.prompt.required'));
        continue;
      }
      if (value === undefined) return undefined;
      if (kind === 'number') {
        if (!/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
          this.log(t('tui.prompt.number'));
          continue;
        }
        return Number(value);
      }
      if (kind === 'numbers') {
        if (!String(value).trim()) return [];
        const parts = String(value)
          .split(',')
          .map((x) => x.trim());
        if (parts.some((x) => !/^[-]?\d+$/.test(x))) {
          this.log(t('tui.prompt.numbers'));
          continue;
        }
        return parts.map(Number);
      }
      return String(value);
    }
  }
  async view(title, value) {
    const lines = (typeof value === 'string' ? clean(value) : publicJSON(value)).split('\n'),
      pages = [],
      size = Math.max(3, (process.stdout.rows || 24) - 18);
    for (let n = 0; n < lines.length; n += size) pages.push(lines.slice(n, n + size).join('\n'));
    let page = 0;
    for (;;) {
      const action = await this.choose(
        title + '\n\n' + pages[page] + '\n\n' + t('tui.view.page', { page: page + 1, total: pages.length }),
        [
          { label: t('tui.view.back'), value: 'back' },
          ...(page > 0 ? [{ label: t('tui.view.prev'), value: 'prev' }] : []),
          ...(page + 1 < pages.length ? [{ label: t('tui.view.next'), value: 'next' }] : []),
        ],
      );
      if (!action || action === 'back') return;
      page += action === 'next' ? 1 : -1;
    }
  }
  async fields(id) {
    const args = {};
    for (const [key, labelKey, kind, defaultValue, required] of commands[id][1]) {
      const label = t(labelKey);
      let values;
      if (kind === 'choice') values = defaultValue.map((o) => ({ label: t(o.label), value: o.value }));
      if (kind === 'regions')
        values = Store.read(path.join(this.root, 'data/regions.json'), []).map((r) => ({
          label: r.Name + ' · ' + (r.DisplayName || ''),
          value: r.reference,
        }));
      if (kind === 'badges')
        values = Store.read(path.join(this.root, 'data/club-badges.json'), []).map((r) => ({
          label: r.Name,
          value: r.reference,
        }));
      if (kind === 'maps')
        values = Store.read(path.join(this.root, 'data/maps.json'), []).map((r) => ({
          label: r.mode + ' · ' + r.name,
          value: r.reference,
        }));
      if (kind === 'modes')
        values = [...new Set(Store.read(path.join(this.root, 'data/maps.json'), []).map((r) => r.mode))].map(
          (value) => ({ label: value, value }),
        );
      if (kind === 'tv-channel') {
        const r = await this.execute(this.active, 'brawl-tv-channels', { experimental: true, timeout: 15000 });
        values = r.channels.map((c) => ({ label: c.id + ' · ' + (c.title || t('tui.channel.unnamed')), value: c.id }));
        if (!values.length) throw Error(t('tui.error.noChannels'));
      }
      if (values) {
        const selected = await this.choose(
          label,
          required ? values : [{ label: t('tui.view.skip'), value: '__skip__' }, ...values],
        );
        if (selected === null) throw new Cancel();
        if (selected !== '__skip__') args[key] = selected;
      } else {
        const value = await this.prompt(label, defaultValue, required, kind);
        if (value !== undefined) args[key] = value;
      }
    }
    return args;
  }
  attach(file, client) {
    this.sessions.set(file, client);
    this.active = client;
    for (const c of this.sessions.values()) c.peers = this.sessions;
    client.on('state', (s) =>
      this.log(
        t('tui.log.state', { name: client.account.name || path.basename(file), state: s.state }) +
          (s.error ? ' · ' + s.error : ''),
      ),
    );
    client.on('warning', (e) => this.log(e.message));
    client.on('battle-vision', () => {
      client.tuiFrames = (client.tuiFrames || 0) + 1;
    });
  }
  async connectAccount(file, name) {
    file = path.resolve(this.root, file);
    const saved = Store.read(file, {});
    if (saved.passToken && !saved.hi && !saved.lo) throw Error(t('tui.error.accountNoId'));
    if (!saved.passToken && !name) throw Error(t('tui.error.newAccountName'));
    if (this.sessions.has(file)) {
      this.active = this.sessions.get(file);
      if (this.active.state !== 'online') await this.active.connect();
      return;
    }
    const client = new this.Client({ root: this.root, account: file, ...this.connection, ...(name ? { name } : {}) });
    this.attach(file, client);
    this.log(t('tui.log.connecting'));
    try {
      await client.connect();
      this.log(t('tui.log.connected'));
    } catch (e) {
      client.close();
      this.sessions.delete(file);
      this.active = [...this.sessions.values()].at(-1) || null;
      throw e;
    }
  }
  saveLanguage(code) {
    const file = path.join(this.root, 'config.json');
    const config = Store.read(file, {});
    Store.write(file, { ...config, uiLanguage: code });
  }
  async language() {
    const file = path.join(this.root, 'config.json');
    const config = Store.read(file, {});
    const configured =
      config.uiLanguage === undefined || I18N.isAuto(config.uiLanguage)
        ? I18N.AUTO
        : I18N.resolve(config.uiLanguage) || I18N.AUTO;
    const current = I18N.getLanguage();
    const code = await this.choose(t('tui.lang.pick'), [
      {
        value: I18N.AUTO,
        label: (configured === I18N.AUTO ? '* ' : '  ') + t('tui.lang.auto', { language: I18N.label(current) }),
      },
      ...I18N.SUPPORTED.map((value) => ({
        value,
        label: (configured === value ? '* ' : '  ') + I18N.label(value) + ' (' + value + ')',
      })),
    ]);
    if (!code) return;
    if (code === I18N.AUTO) {
      const info = I18N.detectInfo({ config: { ...config, uiLanguage: I18N.AUTO } });
      I18N.setLanguage(info.language);
      this.saveLanguage(I18N.AUTO);
      this.uiLanguage = I18N.AUTO;
      this.languageInfo = info;
      this.log(t('tui.lang.autoSaved', { language: I18N.label(info.language) }));
      return;
    }
    if (code === configured && code === current) {
      this.log(t('tui.lang.unchanged'));
      return;
    }
    I18N.setLanguage(code);
    this.saveLanguage(code);
    this.uiLanguage = code;
    this.languageInfo = { language: code, mode: 'fixed', source: 'config' };
    this.log(t('tui.lang.saved', { language: I18N.label(code) }));
  }
  async accounts() {
    for (;;) {
      const choice = await this.choose(t('tui.menu.accounts'), [
        { label: t('tui.accounts.load'), value: 'load' },
        { label: t('tui.accounts.new'), value: 'new' },
        { label: t('tui.accounts.switch'), value: 'switch' },
        { label: t('tui.accounts.info'), value: 'info' },
        { label: t('tui.accounts.reconnect'), value: 'reconnect' },
        { label: t('tui.accounts.close'), value: 'close' },
        { label: t('tui.accounts.settings'), value: 'settings' },
        { label: t('tui.view.back'), value: 'back' },
      ]);
      if (!choice || choice === 'back') return;
      try {
        if (choice === 'load') {
          const files = [];
          if (fs.existsSync(path.join(this.root, 'account.json'))) files.push('account.json');
          const dir = path.join(this.root, 'accounts');
          if (fs.existsSync(dir))
            for (const n of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) files.push('accounts/' + n);
          const picked = await this.choose(t('tui.accounts.pick'), [
            ...files.map((value) => ({ label: value, value })),
            { label: t('tui.accounts.otherPath'), value: '__path__' },
          ]);
          if (!picked) continue;
          const file = picked === '__path__' ? await this.prompt(t('tui.accounts.path'), undefined, true) : picked;
          if (!fs.existsSync(path.resolve(this.root, file))) throw Error(t('tui.error.fileMissing'));
          await this.connectAccount(file);
        } else if (choice === 'new') {
          const file = await this.prompt(t('tui.accounts.newFile'), 'accounts/tui-' + Date.now() + '.json', true);
          if (fs.existsSync(path.resolve(this.root, file))) throw Error(t('tui.error.fileExists'));
          await this.connectAccount(file, await this.prompt(t('tui.accounts.newName'), undefined, true));
        } else if (choice === 'switch') {
          const file = await this.choose(
            t('tui.accounts.sessions'),
            [...this.sessions].map(([value, c]) => ({
              label: (c.account.name || path.basename(value)) + ' · ' + c.state,
              value,
            })),
          );
          if (file) this.active = this.sessions.get(file);
        } else if (choice === 'settings') {
          const transport = await this.choose(t('tui.settings.transport'), [
            { label: 'udp', value: 'udp' },
            { label: t('tui.settings.tcpOnly'), value: 'none' },
          ]);
          if (!transport) continue;
          const proxyPoolFile = await this.prompt(t('tui.settings.proxy'), '');
          this.connection = {
            reconnect: true,
            battleTransport: transport,
            ...(proxyPoolFile ? { proxyPoolFile: path.resolve(this.root, proxyPoolFile) } : {}),
          };
          await this.view(t('tui.settings.title'), this.connection);
        } else {
          if (!this.active) throw Error(t('tui.error.needAccount'));
          if (choice === 'info')
            await this.view(t('tui.title.account'), {
              file: this.active.file,
              account: this.active.account,
              state: this.active.state,
              team: this.active.team,
              club: this.active.club,
              matchmaking: this.active.matchmaking,
              udpFrames: this.active.tuiFrames || 0,
            });
          if (choice === 'reconnect') await this.active.reconnect();
          if (choice === 'close') {
            this.active.close();
            this.sessions.delete(this.active.file);
            this.active = [...this.sessions.values()].at(-1) || null;
          }
        }
      } catch (e) {
        if (e instanceof Exit) throw e;
        if (!(e instanceof Cancel)) await this.view(t('tui.view.error'), e.message);
      }
    }
  }
  async action(id) {
    if (!this.active || this.active.state !== 'online') throw Error(t('tui.error.loginFirst'));
    const feature = this.features.commands.find((f) => f.command === id);
    if (feature?.status === 'unavailable')
      return this.view(t('tui.feature.unavailableTitle'), t('tui.feature.unavailable'));
    if (feature?.experimental) {
      const yes = await this.choose(t('tui.feature.experimentalTitle'), [
        { label: t('tui.view.back'), value: 'back' },
        { label: t('tui.feature.experimentalRun'), value: 'yes' },
      ]);
      if (yes !== 'yes') return;
    }
    const args = await this.fields(id);
    if (id === 'brawl-tv') {
      const pick = await this.choose(t('tui.brawltv.title'), [
        { label: t('tui.brawltv.auto'), value: 'auto' },
        { label: t('tui.brawltv.channel'), value: 'channel' },
        { label: t('tui.brawltv.tag'), value: 'tag' },
      ]);
      if (!pick) throw new Cancel();
      if (pick === 'channel') args.channel = (await this.fields('brawl-tv-next')).channel;
      if (pick === 'tag') args.tag = await this.prompt(t('tui.field.tag'), undefined, true);
    }
    args.experimental = !!feature?.experimental;
    this.log(t('tui.log.waiting'));
    const result = await this.execute(this.active, id, args);
    await this.view(result.confirmed === false ? t('tui.result.notConfirmed') : t('tui.result.server'), result);
  }
  async utilities() {
    for (;;) {
      const selected = await this.choose(t('tui.menu.utilities'), [
        { label: t('tui.utilities.guide'), value: 'guide' },
        { label: t('tui.utilities.features'), value: 'features' },
        { label: t('tui.utilities.commands'), value: 'commands' },
        { label: t('tui.utilities.info'), value: 'info' },
        { label: t('tui.utilities.tagDecode'), value: 'tag-decode' },
        { label: t('tui.utilities.roomCode'), value: 'room-code' },
        { label: t('tui.utilities.lang'), value: 'language' },
        { label: t('tui.utilities.updateCheck'), value: 'update-check' },
        { label: t('tui.utilities.update'), value: 'update' },
        { label: t('tui.utilities.fleetStatus'), value: 'fleet-status' },
        { label: t('tui.view.back'), value: 'back' },
      ]);
      if (!selected || selected === 'back') return;
      try {
        if (selected === 'language') {
          await this.language();
          continue;
        }
        if (selected === 'guide')
          await this.view(t('tui.title.tui'), fs.readFileSync(path.join(this.root, 'docs/TUI.md'), 'utf8'));
        if (selected === 'commands')
          await this.view(t('tui.title.commands'), fs.readFileSync(path.join(this.root, 'docs/COMMANDS.md'), 'utf8'));
        if (selected === 'features') await this.view(t('tui.title.features'), this.features);
        if (selected === 'info') {
          const c = Store.read(path.join(this.root, 'config.json'));
          await this.view(t('tui.title.client'), {
            version: VERSION,
            host: c.host,
            binary: c.appBinaryVersion,
            root: this.root,
            language: I18N.getLanguage(),
          });
        }
        if (selected === 'tag-decode')
          await this.view(
            t('tui.title.tag'),
            require('./utils/TagCodec').describeTag(await this.prompt(t('tui.field.tagPlain'), undefined, true)),
          );
        if (selected === 'room-code')
          await this.view(
            t('tui.title.roomCode'),
            require('./utils/TeamCode').decode(await this.prompt(t('tui.field.codeInput'), undefined, true)),
          );
        if (selected === 'fleet-status') await this.tool('tools/fleet.js', ['status']);
        if (selected === 'update-check') await this.tool('tools/update.js', ['--check']);
        if (selected === 'update') {
          if ([...this.sessions.values()].some((c) => !c.closed)) throw Error(t('tui.error.sessionsFirst'));
          await this.tool('tools/update.js', []);
        }
      } catch (e) {
        if (e instanceof Exit) throw e;
        if (!(e instanceof Cancel)) await this.view(t('tui.view.error'), e.message);
      }
    }
  }
  async tool(file, args) {
    let output = '',
      error = '';
    this.log(t('tui.log.running'));
    const child = (this.child = spawn(process.execPath, [path.join(this.root, file), ...args], {
      cwd: this.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    child.stdout.on('data', (b) => {
      output = (output + b).slice(-150000);
    });
    child.stderr.on('data', (b) => {
      error = (error + b).slice(-150000);
    });
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    this.child = null;
    await this.view(t('tui.result.toolCode', { code: status }), output + error);
  }
  async run() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error(t('tui.error.terminalRequired'));
    global.Debugger = Object.fromEntries(
      ['info', 'warn', 'error', 'fatal'].map((k) => [k, (...v) => this.log(v.join(' '))]),
    );
    const stop = () => {
      this.closing = true;
      for (const c of this.sessions.values()) c.close();
      this.child?.kill('SIGTERM');
      this.abort?.();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      for (;;) {
        const selected = await this.choose(t('tui.menu.main'), [
          ...groups.map((g, value) => ({ label: t(g[0]), value })),
          { label: t('tui.menu.language'), value: 'lang' },
          { label: t('tui.menu.exit'), value: 'exit' },
        ]);
        if (selected === null || selected === 'exit') break;
        if (selected === 'lang') {
          await this.language();
          continue;
        }
        if (selected === 0) {
          await this.accounts();
          continue;
        }
        if (selected === 7) {
          await this.utilities();
          continue;
        }
        const [title, ids] = groups[selected];
        for (;;) {
          const id = await this.choose(
            t(title),
            ids.map((value) => ({
              value,
              label:
                t(commands[value][0]) +
                (this.features.commands.find((f) => f.command === value)?.experimental ? t('tui.feature.tag') : ''),
            })),
          );
          if (!id) break;
          try {
            await this.action(id);
          } catch (e) {
            if (e instanceof Exit) throw e;
            if (!(e instanceof Cancel)) await this.view(t('tui.view.error'), e.message);
          }
        }
      }
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
    } finally {
      stop();
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      global.Debugger = this.previousDebugger;
      if (process.stdin.isRaw) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[2J\x1b[H' + clean(t('tui.menu.closed')) + '\n');
    }
  }
}
async function main() {
  await new App().run();
}
module.exports = { App, commands, groups, main };
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });

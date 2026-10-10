const ByteStream = require('../DataStream/ByteStream');
const Tag = require('../utils/TagCodec');
const TeamCode = require('../utils/TeamCode');
const Club = require('../utils/ClubProtocol');

const roles = {member: 1, president: 2, senior: 3, vice: 4};
function integer(value, name, min = 0, max = 0x7fffffff) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: требуется число ${min}–${max}`);
  return n;
}
function text(value, name, maximum = 500, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || Buffer.byteLength(value) > maximum) {
    throw new Error(`${name}: требуется текст до ${maximum} байт`);
  }
  return value;
}
function reference(stream, value, expectedClass) {
  if (value == null || value === 0) return stream.writeVInt(0);
  const parts = typeof value === 'object' ? [value.class, value.index] : String(value).split(':');
  if (parts.length === 1) parts.unshift(expectedClass);
  const cls = integer(parts[0], 'класс', 1, 100);
  if (expectedClass && cls !== expectedClass) throw new Error(`Ожидается DataReference класса ${expectedClass}`);
  stream.writeDataReference(cls, integer(parts[1], 'индекс'));
}
function readReference(s) {
  const cls = s.readVInt();
  return cls ? {class: cls, index: s.readVInt()} : null;
}
function target(value) {
  if (value && typeof value === 'object' && Number.isInteger(value.hi) && Number.isInteger(value.lo)) return {hi: value.hi, lo: value.lo};
  if (!value) throw new Error('Нужен тег #...');
  const id = Tag.tagToLogicLong(value); return {hi: id.hi, lo: id.lo};
}
function encodeBody(command, args = {}) {
  const s = new ByteStream();
  const long = value => {const id = target(value); s.writeLong(id.hi, id.lo);};
  let id;
  switch (command) {
    case 'account-region': id = 12998; reference(s, args.region, 14); break;
    case 'friend': id = 10502; long(args.tag); s.writeInt(integer(args.reason ?? 0, 'reason')); s.writeInt(integer(args.reasonDetails ?? 0, 'reason-details')); break;
    case 'friends': id = 10504; break;
    case 'accept-friend': id = 10501; long(args.tag); break;
    case 'remove-friend': id = 10506; long(args.tag); break;
    case 'team-request': id = 14881; long(args.tag); {const t = TeamCode.decode(args.code); s.writeLong(t.hi, t.lo);} break;
    case 'team-cancel-request': id = 14880; break;
    case 'team-request-answer': id = 14882; long(args.tag); s.writeBoolean(!!args.accept); s.writeBoolean(!!args.spectator); break;
    case 'team-brawler':
      throw new Error('Выбор бойца пока не подтверждён: пакет 14354 меняет экипировку и не принимает ссылку бойца');
    case 'team-answer': id = 14368; s.writeVInt(integer(args.response ?? (args.accept ? 1 : 0), 'response', 0, 10)); s.writeVInt(integer(args.extra ?? 0, 'extra')); break;
    case 'invite-answer': id = 14479; s.writeVInt(args.accept ? 1 : 2); {const room = args.team || (args.code ? TeamCode.decode(args.code) : null); if (!room) throw new Error('Ответ на приглашение требует ID команды или --code'); long(room);} s.writeBoolean(!!args.spectator); break;
    case 'team-cancel-invite': id = 14367; long(args.tag); break;
    case 'top': id = 14403; s.writeBoolean(!!args.local); s.writeVInt(integer(args.type ?? 0, 'type')); reference(s, args.brawler ?? '16:0', 16); s.writeVInt(integer(args.extra ?? 0, 'extra')); break;
    case 'spectate': id = 14104; long(args.tag); s.writeBoolean(!!(args.brawlTv ?? args.afterDeath)); break;
    case 'brawl-tv': id = 14104; long(args.tag); s.writeBoolean(true); break;
    case 'brawl-tv-channels': id = 14700; s.writeVInt(-1); s.writeBoolean(true); break;
    case 'brawl-tv-next': id = 14701; s.writeVInt(integer(args.channel,'channel')); s.writeVInt(integer(args.previous ?? -1,'previous',-1)); break;
    case 'stop-spectate': id = 14107; break;
    case 'cancel-matchmake': id = 14106; break;
    case 'create-club': return {id: 14301, payload: Club.create(text(args.clubName, 'club-name', 60))};
    case 'join-club': return {id: 14305, payload: Club.join(target(args.clubTag))};
    case 'club-info': return {id: 14302, payload: Club.info(target(args.clubTag))};
    case 'club-recommendations': id = 14303; s.writeVInt(0); break;
    case 'club-stream': throw new Error('Лента приходит в 24311 при входе; используйте Actions/CLI club-stream');
    case 'leave-club': id = 14308; s.writeBoolean(false); break;
    case 'club-chat': id = 14315; s.writeRequiredString(text(args.text, 'text')); break;
    case 'club-role': id = 14306; long(args.tag); s.writeVInt(integer(roles[args.role] ?? args.role, 'role', 1, 4)); break;
    case 'club-kick': id = 14307; long(args.tag); s.writeRequiredString(text(args.text ?? '', 'text', 500, true)); break;
    case 'club-invite': id = 14322; long(args.tag); break;
    case 'club-request': id = 14317; long(args.clubTag); s.writeRequiredString(text(args.text, 'text', 500)); break;
    case 'club-answer': id = 14321; if (!args.entryId) throw new Error('Ответ требует ID записи заявки из ленты клуба'); long(args.entryId); s.writeBoolean(!!args.accept); break;
    case 'club-settings':
      id = 14316;
      if (!args.settings) throw new Error('Сначала нужно получить текущие настройки клуба');
      s.writeRequiredString(text(args.settings.description ?? '', 'description', 1000, true));
      reference(s, args.settings.badge, 8); reference(s, args.settings.region, 14);
      s.writeVInt(integer(args.settings.type, 'club-type', 1, 3));
      s.writeVInt(integer(args.settings.requiredTrophies, 'required-trophies', 0, 1000000));
      s.writeBoolean(!!args.settings.familyFriendly); break;
    case 'create-room': id = 12541; s.writeLong(0, 0); s.writeVInt(integer(args.type ?? 0, 'type', 0, 10)); s.writeVInt(-1); s.writeVInt(-1); break;
    case 'join-room': {
      id = 14358; const t = TeamCode.decode(args.code); s.writeVInt(t.hi); s.writeVInt(t.lo); s.writeVInt(1); break;
    }
    case 'leave-room': id = 14353; break;
    case 'chat': id = 14049; s.writeRequiredString(text(args.text, 'text')); break;
    case 'ready': case 'unready': id = 14355; s.writeBoolean(command === 'ready'); break;
    case 'team-event': id = 14362; s.writeVInt(integer(args.event, 'event')); s.writeVInt(integer(args.slot ?? 0, 'slot')); s.writeVInt(integer(args.modifier ?? 0, 'modifier', -1)); break;
    case 'team-location': {
      id = 14363; reference(s, args.location, 15);
      const modifiers = args.modifiers ?? []; if (!Array.isArray(modifiers) || modifiers.length > 32) throw new Error('modifiers: максимум 32');
      s.writeVInt(modifiers.length); for (const value of modifiers) s.writeVInt(integer(value, 'modifier')); break;
    }
    case 'team-kick': id = 14352; {const t = target(args.tag); s.writeVInt(t.hi); s.writeVInt(t.lo);} break;
    case 'team-advertise': id = 14360; s.writeVInt(integer(args.type ?? 0, 'type')); break;
    case 'team-status': id = 14361; s.writeVInt(integer(args.status, 'status', 0, 10)); break;
    case 'team-invite':
      id = 14365; {const t = target(args.tag); s.writeVInt(t.hi); s.writeVInt(t.lo);}
      s.writeVInt(integer(args.slot ?? 0, 'slot')); s.writeVInt(integer(args.type ?? 0, 'type')); s.writeBoolean(!!args.spectator); break;
    case 'team-bot': id = 14373; s.writeInt(integer(args.slot, 'slot', 0, 9)); s.writeBoolean(!!args.disabled); break;
    case 'practice': id = 14356; break;
    case 'player-status': id = 14366; s.writeVInt(integer(args.status, 'status', 0, 10)); s.writeVInt(integer(args.extra ?? 0, 'extra')); break;
    default: throw new Error(`Неизвестная команда: ${command}`);
  }
  return {id, payload: s.getBytes()};
}
function encode(command, args) {
  const message = encodeBody(command, args);
  message.version = require('../docs/protocol-evidence.json')[message.id]?.version || 0;
  return message;
}
module.exports = {encode, target, readReference, reference, integer, text, roles};

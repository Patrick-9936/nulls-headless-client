const ByteStream = require('../DataStream/ByteStream');
const {readReference} = require('./Protocol');
const Tag = require('../utils/TagCodec');

function stream(bytes) {const s = new ByteStream(); s.set(bytes); return s;}
function count(s, maximum = 1000) {
  const n = s.readVInt();
  if (n < -1 || n > maximum) throw new Error(`Неверный размер списка: ${n}`);
  return Math.max(0, n);
}
function id(s) {const value = s.readLong(); return {...value, tag: Tag.logicLongToTag(value.hi, value.lo)};}
function clubHeader(s) {
  const result = {...id(s), name: s.readString(), badge: readReference(s)};
  for (const field of ['type', 'memberCount', 'trophies', 'requiredTrophies']) result[field] = s.readVInt();
  return result;
}
function clubHeaderExtra(s, result) {
  result.region = readReference(s); result.secondaryName = s.readString();
  result.extra0 = s.readVInt(); result.extra1 = s.readVInt(); result.familyFriendly = s.readBoolean();
  result.extra2 = s.readVInt();
  for (const field of ['season', 'league']) {
    result[field] = s.readVInt();
    if (result[field] > 0) result[field + 'Fields'] = [s.readVInt(), s.readVInt()];
  }
  result.complete = true;
  return result;
}
function recommendedClubs(bytes) {
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Слишком большой список рекомендованных клубов');
  const s = stream(bytes);
  const clubs = Array.from({length: count(s)}, () => clubHeaderExtra(s, clubHeader(s)));
  if (s.remaining()) throw new Error('Лишние данные рекомендованных клубов');
  return clubs;
}
function display(s) {
  return {name: s.readString(), fields: Array.from({length: 4}, () => s.readVInt()), flag: s.readBoolean(), extra: [s.readVInt(), s.readVInt()]};
}
function clubMember(s) {
  const member = {...id(s), role: s.readVInt()};
  member.fields = Array.from({length: 3}, () => s.readVInt());
  member.optional = s.readVInt(); if (member.optional > 0) member.optionalValue = s.readVInt();
  member.flag = s.readBoolean(); member.display = display(s); member.name = member.display.name;
  member.extra = s.readVInt(); member.flag2 = s.readBoolean();
  if (s.readVInt() > 0) {member.league = Array.from({length: 8}, () => s.readVInt()); member.leagueFlag = s.readBoolean();}
  member.extra2 = s.readVInt();
  if (s.readVInt() > 0) member.season = Array.from({length: 3}, () => s.readVInt());
  if (s.readVInt() > 0) member.season2 = [s.readVInt(), s.readVInt()];
  if (s.readVInt() > 0) member.status = s.readVInt();
  member.extra3 = s.readVInt();
  return member;
}
function club(type, bytes) {
  const s = stream(bytes);
  if (type === 24399) {
    const role = s.readVInt();
    if (!s.readBoolean()) return {role, club: null};
    const badge = readReference(s); const value = clubHeader(s);
    try {clubHeaderExtra(s, value);} catch {value.complete = false;}
    return {role, badge, club: value};
  }
  if (type === 24301) {
    const full = s.readBoolean(); const value = clubHeader(s);
    try {
      clubHeaderExtra(s, value); value.description = s.readString();
      const n = s.readVInt();
      if (n >= 0) {
        if (n > 1000) throw new Error('Слишком много членов клуба');
        value.members = Array.from({length: n}, () => clubMember(s));
      }
    } catch (error) {value.parseWarning = error.message;}
    return {...value, full};
  }
  if (type === 24308) return clubMember(s);
  throw new Error('Неизвестный ответ клуба');
}
function teamMember(s) {
  const value = {leader: s.readBoolean(), ...id(s), brawler: readReference(s), skin: readReference(s)};
  value.fields = Array.from({length: 6}, () => s.readVInt());
  value.status = value.fields[5];
  value.ready = s.readBoolean(); value.extra = Array.from({length: 7}, () => s.readVInt());
  value.display = display(s); value.name = value.display.name;
  value.references = Array.from({length: 9}, () => readReference(s)); value.extra2 = s.readVInt();
  value.moreReferences = Array.from({length: count(s, 100)}, () => readReference(s));
  value.extra3 = [s.readVInt(), s.readVInt()];
  value.items = Array.from({length: count(s, 100)}, () => s.readVInt());
  value.itemValues = Array.from({length: count(s, 100)}, () => s.readVInt());
  value.extra4 = s.readVInt(); value.lastReferences = Array.from({length: 4}, () => readReference(s));
  return value;
}
function team(bytes) {
  const s = stream(bytes);
  const value = {type: s.readVInt(), flag: s.readBoolean(), maxMembers: s.readVInt(), ...id(s)};
  value.code = require('../utils/TeamCode').encode(value.hi, value.lo);
  value.slot = s.readVInt(); value.flags = [s.readBoolean(), s.readBoolean()];
  value.fields = [s.readVInt(), s.readVInt(), s.readVInt()]; value.location = readReference(s);
  value.event = value.fields[0]; value.eventSlot = value.fields[1];
  try {
    if (s.readBoolean()) throw new Error('Настройки пользовательской карты ещё не разобраны');
    value.members = Array.from({length: count(s, 10)}, () => teamMember(s));
    if (s.remaining()) value.pendingInvites = Array.from({length: count(s, 100)}, () => ({inviter: id(s), player: id(s), text: s.readString(), slot: s.readVInt(), type: s.readVInt(), spectator: s.readBoolean()}));
    if (s.remaining()) value.requests = Array.from({length: count(s, 100)}, () => ({player: id(s), owner: id(s), profile: friend(s)}));
    if (s.remaining()) value.disabledSlots = Array.from({length: count(s, 10)}, () => s.readVInt());
    if (s.remaining()) value.stateFields = Array.from({length: count(s, 100)}, () => [s.readVInt(), s.readVInt()]);
    if (s.remaining()) value.stateFlags = [s.readBoolean(), s.readBoolean(), s.readBoolean()];
    if (s.remaining()) value.modifiers = Array.from({length: count(s, 100)}, () => s.readVInt());
    if (s.remaining()) throw new Error('Не разобран хвост команды');
    value.complete = true;
  } catch (error) {value.parseWarning = error.message;}
  return value;
}
function friend(s) {
  const value = id(s); value.strings = Array.from({length: 6}, () => s.readString());
  value.fields = Array.from({length: 5}, () => s.readVInt()); value.relationship = value.fields[1];
  if (s.readBoolean()) value.club = {...id(s), role: s.readVInt(), name: s.readString(), fields: [s.readVInt(), s.readVInt()]};
  value.extraString = s.readString(); value.extra = Array.from({length: 3}, () => s.readVInt());
  if (s.readBoolean()) {value.display = display(s); value.name = value.display.name;}
  value.last = s.readVInt(); value.name ||= value.strings.find(Boolean) || null;
  return value;
}
function friends(bytes) {
  let last;
  for (const flagCount of [2, 1]) {
    try {
      const s = stream(bytes); const result = {version: s.readInt(), flags: Array.from({length: flagCount}, () => s.readBoolean())};
      const n = s.readInt(); if (n < -1 || n > 10000) throw new Error('Неверное число друзей');
      result.friends = Array.from({length: Math.max(0, n)}, () => friend(s));
      if (s.remaining()) throw new Error('Лишние данные списка друзей'); return result;
    } catch (error) {last = error;}
  }
  throw last;
}
function friendUpdate(bytes) {const s = stream(bytes); const added = s.readBoolean(); return {added, friend: friend(s)};}
function clubOnline(bytes) {
  const s = stream(bytes), result = {onlineCount: s.readVInt(), total: s.readVInt()};
  result.players = Array.from({length: count(s)}, () => {
    const player = {...id(s), status: s.readVInt(), extra: s.readVInt()};
    if (s.readBoolean()) player.details = [s.readVInt(), s.readVInt(), s.readVInt()];
    if (s.readVInt() > 0) player.league = [s.readVInt(), s.readVInt(), s.readVInt()];
    player.last = s.readVInt(); return player;
  });
  return result;
}
function leaderboard(bytes) {
  const s = stream(bytes);
  const result = {type: s.readVInt(), category: s.readVInt(), brawler: readReference(s), country: s.readOptionalString()};
  result.entries = Array.from({length: count(s, 10000)}, () => {
    const value = {};
    if (s.readBoolean()) value.club = {name: s.readString(), field: s.readVInt(), badge: readReference(s)};
    value.fields = [s.readVInt(), s.readVInt()];
    if (s.readBoolean()) {value.clubName = s.readString(); value.display = display(s); value.name = value.display.name;}
    value.position = s.readVInt();
    if (s.readBoolean()) Object.assign(value, id(s));
    value.last = s.readVInt(); value.score = value.last; return value;
  });
  result.extra = Array.from({length: 4}, () => s.readVInt()); result.extraString = s.readString();
  if (s.remaining()) throw new Error('Лишние данные рейтинга'); return result;
}
function invitation(type, bytes) {
  const s = stream(bytes);
  if (type === 24589) return {type: s.readVInt(), team: id(s), inviter: friend(s)};
  return {status: s.readInt(), player: id(s), text: s.readString()};
}
function friendPresence(bytes) {
  const s = stream(bytes); const value = id(s); value.online = s.readBoolean();
  if (value.online) {value.player = id(s); value.status = s.readVInt();}
  return value;
}
function matchmaking(bytes) {
  // Native 20405: five BE int32 values and one packed boolean, not VInts.
  if (bytes.length !== 21 || bytes[20] > 1) throw new Error('Неверный формат прогресса подбора 20405');
  const s = stream(bytes), fields = Array.from({length: 5}, () => s.readInt());
  const found = fields[1], required = fields[2];
  if (found < 0 || required < 0 || found > required) throw new Error('Неверный счётчик игроков подбора');
  return {found, required, progress: required > 0 ? `${found}/${required}` : null, fields, flag: s.readBoolean()};
}
module.exports = {recommendedClubs, matchmaking, friendPresence, leaderboard, invitation, clubOnline, stream, club, team, clubMember, friends, friendUpdate};

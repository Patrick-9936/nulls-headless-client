const Protocol = require('./Protocol');
const Decode = require('./Decode');
const ByteStream = require('../DataStream/ByteStream');

const commands = ['login', 'create-account', 'account-region', 'accept-friend', 'remove-friend', 'decline-friend', 'friend', 'friends', 'friends-online', 'spectate', 'brawl-tv', 'brawl-tv-channels', 'brawl-tv-next', 'stop-spectate',
  'create-club', 'join-club', 'leave-club', 'club-info', 'club-recommendations', 'club-members', 'club-online', 'club-chat', 'club-stream', 'club-requests',
  'club-settings', 'club-description', 'club-trophies', 'club-role', 'club-promote', 'club-demote', 'club-kick',
  'club-invite', 'club-request', 'club-answer', 'create-room', 'join-room', 'leave-room', 'team-info', 'chat',
  'ready', 'unready', 'matchmake', 'cancel-matchmake', 'team-brawler', 'team-mode', 'team-map', 'team-event', 'team-location', 'team-invite', 'team-answer', 'invite-answer', 'accept-invite', 'decline-invite',
  'team-request', 'team-cancel-request', 'team-request-answer', 'team-cancel-invite', 'team-kick', 'team-advertise', 'team-status', 'invitations', 'team-bot', 'practice', 'player-status', 'top'];
const sameRef = (a, b) => !!(a && b && a.class === b.class && a.index === b.index);
const same = (a, b) => !!(a && b && a.hi === b.hi && a.lo === b.lo);
const experimental = ['club-invite', 'team-advertise', 'practice', 'player-status', 'team-answer', 'brawl-tv', 'brawl-tv-channels', 'brawl-tv-next'];
const echo = value => {const s = new ByteStream(); s.writeRequiredString(value); return s.getBytes();};

async function clubInfo(client, args) {
  const target = Protocol.target(args.clubTag || client.club || client.account.club);
  await client.request('club-info', {clubTag: target}, {types: [24301], check: p => same(Decode.club(p.type, p.payload), target)});
  return client.clubInfo;
}
async function execute(client, command, args = {}) {
  if (!commands.includes(command)) throw new Error(`Неизвестная команда ${command}`);
  if (experimental.includes(command) && !args.experimental) throw new Error('Формат пакета восстановлен, результат не проверен; для этой команды требуется --experimental');
  if (command === 'brawl-tv') return require('./BrawlTV').start(client,args);
  if (command === 'brawl-tv-channels') return require('./BrawlTV').getChannels(client,args);
  if (command === 'brawl-tv-next') return require('./BrawlTV').getNext(client,args);
  if (command === 'club-recommendations') {
    let clubs;
    const result = await client.request(command, args, {types: [24304], errors: [24320, 24332], timeout: args.timeout,
      check: packet => {clubs = Decode.recommendedClubs(packet.payload); return true;}});
    return {...result, source: 'server-recommendations', clubs};
  }
  if (['login', 'create-account'].includes(command)) return {confirmed: true, account: publicAccount(client)};
  if (command === 'decline-friend') return {...await execute(client, 'remove-friend', args), command};
  if (['accept-invite', 'decline-invite'].includes(command)) return {...await execute(client, 'invite-answer', {...args, accept: command === 'accept-invite'}), command};
  if (['club-stream', 'club-requests'].includes(command)) {
    if (args.refresh) await client.reconnect();
    if (!client.clubStreamReady) await client.wait([24311], () => client.clubStreamReady, [], args.timeout || 10000).promise;
    if (client.clubStreamError) throw new Error(client.clubStreamError);
    return {confirmed: true, entries: (client.clubStream || []).filter(e => command !== 'club-requests' || (e.type === 3 && e.state === 1))};
  }
  if (command === 'club-request') {
    Protocol.text(args.text, 'text');
    const club = Protocol.target(args.clubTag);
    const owner = [...(client.peers?.values() || [])].find(peer => same(peer.club, club));
    const existing = owner?.clubStream?.findLast(e => e.type === 3 && e.state === 1 && same(e.player, client.account));
    if (existing) return {command, confirmed: true, alreadyPending: true, entry: existing};
    const wait = owner?.wait([24312], () => owner.clubStream?.some(e => e.type === 3 && e.state === 1 && same(e.player, client.account) && e.text === args.text), [], args.timeout || 10000);
    let response;
    try {
      response = await client.request(command, args, {types: [24333], errors: [24332], timeout: args.timeout});
      const code = client.clubResponse?.code;
      if (code === 52) {wait?.cancel(new Error('Заявка уже существует')); return {command, confirmed: false, alreadyPending: true, response: response.response, code, note: 'Сервер сообщает существующую заявку. Её текст проверяется владельцем через club-requests'};}
      if (code !== 50) throw new Error(`Сервер не подтвердил отправку заявки: ${code}`);
      if (wait) await wait.promise;
    } catch (error) {wait?.cancel(error); throw error;}
    return {...response, stage: 'pending', textVerified: !!wait, entry: owner?.clubStream?.findLast(e => e.type === 3 && same(e.player, client.account) && e.text === args.text),
      note: wait ? undefined : 'Сервер подтвердил отправку заявки кодом 50. Текст и ID записи доступны владельцу через club-requests'};
  }
  if (command === 'club-answer') {
    await execute(client, 'club-stream', args);
    const who = args.tag ? Protocol.target(args.tag) : null;
    const id = typeof args.entryId === 'string' ? (() => {const [hi,lo] = args.entryId.split(':').map(Number); return {hi,lo};})() : args.entryId;
    const entry = client.clubStream.findLast(e => e.type === 3 && e.state === 1 && (id ? same(e.entryId, id) : same(e.player, who)));
    if (!entry) throw new Error('Нет ожидающей заявки: укажите --tag игрока или --entry-id hi:lo');
    const result = await client.request(command, {...args, entryId: entry.entryId}, {types: [24312], timeout: args.timeout, check: () => client.clubStream.some(e => same(e.entryId, entry.entryId) && e.state === (args.accept ? 2 : 3))});
    if (args.accept && !(await clubInfo(client, {})).members?.some(m => same(m, entry.player))) throw new Error('Заявка одобрена, но членство игрока пока не подтверждено');
    return {...result, entry: client.clubStream.find(e => same(e.entryId, entry.entryId))};
  }
  if (command === 'account-region') {
    const region = require('../data/regions.json').find(r => r.Name === String(args.region).toUpperCase() || r.reference === String(args.region) || r.index === Number(args.region));
    if (!region) throw new Error('Выберите регион из каталога regions');
    const result = await client.request(command, {region: region.reference}, {types: [24178], timeout: args.timeout});
    if (client.regionResult?.code !== 0 || client.regionResult?.region?.class !== 14 || client.regionResult?.region?.index !== region.index) throw new Error(`Сервер не подтвердил регион: ${JSON.stringify(client.regionResult)}`);
    return {...result, region: client.regionResult.region, country: region.Name};
  }
  if (['team-request', 'team-cancel-request', 'team-request-answer'].includes(command)) {
    const requester = command === 'team-request-answer' ? Protocol.target(args.tag) : client.account;
    const owner = command === 'team-request-answer' ? client : [...(client.peers?.values() || [])].find(p => (args.tag || client.requestOwner) && same(p.account, Protocol.target(args.tag || client.requestOwner)));
    const present = () => owner.team?.requests?.some(r => same(r.player, requester));
    if (command === 'team-request' && owner) {
      const wait = owner.wait([24124], present, [], args.timeout || 10000);
      const packet = Protocol.encode(command, args); client.messaging.send(packet.id, packet.payload, packet.version);
      await wait.promise; client.requestOwner = owner.account; return {command, confirmed: true, request: owner.team.requests.find(r => same(r.player, requester))};
    }
    if (command === 'team-cancel-request' && owner) {
      if (!present()) throw new Error('Нет ожидающей заявки в лобби');
      const wait = owner.wait([24124], () => !present(), [], args.timeout || 10000);
      const packet = Protocol.encode(command, args); client.messaging.send(packet.id, packet.payload, packet.version);
      await wait.promise; client.requestOwner = null; return {command, confirmed: true, cancelled: true};
    }
    if (command !== 'team-request-answer' && !owner) {
      const packet = Protocol.encode(command, args); await new Promise((resolve, reject) => client.messaging.send(packet.id, packet.payload, packet.version, error => error ? reject(error) : resolve()));
      if (command === 'team-request') client.requestOwner = Protocol.target(args.tag);
      return {command, confirmed: false, note: 'Отправлено. Подтверждение появления/удаления заявки доступно владельцу лобби; fleet проверяет его через второго онлайн-бота'};
    }
    if (command === 'team-request-answer') {
      if (!present()) throw new Error('Нет ожидающей заявки от игрока');
      const result = await client.request(command, args, {types: [24124], errors: [24129], timeout: args.timeout, check: () => !present() && (!args.accept || client.team.members?.some(m => same(m, requester)))});
      return {...result, accepted: !!args.accept, team: client.team};
    }
  }
  if (command === 'team-invite') {
    if (!client.team?.members) throw new Error('Сначала создайте лобби');
    const who = Protocol.target(args.tag);
    await execute(client, 'friends');
    let allowed = client.friends.some(friend => same(friend, who) && friend.relationship === 4);
    if (!allowed && client.club) allowed = (await clubInfo(client, {})).members?.some(member => same(member, who));
    if (!allowed) throw new Error('Игрок должен принять дружбу или состоять в вашем клубе');
    const receiver = [...(client.peers?.values() || [])].find(peer => same(peer.account, who));
    const incoming = receiver?.wait([24589], () => receiver.invitations?.some(inv => same(inv.team, client.team)), [], args.timeout || 10000);
    let result;
    try {result = await client.request(command, args, {types: [24124], errors: [24129], timeout: args.timeout,
      check: () => client.team?.pendingInvites?.some(invite => same(invite.player, who)) || client.team?.members?.some(member => same(member, who))});
      if (incoming) await incoming.promise;
    } catch (error) {incoming?.cancel(error); throw error;}
    return {...result, delivered: !!incoming, stage: 'invited', team: client.team};
  }
  if (command === 'team-cancel-invite') {
    const who = Protocol.target(args.tag);
    if (!client.team?.pendingInvites?.some(inv => same(inv.player, who))) throw new Error('Нет ожидающего приглашения этому игроку');
    const result = await client.request(command, args, {types: [24124], errors: [24129], timeout: args.timeout, check: () => !client.team?.pendingInvites?.some(inv => same(inv.player, who))});
    return {...result, cancelled: true, team: client.team};
  }
  if (command === 'invite-answer') {
    const incoming = (client.invitations || []).slice().reverse().find(inv => inv.team && (!args.tag || same(inv.inviter, Protocol.target(args.tag))));
    const team = args.team || (args.code ? require('../utils/TeamCode').decode(args.code) : incoming?.team);
    if (!team) throw new Error('Нет входящего приглашения; укажите --code из приглашения');
    if (args.accept) {
      const result = await client.request(command, {...args, team}, {types: [24124], errors: [24129], timeout: args.timeout, check: () => same(client.team, team)});
      client.invitations = client.invitations.filter(inv => !same(inv.team, team));
      return {...result, team: client.team};
    }
    const owner = [...(client.peers?.values() || [])].find(peer => same(peer.team, team) && peer.team?.pendingInvites?.some(inv => same(inv.player, client.account)));
    const waiter = owner?.wait([24124], () => same(owner.team, team) && !owner.team.pendingInvites?.some(inv => same(inv.player, client.account)), [], args.timeout || 10000);
    const packet = Protocol.encode(command, {...args, team}); client.messaging.send(packet.id, packet.payload, packet.version);
    if (waiter) await waiter.promise;
    client.invitations = client.invitations.filter(inv => !same(inv.team, team));
    return {command, confirmed: !!waiter, stage: 'declined', note: waiter ? undefined : 'Отказ отправлен; подтверждение удаления заявки доступно на стороне владельца лобби'};
  }
  if (['team-mode', 'team-map'].includes(command)) {
    const maps = require('./Store').read(require('node:path').join(client.root, 'data/maps.json'), []);
    const candidates = maps.filter(map => (!args.mode || map.mode.toLowerCase() === args.mode.toLowerCase()) && (!args.map || map.name.toLowerCase() === args.map.toLowerCase()));
    const map = args.location ? maps.find(map => map.index === Number(String(args.location).split(':').pop())) : candidates[0];
    if (!map || (!args.mode && !args.map && !args.location)) throw new Error('Укажите --mode, --map или --location из каталога modes');
    if (args.mode && map.mode.toLowerCase() !== args.mode.toLowerCase()) throw new Error('Карта не соответствует выбранному режиму');
    const result = await execute(client, 'team-location', {...args, location: map.reference});
    return {...result, command, map};
  }
  if (command === 'stop-spectate') {
    if (!client.battle) throw new Error('Нет подтверждённого наблюдения/боя в этой сессии');
    const packet = Protocol.encode(command, args); client.messaging.send(packet.id, packet.payload, packet.version);
    await client.reconnect(); client.battle = null;
    return {confirmed: true, method: 'stop-request-and-reconnect', account: publicAccount(client)};
  }
  if (['ready', 'matchmake'].includes(command) && client.team?.type === 0 && client.team.members) {
    const fighters = client.team.members.map(m => m.brawler?.index).filter(n => n !== undefined);
    if (new Set(fighters).size !== fighters.length) throw new Error('Обычный подбор требует разных бойцов у участников команды (ошибка сервера 17)');
  }
  if (command === 'invitations') return {confirmed: true, invitations: client.invitations || []};
  if (command === 'team-info') {
    if (!client.team) throw new Error('Сервер ещё не сообщил состояние команды');
    return {confirmed: true, team: client.team};
  }
  if (['club-info', 'club-members', 'club-online'].includes(command)) {
    const club = await clubInfo(client, args);
    if (command === 'club-members') {
      if (!club.members) throw new Error(club.parseWarning || 'Ответ не содержит список участников');
      return {confirmed: true, members: club.members};
    }
    if (command === 'club-online') return {confirmed: true, club, online: client.clubOnline || null,
      note: client.clubOnline ? undefined : 'Сервер не прислал данные присутствия; наличие участника не означает онлайн'};
    return {confirmed: true, club};
  }
  if (['club-settings', 'club-description', 'club-trophies'].includes(command)) {
    const current = await clubInfo(client, args);
    if (!current.complete || current.description === undefined) throw new Error('Не удалось прочитать настройки; изменение отменено');
    if (!same(current, client.club)) throw new Error('Изменять можно только свой клуб');
    const settings = {...current};
    for (const key of ['description', 'badge', 'region', 'type', 'requiredTrophies', 'familyFriendly']) if (args[key] !== undefined) settings[key] = args[key];
    settings.type = Protocol.integer(settings.type, 'club-type', 1, 3);
    settings.requiredTrophies = Protocol.integer(settings.requiredTrophies, 'required-trophies', 0, 1000000);
    settings.region ||= require('../data/regions.json').find(r => r.Name === current.secondaryName)?.reference || client.clubSettingsRegion || client.config.defaultClubRegion || {class: 14, index: 125};
    const ref = (value, cls) => typeof value === 'object' ? value : {class: cls, index: Number(String(value).split(':').pop())};
    settings.badge = ref(settings.badge, 8); settings.region = ref(settings.region, 14);
    const country = require('../data/regions.json').find(r => r.index === settings.region.index)?.Name;
    const matches = () => ['description', 'type', 'requiredTrophies', 'familyFriendly'].every(key => settings[key] === client.clubInfo[key]) && sameRef(settings.badge, client.clubInfo.badge) && (sameRef(settings.region, client.clubInfo.region) || (country && client.clubInfo.secondaryName === country));
    const message = Protocol.encode('club-settings', {settings});
    client.messaging.send(message.id, message.payload, message.version);
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      await clubInfo(client, {clubTag: current});
      if (matches()) break;
    }
    for (const key of ['description', 'type', 'requiredTrophies', 'familyFriendly']) {
      if (settings[key] !== client.clubInfo[key]) throw new Error(`Сервер не подтвердил настройку ${key}`);
    }
    if (!matches()) throw new Error('Сервер не подтвердил эмблему/регион клуба');
    client.clubSettingsRegion = settings.region;
    return {confirmed: true, club: client.clubInfo};
  }
  if (['club-promote', 'club-demote', 'club-role'].includes(command)) {
    const current = await clubInfo(client, args); const who = Protocol.target(args.tag);
    const member = current.members?.find(m => same(m, who));
    if (!member) throw new Error('Участник не найден в ответе клуба');
    const order = [1, 3, 4, 2];
    const role = command === 'club-role' ? Protocol.roles[args.role] ?? Number(args.role)
      : order[order.indexOf(member.role) + (command === 'club-promote' ? 1 : -1)];
    if (!role) throw new Error('Участник уже имеет крайнюю роль');
    if (role === 2 && args.role !== 'president' && Number(args.role) !== 2) throw new Error('Передача президентства требует явного --role president');
    const message = Protocol.encode('club-role', {...args, role}); client.messaging.send(message.id, message.payload, message.version);
    await clubInfo(client, {clubTag: current});
    const changed = client.clubInfo.members?.find(m => same(m, who));
    if (changed?.role !== role) throw new Error('Сервер не подтвердил изменение роли');
    return {confirmed: true, member: changed};
  }
  if (['friend', 'accept-friend', 'remove-friend'].includes(command)) {
    const who = Protocol.target(args.tag);
    const result = await client.request(command, args, {types: [20106], errors: [20112], check: p => {
      const s = Decode.stream(p.payload); s.readBoolean(); const matches = same(s.readLong(), who);
      return matches && (command !== 'accept-friend' || Decode.friendUpdate(p.payload).friend.relationship === 4);
    }});
    if (command === 'remove-friend') {
      await client.request('friends', {}, {types: [20105]});
      if (client.friends?.some(f => same(f, who))) throw new Error('Серверный список всё ещё содержит друга');
      return {...result, removed: who};
    }
    const friend = client.friends?.find(f => same(f, who));
    if (command === 'accept-friend' && friend?.relationship !== 4) throw new Error('Принятие заявки не подтверждено состоянием дружбы');
    if (command === 'remove-friend' && friend) throw new Error('Друг всё ещё присутствует в ответе сервера');
    return {...result, friend, note: command === 'friend' ? 'Запись игрока обновлена; принятие заявки проверяется отдельно' : undefined};
  }
  if (['friends', 'friends-online'].includes(command)) {
    await client.request('friends', args, {types: [20105]});
    if (!client.friends) throw new Error(client.friendParseError || 'Список друзей не разобран');
    return {confirmed: true, friends: command === 'friends-online' ? client.friends.filter(f => f.online === true) : client.friends,
      unknownPresence: client.friends.filter(f => f.online === undefined).length};
  }
  if (command === 'player-status') {
    const observer = [...(client.peers?.values() || [])].find(peer => peer.friends?.some(f => same(f, client.account) && f.relationship === 4));
    if (!observer) throw new Error('Проверка статуса требует онлайн-друга в том же fleet');
    const wait = observer.wait([24555], p => {const value = Decode.friendPresence(p.payload); return same(value, client.account) && value.status === Number(args.status);}, [], args.timeout || 10000);
    const packet = Protocol.encode(command, args); client.messaging.send(packet.id, packet.payload, packet.version);
    await wait.promise; return {command, confirmed: true, presence: observer.friendPresence.get(publicAccount(client).tag)};
  }
  if (command === 'team-bot') {
    const slot = Protocol.integer(args.slot, 'slot', 0, 9);
    if (client.team?.type !== 1 || slot >= client.team.maxMembers) throw new Error('Встроенные боты доступны в пустых слотах дружеского лобби');
  }
  const expected = {
    'create-club': [24399], 'join-club': [24399], 'leave-club': [24399], 'club-stream': [24311],
    'club-chat': [24312, 24311], 'club-kick': [24309], 'club-invite': [24322], 'club-request': [24319], 'club-answer': [24312, 24399],
    'create-room': [24124], 'join-room': [24124], 'leave-room': [24125], 'chat': [24131],
    'cancel-matchmake': [20406, 24101], 'team-brawler': [24124], 'ready': [24124], 'unready': [24124], 'matchmake': [20405, 20559, 24112],
    'team-event': [24124], 'team-location': [24124], 'team-invite': [24582, 24589], 'team-answer': [24124, 24125],
    'invite-answer': [24124, 24125], 'team-cancel-invite': [24582, 24589], 'team-kick': [24124],
    'team-request': [24589, 24582, 24124], 'team-cancel-request': [24589, 24582, 24124], 'team-request-answer': [24589, 24582, 24124],
    'team-advertise': [24124, 24312], 'team-status': [24124], 'team-bot': [24124], 'practice': [20559, 24112, 20405],
    'player-status': [24555, 24364, 20199, 24124], 'top': [24403], 'spectate': [20559, 20405, 24112], 'stop-spectate': [24101]
  };
  const types = expected[command]; const request = command === 'matchmake' ? 'ready' : command;
  const target = args.clubTag ? Protocol.target(args.clubTag) : null;
  const own = m => same(m, client.account);
  const check = p => {
    if (command === 'join-club') return same(client.club, target);
    if (command === 'create-club') return client.club?.name === args.clubName;
    if (command === 'leave-club') return !client.club;
    if (command === 'join-room') return client.team?.code === String(args.code).toUpperCase();
    if (command === 'leave-room') return p.payload.length >= 4 && p.payload.readInt32BE(0) === 0;
    if (['chat', 'club-chat'].includes(command)) return p.payload.includes(echo(args.text));
    if (['ready', 'unready'].includes(command)) return client.team?.members?.find(own)?.ready === (command === 'ready');
    if (command === 'team-kick') return !!client.team?.members && !client.team.members.some(m => same(m, Protocol.target(args.tag)));
    if (command === 'club-kick') {const s = Decode.stream(p.payload); s.readLong(); return same(s.readLong(), Protocol.target(args.tag));}
    if (command === 'team-brawler') return client.team?.members?.find(own)?.brawler?.index === Number(String(args.brawler).split(':').pop());
    if (command === 'team-event') return client.team?.event === Number(args.event) && client.team?.eventSlot === Number(args.slot ?? 0);
    if (command === 'team-status') return client.team?.members?.find(own)?.status === Number(args.status);
    if (command === 'team-bot') return Array.isArray(client.team?.disabledSlots) && client.team.disabledSlots.includes(Number(args.slot)) === !!args.disabled;
    if (command === 'team-location') return client.team?.location?.index === Number(String(args.location).split(':').pop());
    return true;
  };
  const result = await client.request(request, args, {types, check, errors: [20112, 24105, 24129, 24320, 24321, 24332], timeout: args.timeout});
  result.command = command;
  if (command === 'matchmake') {result.stage = result.response === 20405 ? 'queued' : 'loading'; result.matchmaking = client.matchmaking || null;}
  if (['team-invite', 'team-request', 'team-cancel-request', 'team-request-answer', 'club-invite', 'team-advertise', 'practice', 'player-status', 'team-answer', 'invite-answer', 'team-cancel-invite'].includes(command)) {
    result.confirmed = false; result.note = 'Ответ протокола получен; конечный результат этой функции ещё не проверен';
  }
  if (command === 'top') {if (!client.leaderboard) throw new Error('Не удалось разобрать ответ рейтинга'); return {...result, leaderboard: client.leaderboard};}
  if (['create-club', 'join-club'].includes(command)) return {...result, club: client.club};
  if (['create-room', 'join-room', 'ready', 'unready', 'team-location', 'team-event', 'team-status', 'team-bot'].includes(command)) return {...result, team: client.team};
  return result;
}
function publicAccount(client) {
  return {tag: client.account.lo ? require('../utils/TagCodec').logicLongToTag(client.account.hi, client.account.lo) : null,
    name: client.account.name || null, club: client.club, team: client.team, state: client.state};
}
module.exports = {execute, commands, experimental, publicAccount, same};

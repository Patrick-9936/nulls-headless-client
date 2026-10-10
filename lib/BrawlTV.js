const Decode = require('./Decode'), Protocol = require('./Protocol');

function input(bytes) {
  if (bytes.length > 65536) throw new Error('Слишком большой ответ Brawl TV');
  return Decode.stream(bytes);
}
function end(s) {if (s.remaining()) throw new Error('Неизвестный хвост Brawl TV');}
function channels(bytes) {
  const s = input(bytes), length = s.readVInt();
  if (length < 0 || length > 128) throw new Error('Неверное число каналов Brawl TV');
  const items = Array.from({length}, () => ({id: s.readVInt(), title: s.readString(), description: s.readString()}));
  end(s);
  if (items.some(item => item.id < 0) || new Set(items.map(item => item.id)).size !== length) throw new Error('Неверные ID каналов Brawl TV');
  return items;
}
function nextUp(bytes) {
  const s = input(bytes), result = {channel: s.readVInt(), marker: s.readVInt(), live: s.readBoolean()};
  if (result.channel < 0) throw new Error('Неверный ID канала Brawl TV');
  if (result.live) {
    result.player = s.readLong();
    result.available = (result.player.hi !== 0 || result.player.lo !== 0) && !(result.player.hi === 0xffffffff && result.player.lo === 0xffffffff);
    if (result.available) result.player.tag = require('../utils/TagCodec').logicLongToTag(result.player.hi,result.player.lo);
  } else {result.stream = s.readString(); result.available = !!result.stream;}
  end(s); return result;
}
async function getChannels(client, args = {}) {
  let decoded;
  const result = await client.request('brawl-tv-channels', args, {types:[24700],timeout:args.timeout,
    check:p=>{decoded=channels(p.payload);return true;}});
  return {...result,channels:decoded};
}
async function getNext(client, args = {}) {
  const channel = Protocol.integer(args.channel,'channel'); let decoded;
  const result = await client.request('brawl-tv-next', {...args,channel}, {types:[24701],timeout:args.timeout,
    check:p=>{const value=nextUp(p.payload);if(value.channel!==channel)return false;decoded=value;return true;}});
  return {...result, broadcast:decoded};
}
async function start(client, args = {}) {
  let player = args.tag ? Protocol.target(args.tag) : null, broadcast = null;
  if (!player) {
    const channel = args.channel !== undefined ? Protocol.integer(args.channel,'channel') : (await getChannels(client,args)).channels[0]?.id;
    if (channel === undefined) throw new Error('Сервер не сообщил доступных каналов Brawl TV');
    broadcast=(await getNext(client,{...args,channel})).broadcast;
    if (!broadcast.available) throw new Error('В выбранном канале Brawl TV сейчас нет трансляции');
    if (!broadcast.live) return {command:'brawl-tv',confirmed:false,stage:'external-stream',broadcast,note:'Сервер вернул URL трансляции; воспроизведение видео в headless-клиенте не реализовано'};
    player=broadcast.player;
  }
  const result = await client.request('brawl-tv', {...args,tag:player}, {types:[20559,24112],errors:[24105,24129],timeout:args.timeout,
    check:p=>p.payload.length>0});
  return {...result,mode:'brawl-tv',stage:'loading',player,broadcast,
    note:'Сервер прислал загрузку. Получение кадров проверяется отдельно через --battle-transport udp; графического плеера нет'};
}
module.exports = {channels,nextUp,getChannels,getNext,start};

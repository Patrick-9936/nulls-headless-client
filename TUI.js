#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {createInterface}=require('node:readline/promises'),{spawn}=require('node:child_process');
const Client=require('./lib/Client'),Actions=require('./lib/Actions'),Store=require('./lib/Store');
const ROOT=__dirname,VERSION=require('./package.json').version;
const clean=v=>String(v??'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');
const publicJSON=v=>JSON.stringify(v,(k,x)=>/passToken|password|secret|deviceId|androidId|idForVendor|openDeviceId|license|loginClientSeed/i.test(k)?'[скрыто]':x,2);
class Exit extends Error{} class Cancel extends Error{}
const tag=['tag','тег игрока (#...)','text',undefined,true],clubTag=['clubTag','тег клуба (#...)','text',undefined,true];
const text=['text','текст','text',undefined,true],code=['code','код лобби','text',undefined,true];
const decision=['accept','решение','choice',[{label:'принять / одобрить',value:true},{label:'отклонить',value:false}],true];
const commands={
 'account-region':['регион аккаунта',[['region','регион','regions',undefined,true]]],
 'friend':['отправить заявку в друзья',[tag]],'accept-friend':['принять заявку в друзья',[tag]],
 'decline-friend':['отклонить заявку в друзья',[tag]],'remove-friend':['удалить друга',[tag]],
 'friends':['все друзья',[]],'friends-online':['друзья в сети',[]],
 'spectate':['наблюдать за игроком',[tag]],'stop-spectate':['выйти из наблюдения',[]],
 'brawl-tv':['открыть brawl tv',[]],'brawl-tv-channels':['каналы brawl tv',[]],
 'brawl-tv-next':['следующая трансляция',[['channel','номер канала','tv-channel',undefined,true]]],
 'create-club':['создать клуб',[['clubName','название клуба','text',undefined,true]]],
 'join-club':['вступить в клуб',[clubTag]],'leave-club':['выйти из клуба',[]],
 'club-info':['информация о клубе',[['clubTag','тег клуба (пусто — свой)','text']]],
 'club-recommendations':['рекомендованные сервером клубы',[]],
 'club-members':['участники клуба',[]],'club-online':['участники клуба в сети',[]],
 'club-chat':['сообщение в чат клуба',[text]],'club-stream':['лента клуба',[]],'club-requests':['заявки в клуб',[]],
 'club-request':['отправить заявку в клуб',[clubTag,text]],'club-answer':['ответить на заявку в клуб',[tag,decision]],
 'club-description':['описание клуба',[['description','описание (можно пустое)','empty','',true]]],
 'club-trophies':['трофеи для входа',[['requiredTrophies','порог трофеев','number',0,true]]],
 'club-settings':['настройки клуба',[
 ['description','новое описание (пусто — оставить)','text'],
 ['type','тип клуба','choice',[{label:'открытый',value:1},{label:'по заявкам',value:2},{label:'закрытый',value:3}]],
 ['requiredTrophies','новый порог трофеев','number'],['badge','эмблема','badges'],['region','регион','regions'],
 ['familyFriendly','семейный клуб','choice',[{label:'да',value:true},{label:'нет',value:false}]]]],
 'club-role':['назначить роль участнику',[tag,['role','роль','choice',[
 {label:'участник',value:'member'},{label:'старейшина',value:'senior'},{label:'вице-президент',value:'vice'},{label:'президент',value:'president'}],true]]],
 'club-promote':['повысить участника',[tag]],'club-demote':['понизить участника',[tag]],
 'club-kick':['исключить участника',[tag,['text','причина (необязательно)','text']]],'club-invite':['пригласить в клуб',[tag]],
 'create-room':['создать лобби',[['type','тип лобби','choice',[{label:'обычная команда',value:0},{label:'дружеский бой',value:1}],true]]],
 'join-room':['войти в лобби',[code]],'leave-room':['выйти из лобби',[]],'team-info':['состояние лобби',[]],
 'chat':['сообщение в чат лобби',[text]],'team-invite':['пригласить друга / соклубника',[tag]],
 'team-cancel-invite':['отменить приглашение',[tag]],'invitations':['входящие приглашения',[]],
 'accept-invite':['принять приглашение',[['code','код (пусто — входящее)','text']]],
 'decline-invite':['отклонить приглашение',[['code','код (пусто — входящее)','text']]],
 'invite-answer':['ответить на приглашение',[['code','код (пусто — входящее)','text'],decision]],
 'team-answer':['старый ответ на приглашение',[['response','код ответа','number',0,true],['extra','дополнительное поле','number',0,true]]],
 'team-request':['запросить вход в лобби',[tag,code]],'team-cancel-request':['отменить запрос входа',[]],
 'team-request-answer':['ответить на запрос входа',[tag,decision]],'team-kick':['исключить из лобби',[tag]],
 'team-map':['выбрать карту',[['location','карта','maps',undefined,true]]],
 'team-mode':['выбрать режим',[['mode','режим','modes',undefined,true]]],
 'team-location':['карта и модификаторы',[['location','карта','maps',undefined,true],['modifiers','модификаторы через запятую (необязательно)','numbers']]],
 'team-event':['выбрать событие',[['event','ID события','number',undefined,true],['slot','слот','number',0,true],['modifier','модификатор','number',0,true]]],
 'team-status':['статус в лобби',[['status','числовой статус','number',0,true]]],
 'team-bot':['встроенный бот дружеского боя',[['slot','слот 0–9','number',0,true],['disabled','состояние','choice',[{label:'отключить',value:true},{label:'включить',value:false}],true]]],
 'team-advertise':['реклама команды',[['type','тип','number',0,true]]],
 'ready':['нажать «готово»',[]],'unready':['снять готовность',[]],'matchmake':['начать подбор',[]],
 'cancel-matchmake':['выйти из подбора',[]],'practice':['тренировка',[]],
 'player-status':['статус игрока',[['status','статус','number',0,true],['extra','дополнительное поле','number',0,true]]],
 'team-brawler':['выбор бойца (недоступен)',[]],
 'top':['рейтинг игроков',[['type','тип рейтинга','number',0,true],['local','рейтинг','choice',[{label:'общий',value:false},{label:'местный',value:true}],true],['brawler','ссылка бойца','text','16:0',true],['extra','дополнительное поле','number',0,true]]]
};
const groups=[
 ['аккаунт и соединение',[]],
 ['друзья',['friends','friends-online','friend','accept-friend','decline-friend','remove-friend','account-region','player-status']],
 ['клуб',['club-recommendations','club-info','club-members','club-online','club-stream','club-requests','create-club','join-club','leave-club','club-chat','club-request','club-answer','club-description','club-trophies','club-settings','club-role','club-promote','club-demote','club-kick','club-invite']],
 ['лобби и приглашения',['create-room','join-room','leave-room','team-info','chat','team-invite','invitations','accept-invite','decline-invite','invite-answer','team-request','team-cancel-request','team-request-answer','team-cancel-invite','team-kick','team-status','team-advertise','team-answer']],
 ['карты и подбор',['team-mode','team-map','team-location','team-event','team-bot','team-brawler','ready','unready','matchmake','cancel-matchmake','practice']],
 ['наблюдение и brawl tv',['spectate','stop-spectate','brawl-tv','brawl-tv-channels','brawl-tv-next']],
 ['рейтинг',['top']],['инструкция и утилиты',[]]
];
class App {
 constructor(root=ROOT,deps={}) {
  this.root=root;this.Client=deps.Client||Client;this.execute=deps.execute||Actions.execute;
  this.sessions=new Map();this.active=null;this.logs=[];this.closing=false;this.refresh=null;this.abort=null;this.child=null;
  this.connection={battleTransport:'udp',reconnect:true};this.previousDebugger=global.Debugger;
  this.features=Store.read(path.join(root,'docs/features.json'),{commands:[]});
 }
 log(v){this.logs.push(clean(v).replace(/\n/g,' ').slice(0,180));if(this.logs.length>3)this.logs.shift();this.refresh?.();}
 context(){const c=this.active;return c?clean((c.account.name||'без имени')+' '+(c.account.lo?require('./utils/TagCodec').logicLongToTag(c.account.hi,c.account.lo):'')+' · '+c.state+' · сессий '+this.sessions.size):'не подключён · сессий '+this.sessions.size;}
 draw(title,items,index=0){
  const height=Math.max(5,(process.stdout.rows||24)-10),start=Math.max(0,Math.min(index-Math.floor(height/2),items.length-height));
  process.stdout.write('\x1b[2J\x1b[HNulls '+VERSION+' · tui\n'+this.context()+'\n\n'+clean(title)+'\n');
  items.slice(start,start+height).forEach((item,n)=>process.stdout.write((start+n===index?'>':' ')+' '+clean(item.label??item)+'\n'));
  process.stdout.write('\n'+(items.length?(index+1)+'/'+items.length+' · ':'')+'↑↓ Enter · Esc/Q назад · Ctrl+C выход\n');
  for(const log of this.logs)process.stdout.write(clean(log)+'\n');
 }
 choose(title,items){
  if(this.closing)return Promise.reject(new Exit());if(!items.length)return Promise.resolve(null);
  return new Promise((resolve,reject)=>{
   let index=0;const wasRaw=!!process.stdin.isRaw,render=()=>this.draw(title,items,index);
   const done=(v,e)=>{process.stdin.removeListener('keypress',key);process.stdout.removeListener('resize',render);if(process.stdin.isTTY)process.stdin.setRawMode(wasRaw);this.refresh=null;this.abort=null;e?reject(e):resolve(v);};
   const key=(str,k={})=>{
    if(k.ctrl&&k.name==='c')return done(null,new Exit());
    if(k.name==='escape'||k.name==='q')return done(null);
    if(k.name==='up')index=(index+items.length-1)%items.length;
    else if(k.name==='down')index=(index+1)%items.length;
    else if(k.name==='pageup')index=Math.max(0,index-10);
    else if(k.name==='pagedown')index=Math.min(items.length-1,index+10);
    else if(k.name==='home')index=0;else if(k.name==='end')index=items.length-1;
    else if(k.name==='return')return done(items[index].value??items[index]);
    render();
   };
   this.refresh=render;this.abort=()=>done(null,new Exit());
   readline.emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();
   process.stdin.on('keypress',key);process.stdout.on('resize',render);render();
  });
 }
 async prompt(label,fallback,required=false,kind='text'){
  for(;;){
   if(this.closing)throw new Exit();
   process.stdout.write('\x1b[2J\x1b[H'+clean(label)+(fallback!==undefined?' ['+clean(fallback)+']':'')+'\nпусто — значение по умолчанию; /cancel — назад\n');
   const rl=createInterface({input:process.stdin,output:process.stdout}),controller=new AbortController();this.abort=()=>{controller.abort();rl.close();};rl.once('SIGINT',()=>{this.closing=true;this.abort?.();});let answer;
   try{answer=await rl.question('› ',{signal:controller.signal});}catch{throw new Exit();}finally{rl.close();this.abort=null;}
   if(answer==='/cancel')throw new Cancel();
   const value=answer!==''?answer:fallback;
   if(value===undefined&&!required)return undefined;
   if((value===undefined||(kind!=='empty'&&!String(value).trim()))&&required){this.log('нужно заполнить поле');continue;}
   if(value===undefined)return undefined;
   if(kind==='number'){if(!/^-?\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))){this.log('нужно целое число');continue;}return Number(value);}
   if(kind==='numbers'){if(!String(value).trim())return [];const parts=String(value).split(',').map(x=>x.trim());if(parts.some(x=>!/^[-]?\d+$/.test(x))){this.log('введите целые числа через запятую');continue;}return parts.map(Number);}
   return String(value);
  }
 }
 async view(title,value){
  const lines=(typeof value==='string'?clean(value):publicJSON(value)).split('\n'),pages=[],size=Math.max(3,(process.stdout.rows||24)-18);
  for(let n=0;n<lines.length;n+=size)pages.push(lines.slice(n,n+size).join('\n'));
  let page=0;
  for(;;){
   const action=await this.choose(title+'\n\n'+pages[page]+'\n\nстраница '+(page+1)+'/'+pages.length,[
    {label:'назад',value:'back'},...(page>0?[{label:'предыдущая страница',value:'prev'}]:[]),
    ...(page+1<pages.length?[{label:'следующая страница',value:'next'}]:[])]);
   if(!action||action==='back')return;page+=action==='next'?1:-1;
  }
 }
 async fields(id){
  const args={};
  for(const [key,label,kind,defaultValue,required] of commands[id][1]){
   let values;
   if(kind==='choice')values=defaultValue;
   if(kind==='regions')values=Store.read(path.join(this.root,'data/regions.json'),[]).map(r=>({label:r.Name+' · '+(r.DisplayName||''),value:r.reference}));
   if(kind==='badges')values=Store.read(path.join(this.root,'data/club-badges.json'),[]).map(r=>({label:r.Name,value:r.reference}));
   if(kind==='maps')values=Store.read(path.join(this.root,'data/maps.json'),[]).map(r=>({label:r.mode+' · '+r.name,value:r.reference}));
   if(kind==='modes')values=[...new Set(Store.read(path.join(this.root,'data/maps.json'),[]).map(r=>r.mode))].map(value=>({label:value,value}));
   if(kind==='tv-channel'){
    const r=await this.execute(this.active,'brawl-tv-channels',{experimental:true,timeout:15000});
    values=r.channels.map(c=>({label:c.id+' · '+(c.title||'канал'),value:c.id}));
    if(!values.length)throw Error('сервер не сообщил каналов');
   }
   if(values){
    const selected=await this.choose(label,required?values:[{label:'оставить без изменения',value:'__skip__'},...values]);
    if(selected===null)throw new Cancel();if(selected!=='__skip__')args[key]=selected;
   }else{const value=await this.prompt(label,defaultValue,required,kind);if(value!==undefined)args[key]=value;}
  }
  return args;
 }
 attach(file,client){
  this.sessions.set(file,client);this.active=client;for(const c of this.sessions.values())c.peers=this.sessions;
  client.on('state',s=>this.log((client.account.name||path.basename(file))+': '+s.state+(s.error?' · '+s.error:'')));
  client.on('warning',e=>this.log(e.message));client.on('battle-vision',()=>{client.tuiFrames=(client.tuiFrames||0)+1;});
 }
 async connectAccount(file,name){
  file=path.resolve(this.root,file);const saved=Store.read(file,{});
  if(saved.passToken&&!saved.hi&&!saved.lo)throw Error('файл аккаунта не содержит ID');
  if(!saved.passToken&&!name)throw Error('у нового аккаунта нужно задать ник');
  if(this.sessions.has(file)){this.active=this.sessions.get(file);if(this.active.state!=='online')await this.active.connect();return;}
  const client=new this.Client({root:this.root,account:file,...this.connection,...(name?{name}:{})});
  this.attach(file,client);this.log('подключение…');
  try{await client.connect();this.log('вход подтверждён сервером');}
  catch(e){client.close();this.sessions.delete(file);this.active=[...this.sessions.values()].at(-1)||null;throw e;}
 }
 async accounts(){
  for(;;){
   const choice=await this.choose('аккаунт и соединение',[
    {label:'подключить сохранённый аккаунт',value:'load'},{label:'создать один новый аккаунт',value:'new'},
    {label:'переключить активную сессию',value:'switch'},{label:'состояние активного аккаунта',value:'info'},
    {label:'переподключить активный аккаунт',value:'reconnect'},{label:'отключить активный аккаунт',value:'close'},
    {label:'параметры новых подключений',value:'settings'},{label:'назад',value:'back'}]);
   if(!choice||choice==='back')return;
   try{
    if(choice==='load'){
     const files=[];if(fs.existsSync(path.join(this.root,'account.json')))files.push('account.json');
     const dir=path.join(this.root,'accounts');if(fs.existsSync(dir))for(const n of fs.readdirSync(dir).filter(n=>n.endsWith('.json')))files.push('accounts/'+n);
     const picked=await this.choose('выберите аккаунт',[...files.map(value=>({label:value,value})),{label:'указать другой путь',value:'__path__'}]);
     if(!picked)continue;const file=picked==='__path__'?await this.prompt('путь к JSON аккаунта',undefined,true):picked;
     if(!fs.existsSync(path.resolve(this.root,file)))throw Error('файл не найден; для регистрации выберите «создать»');
     await this.connectAccount(file);
    }else if(choice==='new'){
     const file=await this.prompt('файл нового аккаунта','accounts/tui-'+Date.now()+'.json',true);
     if(fs.existsSync(path.resolve(this.root,file)))throw Error('файл уже существует; выберите другое имя');
     await this.connectAccount(file,await this.prompt('ник нового аккаунта',undefined,true));
    }else if(choice==='switch'){
     const file=await this.choose('открытые сессии',[...this.sessions].map(([value,c])=>({label:(c.account.name||path.basename(value))+' · '+c.state,value})));
     if(file)this.active=this.sessions.get(file);
    }else if(choice==='settings'){
     const transport=await this.choose('получение udp кадров',[{label:'udp',value:'udp'},{label:'только TCP',value:'none'}]);if(!transport)continue;
     const proxyPoolFile=await this.prompt('файл пула прокси (пусто — напрямую)','');
     this.connection={reconnect:true,battleTransport:transport,...(proxyPoolFile?{proxyPoolFile:path.resolve(this.root,proxyPoolFile)}:{})};
     await this.view('настройки новых сессий',this.connection);
    }else{
     if(!this.active)throw Error('сначала выберите аккаунт');
     if(choice==='info')await this.view('аккаунт',{file:this.active.file,account:this.active.account,state:this.active.state,team:this.active.team,club:this.active.club,matchmaking:this.active.matchmaking,udpFrames:this.active.tuiFrames||0});
     if(choice==='reconnect')await this.active.reconnect();
     if(choice==='close'){this.active.close();this.sessions.delete(this.active.file);this.active=[...this.sessions.values()].at(-1)||null;}
    }
   }catch(e){if(e instanceof Exit)throw e;if(!(e instanceof Cancel))await this.view('ошибка',e.message);}
  }
 }
 async action(id){
  if(!this.active||this.active.state!=='online')throw Error('сначала подключите аккаунт в разделе «аккаунт и соединение»');
  const feature=this.features.commands.find(f=>f.command===id);
  if(feature?.status==='unavailable')return this.view('недоступно','функция не подтверждена и заблокирована в клиенте.');
  if(feature?.experimental){const yes=await this.choose('функция экспериментальная. результат может быть не подтверждён.',[{label:'назад',value:'back'},{label:'выполнить',value:'yes'}]);if(yes!=='yes')return;}
  const args=await this.fields(id);
  if(id==='brawl-tv'){
   const pick=await this.choose('brawl tv',[{label:'первый доступный канал',value:'auto'},{label:'выбрать канал',value:'channel'},{label:'по тегу игрока',value:'tag'}]);
   if(!pick)throw new Cancel();if(pick==='channel')args.channel=(await this.fields('brawl-tv-next')).channel;
   if(pick==='tag')args.tag=await this.prompt('тег игрока (#...)',undefined,true);
  }
  args.experimental=!!feature?.experimental;this.log('ожидание ответа сервера…');
  const result=await this.execute(this.active,id,args);
  await this.view(result.confirmed===false?'результат не подтверждён':'ответ сервера',result);
 }
 async utilities(){
  for(;;){
   const selected=await this.choose('инструкция и утилиты',[
    {label:'инструкция по tui',value:'guide'},{label:'все функции и статус проверки',value:'features'},
    {label:'инструкция по функциям клиента',value:'commands'},{label:'информация о версии и сервере',value:'info'},
    {label:'расшифровать тег',value:'tag-decode'},{label:'расшифровать код лобби',value:'room-code'},
    {label:'проверить обновление',value:'update-check'},{label:'применить обновление',value:'update'},
    {label:'статус фонового fleet',value:'fleet-status'},{label:'назад',value:'back'}]);
   if(!selected||selected==='back')return;
   try{
    if(selected==='guide')await this.view('tui',fs.readFileSync(path.join(this.root,'docs/tui.md'),'utf8'));
    if(selected==='commands')await this.view('команды',fs.readFileSync(path.join(this.root,'docs/COMMANDS.md'),'utf8'));
    if(selected==='features')await this.view('функции',this.features);
    if(selected==='info'){const c=Store.read(path.join(this.root,'config.json'));await this.view('клиент',{version:VERSION,host:c.host,binary:c.appBinaryVersion,root:this.root});}
    if(selected==='tag-decode')await this.view('тег',require('./utils/TagCodec').describeTag(await this.prompt('тег (#...)',undefined,true)));
    if(selected==='room-code')await this.view('код лобби',require('./utils/TeamCode').decode(await this.prompt('код',undefined,true)));
    if(selected==='fleet-status')await this.tool('tools/fleet.js',['status']);
    if(selected==='update-check')await this.tool('tools/update.js',['--check']);
    if(selected==='update'){if([...this.sessions.values()].some(c=>!c.closed))throw Error('сначала отключите сессии, затем обновляйте настройки.');await this.tool('tools/update.js',[]);}
   }catch(e){if(e instanceof Exit)throw e;if(!(e instanceof Cancel))await this.view('ошибка',e.message);}
  }
 }
 async tool(file,args){
  let output='',error='';this.log('выполнение…');
  const child=this.child=spawn(process.execPath,[path.join(this.root,file),...args],{cwd:this.root,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>{output=(output+b).slice(-150000);});child.stderr.on('data',b=>{error=(error+b).slice(-150000);});
  const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  this.child=null;await this.view('результат · код '+status,output+error);
 }
 async run(){
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('tui нужен интерактивный терминал. запуск: node nulls.js; для команд: node nulls.js help');
  global.Debugger=Object.fromEntries(['info','warn','error','fatal'].map(k=>[k,(...v)=>this.log(v.join(' '))]));
  const stop=()=>{this.closing=true;for(const c of this.sessions.values())c.close();this.child?.kill('SIGTERM');this.abort?.();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{
   for(;;){
    const selected=await this.choose('главное меню',[...groups.map((g,value)=>({label:g[0],value})),{label:'закрыть tui и отключить его сессии',value:'exit'}]);
    if(selected===null||selected==='exit')break;
    if(selected===0){await this.accounts();continue;}if(selected===7){await this.utilities();continue;}
    const [title,ids]=groups[selected];
    for(;;){
     const id=await this.choose(title,ids.map(value=>({value,label:commands[value][0]+(this.features.commands.find(f=>f.command===value)?.experimental?' [эксперимент]':'')})));
     if(!id)break;
     try{await this.action(id);}catch(e){if(e instanceof Exit)throw e;if(!(e instanceof Cancel))await this.view('ошибка',e.message);}
    }
   }
  }catch(e){if(!(e instanceof Exit))throw e;}
  finally{stop();process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);global.Debugger=this.previousDebugger;if(process.stdin.isRaw)process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\x1b[2J\x1b[Hсессии tui закрыты.\n');}
 }
}
async function main(){await new App().run();}
module.exports={App,commands,groups,main};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});

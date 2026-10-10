const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {EventEmitter}=require('node:events'),{App,commands,groups}=require('../TUI'),Actions=require('../lib/Actions');
const root=path.resolve(__dirname,'..');
class FakeClient extends EventEmitter{
 constructor(options){super();this.file=options.account;this.options=options;this.account={hi:0,lo:1,name:options.name||'Saved'};this.state='stopped';}
 async connect(){this.state='online';return this;}close(){this.closed=true;this.state='stopped';}
}
test('TUI covers every client action and groups use known schemas',()=>{
 const supported=new Set(['login','create-account',...Object.keys(commands)]);
 assert.deepEqual(Actions.commands.filter(c=>!supported.has(c)),[]);
 for(const [,ids]of groups)for(const id of ids)assert.ok(commands[id],id);
});
test('forms retain false and zero, omit skipped settings, and map catalogs to native references',async()=>{
 const app=new App(root);app.prompt=async()=> '#2PP';app.choose=async()=>false;
 assert.deepEqual(await app.fields('club-answer'),{tag:'#2PP',accept:false});
 app.choose=async()=>0;assert.deepEqual(await app.fields('create-room'),{type:0});
 app.choose=async()=> '__skip__';app.prompt=async()=>undefined;assert.deepEqual(await app.fields('club-settings'),{});
 app.choose=async()=> '14:125';assert.deepEqual(await app.fields('account-region'),{region:'14:125'});
 app.choose=async()=> '15:7';assert.deepEqual(await app.fields('team-map'),{location:'15:7'});
});
test('connected sessions share peers, switching reuses a session, and failed login closes it',async()=>{
 const app=new App(root,{Client:FakeClient});
 await app.connectAccount('accounts/tui-test-a.json','One');const one=app.active;
 await app.connectAccount('accounts/tui-test-b.json','Two');const two=app.active;
 assert.equal(app.sessions.size,2);assert.equal(one.peers,two.peers);assert.equal(one.peers,app.sessions);
 await app.connectAccount('accounts/tui-test-a.json','One');assert.equal(app.active,one);assert.equal(app.sessions.size,2);
 class Bad extends FakeClient{async connect(){throw Error('login refused');}}
 const failed=new App(root,{Client:Bad});let made;failed.attach=(file,c)=>{made=c;App.prototype.attach.call(failed,file,c);};
 await assert.rejects(failed.connectAccount('accounts/tui-test-c.json','Three'),/login refused/);
 assert.equal(made.closed,true);assert.equal(failed.sessions.size,0);assert.equal(failed.active,null);
});
test('TUI preserves server confirmation and blocks network actions before login',async()=>{
 const requests=[],app=new App(root,{execute:async(c,id,args)=>{requests.push({c,id,args});return {confirmed:false,note:'Not confirmed'};}});
 await assert.rejects(app.action('club-recommendations'),/подключите/);
 app.active={state:'online'};let result;app.view=async(title,v)=>{result={title,v};};
 await app.action('club-recommendations');assert.equal(requests[0].id,'club-recommendations');
 assert.equal(result.v.confirmed,false);assert.match(result.title,/не подтверждён/);
 app.active.state='reconnecting';await assert.rejects(app.action('friends'),/подключите/);assert.equal(requests.length,1);
});

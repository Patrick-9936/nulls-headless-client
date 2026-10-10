#!/usr/bin/env node
const fs=require('fs'),path=require('path'),net=require('net');
const {spawn}=require('child_process'),{parseProxy,connectSocket}=require('../utils/ProxyConnect');
const Sources=require('../lib/ProxySources');
const ROOT=path.resolve(__dirname,'..'),PID=path.join(ROOT,'proxy-watch.pid'),LOG=path.join(ROOT,'proxy-watch.log'),STATE=path.join(ROOT,'proxy-watch-status.json');
const args=process.argv.slice(2),command=args[0]||'status';
function option(flag,fallback){const i=args.indexOf(flag);return i<0?fallback:args[i+1];}
function owned(){if(!fs.existsSync(PID))return null;const n=Number(fs.readFileSync(PID));try{process.kill(n,0);if(!fs.readFileSync('/proc/'+n+'/cmdline').includes(Buffer.from(__filename)))return null;return n;}catch{return null;}}
function atomic(file,value){const temp=file+'.tmp-'+process.pid;fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);}
if(command==='status'){console.log(JSON.stringify({running:!!owned(),...(fs.existsSync(STATE)?JSON.parse(fs.readFileSync(STATE)): {})},null,2));return;}
if(command==='stop'||command==='refresh'){const n=owned();if(n)process.kill(n,command==='stop'?'SIGTERM':'SIGUSR2');console.log(n?'Request sent':'Proxy watcher is not running');return;}
if(command==='start'){if(owned())throw new Error('Proxy watcher already running');const fd=fs.openSync(LOG,'a',0o600);const p=spawn(process.execPath,['--max-old-space-size=64',__filename,'run',...args.slice(1)],{cwd:ROOT,detached:true,stdio:['ignore',fd,fd]});p.unref();fs.closeSync(fd);console.log('Proxy watcher started: PID '+p.pid);return;}
if(command!=='run')throw new Error('Use start|run|status|stop|refresh');
if(owned())throw new Error('Proxy watcher already running');
const poolFile=path.resolve(ROOT,option('--output','working-proxies.json'));
const source=option('--source',null);
const sources=source?[{name:'custom',protocol:option('--protocol','socks5'),url:source}]:Sources.sources;
const parallel=Number(option('--parallel','6')),limit=Number(option('--limit','240')),timeout=Number(option('--timeout','4500')),interval=Number(option('--interval','600'))*1000;
if(!Number.isInteger(parallel)||parallel<1||parallel>32||!Number.isInteger(limit)||limit<1||limit>1000||timeout<1000||interval<60000)throw new Error('Invalid checker limits');
const config=JSON.parse(fs.readFileSync(path.join(ROOT,'config.json')));require('../utils/NullsLicense').apply(config,ROOT);
const Hello=require('../Messaging/Messages/Client/ModernClientHelloMessage');
let stopping=false,busy=false,pendingRefresh=false,timer=null,fetchController=null,lastResult={},active=new Set(),cycleIndex=0;
let ownPoolSignature=null,refreshNotBefore=0;
function signature(value){const items=Array.isArray(value)?value:value.proxies;return Array.isArray(items)?items.join('\n'):null;}
try{ownPoolSignature=signature(JSON.parse(fs.readFileSync(poolFile)));}catch{}
function requestRefresh(){if(stopping)return;if(busy){pendingRefresh=true;return;}clearTimeout(timer);timer=setTimeout(cycle,Math.max(0,refreshNotBefore-Date.now()));}
const watcher=fs.watch(path.dirname(poolFile),(event,name)=>{
 if(String(name)!==path.basename(poolFile))return;
 try{const next=signature(JSON.parse(fs.readFileSync(poolFile)));if(next!==ownPoolSignature){ownPoolSignature=next;requestRefresh();}}catch{requestRefresh();}
});
fs.writeFileSync(PID,String(process.pid),{mode:0o600});
function status(error=null){atomic(STATE,{pid:process.pid,running:!stopping,busy,updatedAt:new Date().toISOString(),sources,parallel,limit,timeout,intervalSeconds:interval/1000,rssBytes:process.memoryUsage().rss,...lastResult,error});}
function check(url){return new Promise(resolve=>{let proxy;try{proxy=parseProxy(url);}catch{return resolve(false);}const s=new net.Socket();active.add(s);let done=false,buffer=Buffer.alloc(0);
 const timer=setTimeout(()=>finish(false),timeout);
 function finish(ok){if(done)return;done=true;clearTimeout(timer);active.delete(s);s.destroy(new Error('Proxy check finished'));resolve(ok);}
 s.on('error',()=>finish(false));s.on('close',()=>finish(false));
 connectSocket(s,{host:config.host,port:config.port,proxy},()=>{s.on('data',b=>{buffer=Buffer.concat([buffer,b]);if(buffer.length>65536)return finish(false);if(buffer.length<7)return;const n=buffer.readUIntBE(2,3);if(buffer.length<n+7)return;finish(buffer.readUInt16BE(0)===config.packetIds.serverHello&&n>=28&&buffer.readUInt32BE(7)===24);});
 const message=new Hello(config);message.encode();const body=message.ByteStream.getBytes(),head=Buffer.alloc(7);head.writeUInt16BE(config.packetIds.clientHello);head.writeUIntBE(body.length,2,3);s.write(Buffer.concat([head,body]));});
});}
async function cycle(){if(stopping)return;if(busy){pendingRefresh=true;return;}busy=true;refreshNotBefore=Date.now()+30000;status();let next=interval;
 try{const groups=[],sourceResults=[];
 for(const item of sources){if(stopping)return;fetchController=new AbortController();const deadline=setTimeout(()=>fetchController.abort(),10000);
 try{const data=await Sources.download(item,fetchController.signal);const group=[...new Set(data.text.split(/\s+/).map(value=>Sources.normalize(value,item.protocol)).filter(Boolean))];groups.push(group);sourceResults.push({name:item.name,entries:group.length,bytes:data.bytes,truncated:data.truncated});}
 catch(error){sourceResults.push({name:item.name,error:error.message});}
 finally{clearTimeout(deadline);fetchController=null;}}
 let previous=[];try{const d=JSON.parse(fs.readFileSync(poolFile));previous=Array.isArray(d)?d:d.proxies;}catch{}
 const candidates=Sources.select(groups,previous||[],limit,cycleIndex++);
 if(!candidates.length)throw new Error('No candidates from any source');
 let cursor=0,checked=0,lastPublish=0;const valid=[];
 function publish(force=false){if(stopping||(!force&&(!valid.length||Date.now()-lastPublish<1000)))return;lastPublish=Date.now();
 const result={checkedAt:new Date().toISOString(),checked,valid:valid.length,partial:checked<candidates.length,verification:'ServerHello through proxy; no account login performed',proxies:valid,sources:sourceResults};
 ownPoolSignature=signature(result);atomic(poolFile,result);fs.writeFileSync(poolFile.replace(/\.json$/,'.txt'),valid.join('\n')+(valid.length?'\n':''),{mode:0o600});
 lastResult={checkedAt:result.checkedAt,checked,valid:valid.length,partial:result.partial,sourceResults};status();}
 async function worker(){while(!stopping&&cursor<candidates.length){const url=candidates[cursor++];if(await check(url))valid.push(url);checked++;publish();}}
 await Promise.all(Array.from({length:parallel},worker));if(stopping)return;
 publish(true);console.log(lastResult.checkedAt,'Checked',checked,'working',valid.length);status();
 // New tunnels load the current pool; healthy established sessions remain connected.
 }catch(e){next=60000;console.log(new Date().toISOString(),e.message);status(e.message);}
 finally{busy=false;if(!stopping){status();timer=setTimeout(cycle,pendingRefresh?Math.max(0,refreshNotBefore-Date.now()):next);pendingRefresh=false;}}
}
function stop(){stopping=true;clearTimeout(timer);watcher.close();fetchController?.abort();for(const s of active)s.destroy(new Error('Watcher stopped'));status();if(owned()===process.pid)fs.unlinkSync(PID);}
process.once('SIGTERM',stop);process.once('SIGINT',stop);process.on('SIGUSR2',requestRefresh);cycle();

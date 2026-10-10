const {EventEmitter}=require('node:events'),dgram=require('node:dgram'),net=require('node:net');
const Protocol=require('./BattleProtocol'),Proxy=require('../utils/ProxyConnect');
class BattleSession extends EventEmitter {
 constructor(connection,options={}){super();this.connection=connection;this.options=options;this.state='stopped';this.tick=0;this.ack=-1;this.sequence=0;this.sent=0;this.received=0;this.visionUpdates=0;this.invalid=0;this.closed=false;}
 async start(){
  this.state='connecting';let endpoint=this.connection;
  try{
   if(this.options.proxy){this.association=await Proxy.associateUdp(this.options.proxy);if(this.closed){this.association.socket.destroy();return;}endpoint=this.association.relay;this.association.socket.on('close',()=>this.fail(Error('SOCKS5 UDP association closed')));}
   if(this.closed)return;
   const socket=this.socket=dgram.createSocket(net.isIP(endpoint.host)===6?'udp6':'udp4');
   socket.on('error',e=>this.fail(e));socket.on('message',bytes=>this.receive(bytes));
   await new Promise((resolve,reject)=>{socket.once('error',reject);socket.connect(endpoint.port,endpoint.host,()=>{socket.off('error',reject);resolve();});});
   if(this.closed)return;
   this.state='awaiting-vision';this.send();this.timer=setInterval(()=>this.send(),50);
   this.timeout=setTimeout(()=>{if(!this.visionUpdates)this.fail(Error('No UDP vision update confirmed within 5 seconds'));},5000);
  }catch(e){this.fail(e);}
 }
 send(){if(this.closed)return;if(this.lastVisionAt&&Date.now()-Date.parse(this.lastVisionAt)>10000)return this.fail(Error('UDP vision updates stopped for 10 seconds'));
  if(this.tick>16383)return this.fail(Error('Battle input tick limit reached'));
  const body=Protocol.input(this.tick++,this.ack,this.sequence=this.sequence>=8000?0:this.sequence+1);
  let bytes=Protocol.frame(this.connection.session,10555,body);
  if(this.options.proxy)bytes=Protocol.socksFrame(this.connection.host,this.connection.port,bytes);
  this.socket.send(bytes,e=>{if(e)this.fail(e);else this.sent++;});
 }
 receive(bytes){if(this.closed)return;try{
  if(this.options.proxy)bytes=Protocol.socksPacket(this.connection.host,this.connection.port,bytes);
  const p=Protocol.packet(this.connection.session,bytes);this.received++;this.emit('packet',p);
  if(p.type!==24109)return;
  const update=Protocol.vision(p.payload);this.visionUpdates++;this.ack=Math.max(this.ack,update.tick);this.inputAck=update.inputAck;
  this.lastVisionAt=new Date().toISOString();this.state='active';clearTimeout(this.timeout);this.emit('vision',update);
 }catch{this.invalid++;}}
 fail(e){if(this.closed)return;this.error=e.message;this.close();this.state='failed';this.emit('warning',e);}
 status(){return {state:this.state,sent:this.sent,received:this.received,visionUpdates:this.visionUpdates,invalid:this.invalid,serverTick:this.ack,inputAck:this.inputAck??null,lastVisionAt:this.lastVisionAt||null,error:this.error||null};}
 close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);clearTimeout(this.timeout);try{this.socket?.close();}catch{}this.association?.socket.destroy();this.state='stopped';this.emit('close');}
}
module.exports=BattleSession;

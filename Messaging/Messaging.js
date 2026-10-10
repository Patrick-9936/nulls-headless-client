const fs = require('fs');
const path = require('path');
const createMessageByType = require('./LogicLaserMessageFactory');
const LegacyClientHelloMessage = require('./Messages/Client/ClientHelloMessage');
const LegacyLoginMessage = require('./Messages/Client/LoginMessage');
const ModernClientHelloMessage = require('./Messages/Client/ModernClientHelloMessage');
const ModernLoginMessage = require('./Messages/Client/ModernLoginMessage');
const AddFriendMessage = require('./Messages/Client/AddFriendMessage');
const StartSpectateMessage = require('./Messages/Client/StartSpectateMessage');
const LegacyCrypto = require('../Crypto/PepperCrypto');
const ModernCrypto = require('../Crypto/ModernCrypto');

class Messaging {
  constructor(socket, queue, options) {
    this._socket = socket;
    this._queue = queue;
    this.config = options.config;
    this.account = options.account;
    this.action = options.action;
    this.root = options.root || path.resolve(__dirname,'..');
    this.accountPath=options.accountPath || path.join(this.root,'account.json');
    this.reconnect=options.reconnect;
    this.dump = !!options.dump;
    this.actionSent = false;
    this.crypto = this.config.cryptoMode === 'nulls-native19' ? new (require('../Crypto/NullsCrypto'))(this.config)
      : this.config.cryptoMode === 'legacy' ? new LegacyCrypto(this.config) : new ModernCrypto(this.config);
    if (this.dump) fs.mkdirSync(path.join(this.root, 'PacketsDumps'), { recursive: true });
  }
  saveAccount() { fs.writeFileSync(this.accountPath, JSON.stringify(this.account, null, 2)); }
  saveConfig() { fs.writeFileSync(path.join(this.root, 'config.json'), JSON.stringify(this.config, null, 2)); }
  close(reason='done') {
    if(this.closing)return; this.closing=true;
    this.closeReason = reason;
    clearInterval(this.keepAlive);
    clearTimeout(this.actionTimeout);
    Debugger.info(`closing connection: ${reason}`);
    try { this._socket.end(); } catch {}
    setTimeout(() => { try { this._socket.destroy(); } catch {} }, 100).unref?.();
  }
  pendingJob() {
    if (this._queue.size() < 7) return false;
    return this._queue.get().readUIntBE(2, 3) <= this._queue.size() - 7;
  }
  update() {
    const buffer = this._queue.get();
    const length = buffer.readUIntBE(2, 3);
    const type = buffer.readUInt16BE(0);
    const version = buffer.readUInt16BE(5);
    const encrypted = buffer.slice(7, 7 + length);
    this._queue.release(length + 7);
    const stamp=`${Date.now()}-${type}`;
    if (this.dump) {
      // Save the raw frame payload even if decryption/decoding fails.
      fs.writeFileSync(path.join(this.root, 'PacketsDumps', `${stamp}.raw.bin`), encrypted);
      const meta={type,length,version,cryptoEstablished:!!this.crypto.established,hasSessionKey:!!this.crypto.sessionKey};
      fs.writeFileSync(path.join(this.root, 'PacketsDumps', `${stamp}.json`), JSON.stringify(meta,null,2));
    }
    let payload;
    try { payload = this.crypto.decrypt(type, encrypted); }
    catch (e) { Debugger.error(`decrypt ${type}: ${e.message}`); return; }
    if (payload == null) return Debugger.error(`Failed to decrypt packet ${type}`);
    this.onPacket?.(type, payload);
    if(type!==20108 && type!==49001) Debugger.info(`recv type=${type} len=${length} ver=${version} decrypted=${payload.length}`);
    if (this.dump) {
      fs.writeFileSync(path.join(this.root, 'PacketsDumps', `${stamp}.dec.bin`), payload);
    }
    if ([24301,24399].includes(type) && ['create-club','join-club','club-info'].includes(this.action?.mode)) {
      try {
        const data=require('../utils/ClubProtocol').decode(type,payload);
        const club=type===24399?data.club:data;
        if (club) {
          Debugger.info(`Club state: ${JSON.stringify(club)}`);
          const expected=this.action.mode==='create-club'?club.name===this.action.clubName:
            club.hi===this.action.target.hi && club.lo===this.action.target.lo;
          if (expected && (club.hi||club.lo) && (type===24399 || this.action.mode==='club-info')) {
            this.clubConfirmed=true;clearTimeout(this.actionTimeout);
            if(type===24399){this.account.club={...club,role:data.role,verifiedAt:new Date().toISOString()};this.saveAccount();}
            Debugger.info(`Club ${this.action.mode} confirmed: ${require('../utils/TagCodec').logicLongToTag(club.hi,club.lo)}`);
            if(this.action.once)this.close('club confirmed');
          }
        }
      } catch(e) { Debugger.error(`Club decode ${type}: ${e.message}`); }
      return;
    }
    if (type===24111) {
      const ByteStream=require('../DataStream/ByteStream');
      const s=new ByteStream(); s.set(payload);
      if (s.readVInt()===201) {
        const name=s.readString(); s.readVInt(); const token=s.readString();
        this.account.name=name;
        if (token) this.account.nameChangeToken=token;
        this.saveAccount();
        Debugger.info(`Nickname confirmed: ${JSON.stringify(name)}; reconnecting`);
        this.close('nickname changed');
        this.reconnect?.();
      }
      return;
    }
    if (type===24131 && this.action.mode==='chat' && this.actionSent) {
      const ByteStream=require('../DataStream/ByteStream');
      const marker=new ByteStream(); marker.writeRequiredString(this.action.text);
      if (payload.includes(marker.getBytes())) {
        this.chatConfirmed=true; clearTimeout(this.actionTimeout);
        Debugger.info(`Chat message confirmed in server team stream: ${JSON.stringify(this.action.text)}`);
        if(this.action.once)this.close('chat confirmed');
      }
    }
    if (type===20300) {
      const ByteStream=require('../DataStream/ByteStream');
      const s=new ByteStream(); s.set(payload);
      const changed=s.readBoolean(), code=s.readInt(), name=s.readString();
      Debugger.info(`Nickname response: changed=${changed} code=${code} name=${JSON.stringify(name)}`);
      if (this.nameValidationPending) {
        this.nameValidationPending=false;
        this.account.nameValidation={requested:this.action.name,changed,code,name,at:new Date().toISOString()};
        this.saveAccount();
        if (code!==0 || name!==this.action.name) {
          this.failProfile(new Error(`Сервер отклонил ник ${JSON.stringify(this.action.name)}: код проверки ${code}`));
          return;
        }
        this.sendRequestedName();
        return;
      }
      if (name && name===this.action.name) { this.account.name=name; this.saveAccount(); }
      this.namePending=false;
      if (this.action.mode==='rename' && this.action.once) this.close('nickname response received');
      else this.runAction('nickname-response');
      return;
    }
    if (type===20205 && this.namePending) {
      const code=payload.length>=4?payload.readInt32BE(0):null;
      this.failProfile(new Error(`Сервер отклонил установку ника ${JSON.stringify(this.action.name)}: код ${code}`));
      return;
    }
    if (type===24105 || type===20112) {
      const code=payload.length>=4?payload.readInt32BE(0):null;
      Debugger.error(`${type===24105?'Spectate':'Friend request'} rejected: server error ${code}`);
      process.exitCode=1;
      if (this.action.once) this.close('action rejected');
      return;
    }
    if (type===20106 && this.action.mode==='friend') {
      const ByteStream=require('../DataStream/ByteStream');
      const s=new ByteStream(); s.set(payload); s.readBoolean();
      const target=s.readLong();
      if (target.hi===this.action.target.hi && target.lo===this.action.target.lo) {
        this.friendUpdateReceived=true;
        Debugger.info(`Friend update confirmed for ${this.action.targetLabel}`);
        clearTimeout(this.actionTimeout);
        if (this.action.once) this.close('target friend update received');
      }
    }
    if (type===20108 || type===49001) return;
    if (type===24125 && this.action.mode==='leave-room' && this.actionSent) {
      const reason=payload.length>=4?payload.readInt32BE(0):null;
      if(reason===0) {
        this.leaveConfirmed=true; this.account.team=null; this.saveAccount();
        Debugger.info('Room leave confirmed by server (reason 0)');
        if(this.action.once)this.close('room leave confirmed');
      } else { Debugger.error(`Room leave response: reason=${reason}`); if(this.action.once){process.exitCode=1;this.close('room leave unconfirmed');} }
      return;
    }
    if (type===24125 && ['join-room','create-room'].includes(this.action?.mode)) {
      const ByteStream=require('../DataStream/ByteStream');
      const stream=new ByteStream(); stream.set(payload);
      Debugger.error(`Room join rejected: server error ${stream.readInt()}`);
      process.exitCode=1;
      this.close('room join rejected');
      return;
    }
    if (type===24124 && ['join-room','create-room'].includes(this.action?.mode)) {
      const ByteStream=require('../DataStream/ByteStream');
      const stream=new ByteStream(); stream.set(payload);
      stream.readVInt(); stream.readBoolean(); stream.readVInt();
      const team=stream.readLong();
      if (this.action.mode==='create-room' ? (team.hi!==0||team.lo!==0) : (team.hi===this.action.target.hi && team.lo===this.action.target.lo)) {
        const first=!this.roomJoined;
        this.roomJoined=true;
        this.account.team=team; this.saveAccount();
        if (first) Debugger.info(`Room ${this.action.mode==='create-room'?'created':'joined'}: ${require('../utils/TeamCode').encode(team.hi,team.lo)} team=${team.hi}:${team.lo}`);
        if (this.action.once) this.close('room membership confirmed');
      } else Debugger.warn(`Team state received for ${team.hi}:${team.lo}; requested room remains unconfirmed`);
      return;
    }
    const message = createMessageByType(type, this.config);
    if (message) {
      message.ByteStream.set(payload);
      try { message.decode(); message.process(this); }
      catch (e) { Debugger.error(`Decode/process ${type}: ${e.message}`); }
    } else {
      Debugger.info(`unsupported decrypted message ${type}; use --dump to inspect it`);
    }
  }
  sendPepperAuthentication() {
    const Cls=this.config.cryptoMode === 'legacy' ? LegacyClientHelloMessage : ModernClientHelloMessage;
    const m = new Cls(this.config); m.encode();
    this.send(this.config.packetIds.clientHello, m.ByteStream.getBytes());
  }
  sendPepperLogin() {
    if (this.config.cryptoMode==='native19') {
      try {
        const AndroidChallengeBridge=require('../Crypto/AndroidChallengeBridge');
        const response=new AndroidChallengeBridge(this.root).respond(this.crypto.sessionKey);
        this.crypto.setChallengeResponse(response);
        Debugger.info(`SDK challenge response prepared: ${response.length} bytes`);
      } catch (error) {
        Debugger.error(error.message);
        process.exitCode=1;
        this.close('SDK challenge processing failed');
        return;
      }
    }
    const Cls=this.config.loginLayout === 'legacy' ? LegacyLoginMessage : ModernLoginMessage;
    const m = new Cls(this.config, this.account); m.encode();
    this.send(this.config.packetIds.login, m.ByteStream.getBytes());
  }
  onLoggedIn() {
    this.keepAlive=setInterval(()=>{
      if (!this._socket.destroyed) this.send(10108,Buffer.alloc(0),1);
    },5000);
    this.keepAlive.unref();
    this._socket.once('close',()=>clearInterval(this.keepAlive));
    this._socket.once('close',()=>clearTimeout(this.actionTimeout));
    if (this.action.mode!=='login' || this.action.name || this.action.age!==undefined) {
      this.actionTimeout=setTimeout(()=>{
        if (this.clubConfirmed || this.roomJoined || this.friendUpdateReceived || this.chatConfirmed || this.leaveConfirmed || (this.action.mode==='rename' && this.account.name===this.action.name)) return;
        Debugger.error('Action was sent, but the server has not confirmed success within 15 seconds.');
        if (this.action.once) { process.exitCode=1; this.close('action unconfirmed'); }
      },15000);
      this.actionTimeout.unref();
    }
    if (!this.action || this.action.mode === 'none' || this.action.mode === 'login') return;
    setTimeout(() => this.runAction('login-delay'), this.config.postLoginDelayMs || 1200);
  }
  onHomeReady(payload) {
    const ageState=require('../utils/HomeAge')(payload);
    if (ageState) { this.account.serverAgeState=ageState.state; this.saveAccount(); }
    if (this.action.age!==undefined && !this.action.ageConfirmed) {
      if (this.action.ageAttempted) {
        if (ageState?.state!==2) {
          Debugger.error(`Age was not confirmed by server: state=${ageState?.state??'unknown'}`);
          process.exitCode=1; this.close('age verification failed'); return;
        }
        this.account.age=this.action.age;
        this.account.ageVerification={state:2,previousState:1,requestedAge:this.action.age,confirmedAt:new Date().toISOString()};
        this.action.ageConfirmed=true; this.saveAccount();
        Debugger.info(`Age ${this.action.age} accepted: server age state changed from unset to adult`);
      } else if (ageState?.state===1) {
        const SetAge=require('./Messages/Client/SetAgeMessage');
        const age=new SetAge(this.action.age); age.encode();
        this.action.ageAttempted=true;
        this.send(14102,age.ByteStream.getBytes(),0);
        this.account.requestedAge=this.action.age; this.saveAccount();
        Debugger.info(`Age ${this.action.age} requested; reconnecting to verify server state`);
        setTimeout(()=>{ if(!this._socket.destroyed) { this.close('verify age'); this.reconnect?.(); } },1000);
        return;
      } else if (ageState?.state===2 && this.account.age===this.action.age && this.account.ageVerification) {
        this.action.ageConfirmed=true;
      } else {
        Debugger.error(`Cannot confirm requested age ${this.action.age}: server state=${ageState?.state??'unknown'}, exact existing age=${this.account.age??'unknown'}`);
        process.exitCode=1; this.close('age could not be set'); return;
      }
    }
    if (!this.profileSetupSent) {
      this.profileSetupSent=true;
      if (this.action.name && this.action.name!==this.account.name) {
        this.namePending=true;
        if (this.config.cryptoMode==='nulls-native19') {
          const s=new (require('../DataStream/ByteStream'))();
          s.writeRequiredString(this.action.name);
          this.nameValidationPending=true;
          this.send(14600,s.getBytes(),9);
        } else this.sendRequestedName();
      }
    }
    if (this.namePending) return;
    this.runAction('home-data');
    if (this.action.mode==='rename' && this.account.name===this.action.name && this.action.once) this.close('nickname confirmed after reconnect');
    if (['login','set-age'].includes(this.action?.mode) && this.action.once) this.close('login and home-data confirmed');
  }
  sendRequestedName() {
    const ChangeName=require('./Messages/Client/ChangeNameMessage');
    const name=new ChangeName(this.action.name,this.config.cryptoMode==='nulls-native19'?false:!this.account.name);
    name.encode();this.namePending=true;
    this.send(10212,name.ByteStream.getBytes(),0);
  }
  failProfile(error) {
    Debugger.error(error.message);
    this.onProfileError?.(error);
    this.close('profile rejected');
  }
  runAction(source) {
    if (this.action.age!==undefined && !this.action.ageConfirmed) return;
    if (this._socket.destroyed || this.closing) return;
    if (this.actionSent || this.namePending || !this.action || !['friend','spectate','join-room','leave-room','chat','create-room','create-club','join-club','club-info'].includes(this.action.mode)) return;
    this.actionSent = true;
    if(['create-club','join-club','club-info'].includes(this.action.mode)) {
      const club=require('../utils/ClubProtocol');
      const id=this.action.mode==='create-club'?14301:this.action.mode==='join-club'?14305:14302;
      const body=this.action.mode==='create-club'?club.create(this.action.clubName):this.action.mode==='join-club'?club.join(this.action.target):club.info(this.action.target);
      this.send(id,body,0);return;
    }
    if (this.action.mode==='create-room') {
      const ByteStream=require('../DataStream/ByteStream');
      const s=new ByteStream(); s.writeLong(0,0); s.writeVInt(0); s.writeVInt(-1); s.writeVInt(-1);
      this.send(12541,s.getBytes(),0); return;
    }
    if (this.action.mode==='leave-room') { this.send(14353,Buffer.alloc(0),0); return; }
    if (this.action.mode==='chat') {
      const ByteStream=require('../DataStream/ByteStream');
      const s=new ByteStream(); s.writeRequiredString(this.action.text);
      this.send(14049,s.getBytes(),0); return;
    }
    if (this.action.mode==='join-room') {
      const ByteStream=require('../DataStream/ByteStream');
      const stream=new ByteStream();
      stream.writeVInt(this.action.target.hi);
      stream.writeVInt(this.action.target.lo);
      stream.writeVInt(1);
      Debugger.info(`Joining room ${this.action.targetLabel}`);
      this.send(14358,stream.getBytes(),0);
      return;
    }
    Debugger.info('friend/spectate encoders match the supplied native v69 library; checking the server result.');
    Debugger.info(`Sending ${this.action.mode} action (${source}) to ${this.action.targetLabel}`);
    if (this.action.mode === 'friend') {
      const m = new AddFriendMessage(this.action.target, this.action.reason ?? 0, this.action.reasonDetails ?? 0); m.encode();
      this.send(this.config.packetIds.addFriend, m.ByteStream.getBytes());
    } else {
      const m = new StartSpectateMessage(this.action.target, this.action.afterDeath); m.encode();
      this.send(this.config.packetIds.startSpectate, m.ByteStream.getBytes());
    }
  }
  messageVersion() {
    if (!this.config.usePackedHeaderVersion) return 0;
    const v=((this.config.major & 0x7ff) << 20) | ((this.config.minor & 0x3ff) << 10) | (this.config.build & 0x3ff);
    return v & 0xffff;
  }
  send(type, payload, version = undefined, onFlushed = undefined) {
    const header = Buffer.alloc(7);
    header.writeUInt16BE(type, 0);
    let encrypted;
    try { encrypted = this.crypto.encrypt(type, payload); }
    catch(e){ Debugger.error(`encrypt ${type}: ${e.message}`); return; }
    header.writeUIntBE(encrypted.length, 2, 3);
    let wireVersion = version;
    if (wireVersion === undefined) {
      // Successful official-client capture: Hello=0, Login=10 (v69.414).
      wireVersion = type===this.config.packetIds.clientHello ? 0
        : type===this.config.packetIds.login ? (this.config.loginHeaderVersion ?? 10)
        : this.messageVersion();
    }
    header.writeUInt16BE(wireVersion, 5);
    this._socket.write(header);
    this._socket.write(encrypted, onFlushed);
    if(type!==10108) Debugger.info(`sent type=${type} len=${encrypted.length} ver=${wireVersion}`);
  }
}
module.exports = Messaging;

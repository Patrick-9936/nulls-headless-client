const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

class AndroidChallengeBridge {
  constructor(root) { this.root=root; }
  respond(challenge) {
    if (!Buffer.isBuffer(challenge) || challenge.length!==32) throw new Error('SDK bridge requires a 32-byte server challenge');
    const bridge=path.join(this.root,'bridge','challenge-bridge.jar');
    const runtime=path.join(this.root,'.sdk-runtime');
    const appProcess='/system/bin/app_process64';
    if (!fs.existsSync(appProcess)) throw new Error('The SDK challenge bridge requires Android ARM64');
    const apks=execFileSync('/system/bin/pm',['path','com.supercell.brawlstars'],{encoding:'utf8',timeout:8000})
      .trim().split(/\r?\n/).filter(line=>line.startsWith('package:')).map(line=>line.slice(8));
    const base=apks.find(p=>path.basename(p)==='base.apk');
    const arm=apks.find(p=>path.basename(p)==='split_config.arm64_v8a.apk') || base;
    if (!base || !arm) throw new Error('Installed Brawl Stars APK files were not found');
    const stat=fs.statSync(arm), stamp=JSON.stringify({apk:arm,size:stat.size,mtime:stat.mtimeMs});
    const lib=path.join(runtime,'libsupercell_brawlstars.so'), marker=path.join(runtime,'source.json');
    fs.mkdirSync(runtime,{recursive:true,mode:0o700});
    if (!fs.existsSync(lib) || !fs.existsSync(marker) || fs.readFileSync(marker,'utf8')!==stamp) {
      const bytes=execFileSync('unzip',['-p',arm,'lib/arm64-v8a/libsupercell_brawlstars.so'],{timeout:10000,maxBuffer:16*1024*1024});
      if (bytes.length<4 || bytes.subarray(0,4).toString('hex')!=='7f454c46') throw new Error('The installed SDK library is missing or invalid');
      fs.writeFileSync(lib+'.tmp',bytes,{mode:0o600});
      fs.chmodSync(lib+'.tmp',0o500);
      fs.renameSync(lib+'.tmp',lib);
      fs.writeFileSync(marker,stamp);
    }
    // Android requires read-only DEX/JAR files.
    fs.chmodSync(bridge,0o444);
    let stdout;
    try {
      stdout=execFileSync(appProcess,[`-Djava.library.path=${runtime}`,'/system/bin','BrawlChallengeBridge'],{
        env:{...process.env,CLASSPATH:`${bridge}:${base}`},
        input:challenge.toString('hex')+'\n',encoding:'utf8',timeout:12000,maxBuffer:512*1024,
      });
    } catch (error) {
      const detail=String(error.stderr||error.message).slice(-1800);
      throw new Error(`SDK challenge call failed: ${detail}`);
    }
    const line=stdout.split(/\r?\n/).find(s=>s.startsWith('BRAWL_CHALLENGE_RESPONSE:'));
    if (!line) throw new Error('SDK bridge returned no challenge response');
    const response=Buffer.from(line.slice('BRAWL_CHALLENGE_RESPONSE:'.length),'base64');
    if (!response.length || response.length>255) throw new Error('SDK bridge returned an invalid response length');
    return response;
  }
}
module.exports=AndroidChallengeBridge;

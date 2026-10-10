const fs=require('fs');
const path=require('path');

function apply(config,root) {
  const license=fs.readFileSync(path.resolve(root,config.clientLicensePath||'client-license.bin'));
  if(license.length<58 || license.readUInt16LE(56)>license.length-58) throw new Error('Invalid installed Nulls APK license block');
  if(!Number.isSafeInteger(config.apkSize)||config.apkSize<=0) throw new Error('Nulls APK size is required');
  config.loginClientSeed=(config.apkSize^4330295)|0;
  config.createHelloExtra=()=>Buffer.concat([license,Buffer.from(JSON.stringify({features:['high_memory'],timestamp:Date.now(),connection:'Keep-Alive',modificationIds:[]})+'\0')]);
  return config;
}
module.exports={apply};

const alphabet='QWERTYUPASDFGHJKLZCVBNM23456789';
function decode(code) {
  const text=String(code).trim().toUpperCase();
  if (!/^X[A-Z2-9]{1,12}$/.test(text)) throw new Error('Room code must begin with X');
  let value=0n;
  for (const ch of text.slice(1)) {
    const digit=alphabet.indexOf(ch);
    if (digit<0) throw new Error(`Invalid room-code character: ${ch}`);
    value=value*31n+BigInt(digit);
  }
  if (value>0x7fffffffffn) throw new Error('Room code exceeds the native ID range');
  return {code:text,hi:Number(value&255n),lo:Number(value>>8n)};
}
function encode(hi,lo) {
  if(!Number.isInteger(hi)||hi<0||hi>255||!Number.isInteger(lo)||lo<0||lo>0x7fffffff)throw new Error('Invalid team ID');
  let v=(BigInt(lo)<<8n)|BigInt(hi),out='';
  do { out=alphabet[Number(v%31n)]+out;v/=31n; } while(v);
  return 'X'+out;
}
module.exports={decode,encode};

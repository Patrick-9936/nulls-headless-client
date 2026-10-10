const test=require('node:test');
const assert=require('node:assert/strict');
const {decode}=require('../utils/TeamCode');
test('room code matches the native base-31 decoder and LogicLong split',()=>{
  assert.deepEqual(decode('XEDFYRN7'),{code:'XEDFYRN7',hi:8,lo:8092227});
  assert.throws(()=>decode('XIO0'),/Room code|Invalid/);
});

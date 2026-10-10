"""Read installed APK metadata/assets; never modify the APK."""
import json, re, struct, subprocess, sys
from pathlib import Path
from zipfile import ZipFile

def license_block(apk):
    with Path(apk).open('rb') as f:
        f.seek(0, 2); size=f.tell(); f.seek(max(0,size-65557)); tail=f.read()
        at=tail.rfind(b'PK\x05\x06')
        if at<0 or at+22>len(tail): raise ValueError('APK ZIP end record missing')
        cd=struct.unpack_from('<I',tail,at+16)[0]
        if cd==0xffffffff or cd<24: raise ValueError('Unsupported APK ZIP directory')
        f.seek(cd-24); footer=f.read(24)
        if footer[8:]!=b'APK Sig Block 42': raise ValueError('APK signing block missing')
        length=struct.unpack_from('<Q',footer)[0]
        if length<24 or length>16*1024*1024 or length+8>cd: raise ValueError('Invalid APK signing block size')
        f.seek(cd-length-8); block=f.read(length+8)
        if struct.unpack_from('<Q',block)[0]!=length: raise ValueError('APK signing block sizes differ')
        off=8; end=len(block)-24
        while off<end:
            if off+8>end: raise ValueError('Truncated APK signing entry')
            n=struct.unpack_from('<Q',block,off)[0];off+=8
            if n<4 or off+n>end: raise ValueError('Invalid APK signing entry size')
            ident=struct.unpack_from('<I',block,off)[0]
            if ident==0x544e3713: return block[off+4:off+n]
            off+=n
    raise ValueError('Nulls license entry 0x544e3713 missing')

def extract(base, libs, out, expected):
    badging=subprocess.check_output(['aapt2','dump','badging',base],text=True,timeout=20)
    m=re.search(r"package: name='([^']+)'[^\n]*versionName='([^']+)'",badging)
    if not m or m[1]!=expected: raise ValueError('APK package does not match this client')
    if not re.fullmatch(r'\d+\.\d+',m[2]): raise ValueError('Unsupported APK versionName: '+m[2])
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    found=False; fingerprint=None
    for apk in dict.fromkeys([libs,base]):
        with ZipFile(apk) as z:
            if not found and 'lib/arm64-v8a/libg.so' in z.namelist():
                item=z.getinfo('lib/arm64-v8a/libg.so')
                if item.file_size>128*1024*1024: raise ValueError('libg size exceeds extraction limit')
                (out/'libg.so').write_bytes(z.read(item));found=True
            if 'assets/fingerprint.json' in z.namelist():
                fingerprint=json.loads(z.read('assets/fingerprint.json'))
    if not found: raise ValueError('ARM64 libg.so missing; supply its APK split')
    license_path=None
    if expected=='daniillnull.nulls.brawlstars':
        data=license_block(base)
        if len(data)<58 or struct.unpack_from('<H',data,56)[0]>len(data)-58: raise ValueError('Invalid Nulls license')
        license_path=str(out/'client-license.bin');Path(license_path).write_bytes(data)
    return {'package':m[1],'appVersion':m[2],'apkSize':Path(base).stat().st_size,'libgPath':str(out/'libg.so'),'licensePath':license_path,'fingerprint':fingerprint}

if __name__=='__main__':
    try: print(json.dumps(extract(*sys.argv[1:5])))
    except Exception as e: print('APK extraction failed: '+str(e),file=sys.stderr);sys.exit(1)

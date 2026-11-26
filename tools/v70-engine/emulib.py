import struct, json
from unicorn import *
from unicorn.arm64_const import *
import os
_LIB=os.environ.get('LIBG64_PATH','libg64.so')
D=open(_LIB,'rb').read()
# parse phdrs
e_phoff=struct.unpack('<Q',D[0x20:0x28])[0]; e_phnum=struct.unpack('<H',D[0x38:0x3a])[0]; e_phent=struct.unpack('<H',D[0x36:0x38])[0]
LOADS=[];DYN=None
for i in range(e_phnum):
    ph=D[e_phoff+i*e_phent:e_phoff+(i+1)*e_phent]
    t=struct.unpack('<I',ph[0:4])[0];off=struct.unpack('<Q',ph[8:16])[0];va=struct.unpack('<Q',ph[16:24])[0]
    fsz=struct.unpack('<Q',ph[32:40])[0];msz=struct.unpack('<Q',ph[40:48])[0]
    if t==1: LOADS.append((off,va,fsz,msz))
    if t==2: DYN=off
def v2o(va):
    for off,v,fsz,msz in LOADS:
        if v<=va<v+msz: return off+(va-v)
    return None
dt={}
o=DYN
while True:
    tag,val=struct.unpack('<QQ',D[o:o+16]);o+=16
    if tag==0:break
    dt[tag]=val
PAGE=0x1000
def al(x):return x&~(PAGE-1)
def alup(x):return (x+PAGE-1)&~(PAGE-1)
STUB=0x90000000   # base for libc stubs
HEAP=0xa0000000   # bump allocator
class Emu:
    def __init__(self, trace_calls=False, trace_key_reads=False):
        self.u=Uc(UC_ARCH_ARM64,UC_MODE_ARM)
        self.heap=HEAP
        self.calls=[]; self.keyreads=[]
        self.trace_calls=trace_calls; self.trace_key=trace_key_reads
        self._map_segments(); self._relocate(); self._plt(); self._tls_stack()
        self.u.hook_add(UC_HOOK_MEM_UNMAPPED, self._on_fault)
        self.u.hook_add(UC_HOOK_CODE, self._on_code)
        if trace_key_reads:
            self.u.hook_add(UC_HOOK_MEM_READ, self._on_read)
    def _map_segments(self):
        for off,va,fsz,msz in LOADS:
            b=al(va); e=alup(va+msz); 
            try:self.u.mem_map(b,e-b,UC_PROT_ALL)
            except: pass
            self.u.mem_write(va, D[off:off+fsz])
    def _relocate(self):
        rela=v2o(dt[7]); cnt=dt[8]//24
        buf=bytearray()
        for i in range(cnt):
            r=rela+i*24
            r_off,r_info,r_add=struct.unpack('<QQq',D[r:r+24])
            if (r_info&0xffffffff)==1027:  # RELATIVE: *off = base(0)+addend
                self.u.mem_write(r_off, struct.pack('<Q', r_add & 0xffffffffffffffff))
    def _plt(self):
        strtab=v2o(dt[5]); symtab=v2o(dt[6]); jmprel=v2o(dt[23]); pltsz=dt[2]
        self.stub2name={}
        def sname(idx):
            e=symtab+idx*24; n=struct.unpack('<I',D[e:e+4])[0]; end=D.find(b'\x00',strtab+n); return D[strtab+n:end].decode()
        self.u.mem_map(STUB, 0x100000, UC_PROT_ALL)
        for i in range(pltsz//24):
            r=jmprel+i*24
            r_off,r_info,r_add=struct.unpack('<QQq',D[r:r+24])
            stub=STUB+i*4
            self.u.mem_write(r_off, struct.pack('<Q', stub))
            self.stub2name[stub]=sname(r_info>>32)
    def _tls_stack(self):
        self.u.mem_map(0x70000000,0x400000,UC_PROT_ALL)  # stack
        self.u.mem_map(0x7f000000,0x10000,UC_PROT_ALL)   # TLS
        self.u.reg_write(UC_ARM64_REG_TPIDR_EL0, 0x7f008000)
        self.u.mem_write(0x7f008028, b'\x55'*8)  # stack canary
        self.u.mem_map(HEAP, 0x2000000, UC_PROT_ALL)
    def alloc(self,n):
        p=self.heap; self.heap=(self.heap+n+15)&~15; return p
    def _on_fault(self,u,access,address,size,value,ud):
        b=al(address)
        try:u.mem_map(b,PAGE,UC_PROT_ALL)
        except:pass
        return True
    def _on_read(self,u,access,address,size,value,ud):
        # log reads of 32 bytes from rodata (<0x6a0000) => candidate key material
        if size in (8,16) and 0x90000<=address<0x6a0000:
            self.keyreads.append(address)
    def _on_code(self,u,address,size,ud):
        if address in self.stub2name:
            self._libc(self.stub2name[address])
            # return: pc=lr
            u.reg_write(UC_ARM64_REG_PC, u.reg_read(UC_ARM64_REG_LR))
            return
        if self.trace_calls:
            # log bl target (this fires every instr; only record if it's a function entry we care about — skip)
            pass
    def _libc(self,name):
        u=self.u
        x0=u.reg_read(UC_ARM64_REG_X0);x1=u.reg_read(UC_ARM64_REG_X1);x2=u.reg_read(UC_ARM64_REG_X2);x3=u.reg_read(UC_ARM64_REG_X3)
        R=UC_ARM64_REG_X0
        if name in('memcpy','memmove'):
            u.mem_write(x0,bytes(u.mem_read(x1,x2))); u.reg_write(R,x0)
        elif name=='__memcpy_chk':
            u.mem_write(x0,bytes(u.mem_read(x1,x2))); u.reg_write(R,x0)
        elif name=='memset':
            u.mem_write(x0,bytes([x1&0xff])*x2); u.reg_write(R,x0)
        elif name=='memcmp':
            a=bytes(u.mem_read(x0,x2));b=bytes(u.mem_read(x1,x2)); u.reg_write(R,0 if a==b else 1)
        elif name=='strlen':
            s=b'';p=x0
            while True:
                c=u.mem_read(p,1)
                if c==b'\x00':break
                s+=bytes(c);p+=1
                if len(s)>4096:break
            u.reg_write(R,len(s))
        elif name in('_Znwm','_Znam'):  # operator new
            u.reg_write(R,self.alloc(max(x0,16)))
        elif name in('_ZdlPv','_ZdaPv','free'):
            pass
        elif name in('__cxa_guard_acquire',):
            u.reg_write(R,1)
        else:
            # default: return 0 / nop
            u.reg_write(R,0)
    def call(self,addr,args=(),maxins=20_000_000):
        u=self.u
        u.reg_write(UC_ARM64_REG_SP,0x70300000)
        LRS=0x4b4b000000
        u.reg_write(UC_ARM64_REG_LR,LRS)
        for i,a in enumerate(args):
            u.reg_write([UC_ARM64_REG_X0,UC_ARM64_REG_X1,UC_ARM64_REG_X2,UC_ARM64_REG_X3,UC_ARM64_REG_X4,UC_ARM64_REG_X5,UC_ARM64_REG_X6,UC_ARM64_REG_X7][i],a)
        try:
            u.emu_start(addr,LRS,count=maxins)
            return True,None
        except UcError as e:
            return False,(u.reg_read(UC_ARM64_REG_PC),str(e))

# --- tracing helpers for crypto discovery ---
import re as _re, capstone as _cs
from unicorn.arm64_const import UC_ARM64_REG_X0 as _X0
_MD=_cs.Cs(_cs.CS_ARCH_ARM64,_cs.CS_MODE_ARM); _MD.detail=True
_REGMAP={}
import unicorn.arm64_const as _ac
for _n in dir(_ac):
    if _n.startswith('UC_ARM64_REG_'):
        _REGMAP[_n[len('UC_ARM64_REG_'):].lower()]=getattr(_ac,_n)
def trace_run(entry, args=(), maxins=3_000_000):
    e=Emu()
    calls=[]; roreads=[]
    def code_hook(u,address,size,ud):
        if address in e.stub2name:
            e._libc(e.stub2name[address]); u.reg_write(UC_ARM64_REG_PC,u.reg_read(UC_ARM64_REG_LR)); return
        b=bytes(u.mem_read(address,4))
        ins=next(_MD.disasm(b,address),None)
        if ins and ins.mnemonic in ('bl','blr'):
            if ins.mnemonic=='bl':
                m=_re.search(r'#(0x[0-9a-fA-F]+)',ins.op_str); tgt=int(m.group(1),16) if m else 0
            else:
                rn=ins.op_str.strip(); tgt=u.reg_read(_REGMAP.get(rn,_X0))
            calls.append((address,tgt))
    def rd_hook(u,access,address,size,value,ud):
        if 0x90000<=address<0x6a0000 and size>=4: roreads.append((address,size))
    e.u.hook_add(UC_HOOK_CODE, code_hook)
    e.u.hook_add(UC_HOOK_MEM_READ, rd_hook)
    for i,a in enumerate(args): e.u.reg_write([UC_ARM64_REG_X0,UC_ARM64_REG_X1,UC_ARM64_REG_X2,UC_ARM64_REG_X3,UC_ARM64_REG_X4][i],a)
    e.u.reg_write(UC_ARM64_REG_SP,0x70300000); e.u.reg_write(UC_ARM64_REG_LR,0x4b4b000000)
    err=None
    try: e.u.emu_start(entry,0x4b4b000000,count=maxins)
    except UcError as ex: err=(hex(e.u.reg_read(UC_ARM64_REG_PC)),str(ex))
    return e,calls,roreads,err

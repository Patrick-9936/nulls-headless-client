#!/usr/bin/env python3
"""
v70 login crypto engine for the Nulls Brawl headless client.

The v70 login box is NaCl crypto_box-shaped but uses THREE non-standard
primitives that live inside the game's native library (libg64.so) and have no
reimplementable constants (no salsa/chacha/poly tables). This module drives
those three primitives directly, by emulating the aarch64 library with Unicorn,
and composes them into a correct login envelope.

Construction (reverse-engineered and verified byte-for-byte against the real
seal 0x8056ec):

    csk      = 32 random bytes (client secret scalar)
    cpk      = X25519_base(csk)                         # standard
    shared   = X25519(csk, server_pk)                   # standard
    nonce    = blake2b(cpk || server_pk, 24)            # standard blake2b
    K        = beforenm(shared)                         # CUSTOM  -> captured from the seal
    buf      = (32 zero bytes) || body
    stream   = 0x830028(buf, buf, len, nonce[16:24]||ctr8, K)   # CUSTOM keystream
    mac_key  = stream[0:32]                             # = keystream over the zero prefix
    ct       = stream[32:]                              # = body XOR keystream tail
    mac      = 0x8262c0(ct, mac_key)  -> 16 bytes       # CUSTOM one-time MAC
    envelope = cpk(32) || mac(16) || ct(len)            # what goes on the wire after the 10101 header

The server derives the same nonce from cpk (it knows server_pk) and the same K
from its own secret key, so no nonce is transmitted. Because this engine
reproduces the real client's seal exactly, any body it seals is processed by the
server identically to the real client.

Requirements: python3, unicorn, pynacl, and the game's libg64.so (arm64).
Point LIBG64_PATH at your libg64.so (extracted from the APK's lib/arm64-v8a/).

Addresses are for libg64.so protocol v70.877. If the library updates, re-run the
discovery tools (see README) to refresh STREAM/MAC/SEAL.
"""
import os, sys, struct, hashlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import emulib  # noqa: E402  (reads LIBG64_PATH at import)
from unicorn import UcError, UC_HOOK_CODE  # noqa: E402
from unicorn.arm64_const import (  # noqa: E402
    UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2, UC_ARM64_REG_X3,
    UC_ARM64_REG_X4, UC_ARM64_REG_PC, UC_ARM64_REG_SP, UC_ARM64_REG_LR,
    UC_ARM64_REG_X30,
)
import nacl.bindings as nb  # noqa: E402

LOADS = emulib.LOADS

# --- function addresses in libg64.so (v70.877) ---
SEAL     = 0x8056ec   # crypto_box seal (used only to capture K per csk)
STREAM   = 0x830028   # keystream/XOR primitive
MAC      = 0x8262c0   # one-time MAC primitive
RANDBYTES = 0x6acab8  # randombytes(buf,len) inside the seal


def _in_load(a):
    for _off, v, _f, m in LOADS:
        if v <= a < v + m:
            return True
    return False


def derive_K(csk, server_pk):
    """Run the real seal with randombytes->csk and read the stream key K (x4) at
    the keystream call. K depends only on csk (via shared/nonce), not on the body,
    so it is valid for sealing any body with this csk."""
    e = emulib.Emu(); u = e.u
    u.mem_map(0x89000000, 0x100000, 7)
    RET, VT, OBJ = 0x89000000, 0x89010000, 0x89020000
    u.mem_write(RET, struct.pack('<I', 0xd65f03c0))  # a bare `ret`
    for off in range(0, 0x8000, 8):
        u.mem_write(VT + off, struct.pack('<Q', RET))
    for off in range(0, 0x8000, 8):
        u.mem_write(OBJ + off, struct.pack('<Q', VT))
    SCR = 0xb0000000; u.mem_map(SCR, 0x400000, 7); bump = [SCR + 0x1000]

    def fresh(n=0x2000):
        p = bump[0]; bump[0] += (n + 15) & ~15; return p

    out = e.alloc(0x800); pt = e.alloc(0x400); non = e.alloc(0x40); pk = e.alloc(0x40)
    u.mem_write(pt, bytes(260)); u.mem_write(non, bytes([0x22] * 24)); u.mem_write(pk, server_pk)
    got = {}

    def ch(uu, a, s, ud):
        nm = e.stub2name.get(a)
        if nm is not None:
            x0 = uu.reg_read(UC_ARM64_REG_X0)
            if nm in ('_Znwm', '_Znam'):
                uu.reg_write(UC_ARM64_REG_X0, fresh(0x400))
            else:
                uu.reg_write(UC_ARM64_REG_X0, x0 if x0 else OBJ)
            uu.reg_write(UC_ARM64_REG_PC, uu.reg_read(UC_ARM64_REG_LR)); return
        if a == RANDBYTES:
            x0 = uu.reg_read(UC_ARM64_REG_X0); x1 = uu.reg_read(UC_ARM64_REG_X1)
            if 0 < x1 <= 64:
                fill = csk[:x1] if x1 <= len(csk) else csk + bytes(x1 - len(csk))
                try:
                    uu.mem_write(x0, fill)
                except Exception:
                    pass
            uu.reg_write(UC_ARM64_REG_PC, uu.reg_read(UC_ARM64_REG_X30)); return
        if a == STREAM and 'K' not in got:
            x4 = uu.reg_read(UC_ARM64_REG_X4)
            got['K'] = bytes(uu.mem_read(x4, 32))
            uu.emu_stop(); return
        if a < 0x1000 or not _in_load(a):
            uu.reg_write(UC_ARM64_REG_X0, OBJ)
            uu.reg_write(UC_ARM64_REG_PC, uu.reg_read(UC_ARM64_REG_X30)); return

    u.hook_add(UC_HOOK_CODE, ch)
    for i, v in enumerate((out, pt, 260, non, pk)):
        u.reg_write([UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2,
                     UC_ARM64_REG_X3, UC_ARM64_REG_X4][i], v)
    u.reg_write(UC_ARM64_REG_SP, 0x70300000); u.reg_write(UC_ARM64_REG_LR, 0x4b4b000000)
    try:
        u.emu_start(SEAL, 0x4b4b000000, count=15000000)
    except UcError:
        pass
    return got.get('K')


def _simple_call(entry, args, in_writes, out_addr, out_len, maxins):
    """Call a leaf crypto primitive with scratch buffers. `in_writes` is a list of
    (offset_index, bytes); addresses are assigned in a private scratch region."""
    e = emulib.Emu(); u = e.u
    SCR = 0xb0000000; u.mem_map(SCR, 0x200000, 7); b = [SCR + 0x1000]

    def fr(n=0x800):
        p = b[0]; b[0] += (n + 15) & ~15; return p

    bufs = [fr(0x800) for _ in range(args)]
    for idx, data in in_writes:
        u.mem_write(bufs[idx], data)

    def ch(uu, a, s, ud):
        nm = e.stub2name.get(a)
        if nm is not None:
            x0 = uu.reg_read(UC_ARM64_REG_X0)
            uu.reg_write(UC_ARM64_REG_X0, x0 if x0 else 0xb0001000)
            uu.reg_write(UC_ARM64_REG_PC, uu.reg_read(UC_ARM64_REG_LR)); return
        if a < 0x1000 or not _in_load(a):
            uu.reg_write(UC_ARM64_REG_PC, uu.reg_read(UC_ARM64_REG_X30)); return

    u.hook_add(UC_HOOK_CODE, ch)
    return e, u, bufs, ch


def _stream(inb, nonce_hi8, K):
    """keystream/XOR: out = in XOR keystream(nonce_hi8||ctr, K).
    Signature: 0x830028(out, in, len, nonce8+ctr, K)."""
    e = emulib.Emu(); u = e.u
    SCR = 0xb0000000; u.mem_map(SCR, 0x200000, 7); b = [SCR + 0x1000]

    def fr(n=0x800):
        p = b[0]; b[0] += (n + 15) & ~15; return p

    out = fr(0x800); i = fr(0x800); p3 = fr(0x80); p4 = fr(0x80)
    u.mem_write(i, inb); u.mem_write(p3, nonce_hi8 + bytes(16)); u.mem_write(p4, K)

    def ch(uu, a, s, ud):
        nm = e.stub2name.get(a)
        if nm is not None:
            x0 = uu.reg_read(UC_ARM64_REG_X0)
            uu.reg_write(UC_ARM64_REG_X0, x0 if x0 else 0xb0001000)
            uu.reg_write(UC_ARM64_REG_PC, uu.reg_read(UC_ARM64_REG_LR)); return
        if a < 0x1000 or not _in_load(a):
            uu.reg_write(UC_ARM64_REG_PC, uu.reg_read(UC_ARM64_REG_X30)); return

    u.hook_add(UC_HOOK_CODE, ch)
    for idx, v in enumerate((out, i, len(inb), p3, p4)):
        u.reg_write([UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2,
                     UC_ARM64_REG_X3, UC_ARM64_REG_X4][idx], v)
    u.reg_write(UC_ARM64_REG_SP, 0x70300000); u.reg_write(UC_ARM64_REG_LR, 0x4b4b000000)
    try:
        u.emu_start(STREAM, 0x4b4b000000, count=8000000)
    except UcError:
        pass
    return bytes(u.mem_read(out, len(inb)))


def _mac(ct, key32):
    """one-time MAC: 0x8262c0(out16, ct, ctlen, key32) -> 16 bytes."""
    e = emulib.Emu(); u = e.u
    SCR = 0xb0000000; u.mem_map(SCR, 0x100000, 7); b = [SCR + 0x1000]

    def fr(n=0x800):
        p = b[0]; b[0] += (n + 15) & ~15; return p

    out = fr(); ctb = fr(0x800); keyb = fr()
    u.mem_write(ctb, ct); u.mem_write(keyb, key32)

    def ch(uu, a, s, ud):
        nm = e.stub2name.get(a)
        if nm is not None:
            x0 = uu.reg_read(UC_ARM64_REG_X0)
            uu.reg_write(UC_ARM64_REG_X0, x0 if x0 else 0xb0001000)
            uu.reg_write(UC_ARM64_REG_PC, uu.reg_read(UC_ARM64_REG_LR)); return
        if a < 0x1000 or not _in_load(a):
            uu.reg_write(UC_ARM64_REG_PC, uu.reg_read(UC_ARM64_REG_X30)); return

    u.hook_add(UC_HOOK_CODE, ch)
    for i, v in enumerate((out, ctb, len(ct), keyb)):
        u.reg_write([UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2, UC_ARM64_REG_X3][i], v)
    u.reg_write(UC_ARM64_REG_SP, 0x70300000); u.reg_write(UC_ARM64_REG_LR, 0x4b4b000000)
    try:
        u.emu_start(MAC, 0x4b4b000000, count=3000000)
    except UcError:
        pass
    return bytes(u.mem_read(out, 16))


def seal_login(csk, server_pk, body, K=None):
    """Return (envelope, info). envelope = cpk || mac || ct, ready to be the
    payload of the 10101 (Login) frame."""
    cpk = nb.crypto_scalarmult_base(csk)
    nonce = hashlib.blake2b(cpk + server_pk, digest_size=24).digest()
    if K is None:
        K = derive_K(csk, server_pk)
        if K is None:
            raise RuntimeError("derive_K failed (check LIBG64_PATH / addresses)")
    buf = bytes(32) + bytes(body)
    streamed = _stream(buf, nonce[16:24], K)
    mac_key = streamed[:32]
    ct = streamed[32:]
    mac = _mac(ct, mac_key)
    envelope = cpk + mac + ct
    return envelope, dict(cpk=cpk.hex(), nonce=nonce.hex(), K=K.hex(),
                          mac=mac.hex(), ct=ct.hex())


# --- known-answer self test (captured from the real seal, csk = 0x11*32) ---
_KAT = dict(
    server_pk="656AA590749960FCFD2A8567A21AC610753DDCF37CA185966F2AEC372B0E8656",
    csk="11" * 32,
    body="00101111111111111111111111111111111111111111111111",
    cpk="7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13",
    nonce="e0c4364ca13c45194a81e62bbfac85c2ddf88d557fb1bb87",
    K="309e42a94ecce03f419d7dae44f8b1740502331b5edc025edc20ec8f93a06b8f",
    ct="1e76c1a808deda1e6cabf64ee59ee8389eb5b1978fcb6e4f94",
    mac="6dfaf9c3dc2bb4c01e830bb3e6716310",
)


def selftest():
    spk = bytes.fromhex(_KAT["server_pk"]); csk = bytes.fromhex(_KAT["csk"])
    body = bytes.fromhex(_KAT["body"])
    K = derive_K(csk, spk)
    env, info = seal_login(csk, spk, body, K=K)
    ok = all(info[k] == _KAT[k] for k in ("cpk", "nonce", "K", "ct", "mac"))
    for k in ("cpk", "nonce", "K", "ct", "mac"):
        mark = "OK " if info[k] == _KAT[k] else "XX "
        print(f"  {mark}{k:6} {info[k]}")
    print("SELFTEST", "PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.exit(0 if selftest() else 1)

# v70 login crypto engine

The Nulls Brawl v70 login box is NaCl `crypto_box`-shaped, but three of its
primitives are **custom** and live only inside the game's native library
`libg64.so` — they have no standard constants (no salsa/chacha/poly tables) and
cannot be reimplemented in pure JS/Python. This package drives those three
primitives directly by emulating the aarch64 library with **Unicorn**, and
composes them into a correct login envelope.

This is what unblocks login "error 10101" (the server silently dropping the
10101 frame): the old client sealed the login with standard NaCl crypto_box, so
the server's MAC check failed and it dropped the connection. This engine
reproduces the real client's seal **byte-for-byte**, so the server accepts it.

## The construction (reverse-engineered, verified against the real seal)

```
csk      = 32 random bytes                         (client secret scalar)
cpk      = X25519_base(csk)                         standard  (pynacl)
shared   = X25519(csk, server_pk)                   standard  (pynacl)
nonce    = blake2b(cpk || server_pk, 24)            standard  (hashlib)
K        = beforenm(shared)                         CUSTOM    -> captured from seal 0x8056ec
buf      = (32 zero bytes) || body
stream   = 0x830028(buf, buf, len, nonce[16:24]||ctr8, K)   CUSTOM keystream
mac_key  = stream[0:32]
ct       = stream[32:]                              ( = body XOR keystream tail )
mac      = 0x8262c0(ct, mac_key)  -> 16 bytes       CUSTOM one-time MAC
envelope = cpk(32) || mac(16) || ct(len)            payload of the 10101 frame
```

The server derives the same `nonce` from `cpk` (it knows `server_pk`) and the
same `K` from its own secret key, so **no nonce is transmitted**.

## Requirements

- `python3`
- `pip install unicorn pynacl`
- the game's **`libg64.so`** (arm64), extracted from the APK at
  `lib/arm64-v8a/libg64.so`. It is NOT shipped here (proprietary + large).

On **Termux** (phone, no root, no PC):

```bash
pkg install python
pip install unicorn pynacl
# copy your libg64.so next to these files, or set LIBG64_PATH
export LIBG64_PATH=/sdcard/Download/libg64.so
python engine.py        # runs the known-answer self test -> SELFTEST PASS
```

## Use

```python
import os
os.environ["LIBG64_PATH"] = "/path/to/libg64.so"
import engine

server_pk = bytes.fromhex("656AA590749960FCFD2A8567A21AC610753DDCF37CA185966F2AEC372B0E8656")
csk  = os.urandom(32)
body = b"...serialized Login (10101) plaintext..."
envelope, info = engine.seal_login(csk, server_pk, body)
# envelope = cpk || mac || ct  -> send as the payload of the 10101 frame
```

`engine.py` as a script runs `selftest()` and must print `SELFTEST PASS`.

## Addresses (libg64.so, protocol v70.877)

| name       | addr       | role                                           |
|------------|------------|------------------------------------------------|
| `SEAL`     | `0x8056ec` | crypto_box seal; used to capture `K` per csk   |
| `STREAM`   | `0x830028` | keystream / XOR primitive                      |
| `MAC`      | `0x8262c0` | one-time MAC primitive                         |
| `RANDBYTES`| `0x6acab8` | `randombytes(buf,len)` inside the seal         |

If the game updates and these move, re-find them: `STREAM` is the function that
XORs a zero-prefixed buffer and whose output's first 32 bytes become the MAC
key; `MAC` is the next crypto-region call after `STREAM`, taking `(out16, ct,
len, key32)`; `SEAL` is `crypto_box` (calls X25519 twice, then blake2b, then
`STREAM`, then `MAC`). The discovery scripts used to locate them are described
in `docs/V70-CRYPTO-RE-FINDINGS.md`.

## Status

- Crypto construction: **SOLVED and verified** (self-test reproduces the real
  seal's `cpk`, `nonce`, `K`, `ct`, and `mac` exactly).
- Remaining for a full login: the correct 284-byte Login (10101) **plaintext
  body** for v70, and wiring this engine into the handshake (the receive
  direction uses the same custom primitives via the session key).

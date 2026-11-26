#!/usr/bin/env python3
"""
CLI wrapper around engine.py so the Node client can seal the v70 login box by
spawning a subprocess (the three custom primitives run in Unicorn; there is no
pure-JS form).

Usage:
    python engine_cli.py selftest
    python engine_cli.py seal <csk_hex32> <server_pk_hex32> <body_hex>
        -> prints one line: <envelope_hex>   (envelope = cpk || mac || ct)

    # csk may be "-" to let the engine pick a random one; its cpk is in the
    # envelope's first 32 bytes, so the caller does not need csk back.

Set LIBG64_PATH to your libg64.so (arm64). Requires: unicorn, pynacl.
Output is a single hex line on stdout; diagnostics go to stderr.
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine  # noqa: E402


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__, file=sys.stderr); return 2
    cmd = argv[0]
    if cmd == "selftest":
        return 0 if engine.selftest() else 1
    if cmd == "seal":
        if len(argv) != 4:
            print("usage: seal <csk_hex32> <server_pk_hex32> <body_hex>", file=sys.stderr)
            return 2
        csk_hex, spk_hex, body_hex = argv[1], argv[2], argv[3]
        csk = os.urandom(32) if csk_hex == "-" else bytes.fromhex(csk_hex)
        if len(csk) != 32:
            print("csk must be 32 bytes", file=sys.stderr); return 2
        spk = bytes.fromhex(spk_hex)
        if len(spk) != 32:
            print("server_pk must be 32 bytes", file=sys.stderr); return 2
        body = bytes.fromhex(body_hex) if body_hex else b""
        env, info = engine.seal_login(csk, spk, body)
        print(env.hex())
        print("engine: cpk=%s nonce=%s K=%s mac=%s ctlen=%d"
              % (info["cpk"], info["nonce"], info["K"][:16] + "…", info["mac"], len(body)),
              file=sys.stderr)
        return 0
    if cmd == "derivek":
        # Slow step (~60s): compute K and cpk for a csk. Pre-run before connecting.
        if len(argv) != 3:
            print("usage: derivek <csk_hex32> <server_pk_hex32>", file=sys.stderr); return 2
        csk = os.urandom(32) if argv[1] == "-" else bytes.fromhex(argv[1])
        spk = bytes.fromhex(argv[2])
        import nacl.bindings as nb, hashlib
        K = engine.derive_K(csk, spk)
        cpk = nb.crypto_scalarmult_base(csk)
        nonce = hashlib.blake2b(cpk + spk, digest_size=24).digest()
        print("%s %s %s %s" % (csk.hex(), cpk.hex(), nonce.hex(), K.hex()))
        return 0
    if cmd == "sealk":
        # Fast step: seal a plaintext with a precomputed K (skips derive_K).
        if len(argv) != 5:
            print("usage: sealk <csk_hex32> <server_pk_hex32> <K_hex32> <plaintext_hex>", file=sys.stderr); return 2
        csk = bytes.fromhex(argv[1]); spk = bytes.fromhex(argv[2]); K = bytes.fromhex(argv[3])
        body = bytes.fromhex(argv[4]) if argv[4] else b""
        env, info = engine.seal_login(csk, spk, body, K=K)
        print(env.hex())
        print("engine: cpk=%s mac=%s ctlen=%d" % (info["cpk"], info["mac"], len(body)), file=sys.stderr)
        return 0
    print("unknown command: %s" % cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

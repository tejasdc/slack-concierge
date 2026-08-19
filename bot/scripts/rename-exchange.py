#!/usr/bin/env python3
import ctypes
import os
import sys


AT_FDCWD = -100
RENAME_EXCHANGE = 2


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: rename-exchange.py <left> <right>", file=sys.stderr)
        return 2
    left, right = (os.fsencode(os.path.abspath(value)) for value in sys.argv[1:])
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(AT_FDCWD, left, AT_FDCWD, right, RENAME_EXCHANGE) == 0:
        return 0
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))


if __name__ == "__main__":
    raise SystemExit(main())

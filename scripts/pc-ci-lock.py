#!/usr/bin/env python3
"""Hold an OS lock until the parent closes stdin. Crashes release the lock."""
import fcntl
import sys

with open(sys.argv[1], 'a') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(1)
    print('locked', flush=True)
    sys.stdin.read()

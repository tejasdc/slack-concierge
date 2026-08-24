import { dlopen, FFIType, ptr } from "bun:ffi";

export interface KernelPeerCredentials {
  pid: number;
  uid: number;
  gid: number;
}

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const UCRED_BYTES = 12;

const libc = dlopen("libc.so.6", {
  getsockopt: {
    args: [FFIType.int, FFIType.int, FFIType.int, FFIType.ptr, FFIType.ptr],
    returns: FFIType.int,
  },
});

export function unixPeerCredentials(socket: { fd: number }): KernelPeerCredentials {
  const credentials = new Int32Array(3);
  const length = new Uint32Array([UCRED_BYTES]);
  const result = libc.symbols.getsockopt(
    socket.fd,
    SOL_SOCKET,
    SO_PEERCRED,
    ptr(credentials),
    ptr(length),
  );
  if (result !== 0 || length[0] !== UCRED_BYTES) {
    throw new Error("The kernel could not authenticate the Unix peer credentials.");
  }
  const [pid, uid, gid] = credentials;
  if (pid < 1 || uid < 0 || gid < 0) throw new Error("The Unix peer credentials are invalid.");
  return { pid, uid, gid };
}

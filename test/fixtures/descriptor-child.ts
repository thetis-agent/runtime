/** Demonstrate explicit authority forwarding without secrets in argv/env; TE-024. */
import { Socket } from 'node:net';

const socket = new Socket({ fd: 3, readable: true, writable: true });
socket.end('child-used-the-inherited-socket');

/** Share the mandatory namespace setup between runtime processes and their tests; ADR 0012 §8. */
export function namespace(runtime: string, temporaryBytes: number): string[] {
  return ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
    '--ro-bind', runtime, '/runtime', '--proc', '/proc', '--dev', '/dev', '--size', String(temporaryBytes), '--tmpfs', '/tmp', '--setenv', 'PATH', '/runtime/bin:/usr/bin:/bin'];
}

export const seal = ['--remount-ro', '/dev', '--remount-ro', '/'];

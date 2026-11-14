/**
 * 8gent Code - seccomp filter for the Linux sandbox (gap register 8gi-governance#1108, lane 3)
 *
 * Builds a classic-BPF seccomp program as raw bytes, the format `bwrap --seccomp FD` reads.
 * Pure and dependency free, so it is tested on any OS; nothing is compiled or installed.
 *
 * The filter allows by default and refuses the syscalls an untrusted command has no business
 * making: the kernel-attack surface container runtimes and Flatpak block (mount, ptrace, bpf,
 * keyctl, io_uring, kernel modules, perf, userfaultfd, process_vm_*), plus making a new user
 * namespace (unshare / setns / clone with CLONE_NEWUSER, clone3). Mount, network and file
 * reach are already removed by bubblewrap's namespaces; this filter shrinks what a command can
 * ask the shared kernel to do from inside them.
 *
 * A foreign architecture (x86 x32 ABI, or anything not the build arch) is killed outright, so
 * the filter cannot be stepped around by switching syscall tables.
 */

export type SeccompArch = "x64" | "arm64";

const AUDIT_ARCH: Record<SeccompArch, number> = {
	x64: 0xc000003e, // AUDIT_ARCH_X86_64
	arm64: 0xc00000b7, // AUDIT_ARCH_AARCH64
};

/** Denied syscalls with their numbers per architecture (x86_64 table, asm-generic table). */
export const DENIED_SYSCALLS: Record<string, Record<SeccompArch, number>> = {
	// mounts and the new mount API
	mount: { x64: 165, arm64: 40 },
	umount2: { x64: 166, arm64: 39 },
	pivot_root: { x64: 155, arm64: 41 },
	open_tree: { x64: 428, arm64: 428 },
	move_mount: { x64: 429, arm64: 429 },
	fsopen: { x64: 430, arm64: 430 },
	fsconfig: { x64: 431, arm64: 431 },
	fsmount: { x64: 432, arm64: 432 },
	fspick: { x64: 433, arm64: 433 },
	mount_setattr: { x64: 442, arm64: 442 },
	// namespaces
	unshare: { x64: 272, arm64: 97 },
	setns: { x64: 308, arm64: 268 },
	// other processes' memory
	ptrace: { x64: 101, arm64: 117 },
	process_vm_readv: { x64: 310, arm64: 270 },
	process_vm_writev: { x64: 311, arm64: 271 },
	kcmp: { x64: 312, arm64: 272 },
	// kernel attack surface
	bpf: { x64: 321, arm64: 280 },
	perf_event_open: { x64: 298, arm64: 241 },
	userfaultfd: { x64: 323, arm64: 282 },
	io_uring_setup: { x64: 425, arm64: 425 },
	io_uring_enter: { x64: 426, arm64: 426 },
	io_uring_register: { x64: 427, arm64: 427 },
	keyctl: { x64: 250, arm64: 219 },
	add_key: { x64: 248, arm64: 217 },
	request_key: { x64: 249, arm64: 218 },
	open_by_handle_at: { x64: 304, arm64: 265 },
	name_to_handle_at: { x64: 303, arm64: 264 },
	lookup_dcookie: { x64: 212, arm64: 18 },
	// host administration
	init_module: { x64: 175, arm64: 105 },
	finit_module: { x64: 313, arm64: 273 },
	delete_module: { x64: 176, arm64: 106 },
	kexec_load: { x64: 246, arm64: 104 },
	kexec_file_load: { x64: 320, arm64: 294 },
	reboot: { x64: 169, arm64: 142 },
	swapon: { x64: 167, arm64: 224 },
	swapoff: { x64: 168, arm64: 225 },
	acct: { x64: 163, arm64: 89 },
	quotactl: { x64: 179, arm64: 60 },
	syslog: { x64: 103, arm64: 116 },
	vhangup: { x64: 153, arm64: 58 },
	settimeofday: { x64: 164, arm64: 170 },
	clock_settime: { x64: 227, arm64: 112 },
	clock_adjtime: { x64: 305, arm64: 266 },
	adjtimex: { x64: 159, arm64: 171 },
};

/** x86-only port I/O. */
const X64_ONLY_DENIED: Record<string, number> = { iopl: 172, ioperm: 173 };

const CLONE_NR: Record<SeccompArch, number> = { x64: 56, arm64: 220 };
/** clone3 passes flags in a struct BPF cannot read; ENOSYS makes libc fall back to clone. */
const CLONE3_NR = 435;
const CLONE_NEWUSER = 0x10000000;
const X32_SYSCALL_BIT = 0x40000000;

// BPF opcodes
const LD_W_ABS = 0x20; // BPF_LD | BPF_W | BPF_ABS
const JEQ_K = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
const JGE_K = 0x35; // BPF_JMP | BPF_JGE | BPF_K
const JSET_K = 0x45; // BPF_JMP | BPF_JSET | BPF_K
const RET_K = 0x06; // BPF_RET | BPF_K

const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const EPERM = 1;
const ENOSYS = 38;
const retErrno = (errno: number) => 0x00050000 | errno;

// struct seccomp_data offsets
const OFF_NR = 0;
const OFF_ARCH = 4;
const OFF_ARG0_LO = 16; // little-endian low word of args[0]

export interface BpfInsn {
	code: number;
	jt: number;
	jf: number;
	k: number;
}

const insn = (code: number, k: number, jt = 0, jf = 0): BpfInsn => ({ code, jt, jf, k });

/** The filter as instructions, for tests and review. */
export function buildSeccompProgram(arch: SeccompArch): BpfInsn[] {
	const denied = Object.values(DENIED_SYSCALLS).map((nrs) => nrs[arch]);
	if (arch === "x64") denied.push(...Object.values(X64_ONLY_DENIED));

	const prog: BpfInsn[] = [
		insn(LD_W_ABS, OFF_ARCH),
		insn(JEQ_K, AUDIT_ARCH[arch], 1, 0),
		insn(RET_K, RET_KILL_PROCESS),
		insn(LD_W_ABS, OFF_NR),
	];
	if (arch === "x64") {
		// x32 ABI numbers carry bit 30; refuse the whole table.
		prog.push(insn(JGE_K, X32_SYSCALL_BIT, 0, 1), insn(RET_K, RET_KILL_PROCESS));
	}
	for (const nr of denied) {
		prog.push(insn(JEQ_K, nr, 0, 1), insn(RET_K, retErrno(EPERM)));
	}
	prog.push(insn(JEQ_K, CLONE3_NR, 0, 1), insn(RET_K, retErrno(ENOSYS)));
	// clone(flags, ...): refuse CLONE_NEWUSER. The accumulator still holds nr here.
	prog.push(
		insn(JEQ_K, CLONE_NR[arch], 0, 3),
		insn(LD_W_ABS, OFF_ARG0_LO),
		insn(JSET_K, CLONE_NEWUSER, 0, 1),
		insn(RET_K, retErrno(EPERM)),
		insn(RET_K, RET_ALLOW),
	);
	return prog;
}

/** Encode instructions as the kernel's struct sock_filter array (8 bytes each, little endian). */
export function encodeSeccompProgram(prog: BpfInsn[]): Uint8Array {
	const buf = new ArrayBuffer(prog.length * 8);
	const view = new DataView(buf);
	prog.forEach((p, i) => {
		view.setUint16(i * 8, p.code, true);
		view.setUint8(i * 8 + 2, p.jt);
		view.setUint8(i * 8 + 3, p.jf);
		view.setUint32(i * 8 + 4, p.k >>> 0, true);
	});
	return new Uint8Array(buf);
}

/** Map process.arch to a filter arch, or undefined when we have no table for it. */
export function seccompArchFor(nodeArch: string = process.arch): SeccompArch | undefined {
	return nodeArch === "x64" || nodeArch === "arm64" ? nodeArch : undefined;
}

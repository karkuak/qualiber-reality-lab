/**
 * The three integrity properties of trusted-local input retention that only a
 * seam can measure.
 *
 * Each of these defects is invisible to an end-to-end test on a healthy local
 * filesystem: a regular file on APFS or ext4 will not short-write, will not be
 * swapped mid-open by a cooperative scheduler, and will not make `lstat` fail
 * with anything but `ENOENT`. That is exactly why all three survived review —
 * the happy path proves nothing about any of them.
 *
 * So these tests reach past the package index into the module and drive the
 * internal helpers with injected filesystem calls. The seams exist for this and
 * are deliberately not re-exported from `@erl2/core`: nothing about the public
 * observation contract changes to make them testable.
 */

import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { CODES, Erl2Error } from "@erl2/contracts";
import {
  REAL_FILE_SEAMS,
  assertAbsentTree,
  digestRetainedFile,
  streamInto,
  writeAllSync,
  type TrustedLocalFileSeams,
  type TrustedLocalInputCeilings,
  type TrustedLocalInputMapping,
} from "../src/observation/trustedLocalInputs.js";

/** Task-owned scratch, removed when this file's process ends. */
const owned: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "erl2-core-tlih-"));
  owned.push(dir);
  return dir;
}
after(() => {
  for (const dir of owned.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* cleanup never speaks over a result */
    }
  }
});

const CEILINGS: TrustedLocalInputCeilings = {
  maxInputCount: 8,
  maxInputBytes: 1024 * 1024,
  maxTotalInputBytes: 4 * 1024 * 1024,
};

/** A mapping whose digest is deliberately unused: these cases end before the compare. */
function mappingFor(bytes: Buffer): TrustedLocalInputMapping {
  return {
    inputId: "seam-input",
    mountId: "seam-mount",
    relativePath: "seam.bin",
    logicalPath: "observation-inputs/seam-mount/seam.bin",
    byteLength: bytes.byteLength,
    fileSha256: `sha256:${"0".repeat(64)}` as TrustedLocalInputMapping["fileSha256"],
  };
}

function erl2(error: unknown): Erl2Error {
  assert.ok(error instanceof Erl2Error, `expected an Erl2Error, got ${String(error)}`);
  return error;
}

/**
 * Runs a thunk that must throw, and hands back what it threw.
 *
 * `assert.throws` returns `undefined`, so it can assert *that* something threw
 * but never lets a case inspect the refusal. Every check below is about which
 * refusal was produced — the code, the message, the preserved cause — so the
 * error itself has to come back.
 */
function caught(thunk: () => unknown): unknown {
  try {
    thunk();
  } catch (error) {
    return error;
  }
  assert.fail("the call was expected to refuse and did not");
}

/** An errno-shaped failure, as the filesystem would raise it. */
function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: simulated`);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Correction 1 — every byte that is read and hashed is a byte that is written.
// ---------------------------------------------------------------------------

test("TLI-WRITE: a writer that always short-writes still writes every byte, in order", () => {
  // One byte per call: the most hostile short write that still makes progress.
  const received: { offset: number; length: number; byte: number }[] = [];
  const source = Buffer.from("abcdefghij", "utf8");
  writeAllSync(
    (_fd, buffer, offset, length) => {
      received.push({ offset, length, byte: buffer[offset] as number });
      return 1;
    },
    7,
    source,
    source.byteLength,
    "seam",
  );

  assert.equal(received.length, source.byteLength, "one call per byte was expected");
  // Offsets advance by the returned count and the remaining length shrinks to
  // match. A loop that advanced by the *requested* count would show a constant
  // offset here, and one that never advanced would not terminate at all.
  assert.deepEqual(
    received.map((entry) => entry.offset),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(
    received.map((entry) => entry.length),
    [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  );
  // And the bytes handed over are the source's bytes, in the source's order.
  assert.equal(Buffer.from(received.map((entry) => entry.byte)).toString("utf8"), "abcdefghij");
});

test("TLI-WRITE: an uneven short writer is resumed from the exact byte it stopped at", () => {
  const source = Buffer.from("0123456789abcdef", "utf8");
  const written: number[] = [];
  const plan = [5, 1, 7]; // and then whatever remains
  let call = 0;
  writeAllSync(
    (_fd, buffer, offset, length) => {
      const take = Math.min(plan[call] ?? length, length);
      call += 1;
      for (let i = 0; i < take; i += 1) written.push(buffer[offset + i] as number);
      return take;
    },
    7,
    source,
    source.byteLength,
    "seam",
  );
  assert.equal(Buffer.from(written).toString("utf8"), source.toString("utf8"));
  assert.ok(call > 1, "the plan must have required more than one call");
});

test("TLI-WRITE: a writer that reports no progress refuses instead of looping forever", () => {
  for (const reported of [0, -1, 1.5, Number.NaN]) {
    let calls = 0;
    const error = caught(() =>
      writeAllSync(
        () => {
          calls += 1;
          // A guard that let this through would hang the process rather than
          // fail a case, so the call count below is the real assertion.
          if (calls > 8) throw new Error("writeAllSync looped on a zero-progress writer");
          return reported;
        },
        7,
        Buffer.from("abc", "utf8"),
        3,
        "seam",
      ),
    );
    assert.equal(erl2(error).code, CODES.ADMISSION_RETENTION_FAILED);
    assert.equal(calls, 1, `a ${String(reported)}-byte write must refuse on the first call`);
  }
});

test("TLI-WRITE: a writer claiming more than it was given refuses", () => {
  const error = caught(() => writeAllSync(() => 99, 7, Buffer.from("abc", "utf8"), 3, "seam"));
  assert.equal(erl2(error).code, CODES.ADMISSION_RETENTION_FAILED);
});

test("TLI-WRITE: a short-writing retention still produces a file matching its own digest", () => {
  // The end-to-end shape of the defect. The hash and the length are taken from
  // the bytes *read*, so a write that drops any of them leaves a truncated file
  // carrying the digest and length of the whole one — and every later check,
  // including the offline verifier, would confirm it.
  const root = scratch();
  const bytes = Buffer.alloc(200 * 1024);
  for (let i = 0; i < bytes.byteLength; i += 1) bytes[i] = i % 251;
  const sourcePath = path.join(root, "source.bin");
  writeFileSync(sourcePath, bytes);
  const stagingPath = path.join(root, "staged.bin");

  const shortWriting: TrustedLocalFileSeams = {
    ...REAL_FILE_SEAMS,
    // Never more than 1023 bytes at a time, so no chunk is ever written whole.
    write: (fd, buffer, offset, length) =>
      REAL_FILE_SEAMS.write(fd, buffer, offset, Math.min(length, 1023)),
  };

  const observed = streamInto(sourcePath, stagingPath, mappingFor(bytes), CEILINGS, 0, shortWriting);

  const retained = readFileSync(stagingPath);
  assert.equal(retained.byteLength, observed.byteLength, "the file is shorter than its own length");
  assert.deepEqual(retained, bytes, "the retained bytes are not the source's bytes");
  assert.equal(statSync(stagingPath).size, bytes.byteLength);
  // The digest the run would assert is the digest of what is actually there.
  assert.equal(digestRetainedFile(stagingPath, CEILINGS.maxInputBytes).fileSha256, observed.fileSha256);
});

// ---------------------------------------------------------------------------
// Correction 2 — the file that was inspected is the file that was opened.
// ---------------------------------------------------------------------------

/** Redirects the first open of `from` to `to`, exactly once. */
function swapOnFirstOpen(from: string, to: string): TrustedLocalFileSeams {
  let opens = 0;
  return {
    ...REAL_FILE_SEAMS,
    open: (target, flags) => {
      opens += 1;
      return REAL_FILE_SEAMS.open(target === from && opens === 1 ? to : target, flags);
    },
  };
}

test("TLI-NOFOLLOW: a source replaced between inspection and opening is refused", () => {
  const root = scratch();
  const honest = path.join(root, "honest.bin");
  const attackers = path.join(root, "attackers.bin");
  writeFileSync(honest, Buffer.from("the bytes the operator bound\n", "utf8"));
  writeFileSync(attackers, Buffer.from("the bytes somebody else wants read\n", "utf8"));

  // The window: the pre-open `lstat` sees `honest`, and by the time `open` runs
  // the name resolves to a different regular file. No symlink is involved, so
  // `O_NOFOLLOW` alone would not catch this — the dev/ino comparison does.
  const error = caught(() =>
    streamInto(
      honest,
      path.join(root, "staged.bin"),
      mappingFor(Buffer.alloc(0)),
      CEILINGS,
      0,
      swapOnFirstOpen(honest, attackers),
    ),
  );
  assert.equal(erl2(error).code, CODES.PATH_SYMLINK_REJECTED);
  assert.match(erl2(error).message, /replaced between inspection and reading/);
  // Nothing was staged from the substituted file.
  assert.equal(readFileSync(path.join(root, "honest.bin")).byteLength > 0, true);
});

test("TLI-NOFOLLOW: a retained file replaced between inspection and opening is refused", () => {
  const root = scratch();
  const retained = path.join(root, "retained.bin");
  const substitute = path.join(root, "substitute.bin");
  writeFileSync(retained, Buffer.from("retained bytes\n", "utf8"));
  writeFileSync(substitute, Buffer.from("substituted bytes\n", "utf8"));

  const error = caught(() =>
    digestRetainedFile(retained, CEILINGS.maxInputBytes, swapOnFirstOpen(retained, substitute)),
  );
  assert.equal(erl2(error).code, CODES.PATH_SYMLINK_REJECTED);
});

test("TLI-NOFOLLOW: an ELOOP or EMLINK from the kernel becomes a classified symlink refusal", () => {
  const root = scratch();
  const target = path.join(root, "target.bin");
  writeFileSync(target, Buffer.from("bytes\n", "utf8"));

  // What the kernel actually does when `O_NOFOLLOW` meets a link that appeared
  // inside the window. Winning that race on purpose is not something a test can
  // do portably — but the translation into an ERL2 refusal is ours to prove.
  for (const code of ["ELOOP", "EMLINK"]) {
    const looping: TrustedLocalFileSeams = {
      ...REAL_FILE_SEAMS,
      open: () => {
        throw errno(code);
      },
    };
    const error = caught(() =>
      digestRetainedFile(target, CEILINGS.maxInputBytes, looping),
    );
    assert.equal(erl2(error).code, CODES.PATH_SYMLINK_REJECTED, `${code} was not classified`);
    // Classified, not leaked: an ERL2 refusal reaches the operator, not a raw
    // filesystem exception.
    assert.match(erl2(error).message, /became a symbolic link/);
    assert.equal(erl2(error).owner, "lab");
    assert.equal(erl2(error).cause !== undefined, true, "the original errno was dropped");
  }
});

test("TLI-NOFOLLOW: a descriptor that is not a regular file is refused before any read", () => {
  const root = scratch();
  const directory = path.join(root, "a-directory");
  const file = path.join(root, "a-file.bin");
  writeFileSync(file, Buffer.from("bytes\n", "utf8"));
  mkdirSync(directory, { recursive: true });

  // `lstat` reports a regular file while the path is really a directory. The
  // `fstat` on the opened descriptor is the check that stands between that and
  // a read.
  const misdirecting: TrustedLocalFileSeams = {
    ...REAL_FILE_SEAMS,
    lstat: (target) => REAL_FILE_SEAMS.lstat(target === directory ? file : target),
  };

  const error = caught(() =>
    digestRetainedFile(directory, CEILINGS.maxInputBytes, misdirecting),
  );
  // Both outcomes are fail-closed: the platform may reject a directory at open
  // (EISDIR), or the fstat/identity checks may reject the descriptor.
  const failClosed: readonly string[] = [
    CODES.PATH_NOT_REGULAR_FILE,
    CODES.ADMISSION_RETENTION_FAILED,
    CODES.PATH_SYMLINK_REJECTED,
  ];
  assert.ok(failClosed.includes(erl2(error).code), `unexpected code ${erl2(error).code}`);
});

test("TLI-NOFOLLOW: a real final-component symlink is refused as source and as retained file", () => {
  const root = scratch();
  const target = path.join(root, "target.bin");
  writeFileSync(target, Buffer.from("target bytes\n", "utf8"));
  const link = path.join(root, "link.bin");
  symlinkSync(target, link);

  const asSource = caught(() =>
    streamInto(link, path.join(root, "staged.bin"), mappingFor(Buffer.alloc(0)), CEILINGS, 0),
  );
  assert.equal(erl2(asSource).code, CODES.PATH_SYMLINK_REJECTED);

  const asRetained = caught(() => digestRetainedFile(link, CEILINGS.maxInputBytes));
  assert.equal(erl2(asRetained).code, CODES.PATH_SYMLINK_REJECTED);
});

test("TLI-NOFOLLOW: ordinary regular files keep working, and every descriptor is closed", () => {
  const root = scratch();
  const bytes = Buffer.from("an ordinary, unremarkable file\n", "utf8");
  const sourcePath = path.join(root, "ordinary.bin");
  writeFileSync(sourcePath, bytes);
  const stagingPath = path.join(root, "ordinary-staged.bin");

  const opened: number[] = [];
  const closed: number[] = [];
  const counting: TrustedLocalFileSeams = {
    ...REAL_FILE_SEAMS,
    open: (target, flags) => {
      const fd = REAL_FILE_SEAMS.open(target, flags);
      opened.push(fd);
      return fd;
    },
    close: (fd) => {
      closed.push(fd);
      REAL_FILE_SEAMS.close(fd);
    },
  };

  const observed = streamInto(sourcePath, stagingPath, mappingFor(bytes), CEILINGS, 0, counting);
  assert.equal(observed.byteLength, bytes.byteLength);
  assert.deepEqual(readFileSync(stagingPath), bytes);
  assert.deepEqual(closed, opened, "a source descriptor was left open");

  // And the retained-file reader agrees with the producer about the same bytes.
  const reread = digestRetainedFile(stagingPath, CEILINGS.maxInputBytes);
  assert.equal(reread.fileSha256, observed.fileSha256);
  assert.equal(reread.byteLength, observed.byteLength);
});

// ---------------------------------------------------------------------------
// Correction 3 — absence means ENOENT and nothing else.
// ---------------------------------------------------------------------------

test("TLI-ABSENT: ENOENT is absence", () => {
  const root = scratch();
  assert.doesNotThrow(() =>
    assertAbsentTree(path.join(root, "never-created"), () => {
      throw errno("ENOENT");
    }),
  );
  // And for real: a path that genuinely is not there.
  assert.doesNotThrow(() => assertAbsentTree(path.join(root, "also-never-created")));
});

test("TLI-ABSENT: every other inspection failure is a refusal that keeps its cause", () => {
  const root = scratch();
  const probe = path.join(root, "probe.bin");

  // Each of these is a condition under which the previous code said "nothing
  // here, go ahead" and then overwrote whatever was actually at the path.
  for (const code of ["EACCES", "EPERM", "EIO", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]) {
    const failure = errno(code);
    const error = caught(() =>
      assertAbsentTree(probe, () => {
        throw failure;
      }),
    );
    assert.equal(erl2(error).code, CODES.ADMISSION_RETENTION_FAILED, `${code} must refuse`);
    assert.match(
      erl2(error).message,
      /not a path that is known to be empty/,
      `${code} must say why it refused`,
    );
    // The original errno survives, so an operator can act on the real cause.
    assert.equal(erl2(error).cause, failure, `${code} lost its cause`);
  }

  // An error with no `code` at all is not absence either.
  const untyped = caught(() =>
    assertAbsentTree(probe, () => {
      throw new Error("something went wrong");
    }),
  );
  assert.equal(erl2(untyped).code, CODES.ADMISSION_RETENTION_FAILED);
});

test("TLI-ABSENT: an existing file or symlink is still a refusal", () => {
  const root = scratch();
  const file = path.join(root, "occupied.bin");
  writeFileSync(file, "taken\n");
  const occupied = caught(() => assertAbsentTree(file));
  assert.equal(erl2(occupied).code, CODES.ADMISSION_RETENTION_FAILED);
  assert.match(erl2(occupied).message, /already exists and will not be overwritten/);

  const link = path.join(root, "occupied-link");
  symlinkSync(file, link);
  const linked = caught(() => assertAbsentTree(link));
  assert.equal(erl2(linked).code, CODES.PATH_SYMLINK_REJECTED);
});

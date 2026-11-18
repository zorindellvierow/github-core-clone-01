// The git layer's view of the forge's store.
//
// This is the interface the other modules implement: the REST layer owns
// repository creation, and the git layer only reads refs/objects and applies
// pushes through these calls. A repository is keyed by `repoKey`, which is
// always "<owner>/<repo>" (for example "octocat/hello-world").
//
// Object identity: `getObject` returns the object's type and its exact raw
// bytes (no loose-object header); `putObject` hashes them the git way
// (SHA-1 over "<type> <size>\0" + raw) and returns the object id. Storing an
// object that already exists is a no-op returning the same id.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredGitObject {
  readonly type: GitObjectType;
  /** The object's exact raw bytes (header excluded). */
  readonly raw: Buffer;
}

export interface GitRef {
  readonly ref: string;
  readonly oid: string;
}

export interface GitStore {
  /** True when the repository exists (it was created through the REST surface). */
  hasRepo(repoKey: string): boolean;

  /** The object with this id, or undefined when the store does not hold it. */
  getObject(oid: string): StoredGitObject | undefined;

  /** Store an object, returning its SHA-1 id. Storing twice returns the same id. */
  putObject(type: GitObjectType, raw: Buffer): string;

  /**
   * Store an object whose id is already known (e.g. computed by a pack
   * decoder), skipping the re-hash. Identical result to putObject.
   */
  putObjectKnown(oid: string, type: GitObjectType, raw: Buffer): void;

  /** The tip a ref points at, or undefined when the ref does not exist. */
  getRef(repoKey: string, ref: string): string | undefined;

  /** Point a ref at an object id (creating the ref when it does not exist). */
  setRef(repoKey: string, ref: string, oid: string): void;

  /** Remove a ref; a no-op when the ref does not exist. */
  deleteRef(repoKey: string, ref: string): void;

  /** The repo's ref generation (0 when untouched); bumped by setRef/deleteRef. */
  refVersion(repoKey: string): number;

  /** Every ref of the repository, sorted by ref name; `prefix` filters by prefix. */
  listRefs(repoKey: string, prefix?: string): GitRef[];
}

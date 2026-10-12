/* ─────────────── Client RPC ─────────────── */

/* ── whose working directory this request means ──

   A request that names no path of its own is about the session's own working
   directory, which is exactly the directory the shell layer already treats as
   home when no workdir is given. Both questions below are that one lookup: which
   repository this request is about, and where a probe of some *other* path may be
   spawned. A probe must never run with the inspected path as its workdir — when
   that directory does not exist the spawn itself fails before git is ever reached
   and the caller sees a rejected promise instead of the diagnosis it asked for. */
function sessionWorkdir(input) {
  /* The async resolution that runs before every handler already went to storage
     for a session that is not live (see `withSessionRepo`), and hands the answer
     back on the input. Read it first so every synchronous reader — including a
     probe whose own target does not exist — sees the session's directory. */
  if (input != null && isStr(input.sessionCwd) && input.sessionCwd.length > 0) return input.sessionCwd
  if (input == null || !isStr(input.sessionId)) return undefined
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return undefined
  try {
    const session = sessions.get(input.sessionId)
    const header = session != null ? session.header : undefined
    const cwd = header != null ? header.cwd : undefined
    if (isStr(cwd) && cwd.length > 0) return cwd
  } catch (error) {
    console.error('dsh-git-idea: could not resolve the session working directory', String(error))
  }
  return undefined
}

/* ── the session's own workspace, resolved before the handler runs ──

   DSH 0.1.7 changed sessions.get(id): it answers for a session that is LIVE in
   this process and nothing else (0.1.5 loaded one from storage). A session the
   reader has just selected is briefly not live while it restores — and one
   selected, switched away from and left there is not live either — so the
   synchronous repoFrom saw no workspace at all and every read answered
   not-a-repository: the panel said「未检测到仓库」while the chip, whose read landed
   a moment later, named the branch.

   So the workspace is resolved once here, before the handler: the live session
   first, its stored header second (sessionPersistence.stat reads the generation
   header without the event log, and never takes ownership). The answer travels
   on the input as sessionCwd — the SESSION's directory, deliberately not the
   requested one, so the probe in 62-panel.js that must not spawn inside a target
   that does not exist keeps the right workdir. */
function sessionCwdOf(input) {
  if (input == null || !isStr(input.sessionId) || input.sessionId.length === 0) return Promise.resolve(undefined)
  const sessions = ctx.get('sessions')
  if (sessions !== undefined) {
    try {
      const live = sessions.get(input.sessionId)
      const header = live != null ? live.header : undefined
      const cwd = header != null ? header.cwd : undefined
      if (isStr(cwd) && cwd.length > 0) return Promise.resolve(cwd)
    } catch (error) {
      console.error('dsh-git-idea: could not read the live session working directory', String(error))
    }
  }
  const store = ctx.get('sessionPersistence')
  if (store === undefined) return Promise.resolve(undefined)
  try {
    return Promise.resolve(store.stat(input.sessionId)).then(function (snapshot) {
      const header = snapshot != null ? snapshot.header : undefined
      const cwd = header != null ? header.cwd : undefined
      return isStr(cwd) && cwd.length > 0 ? cwd : undefined
    }, function () { return undefined })
  } catch (error) {
    return Promise.resolve(undefined)
  }
}

function withSessionRepo(input) {
  if (input == null || !isStr(input.sessionId) || input.sessionId.length === 0) return Promise.resolve(input)
  if (isStr(input.sessionCwd) && input.sessionCwd.length > 0) return Promise.resolve(input)
  return sessionCwdOf(input).then(function (cwd) {
    return cwd === undefined ? input : Object.assign({}, input, { sessionCwd: cwd })
  })
}

function repoFrom(input) {
  if (input != null && isStr(input.repo) && input.repo.trim().length > 0) return input.repo.trim()
  return sessionWorkdir(input)
}

/* Which repository, and on whose behalf. The session id travels with the args so
   the shell layer can ask for that session's sandbox policy — it is the only
   thing that says whether these commands may write at all (see `sandboxFor`).

   Every path that builds these args goes through here, including the ones that
   resolved a path of their own: a request that keeps the repo and drops the
   session id runs under the *deployment* default policy instead of the reader's
   own, which is how `git init` came to be denied on a directory nobody had a
   problem writing to. */
function argsAt(input, repo) {
  const out = repo === undefined || repo === null ? {} : { repo: repo }
  if (input != null && isStr(input.sessionId) && input.sessionId.length > 0) out.sessionId = input.sessionId
  return out
}

function argsFor(input) {
  return argsAt(input, repoFrom(input))
}

/* ── a path that stays inside the repository ──

   Every path the panel sends is one git itself listed, so it is relative to the
   work-tree root. Three of the four diff reads pass it as a pathspec, which git
   keeps inside the repository on its own. The untracked read cannot: it is
   `git diff --no-index -- /dev/null <path>`, and that command reads whatever the
   path names. Measured here, an absolute path came back with the contents of
   /etc/hostname — a file no reader of a git panel asked for. So anything
   absolute, or stepping up with "..", is refused rather than resolved.

   A NUL byte is refused for a different reason: it survives as far as the shell
   layer, where Node's own `spawn` rejects the argument outright (`ERR_INVALID_ARG_VALUE`,
   measured), so the read would throw instead of answering. */
function repoRelativePath(path) {
  if (!isStr(path) || path.length === 0) return 'path is required'
  if (path.charAt(0) === '/' || path.charAt(0) === '\\') return 'path must be relative to the repository root'
  if (path.length > 1 && path.charAt(1) === ':') return 'path must be relative to the repository root'
  if (path.indexOf('\u0000') >= 0) return 'path may not contain a NUL byte'
  const parts = path.split(/[\\/]/)
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === '..') return 'path may not step outside the repository'
  }
  return ''
}

/* ─────────────── per-repository read cache ───────────────

   Opening the panel used to cost nine child processes and nothing was reused,
   so every open re-read the whole repository. Reads are now memoised per
   repository and dropped on any mutation.

   Reads do not age out on a timer. Data may be as old as the last explicit
   invalidation, which is what makes reopening the panel instant; freshness is
   the watcher's job (git/watch below) plus the mutation and refresh paths.

   A miss stores the *promise*, not the value: two surfaces asking for the same
   read at the same moment — the composer chip's full read, and the panel opening
   under it — are one child process instead of two, which on a slow mount is the
   difference between one seven-second `git status` and two. A rejection is never
   kept, so a read that failed can be attempted again, and the value is only
   stored if the entry is still the promise that produced it: an invalidation
   arriving mid-read must not be undone by that read landing afterwards. */

const readCache = new Map()
const READ_CACHE_MAX = 300

async function cached(repo, tag, loader) {
  const key = repo + '\u0000' + tag
  const hit = readCache.get(key)
  if (hit !== undefined) return await hit
  const pending = loader()
  readCache.set(key, pending)
  try {
    const value = await pending
    if (readCache.get(key) === pending) readCache.set(key, value)
    return value
  } catch (error) {
    if (readCache.get(key) === pending) readCache.delete(key)
    throw error
  }
}

/* Invalidate one repository's cached reads. Without tags the whole repository
   goes (the mutation and refresh paths); with tags only those exact entries do —
   `repo + '\0' + tag` is the whole key for the tags the client asks for by name
   (panel-ident, branches), so the deletion is exact and the rest of the cache
   (the graph, the authors, the pathspec reads) survives. This is what makes the
   panel's reopen-time identity re-verification affordable: one cache entry
   re-read, not nine. */
function invalidateRepo(repo, tags) {
  if (repo === undefined || repo === null) { readCache.clear(); return }
  if (Array.isArray(tags) && tags.length > 0) {
    for (let i = 0; i < tags.length; i += 1) {
      if (!isStr(tags[i]) || tags[i].length === 0) continue
      const key = repo + '\u0000' + tags[i]
      readCache.delete(key)
    }
    while (readCache.size > READ_CACHE_MAX) readCache.delete(readCache.keys().next().value)
    return
  }
  const prefix = repo + '\u0000'
  const doomed = []
  readCache.forEach(function (_value, key) {
    if (key.indexOf(prefix) === 0) doomed.push(key)
  })
  for (let i = 0; i < doomed.length; i += 1) readCache.delete(doomed[i])
  /* Oldest first, one key at a time. Clearing the whole map on overflow meant one
     repository's paging dropped every other repository's reads with it. */
  while (readCache.size > READ_CACHE_MAX) readCache.delete(readCache.keys().next().value)
}


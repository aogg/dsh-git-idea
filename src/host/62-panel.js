/* ─────────────── the identity reads, and reading by pathspec ─────────────── */

/* Diagnostics for the "this path is not a repository" setup page. The workdir is
   the session's own directory, never the path being inspected (see
   `sessionWorkdir`). */
async function probeShell(input, command) {
  return await invoke(command, argsAt(input, sessionWorkdir(input)), null, { timeoutMs: 20000 })
}

async function pathKind(input, target) {
  const probe = await probeShell(input, 'if [ -d ' + shq(target) + ' ]; then echo dir; elif [ -f ' + shq(target) + ' ]; then echo file; else echo none; fi')
  const kind = probe.stdout.trim()
  return kind === 'dir' || kind === 'file' ? kind : 'none'
}

/* One shell process answers everything the setup page needs: whether the path
   exists, what it is, git's own status with its exit code carried out
   explicitly, and whether an operation is caught half-done. The previous shape
   cost two or three spawns for the same information. */
/* ── the cheap half of a panel read ──

   `git status` stats every tracked file. On a Windows-mounted worktree of a few
   thousand files that is the whole cost of opening the panel: measured on one
   here, 7.0s for the status against 0.13s for the four commands below. Nothing
   in the composer chip, and nothing in the panel's frame, needs the working
   tree — they need to know whether this path is a repository, which branch it is
   on, where that branch stands against its upstream, and whether a cherry-pick,
   merge or rebase is half-done. The working tree is asked for separately, by the
   request that actually shows it. */
/* ── one directory, no discovery ──

   A workspace is a repository when **that directory** is one: `$dir/.git` (a
   directory, or the file a worktree and a submodule keep there). Git's own
   discovery would instead walk up and answer for whatever repository happens to
   be above — the panel would name another project's branch, its watcher would
   follow that repository's refs, and the answer for a bare subdirectory would
   silently be about a tree the reader never pointed at. So every command below
   tests that one path and stops there; nothing looks upward, and nothing looks
   into the directory either. */
function repoHere(target) {
  return '[ -e ' + shq(target) + '/.git ]'
}

/* The five states in which an operation is caught half-done. Both reads below ask
   for all of them, and they have to stay in step: a state known to one and not
   the other is a panel that offers "continue" on one screen and not the next. */
function sequencerShell() {
  return [
    "    [ -e \"$gd/CHERRY_PICK_HEAD\" ] && printf 'S:cherry-pick\\n'",
    "    [ -e \"$gd/REVERT_HEAD\" ] && printf 'S:revert\\n'",
    "    [ -e \"$gd/MERGE_HEAD\" ] && printf 'S:merge\\n'",
    "    [ -d \"$gd/rebase-merge\" ] && printf 'S:rebase\\n'",
    "    [ -d \"$gd/rebase-apply\" ] && printf 'S:rebase\\n'",
  ].join('\n')
}

/* Whether this machine can sign a commit at all, asked in the same process as
   the rest of the whole-tree read — git's own lookup, and a marker instead of an
   exit code for the same reason `PANEL_NO_GIT` is one (see 10-shell.js). It is
   here so the commit pane can say it before the reader writes a message and gets
   refused, rather than after. */
function identityShell(target) {
  return "    LC_ALL=C " + gitCmd() + " -C " + shq(target) + " var GIT_AUTHOR_IDENT >/dev/null 2>&1 || printf '" + PANEL_NO_IDENT + "\\n'"
}

/* The branch half of the identity read, in one git process instead of three.

   The branch name comes out of `$gd/HEAD` itself rather than out of
   `symbolic-ref`: the gitdir is already in hand, the answer is the one line in
   that file, and the spawn cost a quarter of this read. Reading it also answers
   the case for-each-ref cannot — a repository whose branch has no commit yet
   names that branch, while `refs/heads` is still empty.

   Then one for-each-ref, restricted to that branch, carries the upstream and the
   ahead/behind numbers together. Asking for them separately re-walked the same
   ref table for nothing, and asking for *all* branches instead is far worse than
   it looks: `%(upstream:track)` costs a rev-list pair per branch, 109ms against
   31ms for the single branch on screen on the repository this was measured
   against.

   LC_ALL=C is not decoration either: the words around those numbers are
   translated, and this is the read the composer chip shows. */
function branchIdentityShell(target) {
  return [
    "    b=''",
    '    if [ -f "$gd/HEAD" ]; then',
    '      read -r headline < "$gd/HEAD"',
    '      case "$headline" in',
    "        'ref: refs/heads/'*) b=${headline#'ref: refs/heads/'} ;;",
    '      esac',
    '    fi',
    '    if [ -n "$b" ]; then',
    "      printf 'B:%s\\n' \"$b\"",
    "      printf 'U:%s\\n' \"$(LC_ALL=C " + gitCmd() + " -C " + shq(target) + " for-each-ref --format='%(upstream:short)%1f%(upstream:track)' \"refs/heads/$b\" 2>/dev/null)\"",
    '    fi',
  ].join('\n')
}

/* ── the third refusal that is not the repository's fault ──

   A repository owned by another user is refused outright — `fatal: detected
   dubious ownership in repository at '<path>'` — and as far as `pathShell` can
   see, that refusal is indistinguishable from a directory with no repository at
   all: the stderr is dropped on the floor, `$gd` comes out empty, and the setup
   page tells the reader a perfectly good repository is "not a Git repository"
   (found live: the repository is owned by `node`, dsh runs as root).

   The refusal is git's safe.directory protection, so the fix has to be written
   where git reads that list from: the system or the **global** configuration,
   and nowhere else. This is not a style choice — git deliberately ignores
   `-c safe.directory=...` and every repository-level value for this one key,
   because a repository that could name itself safe would have whitelisted
   itself; only config the repository cannot write counts. `git config --global`
   is the one place a per-repository answer can land and be honored.

   Recognition is pinned to the C locale: git translates its messages, and the
   refusal is matched out of the probe's output, so the probe runs under
   `LC_ALL=C` and matches the one phrase this refusal says there — `dubious
   ownership`. Nothing localized is ever matched, for the same reason
   `PANEL_NO_GIT` is a marker instead of a match on bash's own translated words.

   The fix is idempotent: the global list is asked for first (`--get-all`), and
   `--add` runs only when the path is not already in it — a panel that reads
   every few seconds must not append the same line forever. After the write (or
   the skip), the rev-parse that failed is retried exactly once, and this script
   has no loop: one failed retry is the end of it. When the repository is STILL
   unreadable — the write was refused (a read-only session or sandbox) or the
   entry did not help — the state travels out as the `PANEL_UNSAFE_OWNER`
   marker, the same transport `PANEL_NO_GIT` uses inside this multiplexed
   stdout, so the Host gives the reader a reason of their own and the command
   that fixes it, instead of "not a Git repository". */
const PANEL_UNSAFE_OWNER = 'O:safedir'

function safeDirectoryShell(target) {
  const quoted = shq(target)
  return [
    '    if [ -z "$gd" ]; then',
    '      probe=$(LC_ALL=C ' + gitCmd() + ' -C ' + quoted + ' rev-parse --absolute-git-dir 2>&1)',
    '      case "$probe" in',
    "        *'dubious ownership'*)",
    '          ' + gitCmd() + ' config --global --get-all safe.directory 2>/dev/null | grep -Fxq -- ' + quoted + ' || ' + gitCmd() + ' config --global --add safe.directory ' + quoted + ' >/dev/null 2>&1',
    '          gd=$(' + gitCmd() + ' -C ' + quoted + ' rev-parse --absolute-git-dir 2>/dev/null)',
    "          if [ -z \"$gd\" ]; then printf '" + PANEL_UNSAFE_OWNER + "\\n'; fi",
    '        ;;',
    '      esac',
    '    fi',
  ].join('\n')
}

/* The shape both reads share: the three answers about the path itself, the one
   gitdir both of them need, and the half-done-operation markers — with everything
   that is actually asked of the repository in the middle. Written once because
   the two commands have to keep answering the same way about the same path, and
   only their middles should ever differ. */
function pathShell(target, middle) {
  const quoted = shq(target)
  return [
    'if [ -d ' + quoted + ' ]; then',
    "  printf 'K:dir\\n'",
    /* Asked here, once, before anything that needs git runs. Whether this path
       is a repository is answered by the filesystem above and stays true on a
       machine with no git; what is not true is everything the middle would then
       report, because an empty answer from a git that never ran is not "there is
       nothing here". This is the multiplexed half of `gitGuard` — see there for
       why the answer comes out as a marker instead of an exit code — and it
       stops the script rather than letting the middle fail in a way that would
       be read as git refusing the repository. `pathKind` is deliberately on the
       other side of it: whether the path exists does not need git, so it still
       answers here. */
    '  if ! command -v ' + gitCmd() + ' >/dev/null 2>&1; then printf ' + shq(PANEL_NO_GIT + '\\n') + '; exit 0; fi',
    /* Guarded by `repoHere` and not left to git: without the guard,
       `git rev-parse` in a directory that is not a repository walks up and
       answers for a parent one. */
    '  if ' + repoHere(target) + '; then',
    '    gd=$(' + gitCmd() + ' -C ' + quoted + ' rev-parse --absolute-git-dir 2>/dev/null)',
    safeDirectoryShell(target),
    '  else',
    "    gd=''",
    '  fi',
    middle,
    'elif [ -f ' + quoted + ' ]; then',
    "  printf 'K:file\\n'",
    'else',
    "  printf 'K:none\\n'",
    'fi',
  ].join('\n')
}

function panelIdentityCommand(target) {
  return pathShell(target, [
    '  if [ -z "$gd" ]; then',
    "    printf 'RC:1\\n'",
    "    printf 'fatal: not a git repository\\n'",
    '  else',
    branchIdentityShell(target),
    sequencerShell(),
    "    printf 'RC:0\\n'",
    '  fi',
  ].join('\n'))
}

/* ── reading by pathspec instead of by tree ──

   `git status` stats every tracked file and walks every untracked directory, and
   on a Windows-mounted worktree that is the whole cost of every read this plugin
   makes. Measured on the reader's repository, one whole-tree status: 7.4s
   (13.6s cold), 5.3s with `-uno`, 13.0s with `--untracked-files=all`. The same
   command asked about the 36 paths the changes tree was showing: **0.5s**. The
   working tree is what the panel is showing, so the reads that keep it fresh ask
   about those paths, and only a read that has to answer for the whole tree pays
   for the whole tree.

   The paths come from the client, so each one passes the guard the diff read
   uses (relative, inside the repository, no NUL), and the list is capped: a
   pathspec list is a command line, and a command line has a length. */
const READ_PATHS_MAX = 200

/* How much plain history a filtered graph may lay itself out on. Measured on the
   reader's repository: 200 `fix` matches span 1518 commits, read in 190ms. The
   cap is what keeps a search that matches once per thousand commits from turning
   a keystroke into a whole-history walk — past it, edges leave the page. */
const DAG_MAX = 4000

function readPaths(input) {
  if (input == null || !Array.isArray(input.paths)) return []
  const out = []
  for (let i = 0; i < input.paths.length && out.length < READ_PATHS_MAX; i += 1) {
    const path = input.paths[i]
    if (!isStr(path) || path.length === 0) continue
    if (repoRelativePath(path) !== '') continue
    if (out.indexOf(path) >= 0) continue
    out.push(path)
  }
  return out
}

function pathspecSuffix(paths) {
  if (paths.length === 0) return ''
  return ' -- ' + paths.map(shq).join(' ')
}

function panelCommand(target, paths) {
  const quoted = shq(target)
  const asked = paths == null ? [] : paths
  return pathShell(target, [
    '  if ' + repoHere(target) + '; then',
    "    out=$(" + gitCmd() + " -C " + quoted + " --no-optional-locks -c core.quotePath=false status --porcelain=v2 --branch --untracked-files=normal" + pathspecSuffix(asked) + " 2>&1); rc=$?",
    '  else',
    "    out='fatal: not a git repository'; rc=1",
    '  fi',
    "  printf '%s\n' \"$out\"",
    "  printf 'RC:%s\n' \"$rc\"",
    '  if [ -n "$gd" ]; then',
    sequencerShell(),
    identityShell(target),
    '  fi',
  ].join('\n'))
}

/* One lightweight spawn answers "did anything change?" for the client watcher.
   It deliberately uses --untracked-files=normal: the per-file walk of `all` is
   the expensive part on a large tree, and a collapsed untracked directory still
   changes the signature when its contents do. The ref table and the HEAD file
   cover what the status walk cannot see: a new commit with no worktree change,
   and — the one the working tree is silent about — a branch switch, whether it
   was made here or in a terminal next to us.

   --no-optional-locks is load-bearing, not decoration: a plain `git status`
   refreshes the index cache and takes .git/index.lock to do it, so a background
   poller racing the user's own `git add` makes THEIR command fail. Measured on
   this machine: 15 of 150 adds failed without the flag, 0 of 150 with it, and
   the reported status is identical either way.

   The rule is not "this one call": it is every read this plugin makes. The full
   panel read missed it for a while (so did the `git_status` tool, while the
   plugin still had one) and was caught by a case of exactly this — a fetch that
   triggered auto-gc was blamed first, but
   background gc never touches index.lock (it runs pack-objects --indexed-objects,
   which only reads the index). Whoever writes .git/index is the suspect, and a
   `git status` writes it. `test/gp34a` now holds both the rule and the probe. */
/* What "did anything move?" costs. The status is the expensive part — seconds
   on a slow mount, every tick — and it is only worth paying while something is
   showing the working tree, which is what `deep` asks for. Everything else in
   the signature is three stats, one for-each-ref and one small file read. */
/* ── what this tick deliberately does not fix ──

   A repository git refuses for dubious ownership leaves `$gd` empty here, so the
   tick answers an empty signature until the ownership is settled — and this
   script runs no recognition and no fix of its own. It does not have to: the
   panel read repairs the situation by writing the path into the **global**
   safe.directory list (see `safeDirectoryShell` above), and global configuration
   is read by every later git process — this tick's included. So the tick after
   that write resolves `$gd` again and the signature resumes on its own; nothing
   here changes, and nothing here has to retry. */
function watchCommand(target, deep, paths) {
  const quoted = shq(target)
  const asked = paths == null ? [] : paths
  /* Every git call below is inside `[ -n "$gd" ]`: on a directory that is not a
     repository, git would happily answer for one of its parents, and the
     signature would then follow a tree this workspace does not own. */
  const whenRepo = function (command) {
    return '$(if [ -n "$gd" ]; then ' + command + '; fi)'
  }
  const out = [
    "st() { stat -c '%Y:%s' \"$1\" 2>/dev/null || stat -f '%m:%z' \"$1\" 2>/dev/null; }",
    'if ' + repoHere(target) + '; then',
    '  gd=$(' + gitCmd() + ' -C ' + quoted + ' rev-parse --absolute-git-dir 2>/dev/null)',
    'else',
    "  gd=''",
    'fi',
  ]
  if (deep === true) {
    /* ── the tick asks about the paths on screen ──
       This runs every few seconds while the changes tab is open, and a
       whole-tree status is 7.4s on the reader's mount: the tick then takes
       longer than the interval between ticks, so the poller never stops and
       every cheap read beside it (for-each-ref went 50ms → 143ms) waits behind
       it. The same command over the paths the tree was showing is 0.5s. A file
       that was clean and is now modified is the one thing this cannot see; the
       panel reads the whole tree for that on its own clock. */
    out.push('if [ -n "$gd" ]; then ' + gitCmd() + ' -C ' + quoted + ' --no-optional-locks -c core.quotePath=false status --porcelain=v2 --branch --untracked-files=normal' + pathspecSuffix(asked) + ' 2>&1; fi')
  }
  out.push(
    "printf 'F:%s\\n' \"" + whenRepo(gitCmd() + " -C " + quoted + " for-each-ref --format='%(refname):%(objectname)' refs/heads refs/remotes 2>/dev/null") + "\"",
    "printf 'H:%s\\n' \"" + whenRepo(gitCmd() + " -C " + quoted + " rev-parse -q --verify HEAD 2>/dev/null") + "\"",
    "printf 'I:%s\\n' \"$(st \"$gd/index\")\"",
    /* The HEAD *file*, not just its stamp. Two branches can point at the same
       commit — `git switch -c` always does, and so does any pair left level by a
       fast-forward — and then the ref table, the HEAD sha and often the index are
       byte-identical, so the branch name written in this file is the only thing
       that tells them apart. A stamp is not enough on its own either: it carries
       second resolution, so a switch made in the same second as the previous read
       looks like nothing happened — and then never becomes visible at all. */
    "printf 'R:%s\\n' \"$(cat \"$gd/HEAD\" 2>/dev/null) $(st \"$gd/HEAD\")\"",
    "printf 'P:%s\\n' \"$(st \"$gd/packed-refs\")\"",
  )
  return out.join('\n')
}


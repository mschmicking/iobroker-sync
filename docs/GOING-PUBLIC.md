# Going public: checklist

Everything that has to happen around flipping this repository to public and publishing
v1.0 to npm. Most of it is GitHub settings, which cannot be committed — that is why this
file exists.

Work top to bottom. The ordering in step 4 matters.

---

## 1. Repository settings — do these first, while still private

These change how merges behave, and the release automation depends on them.

> **Branch protection can be created now but will not be enforced yet.** GitHub warns
> "Your rulesets won't be enforced on this private repository until you move to a GitHub
> Team organization account". Reading it back over the API also 403s on the free plan.
> So configure it whenever you like — it starts working the moment the repo is public.
> The settings are listed in step 5.

- [ ] **Settings → General → Pull Requests**
  - [ ] Enable **Allow squash merging**
  - [ ] Disable **Allow merge commits**
  - [ ] Disable **Allow rebase merging**
  - [ ] Set **Default commit message** for squash merges to **Pull request title**

  > **Why squash only:** the commit that lands on `main` is what release-please reads to
  > decide the next version, and the `conventional-commit` check validates the **PR
  > title** — nothing validates the individual commits inside a branch.
  >
  > - _Squash_ → the validated PR title becomes the commit. Always parses. One PR, one
  >   changelog entry.
  > - _Rebase_ → replays every commit from the branch onto `main` with its own message.
  >   "wip", "fix typo" and "oops" land unvalidated, and each is a candidate changelog
  >   entry. Nothing checks them.
  > - _Merge_ → adds "Merge pull request #N from …", which does not parse at all.
  >
  > So **yes, turn rebase merging off** unless you are willing to hand-write conventional
  > commits for every intermediate commit in every branch.

- [ ] **Settings → General → Pull Requests** → enable **Automatically delete head
      branches**

- [ ] **Settings → Actions → General → Workflow permissions** → tick **Allow GitHub
      Actions to create and approve pull requests**

  > **release-please cannot work without this.** It is off by default. The workflow
  > otherwise runs, computes the next version, creates its branch, and then fails at the
  > final step with "GitHub Actions is not permitted to create or approve pull requests".
  > A stale `release-please--branches--main--...` branch is the symptom.

## 2. Secrets and tokens

- [ ] Create an npm account if you do not have one, and enable 2FA on it
- [ ] Create an **automation** access token on npm (Access Tokens → Generate → Automation)
      — a publish token will prompt for 2FA and hang in CI
- [ ] Add it as **Settings → Secrets and variables → Actions → New repository secret**,
      named `NPM_TOKEN`
- [ ] Confirm the package name is still unclaimed: `npm view iobroker-sync` should 404

## 3. Final content pass

- [ ] Add `docs/images/edit-loop.png` — see [docs/images/README.md](images/README.md) for
      what to capture and the personal-data warning. The README references it, so until
      it exists there is a broken image at the top of the page.
- [ ] Re-read the README as a stranger would. It is the npm landing page.
- [ ] Decide the version. `package.json` still says `0.1.0`; releasing as `1.0.0` is a
      commitment to the current CLI surface under semver.

## 3b. Cut the release

release-please only bumps on `feat` and `fix` commits. Everything merged so far is
`ci`/`chore`/`docs`/`test`, so **no release PR will appear on its own**, and the first
release has to be asked for explicitly.

To go straight to 1.0.0, land an empty commit naming the version:

```bash
git commit --allow-empty -m "chore: release 1.0.0" -m "Release-As: 1.0.0"
git push
```

release-please then opens a "chore(main): release 1.0.0" PR that bumps
`package.json`, rewrites `CHANGELOG.md` and updates
`.release-please-manifest.json`. Merging that PR creates the `v1.0.0` tag.

- [ ] Land the `Release-As` commit
- [ ] Review and merge the release PR it opens
- [ ] Confirm the `v1.0.0` tag exists

## 4. Publish and flip — in this order

`npm publish --provenance` attaches a signed attestation that the tarball was built from
a specific commit in this repository. **It only works on a public repository**, so the
release workflow fails while private. That forces this sequence:

1. [ ] **Make the repository public** (Settings → General → Danger Zone)
2. [ ] **Wait for CodeQL to finish its first run**, and read the findings. It has been
       skipping itself this whole time, so its output is genuinely unknown. Going public
       is reversible; `npm publish` is not — so look before you publish.
3. [ ] Remove the `> **Not released yet.**` blockquote from the README quick start, and
       the `RELEASE CHECKLIST` HTML comment beside it
4. [ ] Run **Actions → Release to npm** with `dry_run: true` and read the file list
5. [ ] Run it again with `dry_run: false`
6. [ ] Verify: `npm view iobroker-sync`, then in a clean directory
       `npm i -g iobroker-sync && iob-sync --help`

> The window between step 1 and step 5 is the only time the README promises a package
> that does not exist. Keep it short.

## 5. After going public

Things that only start working once the repository is public:

- [ ] **CodeQL** — the workflow skips itself while private and will run on the next push.
      Check **Security → Code scanning** for findings.
- [ ] **Dependabot** — enable **Settings → Code security → Dependabot alerts** and
      **security updates**. The version-update config in `.github/dependabot.yml` is
      already committed.
- [ ] **Secret scanning + push protection** — Settings → Code security. Push protection
      rejects a commit containing a recognised secret before it reaches GitHub.
- [ ] Run whatever external analysis you planned (SonarQube Cloud). Worth pointing it at
      `src/sync/safe-path.ts` (server-controlled ids become file paths) and
      `src/credentials.ts` specifically.
- [ ] **Branch protection** — now available, since the repository is public.
      **Settings → Rules → Rulesets → New branch ruleset**:

  - Name: `main` (only a label; it appears in the "blocked by" message on a rejected push)
  - Enforcement status: **Active**
  - Target branches: **Include default branch**
  - Rules:
    - [ ] Require a pull request before merging, **required approvals: 0**
    - [ ] Allowed merge methods: **squash only**
    - [ ] Require status checks to pass → `test (22)`, `test (24)`, `audit`,
          `conventional-commit`, `gitleaks`
    - [ ] Require branches to be up to date before merging
    - [ ] Block force pushes, block deletions

  > **Required approvals must be 0 on a solo repository.** GitHub does not let you approve
  > your own pull request, and a ruleset with an empty bypass list does not exempt
  > repository admins — so requiring one approval makes `main` permanently unmergeable,
  > including for Dependabot and the release PR. Zero still forces the PR flow, which is
  > the part that makes the checks run.
  >
  > **Restrict merge methods to squash here too.** The repository setting is a default
  > that can be changed back; the ruleset is the thing that actually holds.

  > A status check can only be selected after it has run at least once, so open a
  > throwaway PR first if the names do not appear in the picker.
  >
  > Leave **Restrict deletions** on and **Require signed commits** off unless you already
  > sign commits — turning it on retroactively blocks your own merges.
  >
  > Note release-please pushes its release branch directly. If you enable "Require a pull
  > request" with bypass disabled, add the GitHub Actions app to the bypass list, or the
  > release PR cannot be created.

- [ ] Add repository topics: `iobroker`, `cli`, `home-automation`, `typescript`
- [ ] Set the repository description and homepage

## 6. Known findings a scanner will report

Not bugs, but they will show up and someone will ask:

- **`test/credentials.test.ts` and `test/auth*.test.ts` contain password-shaped strings.**
  All are fake (`secret`, `correct horse battery staple`, `fake-oauth-token`).
- **The credential store writes the password in plaintext** at mode `0600`. Deliberate:
  there is no portable OS keychain, and the alternative — an env var — leaks into shell
  history and the process list. Documented in `src/credentials.ts`.
- **`192.168.1.13` appears in historical blobs** of the README and a few source comments.
  It is an RFC1918 address on one of the most common home subnets, so it identifies
  nothing, and removing it would need another history rewrite.
- **No `--password` flag exists.** If a reviewer suggests adding one for convenience, the
  reason it is absent is in `src/credentials.ts`: argv is world-readable via `ps`.

## 7. Things deliberately not done

Recorded so they are not mistaken for oversights:

- **No `restore` command.** `cp` + `push` restores source; `diff --against <snapshot>`
  covers seeing what changed. A bulk restore is a destructive operation with no clear
  use case.
- **No `.env` / `__IOBROKER_SECRET_*__` substitution** (the VS Code extension has it). It
  resolves secrets at upload time, so the plaintext lands in `common.source` on the
  server and in every backup snapshot. The `0_userdata.0.secrets.*` runtime pattern is
  strictly safer.
- **No `state set`.** Writing arbitrary ioBroker states from a CLI flag is how a garage
  door opens at 03:00.
- **The legacy `/login` auth path has never run against real hardware.** Current Admin
  uses OAuth2. Covered by tests against the fake server only, and stated in the README's
  Known limitations.

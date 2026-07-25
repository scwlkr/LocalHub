# Zero-cost macOS bundling, updates, and rollback

Research date: 2026-07-25
Decision ticket: [Research zero-cost macOS bundling, updates, and rollback](https://github.com/scwlkr/LocalHub/issues/6)

## Decision

Ship LocalHub v1 for Apple-silicon Macs as one versioned `.tar.gz` on a public
GitHub Release. It contains the LocalHub executable, tested llama.cpp runtime,
libraries, configuration, licenses and—if separately accepted—the SearXNG
sidecar. The Host needs no Bun, Python, compiler, Docker, package manager,
account, billing method, API key, or administrator install.

Install each release in its own user-owned directory. A stable `lh` launcher
selects the current version. Updates are discovered explicitly, verified and
staged without touching the running version, activated only after Host
approval, and rolled back as a complete runtime/state pair.

GitHub documents no total release-size or bandwidth limit (2 GiB per asset),
and standard Actions runners are free for public repositories
([release quotas](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas),
[Actions billing](https://docs.github.com/en/actions/concepts/billing-and-usage#about-billing-for-github-actions)).
Do not use larger runners, LFS, Packages, a hosted updater, or any service with
possible overage.

### Hard Apple constraint

Permanent zero-spend cannot also provide Apple's normal identified-developer,
notarized, warning-free install. Gatekeeper expects downloaded software to be
signed by a registered developer and notarized
([Apple Platform Security](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web)).
Developer ID/notarization require the Apple Developer Program, currently USD
$99 yearly
([membership comparison](https://developer.apple.com/support/compare-memberships/),
[program fee](https://developer.apple.com/help/account/membership/program-enrollment/#payment)).

Ad hoc signing can validate on-disk Mach-O integrity; it supplies neither
Developer ID nor notarization. A Host may need **System Settings > Privacy &
Security > Open Anyway** for every fresh release after its blocked launch;
Apple says that control remains available about one hour
([override procedure](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)).
The installer must disclose this. Never disable Gatekeeper, silently remove
quarantine, or claim a checksum means Apple reviewed the software.

## Exact pins and integrity contract

Use these initial packaging/prototype pins. Replacing one requires a new
reviewed LocalHub release, never a runtime `latest` lookup.

| Component | Exact pin | SHA-256 / package rule |
| --- | --- | --- |
| Bun build/runtime | `bun-v1.3.14`; commit `0d9b296af33f2b851fcbf4df3e9ec89751734ba4` | Official `bun-darwin-aarch64.zip`: `d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620`. Build with this exact Bun; ship the compiled runtime, not this archive. |
| llama.cpp | `b10107`; commit `c0bc8591e8815c63cb01dd3f051a8b0df02501c9` | Official `llama-b10107-bin-macos-arm64.tar.gz`: `b9554ab4c9f6e91199f48387cb4ab27466fb1d724881f81463ef03f6370cfa32`. Preserve its complete extracted tree, dylibs, tools, symlinks, and license. |
| LocalHub | Release tag plus full source commit | Release build generates SHA-256 for the compiled executable and final asset. Missing values block publishing. |
| SearXNG candidate | commit `0909dbc9efb2c6e93e2ad51e60e66417ab291710` | Sidecar, Python/runtime, dependencies, source archive and final-tree hashes must be filled by [Decide the SearXNG bundling and license boundary](https://github.com/scwlkr/LocalHub/issues/14). |

The official release APIs expose the Bun and llama.cpp asset digests
([Bun](https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.3.14),
[llama.cpp](https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b10107)).
Bun supports standalone executables containing packages and the runtime, with
`bun-darwin-arm64` as a target
([Bun executables](https://bun.com/docs/bundler/executables#cross-compile-to-other-platforms)).

Every release includes `release-manifest.json` with LocalHub version/tag/full
commit; target/minimum macOS; final asset name/size/SHA-256; every nested
executable, dylib, runtime, config, license and source archive with
path/version/size/SHA-256; all dependency pins; state schema/rollback target;
and the release-time zero-spend review. GitHub's release schema exposes each
asset's `sha256:` digest
([REST schema](https://docs.github.com/en/rest/releases/releases#get-the-latest-release));
downloaded bytes must match it and the manifest before extraction.

## Bundle, install, and permissions

```text
localhub-vX.Y.Z-darwin-arm64/
  install
  release-manifest.json
  versions/vX.Y.Z/
    bin/localhub
    llama/b10107/...
    search/...                 # only if separately accepted
    licenses/...
    THIRD_PARTY_NOTICES.md
```

The installer verifies the platform, manifest, full tree and architectures,
then writes only:

```text
~/.local/bin/lh
~/Library/Application Support/LocalHub/
  current -> versions/vX.Y.Z
  previous -> versions/vW.Y.Z
  versions/...  state/...  state-backups/...
~/Library/Caches/LocalHub/updates/...
~/Library/Logs/LocalHub/...
~/Library/LaunchAgents/dev.localhub.server.plist
```

Apple documents Application Support for private app-managed data
([file-system guidance](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/ManagingFIlesandDirectories/ManagingFIlesandDirectories.html)).
Keep mutable state and Host-chosen model storage outside executable versions;
use owner-only permissions for state, config, staging and Attachments. Do not
write `/usr/local`, `/opt/homebrew`, `/Library`, `/Applications`, use `sudo`, or
delete models during install/update.

If `~/.local/bin` is absent from `PATH`, offer one explicit, reversible zsh
profile edit and show it. Run the server as a per-user Launch Agent with no
login autostart. Apple recommends `launchd` for per-user background processes
and notes they run only while the user is logged in
([launch agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)).
After `lh` starts it, supervision continues until `lh stop` unloads it; logout,
restart, shutdown, fatal failure or uninstall still ends the Run.

Offer the same immutable pin as:

1. a download whose displayed SHA-256 the Host verifies before `install`; and
2. one pasted command containing the exact tag, asset name and expected
   SHA-256, downloading to a temporary directory before the same installer.

Never pipe a mutable, unverified `latest` script to a shell. Both paths run
version, manifest and no-model diagnostics before success.

Expected Host approvals are limited and visible:

- Gatekeeper **Open Anyway** may be required per release.
- With the firewall enabled, the first LAN connection may require Allow;
  macOS denies it until the Host acts
  ([firewall behavior](https://support.apple.com/guide/mac-help/block-connections-to-your-mac-with-a-firewall-mh34041/mac)).
- A denied per-app Local Network setting must be diagnosed, never changed
  ([Local Network](https://support.apple.com/guide/mac-help/control-access-to-your-local-network-mchla4f49138/mac)).
- LocalHub needs no Full Disk Access, Accessibility, Automation, camera,
  microphone, Photos-library or administrator permission. It reads its state,
  Host-selected models and deliberate temporary Attachments only.

Ad hoc sign each Mach-O/dylib after assembly, nested code outward, then verify
every signature/architecture. Apple warns not to use `--deep` for signing
([signing guidance](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/)).
Record the expected `spctl --assess` rejection as evidence, not failure.

llama.cpp is MIT and requires its notice to remain
([pinned license](https://raw.githubusercontent.com/ggml-org/llama.cpp/b10107/LICENSE)).
Bun is MIT but identifies statically linked LGPL JavaScriptCore/WebKit and
relink-material duties
([Bun license](https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.14/LICENSE.md)).
Ship complete notices and relink/source material after focused license review.

If SearXNG ships, keep it an unmodified separate loopback process. AGPL allows
aggregates of independent works but requires Corresponding Source beside
conveyed object code
([aggregate](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/LICENSE#L196-L204),
[source duty](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/LICENSE#L205-L243)).
Ship its license, exact source, dependencies, build scripts and patches beside
the binary, with focused license review. This is engineering guidance, not
legal advice.

## Explicit update and rollback

Only **Check for updates** or `lh update check` contacts GitHub's public
latest-release endpoint; there is no polling, background download or automatic
install. Published release metadata is public
([GitHub REST](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)).
Network failure means “Could not check,” not “Up to date.” Ignore drafts,
prereleases, wrong architectures and incomplete/incompatible manifests.

Discovery may find a tag; execution pins that tag, asset, size and digest and
shows release/runtime changes. Never execute a mutable
`releases/latest/download/...` target.

Enable GitHub immutable releases before any distributable build. GitHub says
immutability locks tags/assets and creates a release attestation
([guarantees](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)).
LocalHub had this setting **disabled on 2026-07-25**; this research did not
change it. Publishing is blocked until enabled and verified. Build a draft,
upload/verify every asset, then publish as GitHub recommends
([workflow](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release)).

After Host approval:

1. Download into owner-only staging; verify transport, size, GitHub digest,
   manifest, every file, architecture and license/source inventory.
2. Extract a new version without changing `current`; run offline self-tests and
   exact llama.cpp no-model smoke test.
3. Check disk, snapshot state/config, and reject migrations that make the
   previous version unreadable.
4. Confirm interruption, drain/cancel per the queue contract, then stop the
   agent.
5. Atomically point `previous` to old `current`, switch `current`, restart and
   verify control API, dashboard, llama.cpp and search sidecar if present.
6. On failure, restore prior pointers/state, restart it and report why. On
   success, retain active plus immediately previous complete version.

Automatic failure rollback is allowed because it restores the Host-approved
known-working version; it cannot change models or Run Profiles. Manual **Roll
back**/`lh rollback` shows both full component sets, confirms, switches the
runtime/state pair and validates it. LocalHub, Bun runtime, llama.cpp,
SearXNG/Python/config/notices are one indivisible unit; models are untouched.

## SearXNG impact and removal

SearXNG requires Python 3.10+ and pinned dependencies
([metadata](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/setup.py#L18-L43),
[requirements](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/requirements.txt#L1-L19)).
One-download therefore means bundling a tested arm64 Python, dependencies,
server, config, licenses and source—not Docker, system Python or first-run
download. It versions/rolls back with LocalHub. Until the separate SearXNG
decision fills its runtime pins/hashes and license evidence, full v1 Web Search
packaging is not release-ready. Prototype acceptance must measure archive and
installed size, idle/search memory, startup, signatures and clean-Mac
Gatekeeper flow.

`lh uninstall` shows exact targets and confirms; stops/unloads the agent;
removes its launcher, versions, staging, launch plist/logs and only its own
profile line. Normal uninstall preserves and prints state, profiles and every
model location. Separate `--purge-state` and `--purge-models` confirmations
enumerate resolved targets and refuse root, home, broad or unresolved paths.
Never change firewall, Gatekeeper, Local Network or other privacy settings.

## Release gates

Release only after a clean supported Mac proves:

1. one-download and one-command install without runtime/build dependencies,
   account, billing, `sudo`, or hidden quarantine bypass;
2. truthful Gatekeeper/firewall/local-network approval and diagnosis;
3. immutable tag/assets, matching hashes, arm64 code and valid ad hoc signing;
4. `lh` supervision, browser/terminal-close survival and complete `lh stop`;
5. exact pinned runtimes with no independent in-place component update;
6. explicit update approval, fail-closed corrupt/incompatible release handling,
   successful forced-failure and manual rollback with unchanged models;
7. safe normal uninstall and separately confirmed narrow purge;
8. complete licenses/notices/source/relink materials and focused review; and
9. release-time confirmation that every host/build/distribution service remains
   exactly $0 with no possible overage.

The b10107 archive was measured on 2026-07-25: its SHA matched GitHub; it
contained arm64 `llama-server`, its dylibs/tools/license; `codesign` accepted
its linker ad hoc signature and `spctl` rejected it. Recheck Apple policy,
GitHub pricing/limits, licenses and every asset each release.

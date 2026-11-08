# Releasing

How to publish a new version so installed copies of jobpls can update to it.

## Where releases live

Installed copies look for updates on the public repo `Nuja1337/jobpls-releases`. It holds only installers. The source repo stays private.

The location is set in two places, `build.publish` in `package.json` and `RELEASES_URL` in `src/shared/defaults.ts`. A test keeps the two matched, so change them together.

## Steps

1. Raise `version` in `package.json` and commit. The version has to go up with every release, because installed copies ignore any version that isn't newer than theirs.
2. Run `npm run dist:win` on Windows. If you ship Linux or macOS, run `npm run dist:linux` and `npm run dist:mac` on those systems and copy the output into `release/` on the machine you release from.
3. Run `npm run release`. It uploads that version's files from `release/` to a draft GitHub release named `v<version>` on `jobpls-releases`, using the gh CLI. It refuses to run if the working tree has uncommitted changes, if the release already exists, or if files are missing.
4. Check the draft on GitHub, then publish it.

   ```bash
   gh release edit v<version> --repo Nuja1337/jobpls-releases --draft=false
   ```

   Installed copies see only published releases. They never see drafts or prereleases.
5. Optionally, tag the source repo with the same version.

## Files for each platform

| Platform | Files |
|---|---|
| Windows | `jobpls-Setup-<version>.exe`, `jobpls-Setup-<version>.exe.blockmap`, `latest.yml` |
| Linux | `jobpls-<version>.AppImage`, `latest-linux.yml` |
| macOS | the `.dmg`, the `.zip`, `latest-mac.yml` |

The `latest*.yml` files tell installed copies which version is newest and how to verify the download. Upload them with the installer, or updates for that platform won't work.

## Signing

The installers aren't code-signed. On Windows, that means SmartScreen shows a warning the first time someone runs the installer. Updates that the app installs by itself don't show it. On macOS, unsigned apps can't install updates by themselves, so the app links to the download page there.

Anyone who controls the GitHub account can ship code to every user. Turn on two-factor sign-in for the account that owns `jobpls-releases`.

## Rules

- Never reuse a version number. Installed copies decide by version alone, and the checksums in `latest*.yml` no longer match a file that was replaced.
- Don't delete a published release while people might still be updating from it.

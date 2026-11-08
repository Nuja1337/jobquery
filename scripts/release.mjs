// Uploads this version's installers to a draft GitHub release on the public releases repo.
// Installed copies only see a release once it's published, so check the draft before publishing.
//
//   npm run release                          notes say "jobpls <version>"
//   npm run release -- --notes-file notes.md notes come from a file
//
// Needs the gh CLI, signed in with write access to the releases repo. See docs/RELEASING.md.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const publish = [pkg.build.publish].flat()[0]
const repo = `${publish.owner}/${publish.repo}`
const version = pkg.version
const tag = `v${version}`
const outDir = path.join(root, pkg.build.directories.output)

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

// The release should match a commit, so the source of every installer can be found later.
if (git('status', '--porcelain')) fail('Commit or stash your changes first, so the release matches a commit.')

// Each platform build writes a latest*.yml that lists its files. Only files built for this version go up.
const files = []
for (const manifest of ['latest.yml', 'latest-linux.yml', 'latest-mac.yml']) {
  const manifestPath = path.join(outDir, manifest)
  if (!fs.existsSync(manifestPath)) continue
  const text = fs.readFileSync(manifestPath, 'utf8')
  const built = text.match(/^version:\s*['"]?([^'"\s]+)/m)?.[1]
  if (built !== version) {
    console.log(`Skipping ${manifest}. It's from version ${built ?? 'unknown'}, and package.json says ${version}.`)
    continue
  }
  const listed = new Set([...text.matchAll(/^\s*(?:-\s*)?(?:url|path):\s*['"]?([^'"\r\n]+?)['"]?\s*$/gm)].map((m) => m[1]))
  for (const name of listed) {
    if (/\s/.test(name)) fail(`${name} has a space in its name. GitHub renames such files, which breaks updates. Check artifactName in package.json.`)
    const file = path.join(outDir, name)
    if (!fs.existsSync(file)) fail(`${manifest} lists ${name}, but it isn't in ${outDir}. Build again.`)
    files.push(file)
    if (fs.existsSync(`${file}.blockmap`)) files.push(`${file}.blockmap`)
  }
  files.push(manifestPath)
}
if (files.length === 0) fail(`No installers for version ${version} in ${outDir}. Run npm run dist:win (or dist:mac, dist:linux) first.`)

const exists = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { encoding: 'utf8' })
if (exists.error) fail("The gh CLI isn't installed or isn't on PATH. Install it from https://cli.github.com and sign in with gh auth login.")
if (exists.status === 0) fail(`${repo} already has a release ${tag}. Raise the version in package.json instead of reusing one.`)

const notesIndex = process.argv.indexOf('--notes-file')
const notesArgs = notesIndex > -1 ? ['--notes-file', process.argv[notesIndex + 1]] : ['--notes', `jobpls ${version}`]

console.log(`Uploading ${files.length} files to a draft release ${tag} on ${repo}:`)
for (const f of files) console.log(`  ${path.basename(f)}`)
const created = spawnSync('gh', ['release', 'create', tag, '--repo', repo, '--draft', '--title', `jobpls ${version}`, ...notesArgs, ...files], { stdio: 'inherit' })
if (created.status !== 0) fail('gh release create failed. Nothing was published.')

console.log(`\nDraft ready. Check it on GitHub, then publish it with:\n  gh release edit ${tag} --repo ${repo} --draft=false\n`)

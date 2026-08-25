# @ukibbb/buli

Installs the native Buli CLI for macOS or Linux from the matching GitHub
Release. The installer verifies the published SHA-256 checksum before placing
the executable and its private ripgrep and fd sidecars inside this npm package.

```bash
npm install --global @ukibbb/buli
buli --version
```

Release candidates are published under the npm `next` dist-tag.

For npm-managed installations, update through npm:

```bash
npm install --global @ukibbb/buli@next
```

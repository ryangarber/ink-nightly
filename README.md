# ink-nightly

Unofficial nightly builds of [ink](https://github.com/vadimdemedes/ink) from `master`, published to npm as [`ink-nightly`](https://www.npmjs.com/package/ink-nightly).

```sh
npm install ink@npm:ink-nightly
```

Installed under ink's name, packages that depend on `ink` use it too.

## How it works

Once a night, [`nightly.yml`](.github/workflows/nightly.yml) runs [rylease](https://github.com/ryangarber/rylease) with [`rylease.config.ts`](rylease.config.ts). If `master` has moved since the commit in [`upstream.json`](upstream.json), it:

1. syncs upstream's source into [`ink/`](ink), renamed to `ink-nightly`;
2. versions it as the next patch of upstream's version, numbered, e.g. `8.0.1-nightly.3`;
3. builds it, commits and tags it, and publishes it to npm under `latest`, with a GitHub release listing the upstream commits.

Otherwise, nothing is released. Pushes to `main` dry-run it; `pnpm dry-run` does the same locally.

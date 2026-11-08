import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defineRelease,
	git,
	histories,
	schemes,
	steps,
	tryGit,
} from "rylease";

const UPSTREAM = { repository: "vadimdemedes/ink", branch: "master" };
const UPSTREAM_URL = `https://github.com/${UPSTREAM.repository}`;
const REPOSITORY = "ryangarber/ink-nightly";
const NAME = "ink-nightly";
/** Where the synced source lives, and what's published. */
const PACKAGE = "ink";
/** The upstream commit `PACKAGE` was last synced to. */
const SYNCED = "upstream.json";

interface Upstream {
	/** A clone of the upstream branch. */
	dir: string;
	commit: string;
	/** The commit synced last, if any. */
	previous?: string;
	/** The version in upstream's package.json, e.g. `8.0.0`. */
	version?: string;
}

interface Context {
	upstream?: Upstream;
}

const short = (sha: string) => sha.slice(0, 7);
const commits = (n: number) => `${n} upstream commit${n === 1 ? "" : "s"}`;

/** A dry run before the first sync has no package to look at. */
const synced = Object.assign(
	({ env }: { env: { cwd: string; dryRun: boolean } }) =>
		!env.dryRun || existsSync(join(env.cwd, PACKAGE, "package.json")),
	{ source: `!dryRun || ${PACKAGE}/ is synced` },
);

function upstreamOf(context: Context): Upstream {
	if (!context.upstream) throw new Error("ink/read-upstream didn't run");
	return context.upstream;
}

async function syncedCommit(cwd: string): Promise<string | undefined> {
	const text = await readFile(join(cwd, SYNCED), "utf8").catch(() => undefined);
	return text === undefined
		? undefined
		: (JSON.parse(text) as { commit?: string }).commit;
}

async function log(dir: string, ...range: string[]) {
	const output = await git(dir, "log", "--format=%H%x1f%s", ...range);
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha = "", subject = ""] = line.split("\x1f");
			return { sha, subject };
		});
}

export default defineRelease<Context>({
	context: {},
	scheme: schemes.semver(),
	history: histories.gitTags(),
	// Every run is a nightly: the next patch of upstream's version, numbered,
	// e.g. 8.0.1-nightly.3.
	channels: { nightly: { branches: ["**"] } },
	steps: [
		{
			phase: "read-changes",
			name: "ink/read-upstream",
			run: async ({ env, context }) => {
				const dir = await mkdtemp(join(tmpdir(), "ink-upstream-"));
				await git(
					env.cwd,
					"clone",
					"--quiet",
					"--no-tags",
					"--single-branch",
					"--branch",
					UPSTREAM.branch,
					`${UPSTREAM_URL}.git`,
					dir,
				);
				const commit = await git(dir, "rev-parse", "HEAD");
				const previous = await syncedCommit(env.cwd);
				context.upstream = { dir, commit, ...(previous && { previous }) };
				const at = `${UPSTREAM.repository}@${short(commit)}`;
				if (previous === commit) {
					return { changes: [], reason: `already synced to ${at}` };
				}

				const known =
					previous !== undefined &&
					(await tryGit(dir, "cat-file", "-e", `${previous}^{commit}`)) !==
						undefined;
				let logged = known ? await log(dir, `${previous}..${commit}`) : [];
				// A first sync, or upstream rewrote its history: just its head.
				if (logged.length === 0) logged = await log(dir, "-1", commit);
				return {
					changes: logged.map(({ sha, subject }) => ({
						title: subject,
						reason: `upstream commit ${short(sha)}`,
						link: { label: short(sha), url: `${UPSTREAM_URL}/commit/${sha}` },
					})),
					reason: known
						? `${commits(logged.length)} since ${short(previous)}, to ${at}`
						: `first sync, to ${at}`,
				};
			},
		},
		{
			phase: "determine-kind",
			name: "ink/determine-version",
			run: async ({ changes, context }) => {
				if (changes.length === 0) {
					return { kind: "none", reason: "nothing new upstream" };
				}
				const upstream = upstreamOf(context);
				const manifest = JSON.parse(
					await git(upstream.dir, "show", `${upstream.commit}:package.json`),
				) as { version: string };
				upstream.version = manifest.version;
				const base = schemes.parseSemver(manifest.version);
				// A prerelease leads up to its own version; a release, to its next patch.
				const target = base.prerelease
					? { major: base.major, minor: base.minor, patch: base.patch }
					: schemes.bumpSemver(base, "fix");
				const version = schemes.formatSemver(target);
				return {
					kind: "fix",
					version,
					reason: `leads up to ${version}, after upstream's ${manifest.version}`,
				};
			},
		},
		{
			phase: "determine-notes",
			name: "ink/determine-notes",
			run: ({ changes, context }) => {
				const { commit, previous, version } = upstreamOf(context);
				// Issue references are upstream's, not this repository's.
				const title = (text = "") =>
					text.replace(/(^|[\s(])#(\d+)\b/g, `$1${UPSTREAM.repository}#$2`);
				const lines = [
					`Nightly build of [${UPSTREAM.repository}@${short(commit)}](${UPSTREAM_URL}/commit/${commit}), after ink ${version}.`,
					"",
					"### Commits",
					"",
					...changes.map(
						(change) =>
							`- ${title(change.title)}${change.link ? ` ([${change.link.label}](${change.link.url}))` : ""}`,
					),
				];
				if (previous) {
					lines.push(
						"",
						`**Full diff**: ${UPSTREAM_URL}/compare/${previous}...${commit}`,
					);
				}
				return {
					notes: lines.join("\n"),
					reason: commits(changes.length),
				};
			},
		},
		{
			phase: "write",
			name: "ink/sync",
			run: async ({ env, context }) => {
				const { dir, commit } = upstreamOf(context);
				const files = [PACKAGE, SYNCED];
				const at = `${UPSTREAM.repository}@${short(commit)}`;
				if (env.dryRun) {
					return { output: { commit }, files, reason: `would sync ${PACKAGE}/ to ${at}` };
				}

				const target = join(env.cwd, PACKAGE);
				await rm(target, { recursive: true, force: true });
				await cp(dir, target, {
					recursive: true,
					filter: (source) => source !== join(dir, ".git"),
				});

				const manifestPath = join(target, "package.json");
				const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
				manifest.name = NAME;
				manifest.description = `${manifest.description} (nightly builds of ${UPSTREAM.repository}@${UPSTREAM.branch})`;
				// npm checks provenance against the repository that publishes it.
				manifest.repository = {
					type: "git",
					url: `git+https://github.com/${REPOSITORY}.git`,
					directory: PACKAGE,
				};
				await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

				const readmePath = join(target, "readme.md");
				const readme = await readFile(readmePath, "utf8").catch(() => undefined);
				if (readme !== undefined) {
					const banner = `> **${NAME}** is an unofficial nightly build of [ink](${UPSTREAM_URL}) at [\`${short(commit)}\`](${UPSTREAM_URL}/commit/${commit}) on \`${UPSTREAM.branch}\`. Install it in ink's place with \`npm install ink@npm:${NAME}\`.`;
					await writeFile(readmePath, `${banner}\n\n${readme}`);
				}

				await writeFile(
					join(env.cwd, SYNCED),
					`${JSON.stringify({ ...UPSTREAM, commit }, null, "\t")}\n`,
				);
				return { output: { commit }, files, reason: `synced ${PACKAGE}/ to ${at}` };
			},
		},
		{
			...steps.fsWriteVersion({ format: "npm", path: `${PACKAGE}/package.json` }),
			if: synced,
		},
		// Builds before anything's committed, so a broken master isn't released.
		// Install scripts are skipped: only upstream's tests need them (node-pty).
		steps.execCommand({
			phase: "write",
			cwd: PACKAGE,
			command: "npm install --ignore-scripts --no-audit --no-fund && npm run build",
		}),
		steps.gitCommit(),
		steps.gitCreateTag({ push: "origin" }),
		// `latest`, not the channel's `nightly`: every version of the package is one.
		{
			...steps.npmPublish({
				path: PACKAGE,
				client: "npm",
				tag: "latest",
				access: "public",
				provenance: true,
			}),
			if: synced,
		},
		steps.githubCreateRelease(),
	],
});

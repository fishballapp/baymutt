# baymutt

A zero-knowledge secret store for people who run coding agents. Agents load, write and replace
secrets with no approval prompt, through a login the owner approves once. The store keeps every
value sealed, so it cannot read them.

Hosted at **[baymutt.fsh.ba](https://baymutt.fsh.ba)**, free while it is in beta. The name is 秘密
(bei mat), "secret" in Cantonese.

## Use it

Create an account at [baymutt.fsh.ba](https://baymutt.fsh.ba/signup), then, where an agent runs:

```sh
npm install -g baymutt            # or run any command as `npx baymutt …`
baymutt login                     # makes a key here and prints a link; the owner opens it and approves
baymutt projects create app/production
baymutt generate app/production SESSION_SECRET
```

Every command prints JSON on stdout and one JSON error line on stderr, and no command prints a
value. `baymutt --help` lists them all.

- **A login reads and writes every project**, including ones made later: approving it is the
  owner's one decision. `--description` says what it is for, `--expires 90d` when it stops, and
  `baymutt logout` revokes it and forgets its key.
- **A value only the owner can fetch** (a vendor's API key) is asked for with
  `baymutt request <project> <NAME>`, which prints a single-use link to a page where they paste it.
- **A login can make a scoped service account.** It holds only the projects named, cannot widen
  its own access, and its key goes to the command after `--` on stdin, never onto a screen:

  ```sh
  baymutt service-accounts create --name "CI: deploy" --read app/production --expires 90d -- gh secret set BAYMUTT_KEY -R owner/repo
  ```

### Loading values with varlock

[varlock](https://varlock.dev) loads a project's values into a process through
[`@baymutt/varlock-plugin`](packages/varlock-plugin/). In `.env.schema`:

```sh
# @plugin(@baymutt/varlock-plugin)
# @initBaymutt(key=$BAYMUTT_KEY)
# @setValuesBulk(baymuttLoad("app/production"))
# ---
DATABASE_URL=
SESSION_SECRET=
```

Then `varlock run -- <command>`. Where you ran `baymutt login`, `BAYMUTT_KEY` stays unset and the plugin reads
the key it stored; in CI it is the job's secret.

## How it keeps values from the host

- **Values are sealed and opened on the client**, with keys the host never holds: the owner's vault
  is opened in the browser by a passkey or a password, and a service account's key is made where it is used
  and never sent.
- **Read access is cryptographic.** Reading a project means holding its key, wrapped to yours by
  someone who already holds it: the owner's browser wraps every project to each login it approves,
  and a login hands a scoped service account only what it holds. The Worker stores ciphertext,
  public keys, wraps, grants and the audit log.
- **A client does not trust a public key the store serves.** Which key belongs to a project or a
  service account is vouched for by a party the reader already trusts, in a box only those two can make.
- **The dashboard has no reveal.** A value can be put in through a browser and cannot be taken out
  through one.
- **Every write is a new version and every delete is soft**, so what an agent changes can be rolled
  back.

What it does not hide: project and secret names, sizes, and who read or wrote what when. What it
does not protect yet: a compromised host could swap a value for one of its own or answer with an
older version; the audit log and the version history are what would show it.

## What is here

| Path | What | Licence |
| --- | --- | --- |
| [`apps/cli`](apps/cli/) | `@baymutt/cli`, the `baymutt` bin | MIT |
| [`packages/baymutt`](packages/baymutt/) | `baymutt`, the same bin under its short name | MIT |
| [`packages/varlock-plugin`](packages/varlock-plugin/) | `@baymutt/varlock-plugin` | MIT |
| [`packages/keys`](packages/keys/) | the key schedule, on WebCrypto | MIT |
| [`packages/api`](packages/api/) | the API definition every client derives from | MIT |
| `internal/zk-vault` | the vault primitives the key schedule is built on | MIT |
| [`apps/worker-web`](apps/worker-web/) | the one Cloudflare Worker: the API, sign-in, D1 and the static assets | AGPL-3.0 |
| [`apps/web`](apps/web/) | the dashboard | AGPL-3.0 |
| [`apps/site`](apps/site/) | the landing page | AGPL-3.0 |

## Developing

Needs Node 26 and pnpm.

```sh
pnpm install
pnpm -F @baymutt/worker-web dev      # :8790, a local D1 with every migration applied
pnpm -F @baymutt/web dev             # :5183, the dashboard, proxying /api to the Worker
pnpm -F @baymutt/cli cli -- --help   # builds, then runs the CLI
pnpm check && pnpm typecheck && pnpm test
```

Point the CLI at the local Worker with `BAYMUTT_URL=http://localhost:5183`, and keep its key out of
your keychain with `BAYMUTT_KEY_FILE=<path>`. Local development sends no mail:
`GET /api/dev/magic-link?email=…` answers the newest sign-in link's token.

This repository is cut from a private monorepo, and every commit on `main` is deployed to
baymutt.fsh.ba by [`cd.yml`](.github/workflows/cd.yml). Issues are welcome. Please open one before
a pull request, since a change has to be applied upstream.

## Licence

[AGPL-3.0](./LICENSE) for the Worker, the dashboard, the landing page and everything not listed as
MIT above. The CLI, the varlock plugin and the code they bundle are [MIT](./apps/cli/LICENSE), so
they can go into any repository or CI job.

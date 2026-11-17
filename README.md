# baymutt

A zero-knowledge secret store for people who run coding agents. An agent says which environments
it needs and why, the owner approves on one screen, and the agent gets a key of its own that ends.
The store keeps every value and every name sealed, so it cannot read them.

Hosted at **[baymutt.fsh.ba](https://baymutt.fsh.ba)**, free while it is in beta. The name is 秘密
(bei mat), "secret" in Cantonese.

## Use it

Create an account at [baymutt.fsh.ba](https://baymutt.fsh.ba/signup), and an org (`acme` below)
and an environment in it. Then, where agents run:

```sh
npm install -g baymutt            # or run any command as `npx baymutt …`
baymutt auth login                # once per computer: prints a link; the owner opens it and approves
baymutt env list                  # a CLI login lists names, and opens no value
baymutt ask access --read acme/app/production --reason "run the migration" --expires 1h
baymutt ask wait <the id it printed>
```

`baymutt ask access` prints a link and an id, and returns. The owner sees only the agent's reply to
them, so the agent ends that reply with the link, alone on its last line, and runs `ask wait` in
the background or after that reply: a wait that blocks first hides the link. The request waits an
hour for them. The owner sees which CLI login asks, for which environments, why
and until when, and approves or rejects; they can change only when it ends. `baymutt ask wait`
returns when they have answered. Approved, it prints the path of a key file of the agent's own:

```sh
BAYMUTT_KEY_FILE=<that path> varlock run -- pnpm migrate
BAYMUTT_KEY_FILE=<that path> baymutt secret generate acme/app/production SESSION_SECRET   # needs --write
```

Every command prints JSON on stdout and one JSON error line on stderr, and no command prints a
value. `baymutt --help` lists them all.

- **An environment belongs to an org** and is named with the org's slug first, `<org>/<name>`. Orgs
  are made in the dashboard; their creator owns them.
- **A CLI login lists names and holds no environment.** It shows orgs, environments and secret
  names, and makes requests and paste links. `baymutt auth logout` revokes it and forgets its key.
- **Each request is approved on its own**, for whole environments of one org: `--read`, `--write` or both,
  `--expires 15m`, `1h` or `90d`. Nothing carries over to the next agent, which asks for itself.
  `--write` does not include `--read`: `--read-write` asks for both in one approval, where two
  separate asks cost the owner two. A key belongs to the one org it was asked for in, and is
  changed to add environments of that org only; environments of two orgs are two asks.
- **Within a task, change the key you hold rather than ask for another.** `baymutt ask change <id>
  --read acme/app/staging --give-back acme/app/production --reason "…"` asks the owner to add to the
  key the agent already holds and take back what it no longer needs, as one approval; `--expires`
  asks for a new end, counted from the approval. The page shows what the key holds now, what is
  added and what is given back. The same key file keeps working, and holds the new set once
  approved; rejected or expired, it holds what it held. Giving back alone needs no approval and
  takes effect at once. A new key (`ask access`) is for a different job. A key piped into CI is
  changed the same way; its key is not on the asking computer, so `ask wait` says what it could
  not check, and the key's next load proves the rest.
- **A new environment is asked for on its own**: `baymutt ask create-environment acme/app/staging
  --reason "…"` prints a link; the owner creates it, empty, or rejects. Access to it is then an
  `ask access` like any other.
- **Everything asked of the owner is under `baymutt ask`** and waits an hour: `ask wait <id>`
  returns when they have answered, `ask cancel <id>` withdraws it. `ask wait` takes any number of
  ids, of any kind, and prints one JSON line for each as it is answered; it exits 0 only when
  every one was granted (see its `--help`).
- **A key that stays, for CI,** is a request too. `baymutt ask wait` hands the key to the command
  after `--` on stdin once the owner has approved, never onto a screen, and the approval shows
  that command:

  ```sh
  baymutt ask access --read acme/app/production --reason "CI: deploy" -- gh secret set BAYMUTT_KEY -R owner/repo
  baymutt ask wait <the id it printed>
  ```

  It works until it is revoked. The owner changes what it reaches in the dashboard, and its key
  stays the same. Inside a sandbox, a key file's content works as `BAYMUTT_KEY`.
- **A value only the owner can fetch** (a vendor's API key) arrives through a paste link:
  `baymutt ask paste-link <environment> <NAME>` prints a single-use link to a page where the owner,
  signed in, pastes it. It waits an hour, and `baymutt ask wait <id>` returns once they have.

### Loading values with varlock

[varlock](https://varlock.dev) loads an environment's values into a process through
[`@baymutt/varlock-plugin`](packages/varlock-plugin/). In `.env.schema`:

```sh
# @plugin(@baymutt/varlock-plugin)
# @initBaymutt(key=$BAYMUTT_KEY)
# @setValuesBulk(baymuttLoad("acme/app/production"))
# ---
DATABASE_URL=
SESSION_SECRET=
```

Then `varlock run -- <command>`, with `BAYMUTT_KEY_FILE` naming the key file `baymutt ask access` gave
(`BAYMUTT_KEY` stays unset), or with `BAYMUTT_KEY` set to a service account's key in CI.

## How it keeps values from the host

- **Values and names are sealed and opened on the client**, with keys the host never holds: the
  owner's vault is opened in the browser by a passkey or a password, and a CLI login's or any other
  key is made where it is used and never sent.
- **Read access is cryptographic.** Reading an environment means holding its key, wrapped to yours
  by someone who already holds it: the owner's browser wraps to a request's key exactly the
  environments the request named, when the owner approves it, and later exactly what a key change
  adds. Nothing is wrapped to a CLI login.
  The Worker stores ciphertext, sealed names, public keys, wraps, grants and the activity log.
- **A name is stored as an index and a sealed name**, under one names key per org that the owner's
  account wraps to whoever may list names. The store can tell that two names in one environment
  are equal, and nothing else about them.
- **A client does not trust a public key the store serves.** Which key belongs to an environment or
  to a key is vouched for by a party the reader already trusts, in a box only those two
  can make.
- **The dashboard reveals a value only with the vault open.** The owner's browser fetches one
  version's ciphertext and opens it with the vault; the store logs the request and never sees the
  value. A session an email link made cannot.
- **Every write is a new version and a delete goes to the bin**, so what an agent changes can be
  rolled back. `baymutt bin list` shows what was deleted and `baymutt bin restore` brings a secret
  back, for 30 days; then it is removed for good. Only the owner, in the dashboard, removes
  something sooner.

What it does not hide: org names, how many environments and secrets there are, sizes, who read
or wrote what when, and what a person typed as a reason, a hint or a key's name. What
it does not protect yet: a compromised host could swap a value for one of its own or answer with
an older version; the activity log and the version history are what would show it. What an
approval cannot do: take back what a key already read, or stop agents under one operating-system
user from reading each other's key files.

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

Point the CLI at the local Worker with `BAYMUTT_URL=http://localhost:5183`. Local development
sends no mail: `GET /api/dev/magic-link?email=…` answers the newest sign-in link's token.

This repository is cut from a private monorepo, and every commit on `main` is deployed to
baymutt.fsh.ba by [`cd.yml`](.github/workflows/cd.yml). Issues are welcome. Please open one before
a pull request, since a change has to be applied upstream.

## Licence

[AGPL-3.0](./LICENSE) for the Worker, the dashboard, the landing page and everything not listed as
MIT above. The CLI, the varlock plugin and the code they bundle are [MIT](./apps/cli/LICENSE), so
they can go into any repository or CI job.

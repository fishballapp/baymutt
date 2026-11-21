# baymutt

A zero-knowledge secret store for people who run coding agents. An agent asks for everything it
needs in one plan: environments, a key that reads them, values. The owner decides each step on one
page. A key only reads, and ends. The store keeps every value and every name sealed, so it cannot
read them.

Hosted at **[baymutt.fsh.ba](https://baymutt.fsh.ba)**, free while it is in beta. The name is 秘密
(bei mat), "secret" in Cantonese.

## Use it

Create an account at [baymutt.fsh.ba](https://baymutt.fsh.ba/signup), and an org (`acme` below)
and an environment in it. Then, where agents run:

```sh
npm install -g baymutt            # or run any command as `npx baymutt …`
baymutt auth login                # once per computer: prints a link; the owner opens it and approves
baymutt env list                  # a CLI login lists names, and opens no value
baymutt ask plan.json             # prints a link and an id, and returns
baymutt ask wait <the id it printed>
baymutt ask --check plan.json     # checks a plan and sends nothing: no login, no network
baymutt ask schema                # the format of a plan, as JSON Schema
```

A plan is JSON: a reason, and steps in the order they are to happen, all in one org.

```json
{
  "reason": "run the migration",
  "steps": [
    { "type": "secrets", "items": [
      { "op": "paste", "environment": "acme/app/production", "name": "STRIPE_SECRET_KEY", "hint": "Stripe dashboard, API keys" },
      { "op": "generate", "environment": "acme/app/production", "name": "SESSION_SECRET" }
    ] },
    { "type": "access", "read": ["acme/app/production"], "expires": "1h" }
  ]
}
```

The owner sees only the agent's reply to them, so the agent ends that reply with the link, alone
on its last line, and runs `ask wait` in the background or after that reply: a wait that blocks
first hides the link. Each step waits an hour. The owner sees which CLI login asks, why, and each
step, and approves or rejects each one, with a note back to the agent if they like.
`baymutt ask wait` prints each step as it is answered. An approved `access` step gives the path of
a key file of the agent's own:

```sh
BAYMUTT_KEY_FILE=<that path> varlock run -- pnpm migrate
```

Every command prints JSON on stdout and one JSON error line on stderr, and no command prints or
writes a value. `baymutt --help` lists them all; `baymutt ask --help` prints a plan with every step,
`baymutt ask schema` its format as JSON Schema, and `baymutt ask --check` checks a plan without sending it.

- **An environment belongs to an org** and is named with the org's slug first, `<org>/<name>`. Orgs
  are made in the dashboard; their creator owns them.
- **A CLI login lists names and holds no environment.** It shows orgs, environments and secret
  names, and asks with plans. `baymutt auth logout` revokes it and forgets its key.
- **A plan's steps** are `environments` (create, delete or restore), `access` (a new key that
  reads, until an end the owner picks), `change` (a key this login asked for reads more, gives
  some back, or gets a new end) and `secrets` (set a value from a file, an environment variable
  or a dotenv file here; ask the owner to paste one; generate, delete, roll back or restore one).
  A step that needs an environment an earlier step creates waits for it. Nothing carries over to
  the next agent, which asks for itself.
- **A key only reads.** Every value is written by the owner's browser: on its own, or when the
  owner approves a `secrets` step. A plan never holds a value: a `set` names where it is, and the
  CLI seals it so that only the owner's vault opens it.
- **A key belongs to the one org of its plan.** Within a task, change the key you hold with a
  `change` step rather than ask for another: the same key file keeps working.
- **A key that stays, for CI,** is an `access` step with a `command`. `baymutt ask wait` hands the
  key to that command on stdin once the owner has approved, never onto a screen, and the plan page
  shows the command:

  ```json
  { "type": "access", "read": ["acme/app/production"], "name": "CI", "command": ["gh", "secret", "set", "BAYMUTT_KEY", "-R", "owner/repo"] }
  ```

  It works until it is revoked. The owner changes what it reads in the dashboard, and its key
  stays the same. Inside a sandbox, a key file's content works as `BAYMUTT_KEY`.
- **A CLI before 0.11.0** still loads with a key it holds, and can no longer ask or write: upgrade.

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

Then `varlock run -- <command>`, with `BAYMUTT_KEY_FILE` naming the key file `baymutt ask wait`
gave (`BAYMUTT_KEY` stays unset), or with `BAYMUTT_KEY` set to a service account's key in CI.

## How it keeps values from the host

- **Values and names are sealed and opened on the client**, with keys the host never holds: the
  owner's vault is opened in the browser by a passkey or a password, and a CLI login's or any other
  key is made where it is used and never sent.
- **Read access is cryptographic.** Reading an environment means holding its key, wrapped to yours
  by someone who already holds it: the owner's browser wraps to a key exactly the environments its
  `access` step named, when the owner approves it, and later exactly what a `change` step adds.
  Nothing is wrapped to a CLI login. The Worker stores ciphertext, sealed names, public keys,
  wraps, grants, plans and the activity log.
- **A value a plan proposes is sealed by the CLI login to the owner's account key**, so the store
  carries it and cannot open it; the owner's browser opens it, shows it masked, and seals it to the
  environment on approval. The owner's note back is sealed to that login alone.
- **A name is stored as an index and a sealed name**, under one names key per org that the owner's
  account wraps to whoever may list names. The store can tell that two names in one environment
  are equal, and nothing else about them.
- **A client does not trust a public key the store serves.** Which key belongs to an environment or
  to a key is vouched for by a party the reader already trusts, in a box only those two
  can make.
- **The dashboard reveals a value only with the vault open.** The owner's browser fetches one
  version's ciphertext and opens it with the vault; the store logs the request and never sees the
  value. A session an email link made cannot.
- **Every write is a new version and a delete goes to the bin**, so what the owner approved can be
  rolled back. `baymutt bin list` shows what was deleted, for 30 days; a plan's `secrets` step
  asks to restore it. Only the owner, in the dashboard, removes something sooner.

What it does not hide: org names, how many environments and secrets there are, sizes, who read
or wrote what when, and what a person typed as a reason or a key's name. What
it does not protect yet: a compromised host could swap a value for one of its own or answer with
an older version, or show a plan's steps other than the agent wrote them; the activity log and the
version history are what would show it. What an approval cannot do: take back what a key already
read, or stop agents under one operating-system user from reading each other's key files.

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

The ports are `BAYMUTT_WORKER_PORT` (8790), `BAYMUTT_WEB_PORT` (5183), `BAYMUTT_SITE_PORT` (4391)
and `BAYMUTT_WORKER_INSPECTOR_PORT` (9240), so two checkouts can run side by side; give both dev
servers the same set. Point the CLI at the local Worker with `BAYMUTT_URL=http://localhost:5183`
(the web port). Local development sends no mail: `GET /api/dev/magic-link?email=…` answers the newest sign-in link's token.

This repository is cut from a private monorepo, and every commit on `main` is deployed to
baymutt.fsh.ba by [`cd.yml`](.github/workflows/cd.yml). Issues are welcome. Please open one before
a pull request, since a change has to be applied upstream.

## Licence

[AGPL-3.0](./LICENSE) for the Worker, the dashboard, the landing page and everything not listed as
MIT above. The CLI, the varlock plugin and the code they bundle are [MIT](./apps/cli/LICENSE), so
they can go into any repository or CI job.

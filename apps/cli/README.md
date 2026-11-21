# @baymutt/cli

The `baymutt` command: everything a CLI login, a key or a coding agent does with
[baymutt](https://baymutt.fsh.ba), a zero-knowledge secret store. Also published as
[`baymutt`](https://www.npmjs.com/package/baymutt).

```sh
npm install -g @baymutt/cli
baymutt auth login                       # once per computer: prints a link; the owner opens it and approves
baymutt secret list acme/app/production  # names, versions and sizes; never a value
baymutt ask plan.json                    # asks the owner for everything at once: prints a link and returns
baymutt ask --check plan.json            # checks a plan and sends nothing: no login, no network
baymutt ask schema                       # prints the format of a plan as JSON Schema
baymutt ask wait <id>                    # returns once the owner has answered every step
baymutt key list                         # this login's keys: kind (cli-login, agent-key, service-account) and org
baymutt auth logout                      # revokes this CLI login and forgets its key
```

A plan is JSON: a reason, and steps in the order they are to happen, all in one org.

```json
{
  "reason": "Set up the preview deploy of the shop",
  "steps": [
    { "type": "environments", "items": [{ "op": "create", "environment": "acme/shop/preview" }] },
    { "type": "secrets", "items": [
      { "op": "set", "environment": "acme/shop/preview", "name": "DATABASE_URL", "from": { "dotenv": ".env.preview" } },
      { "op": "paste", "environment": "acme/shop/preview", "name": "STRIPE_SECRET_KEY", "hint": "Stripe dashboard, API keys" },
      { "op": "generate", "environment": "acme/shop/preview", "name": "SESSION_SECRET" }
    ] },
    { "type": "access", "read": ["acme/shop/preview"], "expires": "2h" }
  ]
}
```

- Values and names are sealed and opened on this computer. The store holds only ciphertext.
- An environment is named with its org first, `<org>/<name>`. Orgs are made in the dashboard.
- A CLI login lists orgs, environments and secret names, and holds no environment. Everything else
  is asked of the owner in a plan, whose steps are of four types: `environments` (create, delete,
  restore), `access` (a new key that reads), `change` (a key this login asked for reads more,
  gives some back, or gets a new end) and `secrets` (set, paste, generate, delete, roll back,
  restore). `baymutt ask --help` prints a full example and the format is below; every error names
  the path that is wrong.
- **A key only reads.** A value is written by the owner, when they approve a `secrets` step: a
  `set` names a file, an environment variable or a dotenv file here, sealed so that only the
  owner's vault opens it, never a value inline. A value only the owner can fetch is a `paste`,
  with a hint where to find it, sealed here like a proposed value.
- A key belongs to the one org of its plan. Within a task, change the key you hold with a `change`
  step rather than asking for another; the same key file keeps working.
- `ask` prints a link for the owner and returns; each step waits an hour. The owner sees only
  your reply to them, not a command's output: end that reply with the link alone on its last
  line, and run `ask wait` in the background or after that reply, since a wait that blocks first
  hides the link. `ask wait <id>` prints one JSON line per step as it is answered, with the
  owner's note when there is one; an approved `access` step prints its key file, used as
  `BAYMUTT_KEY_FILE=<path>`, or is piped into its `command` (for CI). It exits 0 when every step
  was approved, 9 while any still waits, 4 when one was rejected, withdrawn or expired. `ask cancel
  <id>` withdraws what the owner has not answered.
- `ask wait` checks what was approved against what this computer asked, never the store's word:
  a new or changed key must open the owner's proof of each environment it reads.
- Every command prints JSON on stdout. A failure is one JSON line on stderr that says what to do
  next, with a stable exit code: 2 usage, 3 not logged in, 4 no access, 5 not found, 6 conflict,
  7 unreachable, 8 integrity, 9 check differs.
- Every command is a thing and an action: `auth`, `ask`, `org`, `env`, `secret`, `bin`,
  `key`, `activity`. `baymutt <thing> --help` lists its actions. No command writes or prints a
  value.
- A CLI login's key is kept in the login keychain on a Mac and in an owner-only file elsewhere. A
  CI job holds a service account's key as `BAYMUTT_KEY`. `key list` tells the three apart
  (`kind`) and names each key's org (`org`, null for a CLI login), and `key revoke <id>` revokes one.
- A CLI before 0.11.0 still loads with a key it holds, and can no longer ask or write: upgrade.

`baymutt --help` lists every command. To load an environment's values into a process, use
[`@baymutt/varlock-plugin`](https://www.npmjs.com/package/@baymutt/varlock-plugin).

## The plan

`baymutt ask schema` prints this format as JSON Schema, made from the schemas `ask` decodes with.
`baymutt ask --check plan.json` (or the plan on stdin) runs the decoding `ask` runs, then reads
each `set` source on this computer as `ask` would, and sends nothing. It needs no login and no
network, and prints no value: one JSON line says the plan is well-formed and not sent, with its org
and each step's type (the org is null when the plan only changes keys, since it is then the keys'
org). A plan that fails is refused with the same sentence and exit code as `ask`: 2 for the format,
5 for a source that is not there. It does not look at the store, so whether an environment exists
or a key is this login's is known only when the plan is sent.

A plan holds a `reason` and `steps`; every step has a `type` and an optional `reason`. All objects
are closed: a field not listed here is refused.

| Plan field | Required | Meaning |
| --- | --- | --- |
| `reason` | yes | The task, shown to the owner. 1 to 140 characters. Never a secret |
| `steps` | yes | Steps in the order they are to happen. At most 20 |

| `environments` step | Required | Meaning |
| --- | --- | --- |
| `type` | yes | `"environments"` |
| `reason` | no | Why this step, for the owner |
| `items` | yes | At most 50 of `{ "op", "environment" }`: `op` is `create`, `delete` or `restore`, and `environment` is its address |

| `access` step | Required | Meaning |
| --- | --- | --- |
| `type` | yes | `"access"` |
| `reason` | no | Why this step, for the owner |
| `read` | yes | The environments the new key reads. At most 50 |
| `expires` | no | A number then `m`, `h` or `d` (`30m`, `12h`, `14d`), or `"never"`, counted from when the owner approves the step. Omitted: `1h`, or no end with a `command` |
| `name` | no | What the owner sees the key as. 1 to 60 characters |
| `command` | no | An argv the key is piped into once approved, which makes it a service account. Without it the key is kept in a file here |

| `change` step | Required | Meaning |
| --- | --- | --- |
| `type` | yes | `"change"` |
| `reason` | no | Why this step, for the owner |
| `key` | yes | The id of a key this login asked for |
| `read` | no | Environments the key reads from now on. At most 50 |
| `giveBack` | no | Environments the key reads no more. At most 50 |
| `expires` | no | As on `access`, counted from the approval and replacing the key's end, not added to it. Omitted: the key keeps its end |

A `change` step needs at least one of `read`, `giveBack` and `expires`.

| `secrets` step | Required | Meaning |
| --- | --- | --- |
| `type` | yes | `"secrets"` |
| `reason` | no | Why this step, for the owner |
| `items` | yes | What to do with each secret. At most 50 |

| `secrets` item | Required | Meaning |
| --- | --- | --- |
| `op` | yes | `set`, `paste`, `generate`, `delete`, `restore` or `rollback` |
| `environment` | yes | The secret's environment, as `<org>/<name>` |
| `name` | yes | The secret's name: letters, digits and underscores, not starting with a digit |
| `from` | `set` only | Where the value is on this computer: exactly one of `file` (a path), `env` (a variable) or `dotenv` (a path, with `key`) |
| `key` | no | In `from` beside `dotenv`: the variable to take from the file. Omitted, the item's `name` |
| `hint` | no | On `paste`: where the owner finds the value, up to 500 characters. Sealed on this computer so that only the owner's vault opens it |
| `version` | `rollback` only | The version to roll back to. 1 or more |

A value is never in a plan, not even one you were told in chat: `paste` asks the owner for it, and
`set` reads it from where it already is. A relative path is from the current directory.

The rules a schema cannot state, which `ask` and `--check` refuse:

- One org: the first segment of every environment a plan names is the same.
- A step names each environment once, and in a `secrets` step each secret once. A step may name
  an environment an earlier step creates or restores.
- At most 200 environments and secrets across all the steps.
- A `change` step asks for at least one of `read`, `giveBack` and `expires`.
- A key lasts between one minute and ten years.

## Source and licence

MIT: [fishballapp/baymutt](https://github.com/fishballapp/baymutt).

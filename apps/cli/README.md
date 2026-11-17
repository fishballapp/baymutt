# @baymutt/cli

The `baymutt` command: everything a CLI login, a service account or a coding agent does with
[baymutt](https://baymutt.fsh.ba), a zero-knowledge secret store. Also published as
[`baymutt`](https://www.npmjs.com/package/baymutt).

```sh
npm install -g @baymutt/cli
baymutt auth login                       # once per computer: prints a link; the owner opens it and approves
baymutt secret list acme/app/production  # names, versions and sizes; never a value
baymutt ask access --read acme/app/production --reason "run the migration" --expires 1h
baymutt ask wait <id> [<id>…]            # returns once the owner has answered what was asked
baymutt auth logout                      # revokes this CLI login and forgets its key
```

- Values and names are sealed and opened on this computer. The store holds only ciphertext.
- An environment is named with its org first, `<org>/<name>`. Orgs are made in the dashboard.
- A CLI login lists orgs, environments and secret names, and holds no environment. `ask access` makes a
  key of its own for whole environments (`--read`, `--write`, `--read-write`), with a `--reason` (never a secret:
  it is stored readable) and `--expires 15m|12h|90d`. It prints a link for the owner and returns;
  the request waits an hour. `--read-write` asks for both in one approval; two separate asks cost
  the owner two. `ask wait <id>` returns once the owner has approved or rejected it: approved, it
  prints the path of a key file, used as `BAYMUTT_KEY_FILE=<path>`.
- The owner sees only your reply to them, not a command's output: end that reply with the link
  alone on its last line, and run `ask wait` in the background or after that reply, since a wait
  that blocks first hides the link. `ask wait <id> <id> …` waits for several asks, of any kind,
  within one `--timeout`, and prints one JSON line for each as it is answered. It exits 0 when
  every one was granted, 9 if any is still open (wait again for those), else with the code of the
  first, in the order given, that was not.
- Every command prints JSON on stdout. A failure is one JSON line on stderr that says what to do
  next, with a stable exit code: 2 usage, 3 not logged in, 4 no access, 5 not found, 6 conflict,
  7 unreachable, 8 integrity, 9 check differs.
- Every command is a thing and an action: `auth`, `ask`, `org`, `env`, `secret`, `bin`,
  `service-account`, `activity`. `baymutt <thing> --help` lists its actions.
- No command prints a value. `secret set` reads one from stdin, `secret generate` makes one
  without showing it,
  and `ask access … -- <command>` asks for a key that stays (for CI): `ask wait` pipes it into the
  command after `--` once the owner has approved. A value only the owner can fetch arrives
  through `ask paste-link`, a single-use link to a page where they paste it, signed in.
- `ask create-environment <org>/<name> --reason …` asks the owner for a new environment; it
  gives no access. `ask cancel <id>` withdraws anything asked.
- A CLI login's key is kept in the login keychain on a Mac and in an owner-only file elsewhere. A
  CI job holds a service account's as `BAYMUTT_KEY`.

`baymutt --help` lists every command. To load an environment's values into a process, use
[`@baymutt/varlock-plugin`](https://www.npmjs.com/package/@baymutt/varlock-plugin).

Source and licence (MIT): [fishballapp/baymutt](https://github.com/fishballapp/baymutt).

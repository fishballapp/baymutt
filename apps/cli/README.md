# @baymutt/cli

The `baymutt` command: everything a service account or a coding agent does with
[baymutt](https://baymutt.fsh.ba), a zero-knowledge secret store. Also published as
[`baymutt`](https://www.npmjs.com/package/baymutt).

```sh
npm install -g @baymutt/cli
baymutt login                     # prints a link; the account's owner opens it and approves
baymutt secrets app/production    # names, versions and sizes; never a value
baymutt logout                    # revokes this login and forgets its key
```

- Values are sealed and opened on this computer. The store holds only ciphertext.
- A login reads and writes every project of the account. `service-accounts create` makes a
  scoped one, which holds only the projects it names and cannot widen them;
  `service-accounts access` changes them later, keeping its key. Both take `--description` (never a secret: it is stored readable) and `--expires 12h|90d`.
- Every command prints JSON on stdout. A failure is one JSON line on stderr that says what to do
  next, with a stable exit code: 2 usage, 3 not logged in, 4 no access, 5 not found, 6 conflict,
  7 unreachable, 8 integrity, 9 check differs.
- No command prints a value. `set` reads one from stdin, `generate` makes one without showing it,
  and `service-accounts create` pipes a new service account's key into the command after `--`.
- The service account key is kept in the login keychain on a Mac and in an owner-only file elsewhere. A
  CI job holds it as `BAYMUTT_KEY`.

`baymutt --help` lists every command. To load a project's values into a process, use
[`@baymutt/varlock-plugin`](https://www.npmjs.com/package/@baymutt/varlock-plugin).

Source and licence (MIT): [fishballapp/baymutt](https://github.com/fishballapp/baymutt).

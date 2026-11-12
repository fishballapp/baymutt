# @baymutt/cli

The `baymutt` command: everything a machine or a coding agent does with
[baymutt](https://baymutt.fsh.ba), a zero-knowledge secret store. Also published as
[`baymutt`](https://www.npmjs.com/package/baymutt).

```sh
npm install -g @baymutt/cli
baymutt pair --name "MacBook"     # prints a link; the account's owner opens it and approves
baymutt access request app/production --read --reason "to deploy the worker"
baymutt secrets app/production    # names, versions and sizes; never a value
```

- Values are sealed and opened on this machine. The store holds only ciphertext.
- Every command prints JSON on stdout. A failure is one JSON line on stderr that says what to do
  next, with a stable exit code: 2 usage, 3 not paired, 4 no access, 5 not found, 6 conflict,
  7 unreachable, 8 integrity, 9 check differs.
- No command prints a value. `set` reads one from stdin, `generate` makes one without showing it,
  and `machines create` pipes a new machine's key into the command after `--`.
- The machine's key is kept in the login keychain on a Mac and in an owner-only file elsewhere. A
  CI job holds it as `BAYMUTT_KEY`.

`baymutt --help` lists every command. To load a project's values into a process, use
[`@baymutt/varlock-plugin`](https://www.npmjs.com/package/@baymutt/varlock-plugin).

Source and licence (MIT): [fishballapp/baymutt](https://github.com/fishballapp/baymutt).

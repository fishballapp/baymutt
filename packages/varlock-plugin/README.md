# @baymutt/varlock-plugin

Loads a [baymutt](https://baymutt.fsh.ba) environment's values into
[varlock](https://varlock.dev). The values are fetched as ciphertext and opened on this computer
with a CLI login's or service account's key. Nothing is cached.

```sh
npm install -D varlock @baymutt/varlock-plugin
```

In `.env.schema`:

```sh
# @plugin(@baymutt/varlock-plugin)
# @initBaymutt(key=$BAYMUTT_KEY)
# @setValuesBulk(baymuttLoad("acme/app/production"))
# ---
DATABASE_URL=
SESSION_SECRET=
```

Then `varlock run -- <command>`.

- An environment is named with its org first: `<org>/<name>`.
- `key` is a key that reads, such as a CI job's `BAYMUTT_KEY`. Left unset or empty, the plugin
  reads the key file `BAYMUTT_KEY_FILE` names: the one `baymutt ask wait` printed.
- `url` is optional, for a baymutt that is not `https://baymutt.fsh.ba`:
  `@initBaymutt(key=$BAYMUTT_KEY, url="http://localhost:5183")`.
- It needs a key that reads the environment: one a plan's `access` step asked for
  (`baymutt ask`) and the owner approved. A key only reads. A CLI login lists names and loads
  nothing.

The CLI that logs in and manages secrets is
[`baymutt`](https://www.npmjs.com/package/baymutt).

Source and licence (MIT): [fishballapp/baymutt](https://github.com/fishballapp/baymutt).

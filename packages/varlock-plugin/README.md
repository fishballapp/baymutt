# @baymutt/varlock-plugin

Loads a [baymutt](https://baymutt.fsh.ba) project's values into
[varlock](https://varlock.dev). The values are fetched as ciphertext and opened on this machine
with its machine key. Nothing is cached.

```sh
npm install -D varlock @baymutt/varlock-plugin
```

In `.env.schema`:

```sh
# @plugin(@baymutt/varlock-plugin)
# @initBaymutt(key=$BAYMUTT_KEY)
# @setValuesBulk(baymuttLoad("app/production"))
# ---
DATABASE_URL=
SESSION_SECRET=
```

Then `varlock run -- <command>`.

- `key` is the machine key where the environment holds one, as a CI job does. Left unset or empty,
  the plugin reads the key `baymutt pair` stored on this machine.
- `url` is optional, for a baymutt that is not `https://baymutt.fsh.ba`:
  `@initBaymutt(key=$BAYMUTT_KEY, url="http://localhost:5183")`.
- A machine needs a read grant on the project. Make a CI job's machine with
  `baymutt machines create --read app/production -- gh secret set BAYMUTT_KEY -R owner/repo`.

The CLI that pairs machines and manages secrets is
[`baymutt`](https://www.npmjs.com/package/baymutt).

Source and licence (MIT): [fishballapp/baymutt](https://github.com/fishballapp/baymutt).

# @baymutt/varlock-plugin

Loads a [baymutt](https://baymutt.fsh.ba) project's values into
[varlock](https://varlock.dev). The values are fetched as ciphertext and opened on this computer
with the service account key. Nothing is cached.

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

- `key` is a service account key the environment holds. Left unset or empty,
  the plugin reads the key `baymutt login` stored on this computer.
- `url` is optional, for a baymutt that is not `https://baymutt.fsh.ba`:
  `@initBaymutt(key=$BAYMUTT_KEY, url="http://localhost:5183")`.
- It needs a read grant on the project. A login holds one on every project; a service account
  `baymutt service-accounts create --read <project>` made holds one on the projects it names.

The CLI that logs in service accounts and manages secrets is
[`baymutt`](https://www.npmjs.com/package/baymutt).

Source and licence (MIT): [fishballapp/baymutt](https://github.com/fishballapp/baymutt).

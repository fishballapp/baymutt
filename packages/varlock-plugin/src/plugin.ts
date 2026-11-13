// The varlock plugin:
//
//   # @plugin(@baymutt/varlock-plugin)
//   # @initBaymutt(key=$BAYMUTT_KEY)
//   # @setValuesBulk(baymuttLoad("app/production"))
//
// `key` is the service account key where the process holds one (CI). Left unset or empty, the key is
// read from where `baymutt login` put it: the login keychain on a Mac, an owner-only file elsewhere.
import { loadEnvironment } from '@baymutt/cli/load';
import { plugin } from 'varlock/plugin-lib';

const { SchemaError, ResolutionError } = plugin.ERRORS;

plugin.name = 'baymutt';

type Resolver = { resolve: () => Promise<unknown> };

let connection: { key: string | undefined; url: string | undefined } | undefined;

const optionalString = async (resolver: Resolver | undefined, what: string) => {
  const value = await resolver?.resolve();
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new SchemaError(`Expected ${what} to resolve to a string`);
  return value;
};

plugin.registerRootDecorator({
  name: 'initBaymutt',
  description: 'Connect to baymutt with a service account key, for baymuttLoad()',
  isFunction: true,
  async process(argsVal) {
    const { key, url } = argsVal.objArgs ?? {};
    return { keyResolver: key, urlResolver: url };
  },
  async execute({ keyResolver, urlResolver }) {
    connection = {
      key: await optionalString(keyResolver, 'key'),
      url: await optionalString(urlResolver, 'url'),
    };
  },
});

plugin.registerResolverFunction({
  name: 'baymuttLoad',
  label: 'Load every value of a baymutt environment',
  argsSchema: { type: 'array', arrayMinLength: 1, arrayMaxLength: 1 },
  process() {
    return { environmentResolver: this.arrArgs?.[0] };
  },
  async resolve({ environmentResolver }) {
    if (connection === undefined) {
      throw new SchemaError('baymuttLoad() needs @initBaymutt first', {
        tip: 'Add `# @initBaymutt(key=$BAYMUTT_KEY)` above it.',
      });
    }
    const environment = await environmentResolver?.resolve();
    if (typeof environment !== 'string') {
      throw new SchemaError('Expected the environment name to resolve to a string');
    }
    try {
      return JSON.stringify(await loadEnvironment(environment, connection));
    } catch (error) {
      throw new ResolutionError(
        `baymutt could not load ${environment}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

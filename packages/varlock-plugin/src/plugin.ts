// The varlock plugin:
//
//   # @plugin(@baymutt/varlock-plugin)
//   # @initBaymutt(key=$BAYMUTT_KEY)
//   # @setValuesBulk(baymuttLoad("app/production"))
//
// `key` is the machine key where the environment holds one (CI). Left unset or empty, the key is
// read from where `baymutt pair` put it: the login keychain on a Mac, an owner-only file elsewhere.
import { loadProject } from '@baymutt/cli/load';
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
  description: 'Connect to baymutt with this machine’s key, for baymuttLoad()',
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
  label: 'Load every value of a baymutt project',
  argsSchema: { type: 'array', arrayMinLength: 1, arrayMaxLength: 1 },
  process() {
    return { projectResolver: this.arrArgs?.[0] };
  },
  async resolve({ projectResolver }) {
    if (connection === undefined) {
      throw new SchemaError('baymuttLoad() needs @initBaymutt first', {
        tip: 'Add `# @initBaymutt(key=$BAYMUTT_KEY)` above it.',
      });
    }
    const project = await projectResolver?.resolve();
    if (typeof project !== 'string') {
      throw new SchemaError('Expected the project name to resolve to a string');
    }
    try {
      return JSON.stringify(await loadProject(project, connection));
    } catch (error) {
      throw new ResolutionError(
        `baymutt could not load ${project}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

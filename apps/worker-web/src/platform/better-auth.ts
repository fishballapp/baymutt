// Better Auth, for signing in two ways: a magic link by email, and a passkey. Neither is what
// protects a value: a link only signs in, and what the store lets a session change is decided by
// the vault proof (http/guards.ts), which a passkey or the recovery key alone can produce.
import { VAULT_PROOF_HEADER } from '@baymutt/api';
import { tokenHash } from '@baymutt/keys/wire';
import { passkey } from '@better-auth/passkey';
import { type Auth as BetterAuthInstance, type BetterAuthOptions, betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins';
import * as Config from 'effect/Config';
import * as Redacted from 'effect/Redacted';
import { BaymuttConfig } from './config.ts';

export const AuthConfig = Config.all({
  secret: Config.Redacted('BETTER_AUTH_SECRET'),
  baymutt: BaymuttConfig,
});

/** What the dashboard calls over HTTP. Everything else Better Auth mounts answers 403. */
const HTTP_PATHS: ReadonlySet<string> = new Set([
  '/get-session',
  '/sign-out',
  '/sign-in/magic-link',
  '/magic-link/verify',
  '/sign-in/email',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/generate-authenticate-options',
  '/passkey/verify-authentication',
]);

const REGISTRATION_PATHS: ReadonlySet<string> = new Set([
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
]);

/** The link in the email works this long. The email says so. */
const MAGIC_LINK_MINUTES = 10;

const refused = (message: string, code = 'FORBIDDEN') =>
  new APIError('FORBIDDEN', { message, code });

export type SendMagicLink = (link: {
  readonly email: string;
  readonly url: string;
}) => Promise<void>;

type BaymuttAuthOptions = Omit<BetterAuthOptions, 'plugins'> & {
  plugins: [ReturnType<typeof magicLink>, ReturnType<typeof passkey>];
};

export type BaymuttAuth = BetterAuthInstance<BaymuttAuthOptions>;

const authOptions = (
  db: D1Database,
  { secret, baymutt }: Config.Success<typeof AuthConfig>,
  sendMagicLink: SendMagicLink,
): BaymuttAuthOptions => ({
  appName: 'baymutt',
  database: db,
  secret: Redacted.value(secret),
  baseURL: baymutt.origin,
  basePath: '/api/auth',
  trustedOrigins: [baymutt.origin],
  advanced: {
    // An instance is built per call; committed migrations own the schema, so auth calls don't
    // introspect D1 every time.
    database: { validateSchema: false },
    ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    // One session cookie name in every environment, the one the API's guards declare. Browsers
    // treat `http://localhost` as a secure origin, so local dev takes the `__Secure-` cookie too.
    useSecureCookies: true,
  },
  // An account is made by a magic link, never by this: the password is set through our own route
  // (`Accounts.setPassword`), once the email is verified and with the wrap it opens.
  emailAndPassword: { enabled: true, disableSignUp: true },
  // The library lets a passkey be added only by a session under a day old. The vault proof is
  // our test for that (the hook below), and a vault stays open longer than a day.
  session: { freshAge: 0 },
  // Off by default on Workers (the library enables it by NODE_ENV), and its default store is one
  // isolate's memory. Sign-up is open, so what sends mail or creates rows is held tighter.
  rateLimit: {
    enabled: true,
    storage: 'database',
    window: 60,
    max: 120,
    customRules: {
      '/sign-in/magic-link': { window: 60, max: 5 },
      '/sign-in/email': { window: 60, max: 10 },
      '/passkey/generate-register-options': { window: 60, max: 10 },
      '/passkey/verify-registration': { window: 60, max: 10 },
    },
  },
  hooks: {
    before: createAuthMiddleware(async ctx => {
      // A call with no request is this Worker's own (`auth.api.getSession`).
      if (ctx.request === undefined) return;
      if (!HTTP_PATHS.has(ctx.path)) throw refused('This endpoint is disabled.');
      if (!REGISTRATION_PATHS.has(ctx.path)) return;
      // A passkey is a way in that outlives the session that added it. Once the account has a
      // vault, adding one takes the open vault: a session a magic link made cannot, so a
      // hijacked inbox cannot plant a passkey. Before there is a vault, the first passkey makes it.
      const current = await getSessionFromCtx(ctx);
      if (current === null) return;
      const account = await db
        .prepare('SELECT vault_proof_hash FROM store_account WHERE user_id = ?1')
        .bind(current.user.id)
        .first<{ vault_proof_hash: string }>();
      if (account === null) {
        // No vault yet, so any passkey the user has is one a failed set-up left behind. It opens
        // nothing, and the authenticator would refuse to make another beside it.
        if (ctx.path === '/passkey/generate-register-options') {
          await db.prepare('DELETE FROM passkey WHERE userId = ?1').bind(current.user.id).run();
        }
        return;
      }
      const proof = ctx.headers?.get(VAULT_PROOF_HEADER) ?? '';
      if ((await tokenHash(proof)) !== account.vault_proof_hash) {
        throw refused('Unlock your vault before adding a passkey.', 'VAULT_LOCKED');
      }
    }),
  },
  plugins: [
    magicLink({
      expiresIn: MAGIC_LINK_MINUTES * 60,
      allowedAttempts: 1,
      // Local dev sends no mail: the drive reads the link from the database, so it is kept whole there.
      storeToken: baymutt.isDev ? 'plain' : 'hashed',
      sendMagicLink: ({ email, url }) => sendMagicLink({ email, url }),
    }),
    passkey({
      rpID: new URL(baymutt.origin).hostname,
      rpName: 'baymutt',
      origin: baymutt.origin,
      // PRF is requested by the client: the plugin's `extensions` type has no `prf` member.
    }),
  ],
});

/** A Better Auth instance factory: the live one, or a test's fake. */
export type MakeBetterAuth = () => BaymuttAuth;

/** An instance is built per call: one per isolate is unverified on Workers. */
export const makeBetterAuth =
  (
    db: D1Database,
    config: Config.Success<typeof AuthConfig>,
    sendMagicLink: SendMagicLink,
  ): MakeBetterAuth =>
  () =>
    betterAuth(authOptions(db, config, sendMagicLink));

export { MAGIC_LINK_MINUTES };

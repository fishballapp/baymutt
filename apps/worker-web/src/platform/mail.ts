// The one email baymutt sends: a sign-in link. Local dev sends none.
import { createForwardEmailClient } from '@internal/email';
import * as Config from 'effect/Config';
import * as Redacted from 'effect/Redacted';
import { MAGIC_LINK_MINUTES, type SendMagicLink } from './better-auth.ts';
import { BaymuttConfig } from './config.ts';

export const MailConfig = Config.all({
  baymutt: BaymuttConfig,
  // The forwardemail alias the mail is sent as, and that alias's own password.
  sender: Config.String('MAIL_SENDER'),
  aliasPassword: Config.Redacted('FORWARD_EMAIL_ALIAS_PASSWORD'),
});

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, character => `&#${character.charCodeAt(0)};`);

export const magicLinkSender = ({
  baymutt,
  sender,
  aliasPassword,
}: Config.Success<typeof MailConfig>): SendMagicLink =>
  baymutt.isDev
    ? async () => {}
    : async ({ email, url }) => {
        const text = [
          'Sign in to baymutt:',
          url,
          '',
          `The link works once, for ${MAGIC_LINK_MINUTES} minutes. It signs you in; your vault stays locked until you unlock it with a passkey.`,
          'If you did not ask for it, ignore this email.',
        ].join('\n');
        await createForwardEmailClient({
          alias: sender,
          password: Redacted.value(aliasPassword),
        }).send({
          from: `baymutt <${sender}>`,
          to: email,
          subject: 'Your baymutt sign-in link',
          text,
          html: `<p>Sign in to baymutt:</p><p><a href="${escapeHtml(url)}">Sign in</a></p><p>The link works once, for ${MAGIC_LINK_MINUTES} minutes. It signs you in; your vault stays locked until you unlock it with a passkey.</p><p>If you did not ask for it, ignore this email.</p>`,
        });
      };

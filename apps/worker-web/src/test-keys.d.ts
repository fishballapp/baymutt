// What the tests use of `@baymutt/keys`, declared by hand. The key schedule is typed against the
// DOM's globals and this package against workerd's, so one program cannot check both:
// tsconfig.test.json maps the import here, and Vitest loads the real module.

export type PrivateKey = { readonly publicKey: Uint8Array<ArrayBuffer> };

export type NamesKey = { readonly sealKey: unknown; readonly indexKey: unknown };

type Reader = { readonly id: string; readonly publicKey: string };

export declare const generateEnvironmentKey: () => Promise<{
  readonly publicKey: string;
  readonly privateKey: string;
}>;

export declare const importPrivateKey: (privateKey: string, what: string) => Promise<PrivateKey>;

export declare const createNamesKey: (request: {
  readonly accountKey: PrivateKey;
  readonly orgId: string;
  readonly readers: ReadonlyArray<Reader>;
}) => Promise<{
  readonly namesKey: NamesKey;
  readonly wraps: ReadonlyArray<{ readonly readerId: string; readonly wrap: string }>;
}>;

export declare const openNamesKey: (wrap: {
  readonly wrap: string;
  readonly orgId: string;
  readonly readerKey: PrivateKey;
  readonly readerId: string;
  readonly accountPublicKey: string;
}) => Promise<NamesKey>;

export declare const sealName: (
  namesKey: NamesKey,
  name: { readonly scopeId: string; readonly name: string },
) => Promise<{ readonly name: string; readonly sealedName: string }>;

export declare const openName: (
  namesKey: NamesKey | null,
  name: {
    readonly scopeId: string;
    readonly stored: { readonly name: string; readonly sealedName: string | null };
  },
) => Promise<string>;

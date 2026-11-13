export {
  decodePublicKey,
  importPrivateKey,
  type PrivateKey,
  pairingCode,
  VaultError,
  type VaultFailureCode,
  type VaultKey,
} from '@internal/zk-vault';
export { randomToken } from './encoding.ts';
export {
  createEnvironmentKey,
  type EnvironmentKeyBinding,
  generateEnvironmentKey,
  openValue,
  publicKeyFingerprint,
  sealValue,
  unwrapEnvironmentKey,
  type ValueSlot,
  vouchedEnvironmentKey,
  vouchForEnvironmentKey,
  wrapEnvironmentKey,
} from './environment.ts';
export {
  approvePairing,
  createAccountKey,
  createVault,
  derivePasskeyEncKey,
  derivePasswordKeys,
  endorseCredential,
  endorsedPublicKey,
  endorsedReader,
  generateRecoveryKey,
  grantToServiceAccount,
  grantToTrustedReader,
  MIN_PASSWORD_LENGTH,
  type OwnedEnvironment,
  type OwnerKeys,
  type OwnerVault,
  openAccountKey,
  openOwnedEnvironment,
  openVault,
  PRF_INPUT_LABEL,
  recoveryVaultKey,
  rewrapDek,
  vaultProof,
  vouchedScopedReader,
} from './owner.ts';
export { openWelcome, sealWelcome, type Welcome } from './pairing.ts';
export {
  generateServiceAccountToken,
  type ServiceAccountKey,
  serviceAccountKeyFromToken,
} from './service-account.ts';
export {
  type ServiceAccountVouchers,
  vouchedAccountKey,
  vouchedServiceAccountKey,
  vouchForServiceAccount,
} from './vouchers.ts';
export { formatBearer, parseBearer, tokenHash } from './wire.ts';

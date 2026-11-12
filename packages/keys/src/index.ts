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
  generateMachineToken,
  type MachineKey,
  machineKeyFromToken,
} from './machine.ts';
export {
  approvePairing,
  createAccountKey,
  createVault,
  derivePasskeyEncKey,
  derivePasswordKeys,
  endorseCredential,
  endorsedPublicKey,
  generateRecoveryKey,
  grantToMachine,
  MIN_PASSWORD_LENGTH,
  type OwnedProject,
  type OwnerKeys,
  type OwnerVault,
  openAccountKey,
  openOwnedProject,
  openVault,
  PRF_INPUT_LABEL,
  recoveryVaultKey,
  rewrapDek,
  vaultProof,
} from './owner.ts';
export { openWelcome, sealWelcome, type Welcome } from './pairing.ts';
export {
  createProjectKey,
  generateProjectKey,
  openValue,
  type ProjectKeyBinding,
  publicKeyFingerprint,
  sealValue,
  unwrapProjectKey,
  type ValueSlot,
  vouchedProjectKey,
  vouchForProjectKey,
  wrapProjectKey,
} from './project.ts';
export { formatBearer, parseBearer, tokenHash } from './wire.ts';

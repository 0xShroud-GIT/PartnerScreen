export interface RecoverableSession {
  clearError(): Promise<void>;
}
export interface RecoverableMedia {
  resetToIdle(): Promise<void>;
}
export interface RecoverableCapture {
  resetToIdle(): Promise<void>;
}
export interface RecoverableNotifications {
  clearRequestNotification(): Promise<boolean>;
}
export interface RecoverablePip {
  exitPip(): Promise<boolean>;
}
export interface RecoverableKeepAwake {
  disable(): Promise<boolean>;
}

export interface ErrorRecoveryPorts {
  session: RecoverableSession;
  media: RecoverableMedia;
  capture: RecoverableCapture;
  notifications: RecoverableNotifications;
  pip: RecoverablePip;
  keepAwake: RecoverableKeepAwake;
}

/** One coordinated Error recovery path. Preserves trusted pairing. */
export async function recoverProductError(ports: ErrorRecoveryPorts): Promise<void> {
  await ports.pip.exitPip().catch(() => false);
  await ports.keepAwake.disable().catch(() => false);
  await ports.notifications.clearRequestNotification().catch(() => false);
  await ports.media.resetToIdle().catch(() => undefined);
  await ports.capture.resetToIdle().catch(() => undefined);
  await ports.session.clearError();
}

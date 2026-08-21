export const LOCAL_IDENTITY_SCHEMA_VERSION = 1 as const;
export const MAX_DEVICE_NAME_LENGTH = 64;

export interface LocalDeviceIdentity {
  schemaVersion: typeof LOCAL_IDENTITY_SCHEMA_VERSION;
  deviceId: string;
  deviceName: string | null;
  createdAt: string;
  updatedAt: string;
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidDeviceNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDeviceNameError';
  }
}

export class InvalidLocalIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLocalIdentityError';
  }
}

export function normalizeDeviceName(input: string): string {
  const normalized = input.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) {
    throw new InvalidDeviceNameError('Device name cannot be empty.');
  }
  if (Array.from(normalized).length > MAX_DEVICE_NAME_LENGTH) {
    throw new InvalidDeviceNameError(`Device name must be ${MAX_DEVICE_NAME_LENGTH} characters or fewer.`);
  }
  return normalized;
}

export function parseLocalDeviceIdentity(value: unknown): LocalDeviceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalIdentityError('Persisted local identity is not an object.');
  }

  const candidate = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'deviceId', 'deviceName', 'createdAt', 'updatedAt']);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new InvalidLocalIdentityError('Persisted local identity contains unsupported fields.');
  }
  if (candidate.schemaVersion !== LOCAL_IDENTITY_SCHEMA_VERSION) {
    throw new InvalidLocalIdentityError('Persisted local identity has an unsupported schema version.');
  }
  if (typeof candidate.deviceId !== 'string' || !UUID_V4_PATTERN.test(candidate.deviceId)) {
    throw new InvalidLocalIdentityError('Persisted local identity has an invalid device ID.');
  }
  if (candidate.deviceName !== null && typeof candidate.deviceName !== 'string') {
    throw new InvalidLocalIdentityError('Persisted local identity has an invalid device name.');
  }
  if (typeof candidate.deviceName === 'string' && normalizeDeviceName(candidate.deviceName) !== candidate.deviceName) {
    throw new InvalidLocalIdentityError('Persisted local identity contains a non-normalized device name.');
  }
  if (typeof candidate.createdAt !== 'string' || Number.isNaN(Date.parse(candidate.createdAt))) {
    throw new InvalidLocalIdentityError('Persisted local identity has an invalid creation timestamp.');
  }
  if (typeof candidate.updatedAt !== 'string' || Number.isNaN(Date.parse(candidate.updatedAt))) {
    throw new InvalidLocalIdentityError('Persisted local identity has an invalid update timestamp.');
  }
  if (Date.parse(candidate.updatedAt) < Date.parse(candidate.createdAt)) {
    throw new InvalidLocalIdentityError('Persisted local identity timestamps are out of order.');
  }

  return {
    schemaVersion: LOCAL_IDENTITY_SCHEMA_VERSION,
    deviceId: candidate.deviceId,
    deviceName: candidate.deviceName as string | null,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

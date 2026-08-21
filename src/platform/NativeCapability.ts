export interface NativeCapability {
  readonly name: string;
  isAvailable(): Promise<boolean>;
}

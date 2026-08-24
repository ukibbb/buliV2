export interface IInstallBinaryOptions {
  readonly version?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly destination?: string;
  readonly fetchAsset?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

export function installBinary(options?: IInstallBinaryOptions): Promise<void>;

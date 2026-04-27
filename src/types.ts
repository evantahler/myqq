export type DoorState =
  | "open"
  | "closed"
  | "opening"
  | "closing"
  | "stopped"
  | "transition"
  | "autoreverse"
  | "unknown";

export interface MyQOptions {
  email: string;
  password: string;
  fetch?: typeof fetch;
  logger?: Logger;
}

export interface Logger {
  debug: (msg: string, meta?: unknown) => void;
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface RawAccount {
  id: string;
  name?: string;
}

export interface RawDevice {
  serial_number: string;
  device_family: string;
  name?: string;
  state?: {
    door_state?: DoorState | string;
    online?: boolean;
  };
}

export interface DoorSummary {
  serialNumber: string;
  name: string;
  online: boolean;
  state: DoorState;
}

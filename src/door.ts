import type { Api } from "./api.ts";
import { MYQ_DEVICES_BASE, MYQ_GDO_BASE } from "./constants.ts";
import type { DoorState, DoorSummary, RawDevice } from "./types.ts";

const KNOWN_STATES: ReadonlySet<DoorState> = new Set<DoorState>([
  "open",
  "closed",
  "opening",
  "closing",
  "stopped",
  "transition",
  "autoreverse",
  "unknown",
]);

function normalizeState(raw: string | undefined): DoorState {
  if (!raw) return "unknown";
  return (KNOWN_STATES as Set<string>).has(raw)
    ? (raw as DoorState)
    : "unknown";
}

export class Door {
  readonly serialNumber: string;
  name: string;
  online: boolean;
  private cachedState: DoorState;

  constructor(
    private readonly api: Api,
    private readonly accountId: string,
    raw: RawDevice,
  ) {
    this.serialNumber = raw.serial_number;
    this.name = raw.name ?? raw.serial_number;
    this.online = raw.state?.online ?? false;
    this.cachedState = normalizeState(raw.state?.door_state);
  }

  ingest(raw: RawDevice): void {
    if (raw.name) this.name = raw.name;
    if (raw.state?.online !== undefined) this.online = raw.state.online;
    this.cachedState = normalizeState(raw.state?.door_state);
  }

  get state(): DoorState {
    return this.cachedState;
  }

  async status(): Promise<DoorState> {
    const url = `${MYQ_DEVICES_BASE}/Accounts/${this.accountId}/Devices/${this.serialNumber}`;
    const data = await this.api.request<RawDevice>(url);
    if (data) this.ingest(data);
    return this.cachedState;
  }

  async open(): Promise<void> {
    await this.api.request(
      `${MYQ_GDO_BASE}/Accounts/${this.accountId}/door_openers/${this.serialNumber}/open`,
      { method: "PUT", expectJson: false },
    );
  }

  async close(): Promise<void> {
    await this.api.request(
      `${MYQ_GDO_BASE}/Accounts/${this.accountId}/door_openers/${this.serialNumber}/close`,
      { method: "PUT", expectJson: false },
    );
  }

  toJSON(): DoorSummary {
    return {
      serialNumber: this.serialNumber,
      name: this.name,
      online: this.online,
      state: this.cachedState,
    };
  }
}

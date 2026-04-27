import { Api } from "./api.ts";
import { Auth } from "./auth.ts";
import {
  MYQ_ACCOUNTS_BASE,
  MYQ_DEVICES_BASE,
  MYQ_GDO_FAMILIES,
} from "./constants.ts";
import { Door } from "./door.ts";
import { MyQAuthError, MyQNotFoundError } from "./errors.ts";
import type { DoorState, MyQOptions, RawAccount, RawDevice } from "./types.ts";

interface AccountsResponse {
  accounts?: RawAccount[];
  Items?: RawAccount[];
}

interface DevicesResponse {
  items?: RawDevice[];
  Items?: RawDevice[];
}

export class MyQ {
  readonly auth: Auth;
  private readonly api: Api;
  private readonly options: MyQOptions;
  private accountId: string | undefined;
  private accountName: string | undefined;
  private doorsBySerial = new Map<string, Door>();

  constructor(options: MyQOptions) {
    if (!options.email || !options.password) {
      throw new MyQAuthError("MyQ requires email and password");
    }
    this.options = options;
    this.auth = new Auth({
      email: options.email,
      password: options.password,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
    this.api = new Api({
      auth: this.auth,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }

  get doors(): Door[] {
    return [...this.doorsBySerial.values()];
  }

  get account(): { id: string; name?: string } | undefined {
    if (!this.accountId) return undefined;
    return this.accountName !== undefined
      ? { id: this.accountId, name: this.accountName }
      : { id: this.accountId };
  }

  async connect(): Promise<void> {
    await this.auth.login();
    await this.loadAccount();
    await this.refreshDevices();
  }

  async refreshDevices(): Promise<void> {
    if (!this.accountId) await this.loadAccount();
    const accountId = this.accountId;
    if (!accountId) throw new MyQAuthError("No MyQ account on this login");
    const res = await this.api.request<DevicesResponse>(
      `${MYQ_DEVICES_BASE}/Accounts/${accountId}/Devices`,
    );
    const items = res?.items ?? res?.Items ?? [];
    const seen = new Set<string>();
    for (const raw of items) {
      if (!MYQ_GDO_FAMILIES.has(raw.device_family)) continue;
      seen.add(raw.serial_number);
      const existing = this.doorsBySerial.get(raw.serial_number);
      if (existing) {
        existing.ingest(raw);
      } else {
        this.doorsBySerial.set(
          raw.serial_number,
          new Door(this.api, accountId, raw),
        );
      }
    }
    for (const serial of [...this.doorsBySerial.keys()]) {
      if (!seen.has(serial)) this.doorsBySerial.delete(serial);
    }
  }

  getDoor(serial: string): Door | undefined {
    return this.doorsBySerial.get(serial);
  }

  async status(serial?: string): Promise<DoorState> {
    return this.resolveDoor(serial).status();
  }

  async open(serial?: string): Promise<void> {
    await this.resolveDoor(serial).open();
  }

  async close(serial?: string): Promise<void> {
    await this.resolveDoor(serial).close();
  }

  async disconnect(): Promise<void> {
    this.auth.disconnect();
  }

  private resolveDoor(serial?: string): Door {
    if (serial) {
      const door = this.doorsBySerial.get(serial);
      if (!door) {
        throw new MyQNotFoundError(`No door with serial ${serial}`);
      }
      return door;
    }
    const list = this.doors;
    if (list.length === 0) {
      throw new MyQNotFoundError("No doors on this account");
    }
    if (list.length > 1) {
      throw new MyQNotFoundError(
        "Multiple doors found; pass serial explicitly",
        { recovery: "Iterate myq.doors or pass a serial to status/open/close" },
      );
    }
    return list[0]!;
  }

  private async loadAccount(): Promise<void> {
    const res = await this.api.request<AccountsResponse>(
      `${MYQ_ACCOUNTS_BASE}/accounts`,
    );
    const accounts = res?.accounts ?? res?.Items ?? [];
    const first = accounts[0];
    if (!first) {
      throw new MyQAuthError("MyQ login returned no accounts");
    }
    this.accountId = first.id;
    if (first.name !== undefined) this.accountName = first.name;
    this.options.logger?.debug("MyQ account loaded", {
      id: this.accountId,
      name: this.accountName,
    });
  }
}

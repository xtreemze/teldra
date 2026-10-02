/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: canonical Teldra JSON Schema.
 * Run: pnpm schema:generate
 */

export type TeldraLiveEnvelope = Observation | Availability | DesiredState | CommandAck;
export type Id = string;
export type Timestamp = string;
export type StateValue = BooleanValue | NumberValue | TextValue | RgbValue;

export interface Observation {
  schemaVersion: "0.1.0";
  kind: "observation";
  eventId: Id;
  subject: CapabilitySubject;
  source: Source;
  observedAt: Timestamp;
  receivedAt: Timestamp;
  values: Values;
}
export interface CapabilitySubject {
  deviceId: Id;
  capabilityId: Id;
}
export interface Source {
  adapter: string;
  bindingId?: Id;
  streamId: string;
  sequence?: number;
}
export interface Values {
  [k: string]: StateValue;
}
export interface BooleanValue {
  kind: "boolean";
  value: boolean;
}
export interface NumberValue {
  kind: "number";
  value: number;
  unit?: string;
}
export interface TextValue {
  kind: "text";
  value: string;
}
export interface RgbValue {
  kind: "rgb";
  /**
   * @minItems 3
   * @maxItems 3
   */
  value: [number, number, number];
}
export interface Availability {
  schemaVersion: "0.1.0";
  kind: "availability";
  eventId: Id;
  subject: AvailabilitySubject;
  source: Source;
  observedAt: Timestamp;
  receivedAt: Timestamp;
  status: "online" | "offline" | "unavailable" | "unknown";
}
export interface AvailabilitySubject {
  deviceId: Id;
  capabilityId?: Id;
}
export interface DesiredState {
  schemaVersion: "0.1.0";
  kind: "desired-state";
  eventId: Id;
  commandId: Id;
  subject: CapabilitySubject;
  requestedAt: Timestamp;
  expiresAt?: Timestamp;
  values: Values;
  optimistic: boolean;
}
export interface CommandAck {
  schemaVersion: "0.1.0";
  kind: "command-ack";
  eventId: Id;
  commandId: Id;
  subject: CapabilitySubject;
  source: Source;
  receivedAt: Timestamp;
  status: "accepted" | "rejected" | "completed" | "failed";
  message?: string;
}

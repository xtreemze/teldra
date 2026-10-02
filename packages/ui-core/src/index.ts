export interface BinaryControlState {
  readonly on: boolean;
  readonly disabled?: boolean;
}

export function nextBinaryControlValue(state: BinaryControlState): boolean {
  return state.disabled ? state.on : !state.on;
}

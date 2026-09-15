// Controller haptics — best-effort: a short pulse on the XR input source's first actuator (Quest
// controllers have one); silently nothing where unsupported. A pulse that gets pre-empted by the
// next one rejects on some browsers — that's noise, not an error.

export function pulse(controller: HTMLElement, strength: number, ms: number): void {
  try {
    const source = (
      controller as unknown as {
        components?: {
          "tracked-controls"?: {
            controller?: {
              gamepad?: { hapticActuators?: { pulse?(value: number, ms: number): unknown }[] };
            };
          };
        };
      }
    ).components?.["tracked-controls"]?.controller;
    const result = source?.gamepad?.hapticActuators?.[0]?.pulse?.(strength, ms);
    (result as { catch?: (fn: () => void) => unknown } | undefined)?.catch?.(() => undefined);
  } catch {
    /* no haptics on this device */
  }
}

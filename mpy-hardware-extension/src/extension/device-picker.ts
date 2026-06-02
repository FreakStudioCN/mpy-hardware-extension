export async function pickDevice(input: { shim: { request: (method: string, params: any) => Promise<any> }; choose: (ports: string[]) => Promise<string | undefined>; boardId?: string }) {
  const result = await input.shim.request("device.scan", {});
  const port = await input.choose(result.ports ?? []);
  if (!port) {
    return { ok: false, error_kind: "device_not_selected" };
  }
  return { ok: true, port, boardId: input.boardId ?? null };
}

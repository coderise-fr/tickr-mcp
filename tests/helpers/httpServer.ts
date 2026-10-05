import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
  /** Sends the headers and this partial body, then never ends the response. */
  stallAfter?: string;
}

export async function startServer(responder: (req: RecordedRequest, index: number) => Reply) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rec: RecordedRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    requests.push(rec);
    const reply = responder(rec, requests.length - 1);
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;
    res.writeHead(reply.status, reply.headers ?? {});
    if (reply.stallAfter !== undefined) {
      res.write(reply.stallAfter);
      return;
    }
    res.end(reply.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
  body: JSON.stringify(body),
});

export const problem = (
  status: number,
  code: string,
  detail?: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Reply => ({
  status,
  headers: { "content-type": "application/problem+json", ...headers },
  body: JSON.stringify({
    type: `https://docs.tickr.coderise.cloud/errors/${code}`,
    title: "Problem",
    status,
    detail,
    correlationId: "corr-1",
    ...extra,
  }),
});

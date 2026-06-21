import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { piRuntimeToolsExtensionPath } from "./runtime-tools.js";

type SchemaLike<T = unknown> = {
  parse(value: unknown): T;
};

export type PiCustomToolDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly input: SchemaLike;
  readonly output: SchemaLike;
  execute(context: unknown, input: unknown): Promise<unknown>;
};

export type PiCustomToolRequest = {
  readonly tools: readonly PiCustomToolDefinition[];
  readonly context: unknown;
};

export type PreparedPiCustomTools = {
  readonly extensionPath: string;
  readonly dataPath: string;
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly toolNames: readonly string[];
  close(): Promise<void>;
};

export async function preparePiCustomTools(options: {
  root: string;
  request: PiCustomToolRequest;
}): Promise<PreparedPiCustomTools> {
  const extensionPath = await piRuntimeToolsExtensionPath();
  const toolRoot = path.join(options.root, "custom-tools");
  await mkdir(toolRoot, { recursive: true });
  const dataPath = path.join(toolRoot, "data.json");
  await writeFile(
    dataPath,
    JSON.stringify({
      tools: options.request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    }),
    "utf8",
  );

  const bridge = await startCustomToolBridge(options.request.tools, options.request.context);
  return {
    extensionPath,
    dataPath,
    bridgeUrl: bridge.url,
    bridgeToken: bridge.token,
    toolNames: options.request.tools.map((tool) => tool.name),
    close: bridge.close,
  };
}

async function startCustomToolBridge(
  tools: readonly PiCustomToolDefinition[],
  context: unknown,
): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomBytes(24).toString("hex");
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = createServer((request, response) => {
    void handleBridgeRequest(request, response, token, toolsByName, context);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handleBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  tools: Map<string, PiCustomToolDefinition>,
  context: unknown,
): Promise<void> {
  try {
    if (request.method !== "POST" || request.url !== "/call") {
      writeJson(response, 404, { ok: false, error: "Unknown custom tool bridge route" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      writeJson(response, 401, { ok: false, error: "Invalid custom tool bridge token" });
      return;
    }

    const payload = parseBridgePayload(await readRequestBody(request));
    const tool = tools.get(payload.tool);
    if (!tool) {
      writeJson(response, 404, { ok: false, error: `Unknown custom tool '${payload.tool}'` });
      return;
    }

    const input = tool.input.parse(payload.params);
    const output = await tool.execute(context, input);
    const result = tool.output.parse(output);
    writeJson(response, 200, { ok: true, result });
  } catch (error) {
    writeJson(response, 500, { ok: false, error: errorMessage(error) });
  }
}

function parseBridgePayload(body: string): { tool: string; params: unknown } {
  const value = JSON.parse(body) as unknown;
  if (typeof value !== "object" || value === null) {
    throw new Error("Custom tool bridge payload must be an object");
  }
  const tool = Reflect.get(value, "tool");
  if (typeof tool !== "string" || tool.length === 0) {
    throw new Error("Custom tool bridge payload missing tool");
  }
  return { tool, params: Reflect.get(value, "params") };
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        request.destroy(new Error("Custom tool bridge request is too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

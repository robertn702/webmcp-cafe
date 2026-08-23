#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RegistryClient } from "./client.js";
import { LocalBridgeClient } from "./local-bridge-client.js";
import { registerLocalBridgeTools } from "./local-bridge-tools.js";
import { registerReadTools } from "./read-tools.js";
import { registerSetupTools } from "./setup-tools.js";
import { registerWriteTools } from "./write-tools.js";

const baseUrl = process.env.WEBMCP_TODAY_API_URL ?? "https://webmcp.today";
const apiKey = process.env.WEBMCP_TODAY_API_KEY;

const server = new McpServer({ name: "webmcp-today", version: "0.3.1" });
const client = new RegistryClient({ baseUrl, apiKey });
const localBridgeClient = new LocalBridgeClient();

registerReadTools(server, client);
registerWriteTools(server, client);
registerLocalBridgeTools(server, localBridgeClient);
registerSetupTools(server);

await server.connect(new StdioServerTransport());
console.error(`webmcp-today MCP server connected (registry: ${baseUrl})`);
